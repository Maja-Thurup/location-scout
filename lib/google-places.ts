import { z } from "zod";

import type { Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BusinessStatus =
  | "OPERATIONAL"
  | "CLOSED_TEMPORARILY"
  | "CLOSED_PERMANENTLY"
  | "BUSINESS_STATUS_UNSPECIFIED";

export type GooglePhotoRef = {
  /** "places/<placeId>/photos/<photoRef>" */
  name: string;
  widthPx: number;
  heightPx: number;
  /** Comma-separated HTML attributions Google requires we surface. */
  authorAttributions: string;
};

/** Trimmed Place shape we return; not every field Google exposes. */
export type GooglePlace = {
  id: string;
  displayName: string | null;
  formattedAddress: string | null;
  lat: number;
  lng: number;
  primaryType: string | null;
  types: string[];
  rating: number | null;
  userRatingCount: number | null;
  businessStatus: BusinessStatus | null;
  websiteUri: string | null;
  googleMapsUri: string | null;
  editorialSummary: string | null;
  /** First photo reference, if present. Use buildPhotoUrl() to fetch the bytes. */
  primaryPhoto: GooglePhotoRef | null;
};

// ---------------------------------------------------------------------------
// Field masks (per research § 6).
// We cannot use `*` in production — every field counts toward billing tier.
// ---------------------------------------------------------------------------

const FIELDS_NEARBY_PRO = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.photos",
  "places.editorialSummary",
  "places.websiteUri",
  "places.googleMapsUri",
].join(",");

const FIELDS_TEXT_SEARCH_PRO = FIELDS_NEARBY_PRO; // same set; both are "Pro tier"

// ---------------------------------------------------------------------------
// Endpoint constants
// ---------------------------------------------------------------------------

const PLACES_BASE = "https://places.googleapis.com/v1";
const PLACES_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Response schemas (defensive: real responses sometimes omit fields)
// ---------------------------------------------------------------------------

const photoSchema = z.object({
  name: z.string(),
  widthPx: z.number().optional(),
  heightPx: z.number().optional(),
  authorAttributions: z
    .array(
      z.object({
        displayName: z.string().optional(),
        uri: z.string().optional(),
        photoUri: z.string().optional(),
      }),
    )
    .optional(),
});

const placeSchema = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  businessStatus: z.string().optional(),
  photos: z.array(photoSchema).optional(),
  editorialSummary: z.object({ text: z.string() }).optional(),
  websiteUri: z.string().optional(),
  googleMapsUri: z.string().optional(),
});

const searchResponseSchema = z.object({
  places: z.array(placeSchema).optional(),
});

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function shapeAttribution(
  authors: ReadonlyArray<{ displayName?: string; uri?: string }> = [],
): string {
  if (authors.length === 0) return "Photo via Google";
  return authors
    .map((a) => a.displayName ?? "Google contributor")
    .join(", ");
}

function shapePlace(p: z.infer<typeof placeSchema>): GooglePlace | null {
  if (!p.location) return null; // unusable without coords
  const photo = p.photos?.[0];
  return {
    id: p.id,
    displayName: p.displayName?.text ?? null,
    formattedAddress: p.formattedAddress ?? null,
    lat: p.location.latitude,
    lng: p.location.longitude,
    primaryType: p.primaryType ?? null,
    types: p.types ?? [],
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    businessStatus: (p.businessStatus as BusinessStatus | undefined) ?? null,
    websiteUri: p.websiteUri ?? null,
    googleMapsUri: p.googleMapsUri ?? null,
    editorialSummary: p.editorialSummary?.text ?? null,
    primaryPhoto: photo
      ? {
          name: photo.name,
          widthPx: photo.widthPx ?? 1600,
          heightPx: photo.heightPx ?? 1200,
          authorAttributions: shapeAttribution(photo.authorAttributions),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function callPlaces(
  path: string,
  body: unknown,
  fieldMask: string,
): Promise<unknown> {
  const res = await fetch(`${PLACES_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    logger.warn("places api error", {
      status: res.status,
      preview: errBody.slice(0, 300),
      path,
    });
    throw new Error(`Places API ${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// searchNearby — used to enrich an OSM coord into a named place
// ---------------------------------------------------------------------------

const NEARBY_RADIUS_METERS = 60; // tight; we already know the OSM coord
const NEARBY_RESULT_LIMIT = 5;

export type SearchNearbyInput = {
  lat: number;
  lng: number;
  /** Restrict to certain Google Places types (e.g. ["warehouse"]). Optional. */
  includedTypes?: ReadonlyArray<string>;
  /** Default false. Set true when scene implies abandonment (B1). */
  includeClosedPermanently?: boolean;
};

export async function searchNearby(
  input: SearchNearbyInput,
): Promise<GooglePlace[]> {
  const key = cacheKey("google:place-details", {
    kind: "nearby",
    lat: round(input.lat),
    lng: round(input.lng),
    types: input.includedTypes ? [...input.includedTypes].sort() : null,
    closed: !!input.includeClosedPermanently,
  });
  const cached = await cacheGet<GooglePlace[]>(key);
  if (cached) return cached;

  const body: Record<string, unknown> = {
    locationRestriction: {
      circle: {
        center: { latitude: input.lat, longitude: input.lng },
        radius: NEARBY_RADIUS_METERS,
      },
    },
    maxResultCount: NEARBY_RESULT_LIMIT,
  };
  if (input.includedTypes && input.includedTypes.length > 0) {
    body.includedTypes = [...input.includedTypes];
  }

  let raw: unknown;
  try {
    raw = await callPlaces("/places:searchNearby", body, FIELDS_NEARBY_PRO);
  } catch (err) {
    logger.warn("searchNearby failed", { err: String(err), input });
    return [];
  }

  const parsed = searchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("searchNearby schema mismatch", {
      issue: parsed.error.issues[0]?.message,
    });
    return [];
  }

  let shaped = (parsed.data.places ?? [])
    .map(shapePlace)
    .filter((p): p is GooglePlace => p !== null);

  // Default behavior: drop CLOSED_TEMPORARILY and (unless flagged) CLOSED_PERMANENTLY.
  shaped = shaped.filter((p) => {
    if (p.businessStatus === "CLOSED_TEMPORARILY") return false;
    if (p.businessStatus === "CLOSED_PERMANENTLY" && !input.includeClosedPermanently) {
      return false;
    }
    return true;
  });

  await cacheSet(key, "google:place-details", shaped, 7);
  return shaped;
}

// ---------------------------------------------------------------------------
// searchText — used as a B2 fallback when Overpass is empty
// ---------------------------------------------------------------------------

export type SearchTextInput = {
  textQuery: string;
  bbox?: Bbox;
  /** Optional Google Places "type" filters. */
  includedType?: string;
  includeClosedPermanently?: boolean;
  maxResultCount?: number;
};

export async function searchText(
  input: SearchTextInput,
): Promise<GooglePlace[]> {
  const key = cacheKey("google:place-details", {
    kind: "text",
    q: input.textQuery.toLowerCase().trim(),
    bbox: input.bbox
      ? {
          s: round(input.bbox.south),
          w: round(input.bbox.west),
          n: round(input.bbox.north),
          e: round(input.bbox.east),
        }
      : null,
    type: input.includedType ?? null,
    closed: !!input.includeClosedPermanently,
  });
  const cached = await cacheGet<GooglePlace[]>(key);
  if (cached) return cached;

  const body: Record<string, unknown> = {
    textQuery: input.textQuery,
    maxResultCount: input.maxResultCount ?? 15,
  };
  if (input.bbox) {
    body.locationBias = {
      rectangle: {
        low: { latitude: input.bbox.south, longitude: input.bbox.west },
        high: { latitude: input.bbox.north, longitude: input.bbox.east },
      },
    };
  }
  if (input.includedType) {
    body.includedType = input.includedType;
  }

  let raw: unknown;
  try {
    raw = await callPlaces("/places:searchText", body, FIELDS_TEXT_SEARCH_PRO);
  } catch (err) {
    logger.warn("searchText failed", { err: String(err), q: input.textQuery });
    return [];
  }

  const parsed = searchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("searchText schema mismatch", {
      issue: parsed.error.issues[0]?.message,
    });
    return [];
  }

  let shaped = (parsed.data.places ?? [])
    .map(shapePlace)
    .filter((p): p is GooglePlace => p !== null);

  shaped = shaped.filter((p) => {
    if (p.businessStatus === "CLOSED_TEMPORARILY") return false;
    if (p.businessStatus === "CLOSED_PERMANENTLY" && !input.includeClosedPermanently) {
      return false;
    }
    return true;
  });

  await cacheSet(key, "google:place-details", shaped, 7);
  return shaped;
}

// ---------------------------------------------------------------------------
// Photo URL helper
//
// Google's Place Photo endpoint returns a 302 -> signed URL when called with
// a valid `name` resource path. We can use the redirect URL directly in <img>
// tags — but the redirect URL changes hourly, so we either:
//   a) Use the GET-by-name URL itself (Google handles the redirect)
//   b) Resolve once and cache the redirect target
//
// For v1 we use (a): the GET URL with skipHttpRedirect=false. The browser
// follows the redirect transparently.
// ---------------------------------------------------------------------------

export function buildPhotoUrl(
  photo: GooglePhotoRef,
  opts: { maxWidthPx?: number; maxHeightPx?: number } = {},
): string {
  const maxW = opts.maxWidthPx ?? 800;
  const params = new URLSearchParams({
    key: env.GOOGLE_MAPS_API_KEY,
    maxWidthPx: String(maxW),
  });
  if (opts.maxHeightPx) params.set("maxHeightPx", String(opts.maxHeightPx));
  return `${PLACES_BASE}/${photo.name}/media?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Internal: round coord to 4 decimals (~11m) for stable cache keys
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
