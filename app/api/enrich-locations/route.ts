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
  findBestPanoNear,
  findDetectionsInBbox,
  findImagesNear,
  type MapillaryDetection,
  type MapillaryImage,
} from "@/lib/mapillary";
import { runFilmHistoryProviders } from "@/lib/providers/registry";
import { buildSourceDebugEntry } from "@/lib/source-debug";
import type { EnrichSourcePayload, SourceDebugEntry } from "@/lib/source-debug";
import type {
  AssociatedFilm,
  RawCandidate,
  WikidataFacts,
} from "@/lib/providers/types";
import { enrichWikidataFacts } from "@/lib/wikidata-rest";
import { checkDeepCredit, consumeDeepCredit } from "@/lib/search-tier";
import { buildThumbUrl } from "@/lib/street-view";
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
  "nps-places",
  "ridb-recreation",
  "unesco-heritage",
  "own-db",
  "nrhp",
  "nhl",
]);

const associatedFilmSchema = z.object({
  wikidataQid: z.string().nullable(),
  title: z.string(),
  year: z.number().nullable(),
  imdbId: z.string().nullable(),
});

const wikidataFactsSchema = z.object({
  inception: z.string().nullable(),
  creators: z.array(z.string()).default([]),
  architects: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  genres: z.array(z.string()).default([]),
  depicts: z.array(z.string()).default([]),
  namedAfter: z.array(z.string()).default([]),
  partOf: z.array(z.string()).default([]),
  hasParts: z.array(z.string()).default([]),
  commonsCategory: z.string().nullable(),
  altLabels: z.array(z.string()).default([]),
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
  /** Optional Wikidata facts pre-populated by search-osm. */
  wikidataFacts: wikidataFactsSchema.optional(),
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
   * When true, skip the Claude Vision multi-shot step entirely and rely
   * on tag-overlap ranking from search-osm alone. Set by the caller
   * when search-osm signaled `highConfidence: true`.
   *
   * Saves ~3-5 seconds + ~$0.03 per search and is the default behavior
   * for the future free tier (M5).
   */
  skipVision: z.boolean().default(false),
  /**
   * M5 — search tier. "free" (default) skips Claude Vision multi-shot
   * scoring AND Mapillary alternates fetch (single closest-photo only,
   * for color extraction). "deep" runs the full vision pipeline. Note:
   * `skipVision` overrides this when the search-osm route signals high
   * confidence.
   */
  searchTier: z.enum(["free", "deep"]).optional().default("free"),
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
  /** When true, return per-source enrich-phase debug payloads. */
  developerMode: z.boolean().optional().default(false),
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
  /**
   * Mapillary-only metadata that the carousel uses for hero badges
   * (panorama indicator, compass needle) and for sorting tiebreakers.
   * Optional + nullable so non-Mapillary photos pass through unchanged.
   */
  isPanorama?: boolean;
  qualityScore?: number | null;
  compassAngle?: number | null;
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

  /**
   * Unified list of all photos available for this location, ordered by
   * usefulness: curated first (Wikidata P18, Wikipedia pageimages, NPS
   * curated, UNESCO main image, SF Films stills), then Mapillary
   * street-level shots, then Google Place photos when deep-tier ran.
   *
   * The first entry doubles as the card's primary thumbnail. The rest
   * power the "Photos" carousel — give scouts as much visual context
   * as we can before they tab out to Google Maps.
   */
  photos: ReadonlyArray<SelectedPhoto>;
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
  /**
   * Optional Wikidata facts (year built, creator, material, ...). Filled
   * either at search-osm time (Wikidata SPARQL provider) or at
   * enrichment time via the Wikidata REST client when a candidate has
   * a Q-id but no facts payload yet.
   */
  wikidataFacts?: WikidataFacts;
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
    /** True when vision scoring was skipped (high-confidence tag match). */
    visionSkipped: boolean;
  };
  sourceDebug?: SourceDebugEntry[];
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

function mapillaryImageDebug(m: MapillaryImage): Record<string, unknown> {
  return {
    id: m.id,
    thumbUrl: m.thumbUrl,
    qualityScore: m.qualityScore ?? null,
    compassAngle: m.compassAngle ?? null,
    isPano: m.isPanorama ?? false,
  };
}

function googlePlaceDebug(p: GooglePlace): Record<string, unknown> {
  return {
    id: p.id,
    displayName: p.displayName,
    primaryType: p.primaryType,
    lat: p.lat,
    lng: p.lng,
    businessStatus: p.businessStatus,
  };
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
  // Pull the closest single image (legacy semantics for color check),
  // a small pool of nearby alternates for multi-shot scoring, AND a
  // 360° panorama when available — panoramas are gold for film
  // scouting because they show the surroundings without committing
  // to a particular direction. All cached aggressively.
  const [closest, alternates, panorama] = await Promise.all([
    findBestImageNear(candidate.lat, candidate.lng).catch(() => null),
    altLimit > 1
      ? findImagesNear({
          lat: candidate.lat,
          lng: candidate.lng,
          searchRadiusMeters: 120,
          limit: Math.max(altLimit, 2),
        }).catch(() => [] as MapillaryImage[])
      : Promise.resolve([] as MapillaryImage[]),
    findBestPanoNear(candidate.lat, candidate.lng).catch(
      () => null as MapillaryImage | null,
    ),
  ]);

  // Build a deduped list with the closest first, then panorama, then
  // alternates by recency. The panorama lands second so the carousel's
  // hero slot stays the closest forward-facing photo while the pano is
  // a swipe away.
  const seen = new Set<string>();
  const ordered: MapillaryImage[] = [];
  if (closest) {
    ordered.push(closest);
    seen.add(closest.id);
  }
  if (panorama && !seen.has(panorama.id)) {
    ordered.push(panorama);
    seen.add(panorama.id);
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

/**
 * Cached static enrichment per coord. Not scene-dependent.
 *
 * Street View probing was removed: the static thumbnails were
 * unreliable (often pointed at the wrong building when the OSM coord
 * sat at a polygon centroid) and the interactive panorama costs us
 * money on every load. Scouts get a free OSM map tile in the card's
 * "Map" tab and a one-click "Open in Google Maps" button that gives
 * them the full Street View experience without burning our quota.
 */
type StaticEnrichment = {
  googlePlace: GooglePlace | null;
};

async function fetchStaticEnrichment(args: {
  candidate: z.infer<typeof candidateSchema>;
  mapillary: MapillaryImage | null;
  includeClosed: boolean;
}): Promise<StaticEnrichment> {
  const { candidate, includeClosed } = args;

  const k = cacheKey("google:place-details", {
    kind: "static-v4-no-streetview",
    osmId: candidate.id,
    lat: round(candidate.lat),
    lng: round(candidate.lng),
    closed: includeClosed,
  });

  const cached = await cacheGet<StaticEnrichment>(k);
  if (cached) return cached;

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

  const result: StaticEnrichment = { googlePlace };
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
    isPanorama: m.isPanorama ?? false,
    qualityScore: m.qualityScore ?? null,
    compassAngle: m.compassAngle,
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
    visionScoreLimit,
    minVisionScore,
    photosPerCandidate: photosPerCandidateInput,
    skipVision: skipVisionInput,
    searchTier,
    mapillaryClasses,
    searchBbox,
    developerMode,
  } = parsed.data;

  const enrichByCandidateId: NonNullable<EnrichSourcePayload["byCandidateId"]> =
    {};

  // M5: free tier defaults to single-shot photo + no vision unless the
  // caller explicitly asked otherwise. Deep tier respects whatever
  // photosPerCandidate / skipVision the caller provided.
  const photosPerCandidate =
    searchTier === "free" ? 1 : photosPerCandidateInput;
  const skipVision = skipVisionInput || searchTier === "free";

  // M5: deep tier is credit-gated. Check the user's balance BEFORE we
  // burn API tokens. Free tier searches always pass.
  if (searchTier === "deep") {
    const credit = await checkDeepCredit(req.dbUserId);
    if (!credit.ok) {
      return NextResponse.json(
        {
          error: "deep_tier_no_credits",
          message: `You're out of Deep Search credits. ${credit.tier === "free" ? "Free-tier credits reset at the start of each month." : ""}`,
          remaining: 0,
          resetAt: credit.resetAt.toISOString(),
        },
        { status: 402 },
      );
    }
    // Consume the credit BEFORE we run vision/Mapillary/etc. so a
    // mid-pipeline failure doesn't double-charge.
    await consumeDeepCredit(req.dbUserId);
  }

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

  if (developerMode) {
    for (const s of freeSignals) {
      const imgs: Record<string, unknown>[] = [];
      if (s.mapillary) imgs.push(mapillaryImageDebug(s.mapillary));
      for (const alt of s.mapillaryAlternates) {
        imgs.push(mapillaryImageDebug(alt));
      }
      enrichByCandidateId[s.candidate.id] = {
        ...(enrichByCandidateId[s.candidate.id] ?? {}),
        mapillaryImages: imgs,
      };
    }
  }

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
  // Two paths:
  //   - skipVision: tag-overlap from search-osm was strong enough that
  //     vision scoring is unlikely to change rankings. Skip entirely.
  //     Free tier (M5) defaults to this. Saves ~3-5s and ~$0.03/search.
  //   - !skipVision: multi-shot vision-score the top N candidates.
  // We still distance-sort first because the candidate ORDER from
  // search-osm is already RRF+tag-overlap sorted; the distance-sort
  // here only matters when we have to slice for the vision limit.
  const distanceSorted = [...afterDetectionFilter].sort((a, b) => {
    const da = searchCenter
      ? distanceMeters(searchCenter, { lat: a.candidate.lat, lng: a.candidate.lng })
      : 0;
    const db = searchCenter
      ? distanceMeters(searchCenter, { lat: b.candidate.lat, lng: b.candidate.lng })
      : 0;
    return da - db;
  });

  let scored: Awaited<ReturnType<typeof visionScoreSurvivors>>;
  if (skipVision) {
    // No vision call. Mark every candidate as unscored; downstream
    // ordering will fall back to the search-osm tag/RRF ordering.
    scored = distanceSorted.map((s) => ({
      ...s,
      visionScore: null,
      bestPhoto: null,
    }));
    logger.info("enrich-locations: vision SKIPPED (high-confidence tag overlap)", {
      candidates: scored.length,
    });
  } else {
    scored = await visionScoreSurvivors(
      distanceSorted,
      sceneDescription,
      sceneTokens,
      visionScoreLimit,
    );
  }

  if (developerMode) {
    for (const s of scored) {
      if (!s.visionScore || !s.bestPhoto) continue;
      enrichByCandidateId[s.candidate.id] = {
        ...(enrichByCandidateId[s.candidate.id] ?? {}),
        vision: {
          imageUrl: s.bestPhoto.url,
          score: s.visionScore.score,
          reason: s.visionScore.reason ?? null,
        },
      };
    }
  }

  // Drop candidates whose vision score is below threshold. Strict mode
  // (the user's stated preference: better to show fewer high-confidence
  // matches than many marginal ones). When nothing passes, we degrade
  // gracefully rather than returning zero cards: keep the top-6 BY
  // SCORE even if all scored below threshold, plus some unscored
  // candidates as best-effort. Returning empty pages is the worst UX.
  // When skipVision is set, we don't apply a threshold at all — the
  // search-osm tag-overlap ranking is the source of truth.
  const passedThreshold = scored.filter(
    (s) => s.visionScore != null && s.visionScore.score >= minVisionScore,
  );
  let afterVisionFilter: typeof scored;
  if (skipVision) {
    afterVisionFilter = scored;
  } else if (passedThreshold.length > 0) {
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
      if (developerMode && stat.googlePlace) {
        enrichByCandidateId[s.candidate.id] = {
          ...(enrichByCandidateId[s.candidate.id] ?? {}),
          googleNearby: [googlePlaceDebug(stat.googlePlace)],
        };
      }
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

    // Assemble the FULL set of photos available for this location,
    // ordered by curated-quality and visual usefulness. Scouts want
    // every angle we can give them BEFORE they tab out to Google Maps.
    //
    // Order:
    //   1. Vision-scoring winner (when it ran) — proven best match
    //   2. Provider's curated image (`knownImageUrl`) — Wikidata P18,
    //      Wikipedia pageimages, UNESCO main image, NPS curated, SF
    //      Films stills — hand-picked photos of the actual subject
    //   3. Mapillary closest hit at the candidate's coord
    //   4. Mapillary alternates (other angles, recent shots)
    //   5. Google Place photos (deep tier only — paid)
    //
    // Deduped by URL so the same image doesn't appear twice when two
    // sources point at the same Wikimedia file.
    const visionRan = e.visionScore != null;
    const photos: SelectedPhoto[] = [];
    const seenUrls = new Set<string>();
    const tryPush = (p: SelectedPhoto | null): void => {
      if (!p) return;
      if (seenUrls.has(p.url)) return;
      seenUrls.add(p.url);
      photos.push(p);
    };

    if (visionRan && e.bestPhoto?.kind === "mapillary") {
      tryPush(selectedFromMapillary(e.bestPhoto.mapillary, e.visionScore));
    } else if (visionRan && e.bestPhoto?.kind === "known") {
      tryPush(
        selectedFromKnown({
          url: e.bestPhoto.url,
          attributionText: null,
          attributionHref: candidate.sourceUrl ?? null,
          score: e.visionScore,
        }),
      );
    }
    if (candidate.knownImageUrl) {
      tryPush(
        selectedFromKnown({
          url: candidate.knownImageUrl,
          attributionText: null,
          attributionHref: candidate.sourceUrl ?? null,
          score: e.visionScore,
        }),
      );
    }
    if (e.mapillary) {
      tryPush(selectedFromMapillary(e.mapillary, e.visionScore));
    }
    for (const alt of e.mapillaryAlternates) {
      tryPush(selectedFromMapillary(alt, null));
    }
    if (place) {
      tryPush(selectedFromGooglePlace(place, e.visionScore));
    }

    // ALWAYS use the candidate's original coords for user-facing links.
    // The matched Google Place's coords often point at a business pin
    // INSIDE the building (e.g. a deli inside a historic facade), so
    // navigation links would land the user inside the deli — not the
    // monument they actually want.
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
      photos,
      deepLinks,
      badges: buildBadges(candidate.tags),
      enrichmentSparse: place === null,
      // Phase 2a metadata
      sources: candidate.sources ?? [],
      primarySource: candidate.primarySource ?? null,
      description: candidate.description ?? null,
      sourceUrl: candidate.sourceUrl ?? null,
      films,
      // Wikidata facts: forwarded from search-osm when present.
      // Card-time fill-in for Q-id-only candidates happens below in
      // the post-mapping enrichment pass.
      wikidataFacts: candidate.wikidataFacts,
    };
  });

  // Drop cards with no photo from any source — we now treat "NO PHOTO
  // FOUND" as "candidate not viable" rather than rendering an empty card.
  // Phase 1 quality bar: every card must show something the user can
  // actually look at.
  const withPhoto = locations.filter((loc) => loc.photos.length > 0);

  // -------- Wikidata REST card-time enrichment --------
  // For any surviving card that has a Wikidata Q-id but no facts
  // payload (typically OSM nodes tagged `wikidata=Q1234` that didn't
  // pass through the SPARQL provider), fetch the facts via the REST
  // API. Cheap because most cards either already have facts or have
  // no Q-id at all. Cached server-side.
  const qidByLocId = new Map<string, string>();
  for (const c of candidates) {
    const qid = c.tags?.["wikidata"] ?? c.tags?.["wikidata:qid"];
    if (qid && /^Q\d+$/.test(qid)) qidByLocId.set(c.id, qid);
  }
  await Promise.all(
    withPhoto.map(async (loc) => {
      const qid = qidByLocId.get(loc.id);
      if (!qid) return;
      const enriched = await enrichWikidataFacts({
        qid,
        existing: loc.wikidataFacts,
      });
      if (enriched) {
        loc.wikidataFacts = enriched;
        if (developerMode) {
          enrichByCandidateId[loc.id] = {
            ...(enrichByCandidateId[loc.id] ?? {}),
            wikidataRest: { qid, facts: enriched },
          };
        }
      }
    }),
  );

  // -------- Phase 5.5: film-history POST-CARD enrichment --------
  // Films should NEVER drive search ranking — they're metadata on a card,
  // not a reason for a card to exist. We run film-history providers
  // (Wikidata P915, NYC Scenes from the City, SF Films) here, AFTER the
  // search-osm pipeline has already chosen the cards based on
  // content-only signals (Wikidata landmarks / Wikipedia / OSM).
  // Each card is then matched against film-history coords within 50 m
  // and any associated films are merged into the card's `films` array.
  let filmHistorySourceDebug: SourceDebugEntry[] = [];
  if (withPhoto.length > 0 && searchBbox) {
    const filmHistoryRun = await runFilmHistoryProviders(
      {
        bbox: searchBbox,
        sceneTokens: [],
        locationKind: null,
        osmTagsAlternatives: [],
      },
      { developerMode },
    ).catch(() => null);

    if (developerMode && filmHistoryRun) {
      filmHistorySourceDebug = filmHistoryRun.sourceDebug;
    }

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
    const sa = a.photos[0]?.visionScore ?? -1;
    const sb = b.photos[0]?.visionScore ?? -1;
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

  let sourceDebug: SourceDebugEntry[] | undefined;
  if (developerMode) {
    const mapillaryImageCount = Object.values(enrichByCandidateId).reduce(
      (acc, v) => acc + (v.mapillaryImages?.length ?? 0),
      0,
    );
    const mlyDetectT0 = Date.now();
    sourceDebug = [
      buildSourceDebugEntry({
        sourceKey: "mapillary-images",
        displayName: "Mapillary images (enrich)",
        ms: 0,
        error: null,
        request: {
          photosPerCandidate,
          searchTier,
          candidateCount: dedupedCandidates.length,
        },
        candidates: [],
        enrich: { byCandidateId: enrichByCandidateId },
        notes: `${mapillaryImageCount} images across ${Object.keys(enrichByCandidateId).length} candidates`,
      }),
      buildSourceDebugEntry({
        sourceKey: "mapillary-detections",
        displayName: "Mapillary detections (enrich)",
        ms: Date.now() - mlyDetectT0,
        error: null,
        skipped: mapillaryClasses.length === 0 || !searchBbox,
        skipReason:
          mapillaryClasses.length === 0
            ? "no mapillary_classes"
            : !searchBbox
              ? "no search_bbox"
              : null,
        request: {
          searchBbox: searchBbox ?? null,
          mapillaryClasses,
        },
        candidates: [],
        enrich: {
          summary: {
            detections: detections.map((d) => ({
              id: d.id,
              lat: d.lat,
              lng: d.lng,
              objectClass: d.objectClass,
            })),
          },
        },
      }),
      buildSourceDebugEntry({
        sourceKey: "google-places-nearby",
        displayName: "Google Places nearby (enrich)",
        ms: 0,
        error: null,
        request: { includeClosed, survivors: survivors.length },
        candidates: [],
        enrich: { byCandidateId: enrichByCandidateId },
      }),
      buildSourceDebugEntry({
        sourceKey: "street-view",
        displayName: "Street View static",
        ms: 0,
        error: null,
        skipped: true,
        skipReason: "Street View probe removed — use Mapillary + Google Maps deep links",
        request: {},
        candidates: [],
      }),
      buildSourceDebugEntry({
        sourceKey: "vision-claude",
        displayName: "Claude vision scoring",
        ms: 0,
        error: null,
        skipped: skipVision,
        skipReason: skipVision
          ? searchTier === "free"
            ? "free tier / high-confidence skip"
            : "skipVision flag"
          : null,
        request: {
          sceneTokens,
          visionScoreLimit,
          minVisionScore,
        },
        candidates: [],
        enrich: { byCandidateId: enrichByCandidateId },
      }),
      buildSourceDebugEntry({
        sourceKey: "wikidata-rest",
        displayName: "Wikidata REST (card enrich)",
        ms: 0,
        error: null,
        request: { cardsWithQid: qidByLocId.size },
        candidates: [],
        enrich: { byCandidateId: enrichByCandidateId },
      }),
      ...filmHistorySourceDebug,
    ];
  }

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
      visionSkipped: skipVision,
    },
    sourceDebug,
  };
  return NextResponse.json(response, { status: 200 });
});
