import { z } from "zod";

import type { Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  shouldSkipTiledMapillarySearch,
  splitBboxIntoTiles,
  tileToBboxStr,
} from "@/lib/mapillary/tiles";

// ---------------------------------------------------------------------------
// Mapillary Graph API — free crowdsourced street-level photography.
// https://www.mapillary.com/developer/api-documentation/
//
// We use it as the *primary* photo source for film locations because it
// covers gritty/everyday places Google Street View under-indexes
// (alleys, abandoned lots, industrial blocks, rural roads).
//
// API surface used here:
//   - /images?lat=&lng=&radius=     point search (Apr 2 2026)
//   - /images?bbox=                 area search (formalized ≤ 0.01° square)
//   - /images?fields=quality_score  predicted visual quality (May 18 2026)
//   - /images?is_pano=true          panoramas — the carousel's hero slot
//   - /map_features?bbox=           detected objects (benches, fire hydrants)
//   - /:image_id/detections         per-image segmentation polygons
//   - /image_ids?sequence_id=       sequence playback (ordered images)
//   - tiles.mapillary.com vector tiles  coverage pre-check at zoom 5
//
// License: CC BY-SA 4.0 — we MUST surface attribution wherever a photo
// is displayed (handled by <PhotoAttribution>).
// ---------------------------------------------------------------------------

const MAPILLARY_BASE = "https://graph.mapillary.com";
const MAPILLARY_TILES_BASE = "https://tiles.mapillary.com";
const MAPILLARY_TIMEOUT_MS = 12_000;

export type MapillaryImage = {
  id: string;
  thumbUrl: string;
  /** ISO timestamp of when the photo was captured. */
  capturedAt: string | null;
  /** Compass heading in degrees (0=N, 90=E, 180=S, 270=W). */
  compassAngle: number | null;
  lat: number;
  lng: number;
  /** Public attribution string, mandatory under CC BY-SA. */
  attribution: string;
  /** Direct link back to Mapillary's image page (required by attribution). */
  href: string;
  /**
   * Whether the image is a 360° panorama. When true, the carousel
   * frames it as a hero slot; the embed endpoint treats it as
   * swipeable. Optional for backwards-compat with older entries.
   */
  isPanorama?: boolean;
  /**
   * Predicted visual quality in the range [0, 1]. Mapillary added
   * this field to the entity API in May 2026 — it's a learned proxy
   * for "is this photo well-framed and well-exposed". We sort our
   * candidate pool by quality DESC, then captured_at DESC, so the
   * best-looking photo becomes the primary thumbnail.
   */
  qualityScore?: number | null;
  /** Mapillary sequence id, used for sequence-playback retrieval. */
  sequenceId?: string | null;
};

const imageSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  thumb_2048_url: z.string().optional(),
  thumb_1024_url: z.string().optional(),
  thumb_256_url: z.string().optional(),
  captured_at: z.union([z.string(), z.number()]).optional(),
  compass_angle: z.number().optional(),
  // Apr 2 2026: image radius search uses /images?lat=&lng=&radius=
  // and returns geometry as the primary spatial field. We accept
  // either `geometry` or `computed_geometry` so callers can pick
  // whichever is freshest in cached records.
  geometry: z
    .object({
      type: z.literal("Point").optional(),
      coordinates: z.tuple([z.number(), z.number()]),
    })
    .optional(),
  computed_geometry: z
    .object({
      type: z.literal("Point").optional(),
      coordinates: z.tuple([z.number(), z.number()]),
    })
    .optional(),
  is_pano: z.boolean().optional(),
  // May 18 2026: nullable float in [0, 1].
  quality_score: z.number().nullable().optional(),
  sequence: z.string().optional(),
});

const responseSchema = z.object({
  data: z.array(imageSchema).optional(),
});

const ATTRIBUTION = "© Mapillary contributors · CC BY-SA";

/**
 * Compute a small bbox around a coord. Mapillary expects bbox-style queries
 * (minLng,minLat,maxLng,maxLat). We use ~90 meters in each direction.
 */
function makeBbox(lat: number, lng: number, radiusMeters = 90): string {
  const dLat = radiusMeters / 111_320; // meters per degree of latitude
  const dLng = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat]
    .map((n) => n.toFixed(6))
    .join(",");
}

function pickThumb(img: z.infer<typeof imageSchema>): string | null {
  return img.thumb_2048_url ?? img.thumb_1024_url ?? img.thumb_256_url ?? null;
}

function normalizeCapturedAt(v: string | number | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v).toISOString();
  // Sometimes returned as numeric milliseconds-as-string.
  const asNum = Number(v);
  if (!Number.isNaN(asNum) && v.length > 4) return new Date(asNum).toISOString();
  return v;
}

/** Standard fields tuple — kept identical across all image endpoints. */
const IMAGE_FIELDS = [
  "id",
  "thumb_2048_url",
  "thumb_1024_url",
  "thumb_256_url",
  "captured_at",
  "compass_angle",
  "geometry",
  "computed_geometry",
  "is_pano",
  "quality_score",
  "sequence",
].join(",");

/**
 * Pick the spatial field — Mapillary returns geometry as the original
 * EXIF coord and computed_geometry after their photogrammetry pass.
 * Computed is more accurate (especially in dense urban areas with GPS
 * jitter) so we prefer it when available.
 */
function pickCoords(
  img: z.infer<typeof imageSchema>,
): { lat: number; lng: number } | null {
  const c = img.computed_geometry?.coordinates ?? img.geometry?.coordinates;
  if (!c) return null;
  return { lat: c[1], lng: c[0] };
}

/**
 * Convert a parsed image to our canonical MapillaryImage shape.
 * Returns null when the image lacks a thumbnail or coords (skip).
 */
function toMapillaryImage(
  img: z.infer<typeof imageSchema>,
  fallback: { lat: number; lng: number },
): MapillaryImage | null {
  const thumb = pickThumb(img);
  if (!thumb) return null;
  const coords = pickCoords(img) ?? fallback;
  return {
    id: img.id,
    thumbUrl: thumb,
    capturedAt: normalizeCapturedAt(img.captured_at),
    compassAngle: img.compass_angle ?? null,
    lat: coords.lat,
    lng: coords.lng,
    attribution: ATTRIBUTION,
    href: `https://www.mapillary.com/app/?focus=photo&pKey=${img.id}`,
    isPanorama: img.is_pano ?? false,
    qualityScore: img.quality_score ?? null,
    sequenceId: img.sequence ?? null,
  };
}

/**
 * Compute the great-circle bearing FROM (a) TO (b), in degrees clockwise
 * from north. Used to align a Mapillary photo's compass_angle with the
 * direction the candidate physically lies — we prefer photos that look
 * AT the statue, not photos taken from the statue facing the road.
 */
function bearingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Smallest signed angular delta between two compass headings, returned
 * as an absolute value in [0, 180]. Used to score how closely a photo's
 * compass_angle aligns with the bearing toward the candidate.
 */
function compassDelta(a: number, b: number): number {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
}

/**
 * Score a Mapillary image for "best photo of this candidate":
 *   1. Quality score (Mapillary's predicted visual quality)
 *   2. Compass alignment with the bearing toward the candidate
 *      (photos facing the statue beat photos facing away)
 *   3. Recency (newer ties broken first)
 *
 * Returns a single composite number. Higher is better.
 */
function scoreImage(
  img: MapillaryImage,
  target: { lat: number; lng: number },
): number {
  const quality = img.qualityScore ?? 0.5;
  let alignment = 0.5;
  if (img.compassAngle != null) {
    const wantedBearing = bearingDeg(
      { lat: img.lat, lng: img.lng },
      target,
    );
    const delta = compassDelta(img.compassAngle, wantedBearing);
    // Linear falloff: 0° = 1.0, 90° = 0.5, 180° = 0.0
    alignment = Math.max(0, 1 - delta / 180);
  }
  const recency = img.capturedAt
    ? Math.min(1, Date.parse(img.capturedAt) / Date.now())
    : 0.5;
  // Weights are tunable. Quality and alignment matter most; recency is
  // a tiebreaker because Mapillary's older imagery is often still
  // perfectly usable for film scouting.
  return quality * 0.5 + alignment * 0.35 + recency * 0.15;
}

/**
 * Fetch a pool of images near a coordinate, ranked by composite score
 * (quality × compass alignment × recency). Used as the unified entry
 * point for both single-best and multi-photo lookups.
 *
 * Strategy:
 *   1. Try the new RADIUS endpoint (Apr 2 2026): cleaner spatial
 *      query, "best image" auto-pick on Mapillary's side, max radius
 *      50 m. Default mode for tight candidate-coord lookups.
 *   2. Fall back to the BBOX endpoint when caller wants a wider area
 *      (the radius API caps at 50 m). Bbox area must be ≤ 0.01° square
 *      per the Jan 16 2026 formalization — our 90-meter half-side fits
 *      comfortably.
 *
 * Both modes ALWAYS request `quality_score`, `is_pano`, and `sequence`
 * so downstream callers can filter for panoramas, compute composite
 * rankings, or load a sequence.
 */
async function fetchImagePool(args: {
  lat: number;
  lng: number;
  radiusMeters: number;
  limit: number;
  isPanoOnly?: boolean;
}): Promise<MapillaryImage[]> {
  const url = new URL(`${MAPILLARY_BASE}/images`);
  url.searchParams.set("access_token", env.MAPILLARY_TOKEN);
  url.searchParams.set("fields", IMAGE_FIELDS);
  if (args.radiusMeters <= 50) {
    // RADIUS mode — Apr 2 2026 endpoint. Cannot combine with bbox.
    // Mapillary auto-ranks by proximity + recency + 360° preference.
    url.searchParams.set("lat", String(args.lat));
    url.searchParams.set("lng", String(args.lng));
    url.searchParams.set("radius", String(args.radiusMeters));
    url.searchParams.set("limit", String(args.limit));
  } else {
    // BBOX mode — bigger area, no auto-pick. We re-rank locally.
    url.searchParams.set("bbox", makeBbox(args.lat, args.lng, args.radiusMeters));
    // Caller wants a re-rankable pool — request 4× the final limit.
    url.searchParams.set("limit", String(Math.max(args.limit * 4, 20)));
  }
  if (args.isPanoOnly) url.searchParams.set("is_pano", "true");

  let raw: unknown;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn("mapillary image fetch http error", {
        status: res.status,
        lat: args.lat,
        lng: args.lng,
        radius: args.radiusMeters,
      });
      return [];
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("mapillary image fetch failed", {
      err: String(err),
      lat: args.lat,
      lng: args.lng,
    });
    return [];
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.data) return [];

  const out: MapillaryImage[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data.data) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const m = toMapillaryImage(item, { lat: args.lat, lng: args.lng });
    if (m) out.push(m);
  }
  return out;
}

/**
 * Look up a single best photo near a coordinate. "Best" combines
 * Mapillary's quality_score, compass alignment with the bearing
 * toward the candidate, and recency. Returns null when Mapillary
 * has no coverage.
 *
 * Caching key includes the rounded coord so multiple candidates near
 * the same intersection share one request.
 */
export async function findBestImageNear(
  lat: number,
  lng: number,
  searchRadiusMeters = 50,
): Promise<MapillaryImage | null> {
  const key = cacheKey("mapillary:image", {
    kind: "best-v2-quality-compass",
    lat: round(lat),
    lng: round(lng),
    r: searchRadiusMeters,
  });
  const cached = await cacheGet<MapillaryImage | null>(key);
  if (cached !== null) return cached;

  const pool = await fetchImagePool({
    lat,
    lng,
    radiusMeters: searchRadiusMeters,
    limit: 10,
  });
  if (pool.length === 0) {
    await cacheSet(key, "mapillary:image", null, 7);
    return null;
  }
  const ranked = [...pool].sort(
    (a, b) => scoreImage(b, { lat, lng }) - scoreImage(a, { lat, lng }),
  );
  const winner = ranked[0]!;
  await cacheSet(key, "mapillary:image", winner, 7);
  return winner;
}

/**
 * Look up multiple photos near a coordinate, ranked by composite score
 * (quality × compass alignment × recency). Used by the multi-shot
 * carousel so the strongest photo becomes the primary thumbnail and
 * the rest stack as alternates in the Photos tab.
 */
export async function findImagesNear(args: {
  lat: number;
  lng: number;
  searchRadiusMeters?: number;
  limit?: number;
}): Promise<MapillaryImage[]> {
  const radius = args.searchRadiusMeters ?? 100;
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 12);

  const k = cacheKey("mapillary:image", {
    kind: "many-v2-quality-compass",
    lat: round(args.lat),
    lng: round(args.lng),
    r: radius,
    limit,
  });
  const cached = await cacheGet<MapillaryImage[]>(k);
  if (cached) return cached;

  const pool = await fetchImagePool({
    lat: args.lat,
    lng: args.lng,
    radiusMeters: radius,
    limit,
  });
  const ranked = [...pool]
    .sort(
      (a, b) =>
        scoreImage(b, { lat: args.lat, lng: args.lng }) -
        scoreImage(a, { lat: args.lat, lng: args.lng }),
    )
    .slice(0, limit);
  await cacheSet(k, "mapillary:image", ranked, 7);
  return ranked;
}

/**
 * Look up the single best PANORAMA near a coordinate. 360° images
 * are gold for film scouting because they let the scout see the
 * surroundings without committing to a particular direction. Cached
 * separately from the regular best-image because pano coverage is
 * sparser — many points have a flat-photo but no pano.
 */
export async function findBestPanoNear(
  lat: number,
  lng: number,
  searchRadiusMeters = 50,
): Promise<MapillaryImage | null> {
  const key = cacheKey("mapillary:image", {
    kind: "best-pano-v1",
    lat: round(lat),
    lng: round(lng),
    r: searchRadiusMeters,
  });
  const cached = await cacheGet<MapillaryImage | null>(key);
  if (cached !== null) return cached;

  const pool = await fetchImagePool({
    lat,
    lng,
    radiusMeters: searchRadiusMeters,
    limit: 5,
    isPanoOnly: true,
  });
  if (pool.length === 0) {
    await cacheSet(key, "mapillary:image", null, 7);
    return null;
  }
  const ranked = [...pool].sort(
    (a, b) => scoreImage(b, { lat, lng }) - scoreImage(a, { lat, lng }),
  );
  const winner = ranked[0]!;
  await cacheSet(key, "mapillary:image", winner, 7);
  return winner;
}

/**
 * Sequence-playback: fetch the ordered list of image IDs for a single
 * Mapillary sequence. Used for the "walk through the area" UX. Returns
 * up to `limit` IDs in capture order. Callers can then resolve a few
 * IDs into thumbnails for a filmstrip.
 */
export async function fetchSequenceImageIds(
  sequenceId: string,
  limit = 30,
): Promise<string[]> {
  if (!sequenceId) return [];
  const k = cacheKey("mapillary:image", { kind: "sequence-ids", sequenceId, limit });
  const cached = await cacheGet<string[]>(k);
  if (cached) return cached;

  const url = new URL(`${MAPILLARY_BASE}/image_ids`);
  url.searchParams.set("access_token", env.MAPILLARY_TOKEN);
  url.searchParams.set("sequence_id", sequenceId);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn("mapillary sequence ids http error", { status: res.status });
      return [];
    }
    const raw = await res.json();
    const parsed = z
      .object({ data: z.array(z.object({ id: z.union([z.string(), z.number()]) })) })
      .safeParse(raw);
    if (!parsed.success) return [];
    const out = parsed.data.data.slice(0, limit).map((d) => String(d.id));
    await cacheSet(k, "mapillary:image", out, 14);
    return out;
  } catch (err) {
    logger.warn("mapillary sequence ids fetch failed", { err: String(err) });
    return [];
  }
}

/**
 * Resolve a list of Mapillary image IDs to thumbnails in one
 * round-trip via the multi-entity endpoint. Used by the sequence
 * playback UX so we don't fire one request per image.
 */
export async function fetchImagesByIds(
  ids: ReadonlyArray<string>,
): Promise<MapillaryImage[]> {
  if (ids.length === 0) return [];
  const k = cacheKey("mapillary:image", { kind: "by-ids", ids: [...ids].sort() });
  const cached = await cacheGet<MapillaryImage[]>(k);
  if (cached) return cached;

  const url = new URL(`${MAPILLARY_BASE}`);
  url.searchParams.set("access_token", env.MAPILLARY_TOKEN);
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("fields", IMAGE_FIELDS);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
    if (!res.ok) return [];
    const raw = await res.json();
    // The multi-entity endpoint returns an object keyed by ID, not an
    // array. Re-shape into our standard parser.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: MapillaryImage[] = [];
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (id === "data") continue;
        const parsed = imageSchema.safeParse(value);
        if (!parsed.success) continue;
        const m = toMapillaryImage(parsed.data, { lat: 0, lng: 0 });
        if (m) out.push(m);
      }
      await cacheSet(k, "mapillary:image", out, 14);
      return out;
    }
    return [];
  } catch (err) {
    logger.warn("mapillary fetchImagesByIds failed", { err: String(err) });
    return [];
  }
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Object detections
//
// Mapillary's `/map_features` endpoint returns geometric features detected
// in their imagery — bike racks, benches, traffic signs, fire hydrants, etc.
// Useful when Claude's scene mentions specific objects we can match against.
//
// Note: building/person classes are excluded by Mapillary; for those we
// rely on OSM tags + Claude Vision instead.
// ---------------------------------------------------------------------------

const detectionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  object_value: z.string(),
  object_type: z.string().optional(),
  geometry: z
    .object({
      type: z.literal("Point").optional(),
      coordinates: z.tuple([z.number(), z.number()]),
    })
    .optional(),
});

const detectionsResponseSchema = z.object({
  data: z.array(detectionSchema).optional(),
});

export type MapillaryDetection = {
  id: string;
  /** Object class, e.g. "object--bench", "object--bike-rack", "object--fire-hydrant". */
  objectClass: string;
  lat: number;
  lng: number;
};

/**
 * Find Mapillary feature detections matching the requested classes within
 * a bbox. Cached 14 days because OSM/Mapillary data churns slowly.
 *
 * `classes` should be the Mapillary canonical names like
 * "object--bench", "object--bike-rack", "marking--surface--cobblestone".
 * We pass the list to the Mapillary API verbatim.
 */
async function fetchMapFeaturesOneTile(
  bboxStr: string,
  classes: ReadonlyArray<string>,
  limit: number,
): Promise<MapillaryDetection[]> {
  const url = new URL(`${MAPILLARY_BASE}/map_features`);
  url.searchParams.set("access_token", env.MAPILLARY_TOKEN);
  url.searchParams.set("bbox", bboxStr);
  url.searchParams.set("fields", "id,object_value,object_type,geometry");
  url.searchParams.set("object_values", classes.join(","));
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
  if (!res.ok) {
    logger.warn("mapillary detections http error", { status: res.status, bboxStr });
    return [];
  }
  const raw = await res.json();
  const parsed = detectionsResponseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.data) return [];

  const out: MapillaryDetection[] = [];
  for (const d of parsed.data.data) {
    const coords = d.geometry?.coordinates;
    if (!coords) continue;
    out.push({
      id: d.id,
      objectClass: d.object_value,
      lat: coords[1],
      lng: coords[0],
    });
  }
  return out;
}

const MAPILLARY_TILE_CONCURRENCY = 5;
const MAPILLARY_TILED_SEARCH_BUDGET_MS = 18_000;

export async function findDetectionsInBbox(input: {
  /** Legacy: "minLng,minLat,maxLng,maxLat" */
  bboxStr?: string;
  bbox?: Bbox;
  classes: ReadonlyArray<string>;
  limit?: number;
  maxTiles?: number;
  /** Stop fetching tiles after this many ms (avoids Vercel 504). */
  maxDurationMs?: number;
}): Promise<MapillaryDetection[]> {
  if (input.classes.length === 0) return [];

  let bbox: Bbox | null = input.bbox ?? null;
  if (!bbox && input.bboxStr) {
    const parts = input.bboxStr.split(",").map(Number);
    if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
      bbox = { west: parts[0]!, south: parts[1]!, east: parts[2]!, north: parts[3]! };
    }
  }
  if (!bbox) return [];

  if (shouldSkipTiledMapillarySearch(bbox)) {
    logger.info("mapillary detections skipped — search bbox too large for tiled map_features", {
      classes: input.classes,
    });
    return [];
  }

  const k = cacheKey("mapillary:image", {
    kind: "detections-tiled-v1",
    bbox,
    classes: [...input.classes].sort(),
  });
  const cached = await cacheGet<MapillaryDetection[]>(k);
  if (cached) return cached;

  const tiles = splitBboxIntoTiles(bbox, undefined, input.maxTiles ?? 12);
  const perTileLimit = Math.max(20, Math.floor((input.limit ?? 500) / tiles.length));
  const seen = new Map<string, MapillaryDetection>();
  const budgetMs = input.maxDurationMs ?? MAPILLARY_TILED_SEARCH_BUDGET_MS;
  const t0 = Date.now();

  try {
    for (let i = 0; i < tiles.length; i += MAPILLARY_TILE_CONCURRENCY) {
      if (Date.now() - t0 >= budgetMs) {
        logger.warn("mapillary detections time budget exhausted", {
          tilesDone: i,
          tilesTotal: tiles.length,
          budgetMs,
        });
        break;
      }
      const chunk = tiles.slice(i, i + MAPILLARY_TILE_CONCURRENCY);
      const batches = await Promise.all(
        chunk.map((tile) =>
          fetchMapFeaturesOneTile(tileToBboxStr(tile), input.classes, perTileLimit),
        ),
      );
      for (const batch of batches) {
        for (const d of batch) {
          if (!seen.has(d.id)) seen.set(d.id, d);
        }
      }
    }
  } catch (err) {
    logger.warn("mapillary detections fetch failed", { err: String(err) });
    return [];
  }

  const out = Array.from(seen.values());
  await cacheSet(k, "mapillary:image", out, 14);
  return out;
}

/**
 * Count detections within a small radius of a point. Useful as a free
 * "are there any benches/bike racks near this candidate?" prefilter.
 */
export function countDetectionsNearPoint(
  detections: ReadonlyArray<MapillaryDetection>,
  point: { lat: number; lng: number },
  radiusMeters = 50,
): number {
  const radiusDegLat = radiusMeters / 111_320;
  const radiusDegLng = radiusMeters / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  let count = 0;
  for (const d of detections) {
    if (Math.abs(d.lat - point.lat) > radiusDegLat) continue;
    if (Math.abs(d.lng - point.lng) > radiusDegLng) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-image detections — segmentation polygons within a single photo.
//
// Mapillary returns base64-encoded vector tiles for each detection. The
// raw payload is opaque to the client; we surface the detection class
// names so the carousel can show "this photo contains: bench, bicycle,
// fire hydrant" overlays when the user zooms in.
// ---------------------------------------------------------------------------

const imageDetectionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  value: z.string(),
  geometry: z.string().optional(),
});

export type ImageDetection = {
  id: string;
  /** The class name, e.g. "object--bench", "marking--continuous--solid". */
  objectClass: string;
  /** Base64-encoded mapbox-vector-tile polygon. Decoded client-side when needed. */
  geometryBase64: string | null;
};

/**
 * Fetch all detections within a single Mapillary image. Cached 14 days
 * because the underlying CV pipeline doesn't re-run per upload. Used
 * by the carousel "tap to highlight objects" UX.
 */
export async function fetchImageDetections(
  imageId: string,
): Promise<ImageDetection[]> {
  if (!imageId) return [];
  const k = cacheKey("mapillary:image", { kind: "image-detections", imageId });
  const cached = await cacheGet<ImageDetection[]>(k);
  if (cached) return cached;

  const url = new URL(`${MAPILLARY_BASE}/${imageId}/detections`);
  url.searchParams.set("access_token", env.MAPILLARY_TOKEN);
  url.searchParams.set("fields", "id,value,geometry");

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
    if (!res.ok) {
      await cacheSet(k, "mapillary:image", [], 7);
      return [];
    }
    const raw = await res.json();
    const parsed = z
      .object({ data: z.array(imageDetectionSchema).optional() })
      .safeParse(raw);
    if (!parsed.success || !parsed.data.data) {
      await cacheSet(k, "mapillary:image", [], 7);
      return [];
    }
    const out: ImageDetection[] = parsed.data.data.map((d) => ({
      id: d.id,
      objectClass: d.value,
      geometryBase64: d.geometry ?? null,
    }));
    await cacheSet(k, "mapillary:image", out, 14);
    return out;
  } catch (err) {
    logger.warn("mapillary fetchImageDetections failed", { err: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vector tile coverage pre-check — saves entity-API budget in low-
// coverage areas (rural / wilderness) by checking the public coverage
// tile at a low zoom before firing per-candidate image lookups.
// ---------------------------------------------------------------------------

/**
 * Convert lat/lng to TMS x/y tile coords at the given zoom. Cribbed
 * from the standard slippy-map tile math.
 */
function lngLatToTile(
  lng: number,
  lat: number,
  zoom: number,
): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

/**
 * Check whether Mapillary has ANY coverage at a given coordinate by
 * fetching the low-zoom (z=5) overview vector tile. The tile body is
 * a binary protobuf — but its content-length tells us roughly whether
 * there are any features in this 1°-square area:
 *   - tile body > 1 KB ⇒ has coverage (worth firing entity lookups)
 *   - tile body ~ 0    ⇒ no coverage  (skip, save rate budget)
 *
 * Cached 30 days; coverage maps churn slowly. Returns true on errors
 * so we don't accidentally suppress good candidates.
 */
export async function hasCoverageAt(
  lat: number,
  lng: number,
): Promise<boolean> {
  const z = 5;
  const { x, y } = lngLatToTile(lng, lat, z);
  const k = cacheKey("mapillary:coverage", { z, x, y });
  const cached = await cacheGet<boolean>(k);
  if (cached !== null) return cached;

  const url = `${MAPILLARY_TILES_BASE}/maps/vtp/mly1_public/2/${z}/${x}/${y}?access_token=${encodeURIComponent(
    env.MAPILLARY_TOKEN,
  )}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
    if (!res.ok) {
      // 404 from the tile server == no coverage at all in this area.
      await cacheSet(k, "mapillary:coverage", res.status === 404 ? false : true, 30);
      return res.status === 404 ? false : true;
    }
    const buf = await res.arrayBuffer();
    const has = buf.byteLength > 1024;
    await cacheSet(k, "mapillary:coverage", has, 30);
    return has;
  } catch (err) {
    logger.warn("mapillary tile coverage check failed", { err: String(err) });
    return true;
  }
}
