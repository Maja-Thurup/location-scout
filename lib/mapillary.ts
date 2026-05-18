import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Mapillary Graph API — free crowdsourced street-level photography.
// https://www.mapillary.com/developer/api-documentation/
//
// We use it as the *primary* photo source for film locations because it
// covers gritty/everyday places Google Street View under-indexes
// (alleys, abandoned lots, industrial blocks, rural roads).
//
// License: CC BY-SA 4.0 — we MUST surface attribution wherever a photo
// is displayed (handled by <PhotoAttribution>).
// ---------------------------------------------------------------------------

const MAPILLARY_BASE = "https://graph.mapillary.com";
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
};

const imageSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  thumb_2048_url: z.string().optional(),
  thumb_1024_url: z.string().optional(),
  thumb_256_url: z.string().optional(),
  captured_at: z.union([z.string(), z.number()]).optional(),
  compass_angle: z.number().optional(),
  geometry: z
    .object({
      type: z.literal("Point").optional(),
      coordinates: z.tuple([z.number(), z.number()]),
    })
    .optional(),
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

/**
 * Look up a single best photo near a coordinate. "Best" = the most recent
 * image in the bbox that has a usable thumbnail URL. Returns null when
 * Mapillary has no coverage at that point.
 *
 * Caching key includes the rounded coord so multiple OSM features near the
 * same intersection share one request.
 */
export async function findBestImageNear(
  lat: number,
  lng: number,
  searchRadiusMeters = 90,
): Promise<MapillaryImage | null> {
  const key = cacheKey("mapillary:image", {
    lat: round(lat),
    lng: round(lng),
    r: searchRadiusMeters,
  });
  const cached = await cacheGet<MapillaryImage | null>(key);
  if (cached !== null) return cached;

  const url = new URL(`${MAPILLARY_BASE}/images`);
  url.searchParams.set("access_token", env.MAPILLARY_TOKEN);
  url.searchParams.set("bbox", makeBbox(lat, lng, searchRadiusMeters));
  url.searchParams.set(
    "fields",
    "id,thumb_2048_url,thumb_1024_url,thumb_256_url,captured_at,compass_angle,geometry",
  );
  url.searchParams.set("limit", "10");

  let raw: unknown;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MAPILLARY_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn("mapillary HTTP error", { status: res.status, lat, lng });
      await cacheSet(key, "mapillary:image", null, 7);
      return null;
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("mapillary fetch failed", { err: String(err), lat, lng });
    return null;
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.data || parsed.data.data.length === 0) {
    await cacheSet(key, "mapillary:image", null, 7);
    return null;
  }

  // Sort by captured_at desc and pick the first one with a thumbnail.
  const sorted = [...parsed.data.data].sort((a, b) => {
    const ta = Number(a.captured_at ?? 0);
    const tb = Number(b.captured_at ?? 0);
    return tb - ta;
  });

  const winner = sorted.find((img) => pickThumb(img) !== null);
  if (!winner) {
    await cacheSet(key, "mapillary:image", null, 7);
    return null;
  }

  const thumb = pickThumb(winner)!;
  const coords = winner.geometry?.coordinates;
  const result: MapillaryImage = {
    id: winner.id,
    thumbUrl: thumb,
    capturedAt: normalizeCapturedAt(winner.captured_at),
    compassAngle: winner.compass_angle ?? null,
    lat: coords?.[1] ?? lat,
    lng: coords?.[0] ?? lng,
    attribution: ATTRIBUTION,
    href: `https://www.mapillary.com/app/?focus=photo&pKey=${winner.id}`,
  };

  await cacheSet(key, "mapillary:image", result, 7);
  return result;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
