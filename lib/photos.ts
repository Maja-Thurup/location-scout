import {
  type GooglePhotoRef,
  buildPhotoUrl,
} from "@/lib/google-places";
import { findBestImageNear, type MapillaryImage } from "@/lib/mapillary";
import type { StreetViewProbe } from "@/lib/street-view";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Photo source aggregator
//
// Returns one candidate photo per source (Google / Street View / Mapillary).
// The caller (the enrich endpoint) vision-scores all of them and picks the
// highest-scored one as the card's primary thumbnail.
//
// Source priority (used only as fallback when all vision-scoring fails):
//   1. Google Place Photo  (uploaded by Google users — usually building-facing)
//   2. Street View Static  (Google's car captured imagery from the road)
//   3. Mapillary           (crowdsourced, often gritty street angles)
//
// Mapillary is intentionally last because user feedback found its photos
// often show the road or a generic street scene rather than the building.
// We still query it for places Google has no coverage of.
// ---------------------------------------------------------------------------

export type PhotoSource = "google" | "street_view" | "mapillary";

export type PhotoCandidate = {
  source: PhotoSource;
  url: string;
  capturedAt: string | null;
  attributionText: string;
  attributionHref: string | null;
};

export type GatherPhotosInput = {
  lat: number;
  lng: number;
  /** First Google Place photo (already returned by Place Details). */
  googlePhoto: GooglePhotoRef | null;
  /** Street View probe result (already executed). */
  streetView: StreetViewProbe;
  /** Whether to also fetch Mapillary (skip when Google sources are guaranteed). */
  includeMapillary?: boolean;
};

export async function gatherPhotoCandidates(
  input: GatherPhotosInput,
): Promise<PhotoCandidate[]> {
  const out: PhotoCandidate[] = [];

  if (input.googlePhoto) {
    out.push({
      source: "google",
      url: buildPhotoUrl(input.googlePhoto, { maxWidthPx: 800 }),
      capturedAt: null,
      attributionText: input.googlePhoto.authorAttributions || "Photo via Google",
      attributionHref: null,
    });
  }

  if (input.streetView.available && input.streetView.thumbUrl) {
    out.push({
      source: "street_view",
      url: input.streetView.thumbUrl,
      capturedAt: input.streetView.capturedAt,
      attributionText: input.streetView.copyright ?? "© Google",
      attributionHref: null,
    });
  }

  if (input.includeMapillary !== false) {
    let mapillary: MapillaryImage | null = null;
    try {
      mapillary = await findBestImageNear(input.lat, input.lng);
    } catch (err) {
      logger.warn("photos: mapillary lookup threw", { err: String(err) });
    }
    if (mapillary) {
      out.push({
        source: "mapillary",
        url: mapillary.thumbUrl,
        capturedAt: mapillary.capturedAt,
        attributionText: mapillary.attribution,
        attributionHref: mapillary.href,
      });
    }
  }

  return out;
}

/** Pick the highest-priority candidate as a fallback when vision scoring fails. */
export function fallbackPickByPriority(
  candidates: ReadonlyArray<PhotoCandidate>,
): PhotoCandidate | null {
  // Already in priority order from gatherPhotoCandidates; just take the first.
  return candidates[0] ?? null;
}
