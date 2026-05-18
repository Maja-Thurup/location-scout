import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeocodeResult = {
  /** Canonical formatted address Google returned. */
  label: string;
  lat: number;
  lng: number;
  /** Country code (ISO 3166-1 alpha-2) when available. */
  country: string | null;
  /** Bounding box if Google returned one (e.g. for cities/regions). */
  bbox: { south: number; west: number; north: number; east: number } | null;
  /** "viewport" | "rooftop" | "street_address" | etc. */
  locationType: string | null;
};

const googleGeocodeResponseSchema = z.object({
  status: z.string(),
  error_message: z.string().optional(),
  results: z.array(
    z.object({
      formatted_address: z.string(),
      geometry: z.object({
        location: z.object({ lat: z.number(), lng: z.number() }),
        location_type: z.string().optional(),
        viewport: z
          .object({
            northeast: z.object({ lat: z.number(), lng: z.number() }),
            southwest: z.object({ lat: z.number(), lng: z.number() }),
          })
          .optional(),
        bounds: z
          .object({
            northeast: z.object({ lat: z.number(), lng: z.number() }),
            southwest: z.object({ lat: z.number(), lng: z.number() }),
          })
          .optional(),
      }),
      address_components: z
        .array(
          z.object({
            short_name: z.string(),
            long_name: z.string(),
            types: z.array(z.string()),
          }),
        )
        .optional(),
    }),
  ),
});

const GEOCODE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";
const GEOCODE_TIMEOUT_MS = 10_000;
const CACHE_TTL_DAYS = 90;

// ---------------------------------------------------------------------------
// Internal: shape Google's response into our type
// ---------------------------------------------------------------------------

function shapeResult(
  result: z.infer<typeof googleGeocodeResponseSchema>["results"][number],
): GeocodeResult {
  const country =
    result.address_components?.find((c) => c.types.includes("country"))
      ?.short_name ?? null;

  // Prefer "bounds" (full geographic extent) over "viewport" (zoom hint).
  const box = result.geometry.bounds ?? result.geometry.viewport;
  const bbox = box
    ? {
        south: box.southwest.lat,
        west: box.southwest.lng,
        north: box.northeast.lat,
        east: box.northeast.lng,
      }
    : null;

  return {
    label: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    country,
    bbox,
    locationType: result.geometry.location_type ?? null,
  };
}

// ---------------------------------------------------------------------------
// Forward: address/string → coordinates
// ---------------------------------------------------------------------------

export async function forwardGeocode(query: string): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const key = cacheKey("geocode", { kind: "forward", q: trimmed.toLowerCase() });
  const cached = await cacheGet<GeocodeResult | null>(key);
  if (cached !== null) return cached;

  try {
    const url = new URL(GEOCODE_BASE);
    url.searchParams.set("address", trimmed);
    url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("geocode.forward http error", { status: res.status });
      return null;
    }
    const json = await res.json();
    const parsed = googleGeocodeResponseSchema.parse(json);

    if (parsed.status === "ZERO_RESULTS" || parsed.results.length === 0) {
      await cacheSet(key, "geocode", null, CACHE_TTL_DAYS);
      return null;
    }
    if (parsed.status !== "OK") {
      logger.warn("geocode.forward non-ok", {
        status: parsed.status,
        message: parsed.error_message,
      });
      return null;
    }

    const shaped = shapeResult(parsed.results[0]!);
    await cacheSet(key, "geocode", shaped, CACHE_TTL_DAYS);
    return shaped;
  } catch (err) {
    logger.warn("geocode.forward failed", { err: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reverse: coordinates → human-readable label
// ---------------------------------------------------------------------------

export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodeResult | null> {
  // Round to 4 decimal places (~11 m precision) so very-near coordinates
  // share the same cache entry. Cuts down cache fragmentation when the
  // browser geolocation jitters by a few meters.
  const rLat = Math.round(lat * 1e4) / 1e4;
  const rLng = Math.round(lng * 1e4) / 1e4;

  const key = cacheKey("geocode", { kind: "reverse", lat: rLat, lng: rLng });
  const cached = await cacheGet<GeocodeResult | null>(key);
  if (cached !== null) return cached;

  try {
    const url = new URL(GEOCODE_BASE);
    url.searchParams.set("latlng", `${rLat},${rLng}`);
    url.searchParams.set(
      "result_type",
      "locality|administrative_area_level_3|sublocality|neighborhood|postal_code",
    );
    url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("geocode.reverse http error", { status: res.status });
      return null;
    }
    const json = await res.json();
    const parsed = googleGeocodeResponseSchema.parse(json);

    if (parsed.status === "ZERO_RESULTS" || parsed.results.length === 0) {
      await cacheSet(key, "geocode", null, CACHE_TTL_DAYS);
      return null;
    }
    if (parsed.status !== "OK") {
      logger.warn("geocode.reverse non-ok", {
        status: parsed.status,
        message: parsed.error_message,
      });
      return null;
    }

    const shaped = shapeResult(parsed.results[0]!);
    await cacheSet(key, "geocode", shaped, CACHE_TTL_DAYS);
    return shaped;
  } catch (err) {
    logger.warn("geocode.reverse failed", { err: String(err) });
    return null;
  }
}

/**
 * Concise label for "Use my location" UX — strips ZIP / extra trailing parts.
 * Falls back to the full formatted_address if shaping fails.
 */
export function shortLabel(g: GeocodeResult): string {
  // "Brooklyn, NY 11201, USA" -> "Brooklyn, NY"
  const parts = g.label.split(",").map((s) => s.trim());
  if (parts.length >= 2) {
    const stateAndZip = parts[parts.length - 2] ?? "";
    const stateCode = stateAndZip.split(" ")[0] ?? "";
    return `${parts[0]}, ${stateCode}`;
  }
  return g.label;
}
