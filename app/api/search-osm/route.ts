import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { type Bbox, bboxFromRadius, bboxCenter, clampBbox, isReasonableBbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { forwardGeocode } from "@/lib/geocode";
import { logger } from "@/lib/logger";
import { type OsmCandidate, searchOsm } from "@/lib/overpass";

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

type SearchOsmResponse = {
  bbox: Bbox;
  center: { lat: number; lng: number };
  candidates: OsmCandidate[];
  cached: boolean;
  /** Where the bbox came from: forward-geocoded location, custom radius, or supplied bbox. */
  bboxSource: "geocoded_city" | "geocoded_radius" | "supplied";
  /** Mirror that served the live query (null on cache hit). */
  mirror: string | null;
};

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
  const { osmTags, location, radiusMiles, bbox: suppliedBbox } = parsed.data;

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
  const key = cacheKey("overpass", { bbox, osmTags });
  const cached = await cacheGet<{ candidates: OsmCandidate[] }>(key);
  if (cached) {
    logger.info("search-osm cache hit", {
      userId: req.dbUserId,
      ms: Date.now() - t0,
      candidateCount: cached.candidates.length,
    });
    const response: SearchOsmResponse = {
      bbox,
      center: bboxCenter(bbox),
      candidates: cached.candidates,
      cached: true,
      bboxSource,
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

  // 4) Cache.
  await cacheSet(
    key,
    "overpass",
    { candidates: result.candidates },
    14,
  );

  logger.info("search-osm success", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    candidateCount: result.candidates.length,
    rawCount: result.rawCount,
    mirror: result.mirror,
  });

  const response: SearchOsmResponse = {
    bbox,
    center: bboxCenter(bbox),
    candidates: result.candidates,
    cached: false,
    bboxSource,
    mirror: result.mirror,
  };
  return NextResponse.json(response, { status: 200 });
});
