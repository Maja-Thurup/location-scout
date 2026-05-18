import {
  type GooglePhotoRef,
  buildPhotoUrl,
} from "@/lib/google-places";
import { findBestImageNear, type MapillaryImage } from "@/lib/mapillary";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Photo aggregator
//
// Priority order (cheapest + most permissive first):
//   1. Mapillary near the coordinate (FREE, CC BY-SA)
//   2. Google Place Photo (paid, ~$0.007 per fetch on Pro tier)
//   3. null (caller renders a placeholder)
//
// Wikimedia Commons would slot in as a third tier for landmarks; deferred
// to v3 since it adds complexity for narrow benefit.
// ---------------------------------------------------------------------------

export type PhotoSource = "mapillary" | "google";

export type AggregatedPhoto = {
  url: string;
  source: PhotoSource;
  capturedAt: string | null;
  /** Plain-text attribution line for the badge below the photo. */
  attributionText: string;
  /** Optional clickable href back to the original (required by Mapillary CC BY-SA). */
  attributionHref: string | null;
};

export async function pickBestPhoto(input: {
  lat: number;
  lng: number;
  /** Optional: a Google Place photo we already fetched alongside the place details. */
  googlePhotoRef: GooglePhotoRef | null;
}): Promise<AggregatedPhoto | null> {
  // Tier 1: Mapillary.
  let mapillary: MapillaryImage | null = null;
  try {
    mapillary = await findBestImageNear(input.lat, input.lng);
  } catch (err) {
    logger.warn("mapillary lookup threw", { err: String(err) });
  }

  if (mapillary) {
    return {
      url: mapillary.thumbUrl,
      source: "mapillary",
      capturedAt: mapillary.capturedAt,
      attributionText: mapillary.attribution,
      attributionHref: mapillary.href,
    };
  }

  // Tier 2: Google Place Photo (only when Place Details supplied a photo ref).
  if (input.googlePhotoRef) {
    return {
      url: buildPhotoUrl(input.googlePhotoRef, { maxWidthPx: 800 }),
      source: "google",
      capturedAt: null, // Google doesn't expose photo capture date on this endpoint
      attributionText: input.googlePhotoRef.authorAttributions || "Photo via Google",
      attributionHref: null,
    };
  }

  return null;
}
