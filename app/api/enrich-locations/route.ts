import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { distanceMeters } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { scoreBestPhotoMatch, type VisionScore } from "@/lib/claude-vision";
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
  findImagesNear,
  type MapillaryDetection,
  type MapillaryImage,
} from "@/lib/mapillary";
import { runFilmHistoryProviders } from "@/lib/providers/registry";
import type { AssociatedFilm, RawCandidate } from "@/lib/providers/types";
import {
  buildThumbUrl,
  probeStreetView,
  probeStreetViewWithHeading,
  type StreetViewProbe,
} from "@/lib/street-view";
import {
  findMovieByImdb,
  findMovieByWikidata,
  searchMovieByTitle,
  type TmdbMovie,
} from "@/lib/tmdb";

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

const providerNameSchema = z.enum([
  "osm",
  "wikidata-landmark",
  "wikidata-filming-location",
  "wikipedia-geosearch",
  "nyc-scenes-from-the-city",
  "sf-film-locations",
]);

const associatedFilmSchema = z.object({
  wikidataQid: z.string().nullable(),
  title: z.string(),
  year: z.number().nullable(),
  imdbId: z.string().nullable(),
});

const candidateSchema = z.object({
  id: z.string(),
  type: z.enum(["node", "way", "relation"]),
  lat: z.number(),
  lng: z.number(),
  tags: z.record(z.string(), z.string()).default({}),
  name: z.string().nullable().optional(),
  // Phase 2a: provider metadata (all optional for backwards compat).
  sources: z.array(providerNameSchema).optional().default([]),
  primarySource: providerNameSchema.optional(),
  description: z.string().nullable().optional(),
  knownImageUrl: z.string().nullable().optional(),
  associatedFilms: z.array(associatedFilmSchema).optional().default([]),
  sourceUrl: z.string().nullable().optional(),
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
   * The user's RAW scene text (no Claude embellishment). Used for the
   * color filter so background-color phrases Claude might write into the
   * `visual` field ("framed by green space") don't trigger a subject
   * color filter. Falls back to `sceneDescription` when not provided
   * (backwards compat with older clients).
   */
  sceneText: z.string().min(1).max(20_000).optional(),
  /**
   * Discrete visual checklist tokens (color, material, age, setting, ...).
   * Passed straight through to the vision scorer to make scoring more
   * interpretable and grounded.
   */
  sceneTokens: z.array(z.string().min(1).max(40)).max(30).default([]),
  /**
   * Negative tokens — things that, if visible, kill the score. The vision
   * rubric treats these as fatal (cap at 20) when one dominates the frame.
   */
  antiTokens: z.array(z.string().min(1).max(40)).max(20).default([]),
  /** Cap on candidates that get vision-scored. */
  visionScoreLimit: z.number().int().min(0).max(60).default(10),
  /**
   * How many photos to multi-shot per candidate. We score the closest
   * Mapillary thumb plus N-1 nearby Mapillary thumbs at varying angles,
   * then keep the best-scoring photo as the candidate's thumbnail. This
   * solves the "OSM centroid faces the wrong way" problem where the
   * actual subject is across the street from the closest panorama.
   */
  photosPerCandidate: z.number().int().min(1).max(6).default(3),
  /** Minimum vision score to appear in the output (drop low-quality matches). */
  minVisionScore: z.number().int().min(0).max(100).default(50),
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
  /** Mirrors `PhotoSource` from contracts.ts. "wikimedia" covers Wikidata + Wikipedia + Commons curated images. */
  source: "google" | "street_view" | "mapillary" | "wikimedia";
  capturedAt: string | null;
  attributionText: string;
  attributionHref: string | null;
  visionScore: number | null;
  visionReason: string | null;
};

/**
 * Surfaced film with TMDb enrichment when available. Title is always
 * present (from the source provider). posterUrl and tmdbUrl are filled
 * by the TMDb enricher when a match is found.
 */
export type SurfacedFilm = {
  title: string;
  year: number | null;
  posterUrl: string | null;
  tmdbId: number | null;
  tmdbUrl: string | null;
  /** Wikidata Q-id of the film, when known. */
  wikidataQid: string | null;
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

  // ---- Phase 2a additions ----
  /** Providers that contributed this candidate (for source pills in UI). */
  sources: ReadonlyArray<string>;
  /** Highest-priority source — drives the "primary" pill style. */
  primarySource: string | null;
  /** Wikidata description / NYC fun-fact / Wikipedia summary, when present. */
  description: string | null;
  /** Source URL for the "Open" link (Wikipedia article, NYC dataset row, ...). */
  sourceUrl: string | null;
  /** Films associated with this location (after TMDb poster enrichment). */
  films: ReadonlyArray<SurfacedFilm>;
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
    /** After dropping cards that have no photo from any source. */
    afterPhotoFilter: number;
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
  /** Closest Mapillary photo (legacy, still used for color extraction). */
  mapillary: MapillaryImage | null;
  /** Up to N additional nearby Mapillary photos for multi-shot scoring. */
  mapillaryAlternates: ReadonlyArray<MapillaryImage>;
  observedColor: ColorWord | null;
  /** True if the user asked for a color and this candidate's photo matches. */
  colorOk: boolean;
  /** True if the scene didn't request a color (so color isn't a filter). */
  colorNotRequested: boolean;
};

async function gatherFreeSignals(
  candidate: z.infer<typeof candidateSchema>,
  targetColor: ColorWord | null,
  altLimit: number,
): Promise<FreeSignals> {
  // Pull both the closest single image (legacy semantics for color check)
  // and a small pool of nearby alternates for multi-shot vision scoring.
  // Both are free (Mapillary tokens are unlimited at our scale) but we
  // cache aggressively.
  const [closest, alternates] = await Promise.all([
    findBestImageNear(candidate.lat, candidate.lng).catch(() => null),
    altLimit > 1
      ? findImagesNear({
          lat: candidate.lat,
          lng: candidate.lng,
          searchRadiusMeters: 120,
          limit: Math.max(altLimit, 2),
        }).catch(() => [] as MapillaryImage[])
      : Promise.resolve([] as MapillaryImage[]),
  ]);

  // Build a deduped list with the closest first, then alternates by recency.
  const seen = new Set<string>();
  const ordered: MapillaryImage[] = [];
  if (closest) {
    ordered.push(closest);
    seen.add(closest.id);
  }
  for (const img of alternates) {
    if (seen.has(img.id)) continue;
    ordered.push(img);
    seen.add(img.id);
    if (ordered.length >= altLimit) break;
  }

  // Use the very first image (closest) for color extraction so the color
  // signal stays cheap and stable across runs.
  let observedColor: ColorWord | null = null;
  let colorOk = false;
  if (targetColor && ordered.length > 0) {
    const analysis = await extractDominantColor(ordered[0]!.thumbUrl);
    observedColor = analysis?.word ?? null;
    colorOk = observedColor != null && colorMatches(targetColor, observedColor);
  }

  return {
    candidate,
    mapillary: closest,
    mapillaryAlternates: ordered.slice(1),
    observedColor,
    colorOk,
    colorNotRequested: targetColor == null,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Multi-shot vision scoring on candidate Mapillary photos
//
// For each candidate, we score up to `photosPerCandidate` nearby Mapillary
// thumbnails and keep the BEST-scoring photo as the canonical thumbnail.
// This addresses the "OSM centroid faces the wrong way" problem: when the
// actual subject is across the street from the closest panorama, one of
// the alternate photos usually frames it correctly.
// ---------------------------------------------------------------------------

type PhotoPoolEntry =
  | { kind: "mapillary"; url: string; mapillary: MapillaryImage }
  | { kind: "known"; url: string };

type ScoredCandidate = FreeSignals & {
  /** Best score across the multi-shot pool, or null if scoring failed. */
  visionScore: VisionScore | null;
  /** Pool entry that produced the best score (Mapillary photo OR provider's curated image). */
  bestPhoto: PhotoPoolEntry | null;
};

async function visionScoreSurvivors(
  survivors: ReadonlyArray<FreeSignals>,
  sceneDescription: string,
  sceneTokens: ReadonlyArray<string>,
  antiTokens: ReadonlyArray<string>,
  limit: number,
): Promise<ScoredCandidate[]> {
  // Only the top `limit` candidates get vision-scored to control cost.
  return mapWithConcurrency(
    survivors,
    async (s, i) => {
      if (i >= limit) {
        return { ...s, visionScore: null, bestPhoto: null };
      }

      // Pool of photos: Mapillary closest + alternates + provider's
      // curated `knownImageUrl` (Wikidata/Wikipedia/Wikimedia Commons).
      // Curated images are FREE and often dramatically better than
      // street-level Mapillary thumbs at the centroid.
      const pool: PhotoPoolEntry[] = [];
      if (s.mapillary) {
        pool.push({ kind: "mapillary", url: s.mapillary.thumbUrl, mapillary: s.mapillary });
      }
      for (const alt of s.mapillaryAlternates) {
        if (!pool.some((p) => p.kind === "mapillary" && p.mapillary.id === alt.id)) {
          pool.push({ kind: "mapillary", url: alt.thumbUrl, mapillary: alt });
        }
      }
      const known = s.candidate.knownImageUrl;
      if (known) {
        pool.push({ kind: "known", url: known });
      }
      if (pool.length === 0) {
        return { ...s, visionScore: null, bestPhoto: null };
      }

      const best = await scoreBestPhotoMatch({
        imageUrls: pool.map((p) => p.url),
        sceneDescription,
        sceneTokens,
        antiTokens,
      });

      if (!best) {
        return { ...s, visionScore: null, bestPhoto: null };
      }

      return {
        ...s,
        visionScore: best.score,
        bestPhoto: pool[best.sourceIndex] ?? null,
      };
    },
    MAX_PARALLEL,
  );
}

/** Pick the Mapillary record we should hand off to GSV (for compass alignment). */
function mapillaryForGsvHandoff(s: ScoredCandidate): MapillaryImage | null {
  if (s.bestPhoto?.kind === "mapillary") return s.bestPhoto.mapillary;
  return s.mapillary;
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

/**
 * Build a SelectedPhoto for a curated provider image (Wikidata /
 * Wikipedia / Wikimedia Commons). Attribution defaults to CC BY-SA
 * pointing at the source URL the provider supplied.
 */
function selectedFromKnown(args: {
  url: string;
  attributionText?: string | null;
  attributionHref: string | null;
  score: VisionScore | null;
}): SelectedPhoto {
  return {
    url: args.url,
    source: "wikimedia",
    capturedAt: null,
    attributionText: args.attributionText ?? "Wikimedia Commons \u00b7 CC BY-SA",
    attributionHref: args.attributionHref,
    visionScore: args.score?.score ?? null,
    visionReason: args.score?.reason ?? null,
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
    sceneText,
    sceneTokens,
    antiTokens,
    visionScoreLimit,
    minVisionScore,
    photosPerCandidate,
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
  // Use the user's RAW scene text for color extraction so Claude's
  // background-color phrasing ("framed by green space") doesn't trigger
  // a subject color filter. Falls back to the combined description for
  // backwards compat.
  const targetColor = parseColorFromVisual(sceneText ?? sceneDescription);
  const freeSignals = await mapWithConcurrency(
    dedupedCandidates,
    (c) => gatherFreeSignals(c, targetColor, photosPerCandidate),
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
    antiTokens,
    visionScoreLimit,
  );

  // Drop candidates whose vision score is below threshold. Strict mode
  // (the user's stated preference: better to show fewer high-confidence
  // matches than many marginal ones). When nothing passes, we degrade
  // gracefully rather than returning zero cards: keep the top-6 BY
  // SCORE even if all scored below threshold, plus some unscored
  // candidates as best-effort. Returning empty pages is the worst UX.
  const passedThreshold = scored.filter(
    (s) => s.visionScore != null && s.visionScore.score >= minVisionScore,
  );
  let afterVisionFilter: typeof scored;
  if (passedThreshold.length > 0) {
    afterVisionFilter = passedThreshold;
  } else {
    // Soft fallback: top-6 by vision score (best-of-the-marginals) +
    // up to 3 unscored candidates so sparse-OSM rural areas still
    // surface something.
    const topMarginal = scored
      .filter((s): s is typeof s & { visionScore: NonNullable<typeof s.visionScore> } =>
        s.visionScore != null,
      )
      .sort((a, b) => b.visionScore.score - a.visionScore.score)
      .slice(0, 6);
    const unscored = scored.filter((s) => s.visionScore == null).slice(0, 3);
    afterVisionFilter = [...topMarginal, ...unscored];
    logger.info("enrich-locations: vision soft-fallback (no candidates passed threshold)", {
      threshold: minVisionScore,
      scoredCount: scored.length,
      bestScore: topMarginal[0]?.visionScore.score ?? null,
      kept: afterVisionFilter.length,
    });
  }

  // -------- Phase 3: paid enrichment for survivors --------
  // Cap to 12 to control Place Details spend; the lowest-scoring overflow
  // gets dropped anyway when we re-sort below.
  const survivors = afterVisionFilter.slice(0, 12);

  const enrichments = await mapWithConcurrency(
    survivors,
    async (s) => {
      // Use the multi-shot WINNING photo for the Street View handoff so
      // the GSV thumbnail looks at the same subject the vision model
      // actually rated highly. When the winner was a curated provider
      // image (Wikipedia/Wikidata), fall back to the closest Mapillary
      // panorama for GSV alignment — still better than nothing.
      const photoForHandoff = mapillaryForGsvHandoff(s);
      const stat = await fetchStaticEnrichment({
        candidate: s.candidate,
        mapillary: photoForHandoff,
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

    // Build candidate photos. The multi-shot winner is our canonical
    // primary thumbnail. Other sources go in alternates.
    const winnerPhoto: SelectedPhoto | null =
      e.bestPhoto?.kind === "mapillary"
        ? selectedFromMapillary(e.bestPhoto.mapillary, e.visionScore)
        : e.bestPhoto?.kind === "known"
          ? selectedFromKnown({
              url: e.bestPhoto.url,
              attributionText: null,
              attributionHref: candidate.sourceUrl ?? null,
              score: e.visionScore,
            })
          : e.mapillary
            ? selectedFromMapillary(e.mapillary, e.visionScore)
            : null;

    const streetViewPhoto = selectedFromStreetView(sv, e.visionScore);
    const googlePhoto = place
      ? selectedFromGooglePlace(place, e.visionScore)
      : null;

    // Photo priority: multi-shot WINNER first (already vision-confirmed),
    // then Google Place Photo / GSV / closest-Mapillary as alternates so
    // a "swap photo" UI in the future can offer them.
    const photo = winnerPhoto ?? streetViewPhoto ?? googlePhoto ?? null;
    const alternates: SelectedPhoto[] = [];
    for (const p of [streetViewPhoto, googlePhoto]) {
      if (p && p !== photo) alternates.push(p);
    }

    // ALWAYS use the candidate's original coords for user-facing links
    // and the Street View modal. The matched Google Place's coords often
    // point at a business pin INSIDE the building (e.g. a deli inside a
    // historic facade), so opening Street View at those coords lands
    // the user inside the deli — not what we want.
    //
    // The Google Place is still useful for METADATA (name, rating,
    // editorial summary, photos) — we just don't trust its coords for
    // navigation.
    const lat = candidate.lat;
    const lng = candidate.lng;

    // Display-name priority: provider-supplied name (NYC scene title,
    // Wikidata label, Wikipedia article title) > Google Place name >
    // OSM-derived fallback. Provider names are far more human-friendly.
    const providerName = candidate.name ?? null;
    const name = providerName ?? place?.displayName ?? deriveName(candidate.tags);

    // Don't pass `googlePlaceId` to the deep-link builder either: the
    // Google Maps "see this place" link would also resolve to the
    // wrong business pin. Using lat,lng query keeps the user on the
    // exact coord we surfaced.
    const deepLinks = buildDeepLinks({
      lat,
      lng,
      label: name,
    });

    // Films from the source provider — TMDb posters get filled in below.
    const films: SurfacedFilm[] = (candidate.associatedFilms ?? []).map((f) => ({
      title: f.title,
      year: f.year,
      posterUrl: null,
      tmdbId: null,
      tmdbUrl: null,
      wikidataQid: f.wikidataQid,
    }));

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
      // Phase 2a metadata
      sources: candidate.sources ?? [],
      primarySource: candidate.primarySource ?? null,
      description: candidate.description ?? null,
      sourceUrl: candidate.sourceUrl ?? null,
      films,
    };
  });

  // Drop cards with no photo from any source — we now treat "NO PHOTO
  // FOUND" as "candidate not viable" rather than rendering an empty card.
  // Phase 1 quality bar: every card must show something the user can
  // actually look at.
  const withPhoto = locations.filter((loc) => loc.photo !== null);

  // -------- Phase 5.5: film-history POST-CARD enrichment --------
  // Films should NEVER drive search ranking — they're metadata on a card,
  // not a reason for a card to exist. We run film-history providers
  // (Wikidata P915, NYC Scenes from the City, SF Films) here, AFTER the
  // search-osm pipeline has already chosen the cards based on
  // content-only signals (Wikidata landmarks / Wikipedia / OSM).
  // Each card is then matched against film-history coords within 50 m
  // and any associated films are merged into the card's `films` array.
  if (withPhoto.length > 0 && searchBbox) {
    const filmHistoryRun = await runFilmHistoryProviders({
      bbox: searchBbox,
      sceneTokens: [],
      antiTokens: [],
      locationKind: null,
      osmTagsAlternatives: [],
    }).catch(() => null);

    if (filmHistoryRun && filmHistoryRun.candidates.length > 0) {
      const filmCandidates: ReadonlyArray<RawCandidate> = filmHistoryRun.candidates;
      let attachedTotal = 0;
      for (const loc of withPhoto) {
        const matches = filmCandidates.filter(
          (fc) =>
            distanceMeters(
              { lat: fc.lat, lng: fc.lng },
              { lat: loc.lat, lng: loc.lng },
            ) < 50,
        );
        if (matches.length === 0) continue;
        const additionalFilms: AssociatedFilm[] = matches.flatMap(
          (m) => m.associatedFilms,
        );
        // Dedupe by Wikidata Q-id when present, else by title+year.
        const merged = [...loc.films];
        for (const f of additionalFilms) {
          const dup = merged.find((x) =>
            f.wikidataQid && x.wikidataQid
              ? x.wikidataQid === f.wikidataQid
              : x.title.toLowerCase() === f.title.toLowerCase() && x.year === f.year,
          );
          if (!dup) {
            merged.push({
              title: f.title,
              year: f.year,
              posterUrl: null,
              tmdbId: null,
              tmdbUrl: null,
              wikidataQid: f.wikidataQid,
            });
          }
        }
        if (merged.length !== loc.films.length) {
          (loc as { films: ReadonlyArray<SurfacedFilm> }).films = merged;
          attachedTotal += merged.length - loc.films.length;
        }
      }
      logger.info("enrich-locations film-history attached", {
        cards: withPhoto.length,
        candidatesScanned: filmCandidates.length,
        filmsAttached: attachedTotal,
      });
    }
  }

  // -------- Phase 6: TMDb film enrichment --------
  // For each card with associated films, look up TMDb metadata (poster,
  // year, popularity) and attach it. Resolution order per film:
  //   1. Wikidata Q-id  ->  /find?external_source=wikidata_id
  //   2. IMDb tt-id     ->  /find?external_source=imdb_id
  //   3. Title + year   ->  /search/movie
  // All results cached for 30 days. Cap to top 5 films per card to
  // control TMDb call count for movie-heavy NYC blocks.
  const TMDB_FILMS_PER_CARD = 5;
  await Promise.all(
    withPhoto.map(async (loc) => {
      const filmsToResolve = loc.films.slice(0, TMDB_FILMS_PER_CARD);
      if (filmsToResolve.length === 0) return;

      const enriched = await Promise.all(
        filmsToResolve.map(async (f): Promise<SurfacedFilm> => {
          let tmdb: TmdbMovie | null = null;
          if (f.wikidataQid) {
            tmdb = await findMovieByWikidata(f.wikidataQid);
          }
          if (!tmdb && f.year != null) {
            tmdb = await searchMovieByTitle(f.title, f.year);
          }
          if (!tmdb) {
            tmdb = await searchMovieByTitle(f.title, null);
          }
          // Last resort: if the source had an IMDb id but no Wikidata Q-id,
          // try TMDb's /find by IMDb id.
          // (We don't currently store IMDb ids on SurfacedFilm — but the
          // candidate's associatedFilms may have them. Skipping for now to
          // keep this loop simple; both findMovieBy* functions are cached.)
          void findMovieByImdb;

          if (!tmdb) return f;
          return {
            ...f,
            posterUrl: tmdb.posterUrl,
            tmdbId: tmdb.tmdbId,
            tmdbUrl: tmdb.tmdbUrl,
            // Prefer the TMDb-canonical title over the source's title
            // (handles e.g. "Goodfellas" vs "GoodFellas" inconsistencies).
            title: tmdb.title || f.title,
            year: f.year ?? tmdb.year,
          };
        }),
      );

      // Sort surfaced films by year desc (most recent first) — works
      // both for displaying recent films first and as a stable order.
      enriched.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      // Mutate the location in place (we created the array fresh per
      // card so this doesn't leak into the cached source data).
      (loc as { films: ReadonlyArray<SurfacedFilm> }).films = enriched;
    }),
  );

  // Final sort: vision score desc, then distance asc.
  withPhoto.sort((a, b) => {
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
    afterPhotoFilter: withPhoto.length,
    finalRendered: withPhoto.length,
    visionScored: visionScoringApplied,
    targetColor,
    mapillaryDetections: detections.length,
    photosPerCandidate,
    minVisionScore,
  });

  const response: EnrichResponse = {
    locations: withPhoto,
    visionScoringApplied,
    pipelineStats: {
      inputCandidates: candidates.length,
      afterDedupe: dedupedCandidates.length,
      afterColorFilter: afterColorFilter.length,
      afterDetectionFilter: afterDetectionFilter.length,
      afterVisionFilter: afterVisionFilter.length,
      afterPhotoFilter: withPhoto.length,
      finalRendered: withPhoto.length,
      targetColor,
      mapillaryDetectionsFound: detections.length,
    },
  };
  return NextResponse.json(response, { status: 200 });
});
