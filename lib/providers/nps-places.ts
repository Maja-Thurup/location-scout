import { z } from "zod";

import { isBboxOverlapping, type Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// National Park Service /places + /parks providers.
//
// /places   — named viewpoints / scenic spots / historical markers / trails
//             inside (or near) national parks. Each /places entry has a
//             specific lat/lng + curated photos.
// /parks    — the parks themselves with overall coordinates.
//
// We query both endpoints by US state (the API doesn't support bbox
// queries directly). For each search bbox we map to the relevant US
// state codes, hit the API once per state, and filter results to the
// bbox in-memory. Cached 14 days (API content is slow-changing).
//
// API: https://developer.nps.gov/api/v1/  (Bearer auth via X-Api-Key)
// License: NPS data is U.S. government work, public domain.
// ---------------------------------------------------------------------------

const NPS_BASE = "https://developer.nps.gov/api/v1";
const NPS_TIMEOUT_MS = 15_000;
const NPS_PAGE_LIMIT = 200; // max per request

/**
 * Approximate US state bounding boxes. We map the search bbox to all
 * states that overlap it, then hit /places + /parks for each state.
 *
 * These are intentionally generous (no neat polygon) — we trust the
 * post-fetch in-bbox filter to drop out-of-bbox matches.
 *
 * Source: https://en.wikipedia.org/wiki/List_of_extreme_points_of_U.S._states_and_territories
 */
const US_STATE_BBOXES: ReadonlyArray<{ code: string; bbox: Bbox }> = [
  { code: "AL", bbox: { south: 30.2, west: -88.5, north: 35.0, east: -84.9 } },
  { code: "AK", bbox: { south: 51.2, west: -179.2, north: 71.5, east: -130.0 } },
  { code: "AZ", bbox: { south: 31.3, west: -114.9, north: 37.0, east: -109.0 } },
  { code: "AR", bbox: { south: 33.0, west: -94.6, north: 36.5, east: -89.6 } },
  { code: "CA", bbox: { south: 32.5, west: -124.5, north: 42.0, east: -114.1 } },
  { code: "CO", bbox: { south: 36.9, west: -109.1, north: 41.0, east: -102.0 } },
  { code: "CT", bbox: { south: 40.9, west: -73.7, north: 42.1, east: -71.8 } },
  { code: "DE", bbox: { south: 38.4, west: -75.8, north: 39.9, east: -75.0 } },
  { code: "FL", bbox: { south: 24.5, west: -87.7, north: 31.0, east: -80.0 } },
  { code: "GA", bbox: { south: 30.4, west: -85.6, north: 35.0, east: -80.7 } },
  { code: "HI", bbox: { south: 18.9, west: -160.3, north: 22.3, east: -154.8 } },
  { code: "ID", bbox: { south: 41.9, west: -117.3, north: 49.0, east: -111.0 } },
  { code: "IL", bbox: { south: 36.9, west: -91.5, north: 42.5, east: -87.0 } },
  { code: "IN", bbox: { south: 37.8, west: -88.1, north: 41.8, east: -84.8 } },
  { code: "IA", bbox: { south: 40.4, west: -96.6, north: 43.5, east: -90.1 } },
  { code: "KS", bbox: { south: 36.9, west: -102.1, north: 40.0, east: -94.6 } },
  { code: "KY", bbox: { south: 36.5, west: -89.6, north: 39.2, east: -81.9 } },
  { code: "LA", bbox: { south: 28.9, west: -94.0, north: 33.0, east: -88.8 } },
  { code: "ME", bbox: { south: 43.1, west: -71.1, north: 47.5, east: -66.9 } },
  { code: "MD", bbox: { south: 37.9, west: -79.5, north: 39.7, east: -75.0 } },
  { code: "MA", bbox: { south: 41.2, west: -73.5, north: 42.9, east: -69.9 } },
  { code: "MI", bbox: { south: 41.7, west: -90.4, north: 48.3, east: -82.4 } },
  { code: "MN", bbox: { south: 43.5, west: -97.2, north: 49.4, east: -89.5 } },
  { code: "MS", bbox: { south: 30.2, west: -91.7, north: 35.0, east: -88.1 } },
  { code: "MO", bbox: { south: 36.0, west: -95.8, north: 40.6, east: -89.1 } },
  { code: "MT", bbox: { south: 44.4, west: -116.1, north: 49.0, east: -104.0 } },
  { code: "NE", bbox: { south: 40.0, west: -104.1, north: 43.0, east: -95.3 } },
  { code: "NV", bbox: { south: 35.0, west: -120.0, north: 42.0, east: -114.0 } },
  { code: "NH", bbox: { south: 42.7, west: -72.6, north: 45.3, east: -70.6 } },
  { code: "NJ", bbox: { south: 38.9, west: -75.6, north: 41.4, east: -73.9 } },
  { code: "NM", bbox: { south: 31.3, west: -109.1, north: 37.0, east: -103.0 } },
  { code: "NY", bbox: { south: 40.4, west: -79.8, north: 45.0, east: -71.8 } },
  { code: "NC", bbox: { south: 33.8, west: -84.4, north: 36.6, east: -75.4 } },
  { code: "ND", bbox: { south: 45.9, west: -104.1, north: 49.0, east: -96.6 } },
  { code: "OH", bbox: { south: 38.4, west: -84.8, north: 42.0, east: -80.5 } },
  { code: "OK", bbox: { south: 33.6, west: -103.0, north: 37.0, east: -94.4 } },
  { code: "OR", bbox: { south: 41.9, west: -124.6, north: 46.3, east: -116.5 } },
  { code: "PA", bbox: { south: 39.7, west: -80.6, north: 42.3, east: -74.7 } },
  { code: "RI", bbox: { south: 41.1, west: -71.9, north: 42.1, east: -71.1 } },
  { code: "SC", bbox: { south: 32.0, west: -83.4, north: 35.2, east: -78.5 } },
  { code: "SD", bbox: { south: 42.5, west: -104.1, north: 46.0, east: -96.4 } },
  { code: "TN", bbox: { south: 34.9, west: -90.4, north: 36.7, east: -81.6 } },
  { code: "TX", bbox: { south: 25.8, west: -106.7, north: 36.5, east: -93.5 } },
  { code: "UT", bbox: { south: 36.9, west: -114.1, north: 42.0, east: -109.0 } },
  { code: "VT", bbox: { south: 42.7, west: -73.5, north: 45.0, east: -71.5 } },
  { code: "VA", bbox: { south: 36.5, west: -83.7, north: 39.5, east: -75.2 } },
  { code: "WA", bbox: { south: 45.5, west: -124.8, north: 49.0, east: -116.9 } },
  { code: "WV", bbox: { south: 37.2, west: -82.7, north: 40.6, east: -77.7 } },
  { code: "WI", bbox: { south: 42.5, west: -92.9, north: 47.1, east: -86.2 } },
  { code: "WY", bbox: { south: 40.9, west: -111.1, north: 45.0, east: -104.1 } },
  { code: "DC", bbox: { south: 38.8, west: -77.1, north: 39.0, east: -76.9 } },
];

function statesIntersectingBbox(bbox: Bbox): string[] {
  return US_STATE_BBOXES.filter((s) => isBboxOverlapping(s.bbox, bbox)).map(
    (s) => s.code,
  );
}

// ---------------------------------------------------------------------------
// /places endpoint
// ---------------------------------------------------------------------------

const placeImageSchema = z.object({
  url: z.string().optional(),
  altText: z.string().optional(),
  caption: z.string().optional(),
  credit: z.string().optional(),
  title: z.string().optional(),
});

const placeSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Latitude as a string (NPS quirk). May be empty when the place is
   *  associated with a park but has no specific point. */
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  /** "ABBR1,ABBR2" — codes of parks this place belongs to. */
  relatedParks: z
    .array(z.object({ parkCode: z.string(), fullName: z.string().optional() }))
    .optional(),
  listingDescription: z.string().optional(),
  bodyText: z.string().optional(),
  /** Curated images (CC0). */
  images: z.array(placeImageSchema).optional(),
  /** Tags / qualities — useful as scene tokens. */
  tags: z.array(z.string()).optional(),
  /** Permalink to the place's page on nps.gov. */
  url: z.string().optional(),
  /** State two-letter codes the place is in. */
  states: z.string().optional(),
});

type Place = z.infer<typeof placeSchema>;

const placesResponseSchema = z.object({
  total: z.union([z.string(), z.number()]).optional(),
  data: z.array(placeSchema).default([]),
});

async function fetchPlacesForState(
  state: string,
  query?: string,
): Promise<Place[]> {
  const cKey = cacheKey("nps:dataset", {
    kind: "places",
    state,
    q: query ?? "",
  });
  const cached = await cacheGet<Place[]>(cKey);
  if (cached) return cached;

  const url = new URL(`${NPS_BASE}/places`);
  url.searchParams.set("stateCode", state);
  url.searchParams.set("limit", String(NPS_PAGE_LIMIT));
  if (query && query.trim()) {
    // NPS API supports ?q=<keyword> for full-text search across
    // place title + body. Combined with stateCode this gives us a
    // tightly-scoped retrieval per user keyword.
    url.searchParams.set("q", query.trim());
  }
  url.searchParams.set("api_key", env.NPS_API_KEY ?? "");

  let raw: unknown;
  try {
    const res = await fetch(url, {
      headers: env.NPS_API_KEY ? { "X-Api-Key": env.NPS_API_KEY } : {},
      signal: AbortSignal.timeout(NPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("nps places HTTP error", { state, status: res.status });
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("nps places fetch failed", {
      state,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const parsed = placesResponseSchema.safeParse(raw);
  if (!parsed.success) {
    await cacheSet(cKey, "nps:dataset", [], 1);
    return [];
  }
  await cacheSet(cKey, "nps:dataset", parsed.data.data, 14);
  return parsed.data.data;
}

/**
 * Pull a single keyword from scene_tokens for the NPS ?q= param. NPS
 * search is a single-string query against title+body; we pick the
 * longest non-generic token (proxy for "most distinctive").
 */
function extractNpsQuery(sceneTokens: ReadonlyArray<string>): string | null {
  const filtered = sceneTokens
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 4)
    .filter(
      (t) =>
        ![
          "park",
          "tree",
          "trees",
          "grass",
          "building",
          "house",
          "outdoor",
          "exterior",
          "interior",
          "background",
        ].includes(t),
    );
  if (filtered.length === 0) return null;
  const longest = [...filtered].sort((a, b) => b.length - a.length)[0]!;
  return longest;
}

function placeCoord(p: Place): { lat: number; lng: number } | null {
  if (!p.latitude || !p.longitude) return null;
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function placeToCandidate(p: Place): RawCandidate | null {
  const coord = placeCoord(p);
  if (!coord) return null;
  const description =
    p.listingDescription ??
    (p.bodyText ? p.bodyText.slice(0, 280).replace(/\s+/g, " ") : null);
  const image = p.images?.find((i) => i.url)?.url ?? null;
  const tags: Record<string, string> = { "nps:place_id": p.id };
  if (p.tags && p.tags.length > 0) {
    tags["nps:tags"] = p.tags.slice(0, 6).join(", ");
  }
  if (p.relatedParks && p.relatedParks.length > 0) {
    tags["nps:park_code"] = p.relatedParks[0]!.parkCode;
  }
  return {
    externalId: p.id,
    source: "nps-places",
    lat: coord.lat,
    lng: coord.lng,
    name: p.title,
    description,
    knownImageUrl: image,
    tags,
    associatedFilms: [],
    sourceUrl: p.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const npsPlacesProvider: CandidateProvider = {
  name: "nps-places",
  supportsBbox: () => true, // gated at runtime by US-state intersection
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();

    if (!env.NPS_API_KEY) {
      // Quietly skip when the optional key is missing.
      return { candidates: [], elapsedMs: Date.now() - t0, error: null };
    }

    const states = statesIntersectingBbox(input.bbox);
    if (states.length === 0) {
      return { candidates: [], elapsedMs: Date.now() - t0, error: null };
    }

    const npsQuery = extractNpsQuery(input.sceneTokens);

    const allPlaces: Place[] = [];
    try {
      // Always fetch the broad state slice; ALSO fetch a keyword-
      // narrowed slice when scene_tokens give us something distinctive.
      // The keyword slice surfaces hits that wouldn't fit in the 200-
      // result state cap (e.g. a specific obscure equestrian statue).
      const fetches: Array<Promise<Place[]>> = [];
      for (const s of states) {
        fetches.push(fetchPlacesForState(s).catch(() => []));
        if (npsQuery) {
          fetches.push(fetchPlacesForState(s, npsQuery).catch(() => []));
        }
      }
      const results = await Promise.all(fetches);
      for (const list of results) {
        allPlaces.push(...list);
      }
    } catch (err) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const out: RawCandidate[] = [];
    const seen = new Set<string>();
    for (const place of allPlaces) {
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      const coord = placeCoord(place);
      if (!coord) continue;
      // In-bbox filter.
      if (
        coord.lat < input.bbox.south ||
        coord.lat > input.bbox.north ||
        coord.lng < input.bbox.west ||
        coord.lng > input.bbox.east
      ) {
        continue;
      }
      const c = placeToCandidate(place);
      if (c) out.push(c);
    }

    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
