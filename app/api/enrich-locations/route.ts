import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { distanceMeters } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { scoreImagesParallel, type VisionScore } from "@/lib/claude-vision";
import { buildDeepLinks, type DeepLinks } from "@/lib/deep-links";
import {
  type GooglePlace,
  searchNearby,
} from "@/lib/google-places";
import { logger } from "@/lib/logger";
import {
  fallbackPickByPriority,
  gatherPhotoCandidates,
  type PhotoCandidate,
  type PhotoSource,
} from "@/lib/photos";
import { probeStreetView, type StreetViewProbe } from "@/lib/street-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
   * Scene description used by Claude Vision to score photos and pick the
   * best-matching thumbnail per card. Combines Claude's `visual` field
   * with the user's raw scene text for richer signal.
   */
  sceneDescription: z.string().min(5).max(2000),
  /** Cap on candidates that get vision-scored. Cheaper requests pass less. */
  visionScoreLimit: z.number().int().min(0).max(60).default(10),
});

export type SelectedPhoto = {
  url: string;
  source: PhotoSource;
  capturedAt: string | null;
  attributionText: string;
  attributionHref: string | null;
  /** Vision-scored 0-100; null when scoring failed for every candidate. */
  visionScore: number | null;
  visionReason: string | null;
};

export type EnrichedLocation = {
  id: string;
  name: string;
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

  /** The thumbnail Claude Vision picked (or fallback by priority). */
  photo: SelectedPhoto | null;
  /** Other candidate photos NOT picked, with their scores — for a "more views" UI later. */
  alternatePhotos: ReadonlyArray<SelectedPhoto>;
  /** Street View probe result for the interactive panorama modal. */
  streetView: StreetViewProbe;
  /** Pre-built deep-link bundle. */
  deepLinks: DeepLinks;

  badges: ReadonlyArray<{ key: string; value: string }>;
  enrichmentSparse: boolean;
};

type EnrichResponse = {
  locations: EnrichedLocation[];
  /** True when at least one photo was successfully vision-scored. */
  visionScoringApplied: boolean;
};

// ---------------------------------------------------------------------------
// Per-candidate enrichment (no vision yet — that runs after the static
// data is gathered in parallel).
// ---------------------------------------------------------------------------

/** Static fields that don't depend on the scene description. Cached separately. */
type StaticEnrichment = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  primaryType: string | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: string | null;
  editorialSummary: string | null;
  googleMapsUri: string | null;
  websiteUri: string | null;
  googlePlaceId: string | null;
  /** Photo candidates ready for vision scoring. */
  photoCandidates: ReadonlyArray<PhotoCandidate>;
  streetView: StreetViewProbe;
  badges: ReadonlyArray<{ key: string; value: string }>;
  enrichmentSparse: boolean;
};

const STATIC_TTL_DAYS = 7;
const MAX_PARALLEL_STATIC = 4;
const VISION_PARALLELISM_PER_CANDIDATE = 3;

async function gatherStaticEnrichment(args: {
  candidate: z.infer<typeof candidateSchema>;
  includeClosed: boolean;
}): Promise<StaticEnrichment> {
  const { candidate, includeClosed } = args;

  const cKey = cacheKey("google:place-details", {
    kind: "static-v2",
    osmId: candidate.id,
    lat: round(candidate.lat),
    lng: round(candidate.lng),
    closed: includeClosed,
  });

  const cached = await cacheGet<StaticEnrichment>(cKey);
  if (cached) return cached;

  // Step 1: Place Details around the OSM coord (20m radius after recent change).
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

  // Step 2: Probe Street View metadata (free).
  let sv: StreetViewProbe;
  try {
    sv = await probeStreetView(candidate.lat, candidate.lng);
  } catch (err) {
    logger.warn("static enrichment probeStreetView threw", {
      id: candidate.id,
      err: String(err),
    });
    sv = { available: false, capturedAt: null, thumbUrl: null, copyright: null };
  }

  // Step 3: Gather photo candidates (Google + Street View + Mapillary).
  const photoCandidates = await gatherPhotoCandidates({
    lat: candidate.lat,
    lng: candidate.lng,
    googlePhoto: googlePlace?.primaryPhoto ?? null,
    streetView: sv,
    includeMapillary: true,
  });

  const name =
    googlePlace?.displayName ??
    candidate.name ??
    deriveName(candidate.tags);
  const address = googlePlace?.formattedAddress ?? "";
  const lat = googlePlace?.lat ?? candidate.lat;
  const lng = googlePlace?.lng ?? candidate.lng;

  const result: StaticEnrichment = {
    name,
    address,
    lat,
    lng,
    primaryType: googlePlace?.primaryType ?? null,
    rating: googlePlace?.rating ?? null,
    ratingCount: googlePlace?.userRatingCount ?? null,
    businessStatus: googlePlace?.businessStatus ?? null,
    editorialSummary: googlePlace?.editorialSummary ?? null,
    googleMapsUri: googlePlace?.googleMapsUri ?? null,
    websiteUri: googlePlace?.websiteUri ?? null,
    googlePlaceId: googlePlace?.id ?? null,
    photoCandidates,
    streetView: sv,
    badges: buildBadges(candidate.tags),
    enrichmentSparse: googlePlace === null,
  };

  await cacheSet(cKey, "google:place-details", result, STATIC_TTL_DAYS);
  return result;
}

// ---------------------------------------------------------------------------
// Vision scoring layer
// ---------------------------------------------------------------------------

async function pickPhoto(
  candidates: ReadonlyArray<PhotoCandidate>,
  sceneDescription: string,
  visionEnabled: boolean,
): Promise<{ picked: SelectedPhoto | null; alternates: SelectedPhoto[]; scored: boolean }> {
  if (candidates.length === 0) {
    return { picked: null, alternates: [], scored: false };
  }

  if (!visionEnabled) {
    const fallback = fallbackPickByPriority(candidates);
    return {
      picked: fallback ? selectedFromCandidate(fallback, null) : null,
      alternates: candidates
        .slice(1)
        .map((c) => selectedFromCandidate(c, null)),
      scored: false,
    };
  }

  const scores = await scoreImagesParallel({
    imageUrls: candidates.map((c) => c.url),
    sceneDescription,
    concurrency: VISION_PARALLELISM_PER_CANDIDATE,
  });

  const enriched = candidates.map((c, i) => ({ candidate: c, score: scores[i] ?? null }));

  // Best score wins; on a tie, source priority (already the array order) wins.
  const successful = enriched.filter((e) => e.score !== null);
  if (successful.length === 0) {
    // Every score failed — fall back to priority.
    const fallback = enriched[0]!;
    return {
      picked: selectedFromCandidate(fallback.candidate, null),
      alternates: enriched.slice(1).map((e) => selectedFromCandidate(e.candidate, e.score)),
      scored: false,
    };
  }

  successful.sort((a, b) => (b.score!.score - a.score!.score));
  const winner = successful[0]!;
  const losers = enriched.filter((e) => e.candidate.url !== winner.candidate.url);

  return {
    picked: selectedFromCandidate(winner.candidate, winner.score),
    alternates: losers.map((e) => selectedFromCandidate(e.candidate, e.score)),
    scored: true,
  };
}

function selectedFromCandidate(
  c: PhotoCandidate,
  score: VisionScore | null,
): SelectedPhoto {
  return {
    url: c.url,
    source: c.source,
    capturedAt: c.capturedAt,
    attributionText: c.attributionText,
    attributionHref: c.attributionHref,
    visionScore: score?.score ?? null,
    visionReason: score?.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveName(tags: Record<string, string>): string {
  if (tags.name) return tags.name;
  if (tags["name:en"]) return tags["name:en"]!;
  if (tags.brand) return tags.brand!;
  if (tags.operator) return tags.operator!;
  if (tags.building && tags.building !== "yes") return capitalize(tags.building) + " (OSM)";
  if (tags.amenity) return capitalize(tags.amenity);
  if (tags.natural) return capitalize(tags.natural);
  if (tags.landuse) return capitalize(tags.landuse);
  if (tags.historic) return capitalize(tags.historic);
  return "OSM feature";
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, " ") : s;
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
    visionScoreLimit,
  } = parsed.data;

  // Stage 1 — gather static enrichment for every candidate (parallel).
  const staticData = await mapWithConcurrency(
    candidates,
    (c) => gatherStaticEnrichment({ candidate: c, includeClosed }),
    MAX_PARALLEL_STATIC,
  );

  // Stage 2 — pre-rank by distance, vision-score the top N.
  const indexedDistances = staticData.map((s, i) => ({
    i,
    dist: searchCenter
      ? distanceMeters(searchCenter, { lat: s.lat, lng: s.lng })
      : Number.POSITIVE_INFINITY,
  }));
  indexedDistances.sort((a, b) => a.dist - b.dist);

  const visionEligible = new Set(
    indexedDistances.slice(0, visionScoreLimit).map((d) => d.i),
  );

  const photoSelections = await mapWithConcurrency(
    staticData,
    async (sd, i) =>
      pickPhoto(sd.photoCandidates, sceneDescription, visionEligible.has(i)),
    MAX_PARALLEL_STATIC,
  );

  let visionScoringApplied = false;
  for (const sel of photoSelections) {
    if (sel.scored) {
      visionScoringApplied = true;
      break;
    }
  }

  // Stage 3 — assemble the response.
  const enriched: EnrichedLocation[] = staticData.map((sd, i) => {
    const sel = photoSelections[i]!;
    const candidate = candidates[i]!;
    const deepLinks = buildDeepLinks({
      lat: sd.lat,
      lng: sd.lng,
      label: sd.name,
      googlePlaceId: sd.googlePlaceId ?? undefined,
    });

    return {
      id: candidate.id,
      name: sd.name,
      address: sd.address,
      lat: sd.lat,
      lng: sd.lng,
      distanceMeters: searchCenter
        ? distanceMeters(searchCenter, { lat: sd.lat, lng: sd.lng })
        : null,
      primaryType: sd.primaryType,
      rating: sd.rating,
      ratingCount: sd.ratingCount,
      businessStatus: sd.businessStatus,
      editorialSummary: sd.editorialSummary,
      googleMapsUri: sd.googleMapsUri,
      websiteUri: sd.websiteUri,
      photo: sel.picked,
      alternatePhotos: sel.alternates,
      streetView: sd.streetView,
      deepLinks,
      badges: sd.badges,
      enrichmentSparse: sd.enrichmentSparse,
    };
  });

  // Sort by vision score (desc) for the top-vision-scored slice, then by
  // distance for everyone else. This puts the strongest visual matches at
  // the top of the grid without burying nearby-but-unscored candidates.
  enriched.sort((a, b) => {
    const sa = a.photo?.visionScore ?? -1;
    const sb = b.photo?.visionScore ?? -1;
    if (sa !== sb) return sb - sa;
    const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
    const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
    return da - db;
  });

  logger.info("enrich-locations done", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    inCount: candidates.length,
    outCount: enriched.length,
    sparseCount: enriched.filter((e) => e.enrichmentSparse).length,
    visionScored: visionScoringApplied,
    visionScoreLimit,
  });

  const response: EnrichResponse = {
    locations: enriched,
    visionScoringApplied,
  };
  return NextResponse.json(response, { status: 200 });
});
