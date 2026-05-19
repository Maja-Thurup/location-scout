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
import {
  type MatchMode,
  type OsmCandidate,
  searchOsm,
  searchOsmRich,
} from "@/lib/overpass";
import { mergeCandidates } from "@/lib/providers/dedupe";
import { runProviders } from "@/lib/providers/registry";
import type {
  AssociatedFilm,
  ProviderName,
  RawCandidate,
} from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Bumped from default (10s on Vercel Hobby, 15s on Pro) so the rich-tag
 * parallel-alternatives pipeline plus the new candidate providers
 * (Wikidata SPARQL, Wikipedia geosearch, NYC/SF datasets) all have
 * headroom on big-city bboxes.
 */
export const maxDuration = 60;

const ALLOWED_RADII = [5, 10, 25, 50, 100] as const;

const requestSchema = z.object({
  /**
   * Single OSM tag-set. Backwards-compat path; if `osmTagsAlternatives` is
   * non-empty, this is ignored for OSM retrieval. Always required so callers
   * can fall back when the LLM didn't emit alternatives.
   */
  osmTags: z
    .record(z.string(), z.string())
    .refine((obj) => Object.keys(obj).length > 0, "osmTags must have at least one entry"),

  /** Multiple alternative tag-sets to UNION at the OSM layer. */
  osmTagsAlternatives: z
    .array(z.record(z.string(), z.string()))
    .optional()
    .default([]),

  /** Optional Google Places "type" filter for the B2 text-search fallback. */
  googleTypes: z.array(z.string()).optional(),

  /** Optional Claude-derived text query for the B2 fallback. */
  googleQuery: z.string().min(1).max(200).optional(),

  /** Optional Mapillary `object_value` classes specified by Claude. */
  mapillaryClasses: z.array(z.string()).optional(),

  /**
   * Phase 2a: pass through to providers so they can tailor their queries
   * (e.g. Wikidata could filter by location_kind in the future).
   */
  sceneTokens: z.array(z.string()).optional().default([]),
  antiTokens: z.array(z.string()).optional().default([]),
  locationKind: z
    .enum([
      "urban",
      "suburban",
      "rural",
      "industrial",
      "wilderness",
      "waterfront",
      "mixed",
    ])
    .nullable()
    .optional()
    .default(null),

  /** Free-text location string to geocode. */
  location: z.string().min(2).max(160).optional(),

  /** Optional radius around the geocoded location, in miles. */
  radiusMiles: z
    .number()
    .int()
    .refine((v) => (ALLOWED_RADII as readonly number[]).includes(v))
    .nullable()
    .optional(),

  /** Pre-computed bbox. */
  bbox: z
    .object({
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    })
    .optional(),
});

/**
 * Candidate sent to the client. Extends the OSM-shape with provider
 * metadata so the enrichment pipeline + UI can show richer cards
 * (descriptions, curated images, films attached, source pills).
 */
type RankedCandidate = {
  // OSM-style core
  id: string;
  type: "node" | "way" | "relation";
  osmId: number;
  lat: number;
  lng: number;
  tags: Record<string, string>;
  name: string | null;
  // Provider extension
  sources: ReadonlyArray<ProviderName>;
  primarySource: ProviderName;
  description: string | null;
  knownImageUrl: string | null;
  associatedFilms: ReadonlyArray<AssociatedFilm>;
  sourceUrl: string | null;
  // Search-time
  distanceMeters: number;
};

export type ExtendedMatchMode = MatchMode | "google_text_fallback";

type SearchOsmResponse = {
  bbox: Bbox;
  requestedBbox: Bbox;
  center: { lat: number; lng: number };
  candidates: RankedCandidate[];
  cached: boolean;
  bboxSource: "geocoded_city" | "geocoded_radius" | "supplied";
  matchMode: ExtendedMatchMode;
  primaryTag: { key: string; value: string } | null;
  expansionMultiplier: 1 | 2 | 4;
  mirror: string | null;
  alternativesTried: number;
  alternativesSucceeded: number;
  /** Per-provider stats, surfaced for debugging + the analysis panel UI. */
  providerStats: Record<ProviderName, { count: number; ms: number; error: string | null }>;
};

type CachedSearchValue = {
  candidates: RankedCandidate[];
  effectiveBbox: Bbox;
  matchMode: ExtendedMatchMode;
  primaryTag: { key: string; value: string } | null;
  expansionMultiplier: 1 | 2 | 4;
  alternativesTried: number;
  alternativesSucceeded: number;
  providerStats: Record<ProviderName, { count: number; ms: number; error: string | null }>;
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
// Conversion: OSM candidate -> RawCandidate so it can flow through the
// provider-merge step alongside Wikidata/Wikipedia/NYC/SF results.
// ---------------------------------------------------------------------------

function osmCandidateToRaw(c: OsmCandidate): RawCandidate {
  return {
    externalId: c.id,
    source: "osm",
    lat: c.lat,
    lng: c.lng,
    name: c.name,
    description: null,
    knownImageUrl: null,
    tags: c.tags,
    associatedFilms: [],
    sourceUrl: `https://www.openstreetmap.org/${c.type}/${c.osmId}`,
  };
}

function googlePlaceToRaw(p: GooglePlace): RawCandidate {
  return {
    externalId: p.id,
    source: "osm", // treat Google fallback as OSM-class for the merge step
    lat: p.lat,
    lng: p.lng,
    name: p.displayName ?? null,
    description: p.editorialSummary ?? null,
    knownImageUrl: null,
    tags: {
      "google:place_id": p.id,
      "google:primary_type": p.primaryType ?? "",
      ...(p.businessStatus ? { "google:business_status": p.businessStatus } : {}),
    },
    associatedFilms: [],
    sourceUrl: p.googleMapsUri ?? null,
  };
}

const MAX_BBOX_RADIUS_MILES = 100;
const MAX_OUTPUT_CANDIDATES = 50;

/** OSM "type" used downstream for ID composition. Provider candidates use "node". */
function inferTypeFromId(id: string): "node" | "way" | "relation" {
  if (id.startsWith("way/")) return "way";
  if (id.startsWith("relation/")) return "relation";
  return "node";
}

/** OSM-internal numeric id, when applicable; 0 for non-OSM provider sources. */
function inferOsmId(externalIds: Record<string, string | undefined>): number {
  const osmExt = externalIds.osm;
  if (!osmExt) return 0;
  const m = /^(?:node|way|relation)\/(\d+)$/.exec(osmExt);
  return m ? Number(m[1]) : 0;
}

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
    osmTagsAlternatives,
    googleTypes,
    googleQuery,
    mapillaryClasses,
    sceneTokens,
    antiTokens,
    locationKind,
    location,
    radiusMiles,
    bbox: suppliedBbox,
  } = parsed.data;

  const effectiveAlternatives: ReadonlyArray<Record<string, string>> =
    osmTagsAlternatives.length > 0 ? osmTagsAlternatives : [osmTags];

  // 1) Resolve bbox.
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
        { error: "invalid_request", message: "Either `location` or `bbox` is required." },
        { status: 400 },
      );
    }
    const geocoded = await forwardGeocode(location);
    if (!geocoded) {
      return NextResponse.json(
        { error: "geocode_failed", message: `Could not find "${location}" on the map.` },
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
      bbox = bboxFromRadius({ lat: geocoded.lat, lng: geocoded.lng }, 25);
      bboxSource = "geocoded_radius";
    }
  }

  // 2) Cache lookup.
  // v4 namespace: response now includes provider results (Wikidata,
  // Wikipedia, NYC, SF). Previous cache entries don't have those.
  const key = cacheKey("overpass:v3", {
    schema: "v4-providers",
    bbox,
    osmTags,
    osmTagsAlternatives: effectiveAlternatives,
    mapillaryClasses: mapillaryClasses ? [...mapillaryClasses].sort() : null,
  });
  const cached = await cacheGet<CachedSearchValue>(key);
  if (cached?.candidates) {
    logger.info("search-osm cache hit", {
      userId: req.dbUserId,
      ms: Date.now() - t0,
      candidateCount: cached.candidates.length,
      matchMode: cached.matchMode,
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
      alternativesTried: cached.alternativesTried ?? 1,
      alternativesSucceeded: cached.alternativesSucceeded ?? cached.alternativesTried ?? 1,
      providerStats:
        cached.providerStats ??
        ({} as Record<ProviderName, { count: number; ms: number; error: string | null }>),
    };
    return NextResponse.json(response, { status: 200 });
  }

  // 3) PARALLEL: run OSM and the provider registry.
  //    OSM has its own tier-relaxation logic; providers each cache for
  //    7 days so re-runs are nearly free.
  const osmPromise = (async () => {
    return effectiveAlternatives.length > 1
      ? await searchOsmRich({
          bbox,
          osmTagsAlternatives: effectiveAlternatives,
        })
      : await searchOsm({ bbox, osmTags: effectiveAlternatives[0]! });
  })();
  const providersPromise = runProviders({
    bbox,
    sceneTokens,
    antiTokens,
    locationKind,
    osmTagsAlternatives: effectiveAlternatives,
  });

  let osmResult;
  try {
    [osmResult] = await Promise.all([osmPromise]);
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
  // Providers must NEVER throw; if they do, runProviders catches and
  // returns an error stat. We await separately so an OSM throw doesn't
  // cancel them (and vice versa).
  const providerResult = await providersPromise;

  let effectiveBbox = osmResult.effectiveBbox;
  const osmCandidates = osmResult.candidates;
  let finalMatchMode: ExtendedMatchMode = osmResult.matchMode;
  let finalExpansion: 1 | 2 | 4 = osmResult.expansionMultiplier;
  let finalPrimaryTag = osmResult.primaryTag;

  // 3.5) Mapillary detections — additional OSM-flavored candidates from
  // street-level object detections (benches, hydrants, etc.).
  const mapillaryCandidates: OsmCandidate[] = [];
  if (mapillaryClasses && mapillaryClasses.length > 0) {
    const bboxStr = `${effectiveBbox.west},${effectiveBbox.south},${effectiveBbox.east},${effectiveBbox.north}`;
    try {
      const detections = await findDetectionsInBbox({
        bboxStr,
        classes: mapillaryClasses,
        limit: 80,
      });
      for (const d of detections) {
        mapillaryCandidates.push({
          id: `mapillary/${d.id}`,
          type: "node",
          osmId: 0,
          lat: d.lat,
          lng: d.lng,
          tags: { [`mapillary:${d.objectClass}`]: "yes" },
          name: null,
        });
      }
      if (detections.length > 0) {
        logger.info("search-osm Mapillary detections merged", {
          count: detections.length,
        });
      }
    } catch (err) {
      logger.warn("search-osm Mapillary detections threw (non-fatal)", {
        err: String(err),
      });
    }
  }

  // 4) Build the unified raw-candidate pool: OSM + Mapillary + providers.
  const rawCandidates: RawCandidate[] = [
    ...osmCandidates.map(osmCandidateToRaw),
    ...mapillaryCandidates.map(osmCandidateToRaw),
    ...providerResult.candidates,
  ];

  // 4.5) B2 — Google Places text-search fallback. Triggered when EVERY
  // source came back empty (OSM + providers + Mapillary).
  if (
    rawCandidates.length === 0 &&
    googleQuery &&
    googleQuery.trim().length >= 2
  ) {
    logger.info("search-osm all sources empty, attempting Google Places text fallback", {
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
      rawCandidates.push(...places.map(googlePlaceToRaw));
      finalMatchMode = "google_text_fallback";
      finalExpansion = osmResult.expansionMultiplier;
      finalPrimaryTag = null;
      logger.info("search-osm Google Places fallback hit", {
        count: places.length,
      });
    }
  }

  // 5) Merge by 50m proximity, preferring richer sources.
  const merged = mergeCandidates(rawCandidates);

  // 5.5) Drop low-signal OSM-only candidates.
  // OSM has tons of un-named polygons (`tourism=attraction` for an empty
  // park lawn, `building=yes` for a generic shed, ...). When OSM is the
  // ONLY source for a candidate AND there's no `name` tag AND no
  // structural keyword the user actually asked about (abandoned/ruins/
  // material/forest/...), drop it. Cards without curated metadata are
  // close to useless to filmmakers.
  const STRUCTURAL_KEEP_TAGS = new Set([
    "abandoned",
    "ruins",
    "disused",
    "building:material",
    "building:colour",
    "natural",
    "leisure",
    "historic",
    "memorial",
    "tourism",
  ]);
  const filteredMerged = merged.filter((c) => {
    // Multi-source candidates always pass — the OSM signal is augmenting
    // a curated record (Wikidata, Wikipedia, NYC Scenes, etc.).
    if (c.sources.length > 1 || c.primarySource !== "osm") return true;
    // Pure OSM. Keep only when there's a name OR a structural tag.
    if (c.name && c.name.trim().length > 0) return true;
    for (const k of Object.keys(c.tags)) {
      if (STRUCTURAL_KEEP_TAGS.has(k)) return true;
    }
    return false;
  });
  const droppedOsmNoise = merged.length - filteredMerged.length;
  if (droppedOsmNoise > 0) {
    logger.info("search-osm dropped low-signal OSM-only candidates", {
      droppedOsmNoise,
      remaining: filteredMerged.length,
    });
  }

  // 6) Convert merged -> ranked, sort by distance from search center.
  const center = bboxCenter(effectiveBbox);
  const ranked: RankedCandidate[] = filteredMerged
    .map((m) => ({
      id: m.id,
      type: m.primarySource === "osm" ? inferTypeFromId(m.externalIds.osm ?? "") : "node",
      osmId: inferOsmId(m.externalIds),
      lat: m.lat,
      lng: m.lng,
      tags: m.tags,
      name: m.name,
      sources: m.sources,
      primarySource: m.primarySource,
      description: m.description,
      knownImageUrl: m.knownImageUrl,
      associatedFilms: m.associatedFilms,
      sourceUrl: m.sourceUrl,
      distanceMeters: distanceMeters(center, { lat: m.lat, lng: m.lng }),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, MAX_OUTPUT_CANDIDATES);

  // 7) Cache.
  const alternativesTried =
    "alternativesTried" in osmResult
      ? (osmResult as { alternativesTried: number }).alternativesTried
      : 1;
  const alternativesSucceeded =
    "alternativesSucceeded" in osmResult
      ? (osmResult as { alternativesSucceeded: number }).alternativesSucceeded
      : 1;

  const toCache: CachedSearchValue = {
    candidates: ranked,
    effectiveBbox,
    matchMode: finalMatchMode,
    primaryTag: finalPrimaryTag,
    expansionMultiplier: finalExpansion,
    alternativesTried,
    alternativesSucceeded,
    providerStats: providerResult.perProvider,
  };
  await cacheSet(key, "overpass:v3", toCache, 14);

  logger.info("search-osm success", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    osmCount: osmCandidates.length,
    mapillaryCount: mapillaryCandidates.length,
    providerCount: providerResult.candidates.length,
    rawTotal: rawCandidates.length,
    rendered: ranked.length,
    matchMode: finalMatchMode,
    perProvider: providerResult.perProvider,
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
    mirror: osmResult.mirror,
    alternativesTried,
    alternativesSucceeded,
    providerStats: providerResult.perProvider,
  };
  return NextResponse.json(response, { status: 200 });
});
