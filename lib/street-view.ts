import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Street View Static API
// https://developers.google.com/maps/documentation/streetview
//
// Two endpoints used here:
//   /streetview              -> the actual JPEG image (no extra cost vs static)
//   /streetview/metadata     -> FREE probe ("OK" / "ZERO_RESULTS") so we
//                               only render the panorama option when imagery
//                               actually exists at the coord.
// ---------------------------------------------------------------------------

const STREET_VIEW_BASE = "https://maps.googleapis.com/maps/api/streetview";
const PROBE_TIMEOUT_MS = 8_000;

const metadataSchema = z.object({
  status: z.string(),
  date: z.string().optional(),
  pano_id: z.string().optional(),
  copyright: z.string().optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
});

export type StreetViewProbe = {
  available: boolean;
  /** Public-domain capture date Google attributes the imagery to (e.g. "2024-08"). */
  capturedAt: string | null;
  /** Static thumbnail URL ready to embed in <img>; null when unavailable. */
  thumbUrl: string | null;
  /** "© 2024 Google" line for attribution UI. */
  copyright: string | null;
};

/**
 * Default thumbnail dimensions. 640x400 keeps card-sized previews under
 * Street View's free-tier per-image cost while still being readable.
 */
const THUMB_W = 640;
const THUMB_H = 400;

/**
 * Probe whether Street View imagery exists at a coord, and produce a
 * thumbnail URL when it does. Cached for 30 days because Street View
 * coverage is stable.
 *
 * Returns `{ available: false, ...nulls }` when:
 *   - Google's metadata says ZERO_RESULTS
 *   - The HTTP call fails (offline / quota)
 *
 * The probe endpoint is FREE per Google's billing; only image fetches cost.
 */
export async function probeStreetView(
  lat: number,
  lng: number,
  searchRadiusMeters = 75,
): Promise<StreetViewProbe> {
  const key = cacheKey("google:place-photo", {
    kind: "streetview-probe",
    lat: round(lat),
    lng: round(lng),
    r: searchRadiusMeters,
  });
  const cached = await cacheGet<StreetViewProbe>(key);
  if (cached) return cached;

  const url = new URL(`${STREET_VIEW_BASE}/metadata`);
  url.searchParams.set("location", `${lat},${lng}`);
  url.searchParams.set("radius", String(searchRadiusMeters));
  url.searchParams.set("source", "outdoor");
  url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);

  let metadata: z.infer<typeof metadataSchema> | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn("street-view metadata HTTP error", { status: res.status });
    } else {
      const json = await res.json();
      const parsed = metadataSchema.safeParse(json);
      if (parsed.success) metadata = parsed.data;
    }
  } catch (err) {
    logger.warn("street-view metadata fetch failed", { err: String(err) });
  }

  const ok = metadata?.status === "OK";
  const probe: StreetViewProbe = {
    available: ok,
    capturedAt: ok ? (metadata?.date ?? null) : null,
    thumbUrl: ok ? buildThumbUrl(lat, lng) : null,
    copyright: ok ? (metadata?.copyright ?? "© Google") : null,
  };

  await cacheSet(key, "google:place-photo", probe, 30);
  return probe;
}

/**
 * Build a Street View Static thumbnail URL. Caller decides whether to
 * actually use it; we never embed it without first probing for availability.
 */
export function buildThumbUrl(
  lat: number,
  lng: number,
  opts: { width?: number; height?: number; fov?: number; heading?: number } = {},
): string {
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    size: `${opts.width ?? THUMB_W}x${opts.height ?? THUMB_H}`,
    fov: String(opts.fov ?? 80),
    source: "outdoor",
    return_error_code: "true",
    key: env.GOOGLE_MAPS_API_KEY,
  });
  if (opts.heading != null) {
    params.set("heading", String(opts.heading));
  }
  return `${STREET_VIEW_BASE}?${params.toString()}`;
}

/**
 * Probe with a custom heading. Returns the Street View metadata + a
 * pre-built thumbnail URL pointing in the requested direction.
 *
 * Used in the M4+ pipeline: when Mapillary has a high-scoring photo at
 * (lat, lng) with a known compass_angle, we ask Google Street View for
 * imagery at the SAME coord pointing the SAME way — usually a
 * higher-quality version of the matching shot.
 */
export async function probeStreetViewWithHeading(
  lat: number,
  lng: number,
  heading: number,
  searchRadiusMeters = 75,
): Promise<StreetViewProbe> {
  const base = await probeStreetView(lat, lng, searchRadiusMeters);
  if (!base.available) return base;
  return {
    ...base,
    thumbUrl: buildThumbUrl(lat, lng, { heading }),
  };
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
