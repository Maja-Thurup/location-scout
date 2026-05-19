import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { distanceMeters } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { scoreImageMatch, type VisionScore } from "@/lib/claude-vision";
import {
  type ColorWord,
  colorMatches,
  extractDominantColor,
  parseColorFromVisual,
} from "@/lib/color-extract";
import { buildDeepLinks, type DeepLinks } from "@/lib/deep-links";
import {
  type GooglePlace,
  searchNearby,
} from "@/lib/google-places";
import { logger } from "@/lib/logger";
import {
  countDetectionsNearPoint,
  findBestImageNear,
  findDetectionsInBbox,
  type MapillaryDetection,
  type MapillaryImage,
} from "@/lib/mapillary";
import {
  buildThumbUrl,
  probeStreetView,
  probeStreetViewWithHeading,
  type StreetViewProbe,
} from "@/lib/street-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The pipeline does Mapillary + color extraction + vision scoring + Google
 * Place Details + Street View probes for up to 12 candidates. Bump above
 * the Vercel default so we don't get cut off mid-flight on slow networks.
 */
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

const candidateSchema = z.object({
  id: z.string(),
  type: z.enum(["node", "way", "relation"]),
  lat: z.number(),
  lng: z.number(),
  tags: z.record(z.string(), z.string()).default({}),
  name: z.string().nullable().optional(),
});

const requestSchema = z.object({
  candidates: z.array(candidateSchema).min(1).max(60),
  /** When true, includes CLOSED_PERMANENTLY businesses (B1). */
  includeClosed: z.boolean().optional(),
  /** Center for distance ranking (usually the search bbox center). */
  searchCenter: z
    .object({ lat: z.number(), lng: z.number() })
    .optional(),
  /**
   * Scene description used by Claude Vision to score photos. Combines the
   * raw scene text with Claude's distilled visual descriptor.
   */
  sceneDescription: z.string().min(5).max(2000),
  /**
   * Discrete visual checklist tokens (color, material, age, setting, ...).
   * Passed straight through to the vision scorer to make scoring more
   * interpretable and grounded.
   */
  sceneTokens: z.array(z.string().min(1).max(40)).max(30).default([]),
  /** Cap on candidates that get vision-scored. */
  visionScoreLimit: z.number().int().min(0).max(60).default(10),
  /** Minimum vision score to appear in the output (drop low-quality matches). */
  minVisionScore: z.number().int().min(0).max(100).default(30),
  /**
   * Mapillary `object_value` classes that should appear near the candidate.
   * When non-empty, we fetch Mapillary detections in the search bbox once
   * and require each candidate to have at least one matching detection
   * within 50m. Use ONLY when the scene specifically calls for these.
   */
  mapillaryClasses: z.array(z.string()).default([]),
  /** Search bbox so Mapillary detections can be fetched once for the area. */
  searchBbox: z
    .object({
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    })
    .optional(),
});

export type SelectedPhoto = {
  url: string;
  source: "google" | "street_view" | "mapillary";
  capturedAt: string | null;
  attributionText: string;
  attributionHref: string | null;
  visionScore: number | null;
  visionReason: string | null;
};

export type EnrichedLocation = {
  id: string;
  name: string;
  /** Postal address; we no longer surface this in the UI but keep it on the
   *  payload for "Send to..." link labels and possible future use. */
  address: string;
  lat: number;
  lng: number;
  distanceMeters: number | null;

  primaryType: string | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: string | null;
  editorialSummary: string | null;
  googleMapsUri: string | null;
  websiteUri: string | null;

  /** Primary thumbnail (GSV when imagery exists at Mapillary's coord, else Mapillary). */
  photo: SelectedPhoto | null;
  /** Other candidate photos for a future "more views" UI. */
  alternatePhotos: ReadonlyArray<SelectedPhoto>;
  /** Street View probe so the card can offer the interactive panorama. */
  streetView: StreetViewProbe;
  /** Pre-built deep-link bundle. */
  deepLinks: DeepLinks;

  badges: ReadonlyArray<{ key: string; value: string }>;
  enrichmentSparse: boolean;
};

type EnrichResponse = {
  locations: EnrichedLocation[];
  /** True when Claude Vision actually ran on at least one candidate. */
  visionScoringApplied: boolean;
  /** Free-signals filter outcome counts for observability. */
  pipelineStats: {
    inputCandidates: number;
    afterDedupe: number;
    afterColorFilter: number;
    afterDetectionFilter: number;
    afterVisionFilter: number;
    finalRendered: number;
    targetColor: string | null;
    mapillaryDetectionsFound: number;
  };
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_PARALLEL = 4;
const STATIC_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function deriveName(tags: Record<string, string>): string {
  if (tags.name) return tags.name;
  if (tags["name:en"]) return tags["name:en"]!;
  if (tags.brand) return tags.brand!;
  if (tags.operator) return tags.operator!;
  if (tags.building && tags.building !== "yes") {
    return tags.building[0]!.toUpperCase() + tags.building.slice(1).replace(/_/g, " ") + " (OSM)";
  }
  if (tags.amenity) return tags.amenity[0]!.toUpperCase() + tags.amenity.slice(1).replace(/_/g, " ");
  if (tags.natural) return tags.natural[0]!.toUpperCase() + tags.natural.slice(1).replace(/_/g, " ");
  if (tags.landuse) return tags.landuse[0]!.toUpperCase() + tags.landuse.slice(1).replace(/_/g, " ");
  if (tags.historic) return tags.historic[0]!.toUpperCase() + tags.historic.slice(1).replace(/_/g, " ");
  return "OSM feature";
}

const BADGE_KEY_ORDER: ReadonlyArray<string> = [
  "building",
  "amenity",
  "landuse",
  "natural",
  "historic",
  "leisure",
  "shop",
  "tourism",
  "building:material",
  "building:colour",
  "building:levels",
  "abandoned",
  "ruins",
  "surface",
  "roof:shape",
  "roof:material",
];

function buildBadges(
  tags: Record<string, string>,
): ReadonlyArray<{ key: string; value: string }> {
  const badges: Array<{ key: string; value: string }> = [];
  for (const k of BADGE_KEY_ORDER) {
    if (tags[k] && badges.length < 6) {
      badges.push({ key: k, value: tags[k]! });
    }
  }
  return badges;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

async function mapWithConcurrency<T, U>(
  items: ReadonlyArray<T>,
  worker: (item: T, idx: number) => Promise<U>,
  concurrency: number,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let idx = 0;
  async function next(): Promise<void> {
    const i = idx++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]!, i);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

// ---------------------------------------------------------------------------
// Phase 0: Dedupe input candidates
// ---------------------------------------------------------------------------

const DEDUPE_PROXIMITY_METERS = 12;

function dedupeCandidates(
  candidates: ReadonlyArray<z.infer<typeof candidateSchema>>,
): Array<z.infer<typeof candidateSchema>> {
  const out: Array<z.infer<typeof candidateSchema>> = [];
  for (const c of candidates) {
    const dup = out.find(
      (o) => distanceMeters({ lat: o.lat, lng: o.lng }, { lat: c.lat, lng: c.lng }) < DEDUPE_PROXIMITY_METERS,
    );
    if (!dup) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 1: Free signals per candidate (Mapillary photo + color extraction)
// ---------------------------------------------------------------------------

type FreeSignals = {
  candidate: z.infer<typeof candidateSchema>;
  mapillary: MapillaryImage | null;
  observedColor: ColorWord | null;
  /** True if the user asked for a color and this candidate's photo matches. */
  colorOk: boolean;
  /** True if the scene didn't request a color (so color isn't a filter). */
  colorNotRequested: boolean;
};

async function gatherFreeSignals(
  candidate: z.infer<typeof candidateSchema>,
  targetColor: ColorWord | null,
): Promise<FreeSignals> {
  const mapillary = await findBestImageNear(candidate.lat, candidate.lng).catch(() => null);

  let observedColor: ColorWord | null = null;
  let colorOk = false;
  if (targetColor && mapillary) {
    const analysis = await extractDominantColor(mapillary.thumbUrl);
    observedColor = analysis?.word ?? null;
    colorOk = observedColor != null && colorMatches(targetColor, observedColor);
  }

  return {
    candidate,
    mapillary,
    observedColor,
    colorOk,
    colorNotRequested: targetColor == null,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Vision scoring on Mapillary photos (cheap)
// ---------------------------------------------------------------------------

type ScoredCandidate = FreeSignals & {
  visionScore: VisionScore | null;
};

async function visionScoreSurvivors(
  survivors: ReadonlyArray<FreeSignals>,
  sceneDescription: string,
  sceneTokens: ReadonlyArray<string>,
  limit: number,
): Promise<ScoredCandidate[]> {
  // Only the top `limit` get scored to keep costs predictable.
  return mapWithConcurrency(
    survivors,
    async (s, i) => {
      if (i >= limit || !s.mapillary) {
        return { ...s, visionScore: null };
      }
      const score = await scoreImageMatch({
        imageUrl: s.mapillary.thumbUrl,
        sceneDescription,
        sceneTokens,
      });
      return { ...s, visionScore: score };
    },
    MAX_PARALLEL,
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Paid enrichment for survivors (Place Details + GSV)
// ---------------------------------------------------------------------------

/** Cached static enrichment per coord. Not scene-dependent. */
type StaticEnrichment = {
  googlePlace: GooglePlace | null;
  /** GSV probe at the Mapillary photo coord (with that photo's heading). */
  streetView: StreetViewProbe;
};

async function fetchStaticEnrichment(args: {
  candidate: z.infer<typeof candidateSchema>;
  mapillary: MapillaryImage | null;
  includeClosed: boolean;
}): Promise<StaticEnrichment> {
  const { candidate, mapillary, includeClosed } = args;

  const k = cacheKey("google:place-details", {
    kind: "static-v3",
    osmId: candidate.id,
    lat: round(candidate.lat),
    lng: round(candidate.lng),
    mLat: mapillary ? round(mapillary.lat) : null,
    mLng: mapillary ? round(mapillary.lng) : null,
    mHeading:
      mapillary?.compassAngle != null ? Math.round(mapillary.compassAngle) : null,
    closed: includeClosed,
  });

  const cached = await cacheGet<StaticEnrichment>(k);
  if (cached) return cached;

  // Place Details around the OSM coord.
  let googlePlace: GooglePlace | null = null;
  try {
    const places = await searchNearby({
      lat: candidate.lat,
      lng: candidate.lng,
      includeClosedPermanently: includeClosed,
    });
    googlePlace = places[0] ?? null;
  } catch (err) {
    logger.warn("static enrichment searchNearby threw", {
      id: candidate.id,
      err: String(err),
    });
  }

  // Street View probe at the Mapillary capture location, pointing the same
  // direction the matching Mapillary photo was facing. This makes the GSV
  // thumbnail show roughly the same scene as the Mapillary photo, with
  // Google's higher resolution.
  let sv: StreetViewProbe;
  try {
    if (mapillary && mapillary.compassAngle != null) {
      sv = await probeStreetViewWithHeading(
        mapillary.lat,
        mapillary.lng,
        mapillary.compassAngle,
      );
    } else {
      sv = await probeStreetView(candidate.lat, candidate.lng);
    }
  } catch (err) {
    logger.warn("static enrichment probeStreetView threw", {
      id: candidate.id,
      err: String(err),
    });
    sv = { available: false, capturedAt: null, thumbUrl: null, copyright: null };
  }

  const result: StaticEnrichment = { googlePlace, streetView: sv };
  await cacheSet(k, "google:place-details", result, STATIC_TTL_DAYS);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 4: Final dedupe by Google Place ID (handles cases where multiple
// nearby OSM coords resolve to the same business)
// ---------------------------------------------------------------------------

function dedupeByPlaceId<T extends { static: StaticEnrichment }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = item.static.googlePlace?.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Final assembly
// ---------------------------------------------------------------------------

function selectedFromMapillary(
  m: MapillaryImage,
  score: VisionScore | null,
): SelectedPhoto {
  return {
    url: m.thumbUrl,
    source: "mapillary",
    capturedAt: m.capturedAt,
    attributionText: m.attribution,
    attributionHref: m.href,
    visionScore: score?.score ?? null,
    visionReason: score?.reason ?? null,
  };
}

function selectedFromStreetView(
  sv: StreetViewProbe,
  score: VisionScore | null,
): SelectedPhoto | null {
  if (!sv.available || !sv.thumbUrl) return null;
  return {
    url: sv.thumbUrl,
    source: "street_view",
    capturedAt: sv.capturedAt,
    attributionText: sv.copyright ?? "© Google",
    attributionHref: null,
    visionScore: score?.score ?? null,
    visionReason: score?.reason ?? null,
  };
}

function selectedFromGooglePlace(
  place: GooglePlace,
  score: VisionScore | null,
): SelectedPhoto | null {
  if (!place.primaryPhoto) return null;
  const url = `https://places.googleapis.com/v1/${place.primaryPhoto.name}/media?maxWidthPx=800&key=${process.env.GOOGLE_MAPS_API_KEY}`;
  return {
    url,
    source: "google",
    capturedAt: null,
    attributionText: place.primaryPhoto.authorAttributions || "Photo via Google",
    attributionHref: null,
    visionScore: score?.score ?? null,
    visionReason: score?.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

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
    candidates,
    includeClosed = false,
    searchCenter,
    sceneDescription,
    sceneTokens,
    visionScoreLimit,
    minVisionScore,
    mapillaryClasses,
    searchBbox,
  } = parsed.data;

  // -------- Phase 0: dedupe input by proximity --------
  const dedupedCandidates = dedupeCandidates(candidates);

  // -------- Phase 0.5: pull Mapillary detections once per search --------
  // When the scene calls out specific objects (bench, bike rack, etc.),
  // fetching all matching detections for the bbox in one call is far
  // cheaper than per-candidate fetches.
  let detections: MapillaryDetection[] = [];
  if (mapillaryClasses.length > 0 && searchBbox) {
    const bboxStr = `${searchBbox.west},${searchBbox.south},${searchBbox.east},${searchBbox.north}`;
    detections = await findDetectionsInBbox({
      bboxStr,
      classes: mapillaryClasses,
    });
  }

  // -------- Phase 1: free signals (Mapillary + color) --------
  const targetColor = parseColorFromVisual(sceneDescription);
  const freeSignals = await mapWithConcurrency(
    dedupedCandidates,
    (c) => gatherFreeSignals(c, targetColor),
    MAX_PARALLEL,
  );

  // Keep candidates that pass the color filter (or where color isn't a constraint).
  // Candidates with no Mapillary photo are kept since we can't apply the
  // filter; the vision step will de-prioritize them.
  const afterColorFilter = freeSignals.filter(
    (s) => s.colorNotRequested || s.colorOk || !s.mapillary,
  );

  // -------- Phase 1.5: object-class detections (Mapillary) --------
  // When the scene calls out specific objects, drop candidates that have
  // none of them within 50m. Free filter, no API calls per candidate.
  const afterDetectionFilter =
    mapillaryClasses.length > 0
      ? afterColorFilter.filter((s) => {
          const hits = countDetectionsNearPoint(
            detections,
            { lat: s.candidate.lat, lng: s.candidate.lng },
            50,
          );
          return hits > 0;
        })
      : afterColorFilter;

  // -------- Phase 2: vision scoring on Mapillary photos --------
  // Sort by distance so we score the nearest survivors first.
  const distanceSorted = [...afterDetectionFilter].sort((a, b) => {
    const da = searchCenter
      ? distanceMeters(searchCenter, { lat: a.candidate.lat, lng: a.candidate.lng })
      : 0;
    const db = searchCenter
      ? distanceMeters(searchCenter, { lat: b.candidate.lat, lng: b.candidate.lng })
      : 0;
    return da - db;
  });
  const scored = await visionScoreSurvivors(
    distanceSorted,
    sceneDescription,
    sceneTokens,
    visionScoreLimit,
  );

  // Drop candidates whose vision score is below threshold. Keep candidates
  // that weren't scored (no Mapillary photo, or beyond the limit) so we
  // still surface something for sparse areas.
  const afterVisionFilter = scored.filter((s) => {
    if (s.visionScore == null) return true; // unscored, keep
    return s.visionScore.score >= minVisionScore;
  });

  // -------- Phase 3: paid enrichment for survivors --------
  // Cap to 12 to control Place Details spend; the lowest-scoring overflow
  // gets dropped anyway when we re-sort below.
  const survivors = afterVisionFilter.slice(0, 12);

  const enrichments = await mapWithConcurrency(
    survivors,
    async (s) => {
      const stat = await fetchStaticEnrichment({
        candidate: s.candidate,
        mapillary: s.mapillary,
        includeClosed,
      });
      return { ...s, static: stat };
    },
    MAX_PARALLEL,
  );

  // -------- Phase 4: dedupe by Place ID --------
  const finalSet = dedupeByPlaceId(enrichments);

  // -------- Phase 5: assemble cards --------
  const locations: EnrichedLocation[] = finalSet.map((e) => {
    const candidate = e.candidate;
    const place = e.static.googlePlace;
    const sv = e.static.streetView;

    // Pick primary photo: GSV (when available, since it uses Mapillary's
    // coord+heading for a higher-quality version of the matching shot)
    // → Google Place Photo → Mapillary fallback.
    const mapillaryPhoto = e.mapillary
      ? selectedFromMapillary(e.mapillary, e.visionScore)
      : null;
    const streetViewPhoto = selectedFromStreetView(sv, e.visionScore);
    const googlePhoto = place
      ? selectedFromGooglePlace(place, e.visionScore)
      : null;

    // Order: GSV > Google Place Photo > Mapillary. Caller's directive:
    // "if you find perfect coordinates in mapillary, use them to get the
    // GSV tab/thumbnail; if too hard, keep mapillary thumbnail."
    const photo = streetViewPhoto ?? googlePhoto ?? mapillaryPhoto;
    const alternates: SelectedPhoto[] = [];
    for (const p of [streetViewPhoto, googlePhoto, mapillaryPhoto]) {
      if (p && p !== photo) alternates.push(p);
    }

    const lat = place?.lat ?? candidate.lat;
    const lng = place?.lng ?? candidate.lng;

    const name = place?.displayName ?? candidate.name ?? deriveName(candidate.tags);

    const deepLinks = buildDeepLinks({
      lat,
      lng,
      label: name,
      googlePlaceId: place?.id,
    });

    return {
      id: candidate.id,
      name,
      address: place?.formattedAddress ?? "",
      lat,
      lng,
      distanceMeters: searchCenter
        ? distanceMeters(searchCenter, { lat, lng })
        : null,
      primaryType: place?.primaryType ?? null,
      rating: place?.rating ?? null,
      ratingCount: place?.userRatingCount ?? null,
      businessStatus: place?.businessStatus ?? null,
      editorialSummary: place?.editorialSummary ?? null,
      googleMapsUri: place?.googleMapsUri ?? null,
      websiteUri: place?.websiteUri ?? null,
      photo,
      alternatePhotos: alternates,
      streetView: sv,
      deepLinks,
      badges: buildBadges(candidate.tags),
      enrichmentSparse: place === null,
    };
  });

  // Final sort: vision score desc, then distance asc.
  locations.sort((a, b) => {
    const sa = a.photo?.visionScore ?? -1;
    const sb = b.photo?.visionScore ?? -1;
    if (sa !== sb) return sb - sa;
    const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
    const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
    return da - db;
  });

  const visionScoringApplied = scored.some((s) => s.visionScore != null);

  // Build the buildThumbUrl placeholder line so the unused import lint
  // doesn't catch us off guard if we trim usage later. (No-op at runtime.)
  void buildThumbUrl;

  logger.info("enrich-locations done", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    inputCandidates: candidates.length,
    afterDedupe: dedupedCandidates.length,
    afterColorFilter: afterColorFilter.length,
    afterDetectionFilter: afterDetectionFilter.length,
    afterVisionFilter: afterVisionFilter.length,
    finalRendered: locations.length,
    visionScored: visionScoringApplied,
    targetColor,
    mapillaryDetections: detections.length,
  });

  const response: EnrichResponse = {
    locations,
    visionScoringApplied,
    pipelineStats: {
      inputCandidates: candidates.length,
      afterDedupe: dedupedCandidates.length,
      afterColorFilter: afterColorFilter.length,
      afterDetectionFilter: afterDetectionFilter.length,
      afterVisionFilter: afterVisionFilter.length,
      finalRendered: locations.length,
      targetColor,
      mapillaryDetectionsFound: detections.length,
    },
  };
  return NextResponse.json(response, { status: 200 });
});
