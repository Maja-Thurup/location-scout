import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import {
  type Bbox,
  bboxFromRadius,
  bboxCenter,
  clampBbox,
  distanceMeters,
  isReasonableBbox,
} from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { forwardGeocode } from "@/lib/geocode";
import { type GooglePlace, searchText } from "@/lib/google-places";
import { logger } from "@/lib/logger";
import { findDetectionsInBbox } from "@/lib/mapillary";
import { type MatchMode, type OsmCandidate, searchOsm } from "@/lib/overpass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_RADII = [5, 10, 25, 50, 100] as const;

const requestSchema = z.object({
  /**
   * OSM tags to filter by, as Claude returned them.
   * Example: { "building": "warehouse", "abandoned": "yes" }
   */
  osmTags: z
    .record(z.string(), z.string())
    .refine((obj) => Object.keys(obj).length > 0, "osmTags must have at least one entry"),

  /** Optional Google Places "type" filter for the B2 text-search fallback. */
  googleTypes: z.array(z.string()).optional(),

  /**
   * Optional Claude-derived text query for the B2 fallback when OSM is
   * empty even after ring expansion. e.g. "warehouse Brooklyn industrial".
   */
  googleQuery: z.string().min(1).max(200).optional(),

  /**
   * Optional Mapillary `object_value` classes specified by Claude. When
   * present, we fetch detections in the bbox and ADD them as candidates
   * alongside OSM results. Especially useful for object-rich scenes
   * where OSM is sparse (e.g. "bench on a wooded path" — OSM returns
   * the park polygon centroid; Mapillary returns 50+ actual bench coords).
   */
  mapillaryClasses: z.array(z.string()).optional(),

  /**
   * Free-text location string to geocode (city, neighborhood, address).
   * One of `location` or `bbox` must be provided.
   */
  location: z.string().min(2).max(160).optional(),

  /** Optional radius around the geocoded location, in miles. */
  radiusMiles: z
    .number()
    .int()
    .refine((v) => (ALLOWED_RADII as readonly number[]).includes(v))
    .nullable()
    .optional(),

  /**
   * Pre-computed bbox. Used when a Project saves a search and we want to
   * re-render the same results next session.
   */
  bbox: z
    .object({
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    })
    .optional(),
});

/** Candidate enriched with distance from the search center. */
type RankedCandidate = OsmCandidate & {
  /** Approximate distance (meters) from the search center. */
  distanceMeters: number;
};

/** Extended match modes including the B2 Google-Places-text-search fallback. */
export type ExtendedMatchMode = MatchMode | "google_text_fallback";

type SearchOsmResponse = {
  /** Bbox actually queried (post-expansion if any). */
  bbox: Bbox;
  /** Bbox the user originally requested, before any ring expansion. */
  requestedBbox: Bbox;
  center: { lat: number; lng: number };
  candidates: RankedCandidate[];
  cached: boolean;
  /** Where the original bbox came from. */
  bboxSource: "geocoded_city" | "geocoded_radius" | "supplied";
  /** Tier that supplied the result. */
  matchMode: ExtendedMatchMode;
  /** Tag the loose path used (non-null for primary_only* and possibly best_effort). */
  primaryTag: { key: string; value: string } | null;
  /** Multiplier applied to the user's bbox: 1 | 2 | 4. */
  expansionMultiplier: 1 | 2 | 4;
  /** Mirror that served the live query (null on cache hit). */
  mirror: string | null;
};

type CachedSearchValue = {
  candidates: RankedCandidate[];
  effectiveBbox: Bbox;
  matchMode: ExtendedMatchMode;
  primaryTag: { key: string; value: string } | null;
  expansionMultiplier: 1 | 2 | 4;
};

// ---------------------------------------------------------------------------
// B1 helper: detect "abandonment / decay" cues that should make us include
// CLOSED_PERMANENTLY businesses when we hit Google Places.
// ---------------------------------------------------------------------------

const ABANDONED_OSM_KEYS = new Set(["abandoned", "ruins", "disused"]);
const ABANDONED_VALUE_RE =
  /\b(abandoned|disused|ruined|ruins|derelict|boarded[- ]up|decayed|deserted|forgotten|crumbling)\b/i;

export function sceneImpliesAbandonment(args: {
  osmTags: Record<string, string>;
  googleQuery?: string;
}): boolean {
  for (const [k, v] of Object.entries(args.osmTags)) {
    if (ABANDONED_OSM_KEYS.has(k) && v && v !== "no") return true;
    if (ABANDONED_VALUE_RE.test(v)) return true;
  }
  if (args.googleQuery && ABANDONED_VALUE_RE.test(args.googleQuery)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// B2 helper: convert Google Places search results into the same OsmCandidate
// shape downstream code expects, so the rest of the pipeline doesn't care
// where the candidates came from.
// ---------------------------------------------------------------------------

function googlePlaceToOsmCandidate(p: GooglePlace): OsmCandidate {
  return {
    id: `google/${p.id}`,
    type: "node",
    osmId: 0,
    lat: p.lat,
    lng: p.lng,
    tags: {
      name: p.displayName ?? "",
      "google:place_id": p.id,
      "google:primary_type": p.primaryType ?? "",
      ...(p.businessStatus ? { "google:business_status": p.businessStatus } : {}),
    },
    name: p.displayName ?? null,
  };
}

const MAX_BBOX_RADIUS_MILES = 100;

export const POST = withAuth(async (req) => {
  const t0 = Date.now();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const {
    osmTags,
    googleTypes,
    googleQuery,
    mapillaryClasses,
    location,
    radiusMiles,
    bbox: suppliedBbox,
  } = parsed.data;

  // 1) Resolve bbox: supplied -> custom radius around geocode -> geocoded bbox.
  let bbox: Bbox;
  let bboxSource: SearchOsmResponse["bboxSource"];

  if (suppliedBbox) {
    if (!isReasonableBbox(suppliedBbox)) {
      return NextResponse.json(
        { error: "invalid_bbox", message: "Supplied bbox is too large or malformed." },
        { status: 400 },
      );
    }
    bbox = suppliedBbox;
    bboxSource = "supplied";
  } else {
    if (!location) {
      return NextResponse.json(
        {
          error: "invalid_request",
          message: "Either `location` or `bbox` is required.",
        },
        { status: 400 },
      );
    }
    const geocoded = await forwardGeocode(location);
    if (!geocoded) {
      return NextResponse.json(
        {
          error: "geocode_failed",
          message: `Could not find "${location}" on the map.`,
        },
        { status: 422 },
      );
    }

    if (radiusMiles != null) {
      bbox = clampBbox(
        bboxFromRadius({ lat: geocoded.lat, lng: geocoded.lng }, radiusMiles),
        MAX_BBOX_RADIUS_MILES,
      );
      bboxSource = "geocoded_radius";
    } else if (geocoded.bbox) {
      bbox = clampBbox(geocoded.bbox, MAX_BBOX_RADIUS_MILES);
      bboxSource = "geocoded_city";
    } else {
      // Geocoder didn't return a bbox (rare). Default to a 25-mile radius.
      bbox = bboxFromRadius({ lat: geocoded.lat, lng: geocoded.lng }, 25);
      bboxSource = "geocoded_radius";
    }
  }

  // 2) Cache lookup (14-day TTL).
  // v3 namespace: candidate set now also includes Mapillary detections when
  // mapillaryClasses is non-empty, so the key must include that signal.
  const key = cacheKey("overpass:v2", {
    bbox,
    osmTags,
    mapillaryClasses: mapillaryClasses ? [...mapillaryClasses].sort() : null,
  });
  const cached = await cacheGet<CachedSearchValue>(key);
  if (cached?.candidates) {
    logger.info("search-osm cache hit", {
      userId: req.dbUserId,
      ms: Date.now() - t0,
      candidateCount: cached.candidates.length,
      matchMode: cached.matchMode,
      expansionMultiplier: cached.expansionMultiplier,
    });
    const effective = cached.effectiveBbox ?? bbox;
    const response: SearchOsmResponse = {
      bbox: effective,
      requestedBbox: bbox,
      center: bboxCenter(effective),
      candidates: cached.candidates,
      cached: true,
      bboxSource,
      matchMode: cached.matchMode,
      primaryTag: cached.primaryTag,
      expansionMultiplier: cached.expansionMultiplier ?? 1,
      mirror: null,
    };
    return NextResponse.json(response, { status: 200 });
  }

  // 3) Run the Overpass query.
  let result;
  try {
    result = await searchOsm({ bbox, osmTags });
  } catch (err) {
    logger.error("search-osm overpass failed", {
      userId: req.dbUserId,
      err: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      {
        error: "overpass_failed",
        message: "Couldn't reach the OpenStreetMap query service. Try again in a moment.",
      },
      { status: 502 },
    );
  }

  let effectiveBbox = result.effectiveBbox;
  let candidatesRaw = result.candidates;
  let finalMatchMode: ExtendedMatchMode = result.matchMode;
  let finalExpansion: 1 | 2 | 4 = result.expansionMultiplier;
  let finalPrimaryTag = result.primaryTag;

  // 3.5) Mapillary detections as additional candidates.
  //
  // For object-rich scenes (bench, fire hydrant, bike rack, cobblestone),
  // Mapillary's pre-computed detections often locate filmable spots more
  // precisely than OSM does. We fetch them in parallel with the OSM result
  // and merge — each detection becomes its own candidate at the exact
  // coord where the camera saw the object.
  if (mapillaryClasses && mapillaryClasses.length > 0) {
    const bboxStr = `${effectiveBbox.west},${effectiveBbox.south},${effectiveBbox.east},${effectiveBbox.north}`;
    try {
      const detections = await findDetectionsInBbox({
        bboxStr,
        classes: mapillaryClasses,
        limit: 80,
      });

      if (detections.length > 0) {
        const before = candidatesRaw.length;
        const seen = new Set(candidatesRaw.map((c) => c.id));
        for (const d of detections) {
          const id = `mapillary/${d.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          candidatesRaw.push({
            id,
            type: "node",
            osmId: 0,
            lat: d.lat,
            lng: d.lng,
            tags: { [`mapillary:${d.objectClass}`]: "yes" },
            name: null,
          });
        }
        logger.info("search-osm Mapillary detections merged in", {
          userId: req.dbUserId,
          osmCount: before,
          detectionCount: detections.length,
          afterMerge: candidatesRaw.length,
        });
      }
    } catch (err) {
      logger.warn("search-osm Mapillary detections threw (non-fatal)", {
        err: String(err),
      });
    }
  }

  // 4) B2 — Google Places text-search fallback. Triggered when Overpass came
  //    back empty even after ring expansion. Filmmakers' "diner" / "old
  //    movie theatre" type searches in places where OSM is sparse get
  //    rescued here, fulfilling the "always return something" promise.
  if (
    candidatesRaw.length === 0 &&
    googleQuery &&
    googleQuery.trim().length >= 2
  ) {
    logger.info("search-osm OSM empty, attempting Google Places text fallback", {
      userId: req.dbUserId,
      googleQuery,
    });

    const includeClosed = sceneImpliesAbandonment({ osmTags, googleQuery });
    const places = await searchText({
      textQuery: googleQuery,
      bbox: effectiveBbox,
      includedType: googleTypes?.[0],
      includeClosedPermanently: includeClosed,
      maxResultCount: 15,
    });

    if (places.length > 0) {
      candidatesRaw = places.map(googlePlaceToOsmCandidate);
      finalMatchMode = "google_text_fallback";
      finalExpansion = result.expansionMultiplier;
      finalPrimaryTag = null;
      logger.info("search-osm Google Places fallback hit", {
        userId: req.dbUserId,
        count: candidatesRaw.length,
        includeClosed,
      });
    }
  }

  // 5) Sort candidates by distance from the *effective* bbox center, so
  //    the closest possible matches surface first.
  const center = bboxCenter(effectiveBbox);
  const ranked: RankedCandidate[] = candidatesRaw
    .map((c) => ({
      ...c,
      distanceMeters: distanceMeters(center, { lat: c.lat, lng: c.lng }),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  // 6) Cache.
  const toCache: CachedSearchValue = {
    candidates: ranked,
    effectiveBbox,
    matchMode: finalMatchMode,
    primaryTag: finalPrimaryTag,
    expansionMultiplier: finalExpansion,
  };
  await cacheSet(key, "overpass:v2", toCache, 14);

  logger.info("search-osm success", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    candidateCount: ranked.length,
    rawCount: result.rawCount,
    mirror: result.mirror,
    matchMode: finalMatchMode,
    expansionMultiplier: finalExpansion,
  });

  const response: SearchOsmResponse = {
    bbox: effectiveBbox,
    requestedBbox: bbox,
    center,
    candidates: ranked,
    cached: false,
    bboxSource,
    matchMode: finalMatchMode,
    primaryTag: finalPrimaryTag,
    expansionMultiplier: finalExpansion,
    mirror: result.mirror,
  };
  return NextResponse.json(response, { status: 200 });
});
