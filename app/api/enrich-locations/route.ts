import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { distanceMeters } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { buildDeepLinks, type DeepLinks } from "@/lib/deep-links";
import {
  type GooglePlace,
  searchNearby,
} from "@/lib/google-places";
import { logger } from "@/lib/logger";
import { type AggregatedPhoto, pickBestPhoto } from "@/lib/photos";
import { probeStreetView, type StreetViewProbe } from "@/lib/street-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** A subset of OsmCandidate that the client passes to /api/enrich-locations. */
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
});

export type EnrichedLocation = {
  /** Stable id from OSM (or text-search-derived). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Postal address when known. */
  address: string;
  lat: number;
  lng: number;
  /** Distance from search center in meters (if center provided). */
  distanceMeters: number | null;

  /** Google Places primary type ("warehouse", "restaurant", ...). */
  primaryType: string | null;
  /** Google rating 0-5, when present. */
  rating: number | null;
  ratingCount: number | null;
  /** "OPERATIONAL" / "CLOSED_PERMANENTLY" / null. */
  businessStatus: string | null;
  /** Short Google-curated description, when present. */
  editorialSummary: string | null;
  /** Direct link to Google Maps for this place. */
  googleMapsUri: string | null;
  /** Operator's website, when known. */
  websiteUri: string | null;

  /** Aggregated primary photo (Mapillary first, Google fallback). */
  photo: AggregatedPhoto | null;
  /** Street View static thumbnail probe. */
  streetView: StreetViewProbe;
  /** Pre-built deep-link bundle. */
  deepLinks: DeepLinks;

  /** Up to 6 OSM tag pairs surfaced as badges. */
  badges: ReadonlyArray<{ key: string; value: string }>;

  /** True when no Google Places match could be associated to this OSM coord. */
  enrichmentSparse: boolean;
};

type EnrichResponse = {
  locations: EnrichedLocation[];
  cached: boolean;
};

// ---------------------------------------------------------------------------
// Per-candidate enrichment
// ---------------------------------------------------------------------------

const PER_CANDIDATE_TTL_DAYS = 7;
const MAX_PARALLEL_ENRICHMENT = 4;

async function enrichOne(args: {
  candidate: z.infer<typeof candidateSchema>;
  searchCenter: { lat: number; lng: number } | undefined;
  includeClosed: boolean;
}): Promise<EnrichedLocation> {
  const { candidate, searchCenter, includeClosed } = args;

  const cKey = cacheKey("google:place-details", {
    kind: "enriched-osm",
    osmId: candidate.id,
    lat: round(candidate.lat),
    lng: round(candidate.lng),
    closed: includeClosed,
  });

  const cached = await cacheGet<Omit<EnrichedLocation, "distanceMeters">>(cKey);
  if (cached) {
    return {
      ...cached,
      distanceMeters: searchCenter
        ? distanceMeters(searchCenter, { lat: cached.lat, lng: cached.lng })
        : null,
    };
  }

  // Step 1: Find a Google Place at this OSM coord (best-effort).
  let googlePlace: GooglePlace | null = null;
  try {
    const places = await searchNearby({
      lat: candidate.lat,
      lng: candidate.lng,
      includeClosedPermanently: includeClosed,
    });
    googlePlace = places[0] ?? null;
  } catch (err) {
    logger.warn("enrichOne searchNearby threw", { id: candidate.id, err: String(err) });
  }

  // Step 2: Fetch a primary photo (Mapillary preferred, Google fallback).
  let photo: AggregatedPhoto | null = null;
  try {
    photo = await pickBestPhoto({
      lat: candidate.lat,
      lng: candidate.lng,
      googlePhotoRef: googlePlace?.primaryPhoto ?? null,
    });
  } catch (err) {
    logger.warn("enrichOne pickBestPhoto threw", { id: candidate.id, err: String(err) });
  }

  // Step 3: Probe Street View. Free, doesn't fetch the actual image.
  let sv: StreetViewProbe;
  try {
    sv = await probeStreetView(candidate.lat, candidate.lng);
  } catch (err) {
    logger.warn("enrichOne probeStreetView threw", { id: candidate.id, err: String(err) });
    sv = { available: false, capturedAt: null, thumbUrl: null, copyright: null };
  }

  const name =
    googlePlace?.displayName ??
    candidate.name ??
    deriveName(candidate.tags);
  const address = googlePlace?.formattedAddress ?? "";

  const deepLinks = buildDeepLinks({
    lat: candidate.lat,
    lng: candidate.lng,
    label: name,
    googlePlaceId: googlePlace?.id,
  });

  const badges = buildBadges(candidate.tags);

  const lat = googlePlace?.lat ?? candidate.lat;
  const lng = googlePlace?.lng ?? candidate.lng;

  const enriched: Omit<EnrichedLocation, "distanceMeters"> = {
    id: candidate.id,
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
    photo,
    streetView: sv,
    deepLinks,
    badges,
    enrichmentSparse: googlePlace === null,
  };

  await cacheSet(cKey, "google:place-details", enriched, PER_CANDIDATE_TTL_DAYS);

  return {
    ...enriched,
    distanceMeters: searchCenter
      ? distanceMeters(searchCenter, { lat, lng })
      : null,
  };
}

function deriveName(tags: Record<string, string>): string {
  if (tags.name) return tags.name;
  if (tags["name:en"]) return tags["name:en"]!;
  if (tags.brand) return tags.brand!;
  if (tags.operator) return tags.operator!;
  // Fall back to a friendly "type" label.
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

// ---------------------------------------------------------------------------
// Concurrency-limited Promise.all
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, U>(
  items: ReadonlyArray<T>,
  worker: (item: T) => Promise<U>,
  concurrency: number,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let idx = 0;
  async function next(): Promise<void> {
    const i = idx++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]!);
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

  const { candidates, includeClosed = false, searchCenter } = parsed.data;

  const enriched = await mapWithConcurrency(
    candidates,
    (c) =>
      enrichOne({
        candidate: c,
        searchCenter,
        includeClosed,
      }),
    MAX_PARALLEL_ENRICHMENT,
  );

  // Sort by distance from center (when known), then by Google rating desc
  // as a tiebreaker for items at the same distance bucket.
  if (searchCenter) {
    enriched.sort((a, b) => {
      const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
      const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
      if (Math.abs(da - db) > 50) return da - db;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
  }

  logger.info("enrich-locations done", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    inCount: candidates.length,
    outCount: enriched.length,
    sparseCount: enriched.filter((e) => e.enrichmentSparse).length,
  });

  const response: EnrichResponse = {
    locations: enriched,
    cached: false, // per-candidate cache status is internal
  };
  return NextResponse.json(response, { status: 200 });
});
