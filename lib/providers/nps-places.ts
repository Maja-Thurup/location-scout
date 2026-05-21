import { z } from "zod";

import { isBboxOverlapping, type Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { extractKeywords } from "@/lib/providers/keywords";
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
 * Build the NPS ?q= keyword string from scene_tokens. NPS full-text
 * search runs OR-style BM25 over title + bodyText, so a multi-word
 * query gives much better recall than picking a single token: for
 * "horse statue" we now send "statue horse" instead of just "statue".
 *
 * Returns the joined query AND the individual token list so the caller
 * can also fan out per-token requests when each one is highly
 * discriminative (e.g. ["lighthouse"] alone is enough).
 */
function extractNpsQuery(sceneTokens: ReadonlyArray<string>): {
  joined: string | null;
  list: string[];
} {
  const { list, joined } = extractKeywords(sceneTokens, {
    minLength: 4,
    maxTokens: 3,
  });
  return { joined: joined.length > 0 ? joined : null, list };
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
  const tags: Record<string, string> = { "nps:place_id": p.id, "nps:type": "place" };
  if (p.tags && p.tags.length > 0) {
    tags["nps:tags"] = p.tags.slice(0, 6).join(", ");
  }
  if (p.relatedParks && p.relatedParks.length > 0) {
    tags["nps:park_code"] = p.relatedParks[0]!.parkCode;
  }
  return {
    externalId: `place-${p.id}`,
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
// /parks endpoint — full national parks with at least 5 photos each.
// Adds wide coverage for natural / historical sites where /places is
// sparse: Yellowstone, Yosemite, Independence Hall, etc. Lat/lng on
// the park record is the headquarters / canonical center.
// ---------------------------------------------------------------------------

const parkSchema = z.object({
  id: z.string(),
  parkCode: z.string(),
  fullName: z.string(),
  description: z.string().optional(),
  designation: z.string().optional(),
  states: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  url: z.string().optional(),
  images: z.array(placeImageSchema).optional(),
});
type Park = z.infer<typeof parkSchema>;

const parksResponseSchema = z.object({
  total: z.union([z.string(), z.number()]).optional(),
  data: z.array(parkSchema).default([]),
});

async function fetchParksForState(
  state: string,
  query?: string,
): Promise<Park[]> {
  const cKey = cacheKey("nps:dataset", { kind: "parks", state, q: query ?? "" });
  const cached = await cacheGet<Park[]>(cKey);
  if (cached) return cached;
  const url = new URL(`${NPS_BASE}/parks`);
  url.searchParams.set("stateCode", state);
  url.searchParams.set("limit", String(NPS_PAGE_LIMIT));
  if (query) url.searchParams.set("q", query.trim());
  url.searchParams.set("api_key", env.NPS_API_KEY ?? "");
  try {
    const res = await fetch(url, {
      headers: env.NPS_API_KEY ? { "X-Api-Key": env.NPS_API_KEY } : {},
      signal: AbortSignal.timeout(NPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    const raw = await res.json();
    const parsed = parksResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    await cacheSet(cKey, "nps:dataset", parsed.data.data, 14);
    return parsed.data.data;
  } catch (err) {
    logger.warn("nps parks fetch failed", { state, err: String(err) });
    return [];
  }
}

function parkToCandidate(p: Park): RawCandidate | null {
  if (!p.latitude || !p.longitude) return null;
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  const image = p.images?.find((i) => i.url)?.url ?? null;
  const tags: Record<string, string> = {
    "nps:park_code": p.parkCode,
    "nps:type": "park",
  };
  if (p.designation) tags["nps:designation"] = p.designation;
  if (p.states) tags["nps:states"] = p.states;
  return {
    externalId: `park-${p.id}`,
    source: "nps-places",
    lat,
    lng,
    name: p.fullName,
    description: p.description?.slice(0, 280) ?? null,
    knownImageUrl: image,
    tags,
    associatedFilms: [],
    sourceUrl: p.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// /articles endpoint — themed content articles, one of NPS's
// highest-quality narrative sources. "Civil War battlefields" /
// "Lighthouses of New England" / "Buffalo herds in the West" type
// listicles, each with hand-curated images and bodies. We attach
// each article that has a related park's coords (or a placement
// lat/lng — many articles do) as a candidate.
// ---------------------------------------------------------------------------

const articleSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  title: z.string(),
  listingDescription: z.string().optional(),
  bodyText: z.string().optional(),
  geometryPoiId: z.string().optional(),
  images: z.array(placeImageSchema).optional(),
  // Articles have lat/lng either as siteAccessLocations[].coords or as
  // a single latitude/longitude pair on the relatedParks. We try both.
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  relatedParks: z
    .array(
      z.object({
        parkCode: z.string(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
      }),
    )
    .optional(),
  tags: z.array(z.string()).optional(),
});
type Article = z.infer<typeof articleSchema>;

const articlesResponseSchema = z.object({
  data: z.array(articleSchema).default([]),
});

async function fetchArticlesForState(
  state: string,
  query?: string,
): Promise<Article[]> {
  const cKey = cacheKey("nps:dataset", { kind: "articles", state, q: query ?? "" });
  const cached = await cacheGet<Article[]>(cKey);
  if (cached) return cached;
  const url = new URL(`${NPS_BASE}/articles`);
  url.searchParams.set("stateCode", state);
  url.searchParams.set("limit", String(NPS_PAGE_LIMIT));
  if (query) url.searchParams.set("q", query.trim());
  url.searchParams.set("api_key", env.NPS_API_KEY ?? "");
  try {
    const res = await fetch(url, {
      headers: env.NPS_API_KEY ? { "X-Api-Key": env.NPS_API_KEY } : {},
      signal: AbortSignal.timeout(NPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    const raw = await res.json();
    const parsed = articlesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    await cacheSet(cKey, "nps:dataset", parsed.data.data, 14);
    return parsed.data.data;
  } catch (err) {
    logger.warn("nps articles fetch failed", { state, err: String(err) });
    return [];
  }
}

function articleCoord(a: Article): { lat: number; lng: number } | null {
  if (a.latitude && a.longitude) {
    const lat = Number(a.latitude);
    const lng = Number(a.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
      return { lat, lng };
    }
  }
  for (const rp of a.relatedParks ?? []) {
    if (rp.latitude && rp.longitude) {
      const lat = Number(rp.latitude);
      const lng = Number(rp.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
        return { lat, lng };
      }
    }
  }
  return null;
}

function articleToCandidate(a: Article): RawCandidate | null {
  const coord = articleCoord(a);
  if (!coord) return null;
  const description =
    a.listingDescription ??
    (a.bodyText ? a.bodyText.slice(0, 280).replace(/\s+/g, " ") : null);
  const image = a.images?.find((i) => i.url)?.url ?? null;
  const tags: Record<string, string> = {
    "nps:article_id": a.id,
    "nps:type": "article",
  };
  if (a.tags && a.tags.length > 0) {
    tags["nps:tags"] = a.tags.slice(0, 6).join(", ");
  }
  return {
    externalId: `article-${a.id}`,
    source: "nps-places",
    lat: coord.lat,
    lng: coord.lng,
    name: a.title,
    description,
    knownImageUrl: image,
    tags,
    associatedFilms: [],
    sourceUrl: a.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// /people endpoint — historical figures and biographical entries with
// portraits + biographies. Connects "statue of Lincoln" to NPS's own
// Lincoln biography (with portrait photo) when prompts mention named
// people. Geographic anchor is the park associated with the person.
// ---------------------------------------------------------------------------

const personSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  title: z.string(),
  listingDescription: z.string().optional(),
  bodyText: z.string().optional(),
  images: z.array(placeImageSchema).optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  relatedParks: z
    .array(
      z.object({
        parkCode: z.string(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
      }),
    )
    .optional(),
  tags: z.array(z.string()).optional(),
});
type Person = z.infer<typeof personSchema>;

const peopleResponseSchema = z.object({
  data: z.array(personSchema).default([]),
});

async function fetchPeopleForState(
  state: string,
  query?: string,
): Promise<Person[]> {
  const cKey = cacheKey("nps:dataset", { kind: "people", state, q: query ?? "" });
  const cached = await cacheGet<Person[]>(cKey);
  if (cached) return cached;
  const url = new URL(`${NPS_BASE}/people`);
  url.searchParams.set("stateCode", state);
  url.searchParams.set("limit", String(NPS_PAGE_LIMIT));
  if (query) url.searchParams.set("q", query.trim());
  url.searchParams.set("api_key", env.NPS_API_KEY ?? "");
  try {
    const res = await fetch(url, {
      headers: env.NPS_API_KEY ? { "X-Api-Key": env.NPS_API_KEY } : {},
      signal: AbortSignal.timeout(NPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    const raw = await res.json();
    const parsed = peopleResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    await cacheSet(cKey, "nps:dataset", parsed.data.data, 14);
    return parsed.data.data;
  } catch (err) {
    logger.warn("nps people fetch failed", { state, err: String(err) });
    return [];
  }
}

function personCoord(p: Person): { lat: number; lng: number } | null {
  if (p.latitude && p.longitude) {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
      return { lat, lng };
    }
  }
  for (const rp of p.relatedParks ?? []) {
    if (rp.latitude && rp.longitude) {
      const lat = Number(rp.latitude);
      const lng = Number(rp.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
        return { lat, lng };
      }
    }
  }
  return null;
}

function personToCandidate(p: Person): RawCandidate | null {
  const coord = personCoord(p);
  if (!coord) return null;
  const description =
    p.listingDescription ??
    (p.bodyText ? p.bodyText.slice(0, 280).replace(/\s+/g, " ") : null);
  const image = p.images?.find((i) => i.url)?.url ?? null;
  return {
    externalId: `person-${p.id}`,
    source: "nps-places",
    lat: coord.lat,
    lng: coord.lng,
    name: p.title,
    description,
    knownImageUrl: image,
    tags: {
      "nps:person_id": p.id,
      "nps:type": "person",
      ...(p.tags && p.tags.length > 0
        ? { "nps:tags": p.tags.slice(0, 6).join(", ") }
        : {}),
    },
    associatedFilms: [],
    sourceUrl: p.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// /campgrounds endpoint — campgrounds with location, amenities,
// accessibility info, and curated photos. Useful for wilderness /
// "secluded campsite by a river" prompts.
// ---------------------------------------------------------------------------

const campgroundSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  parkCode: z.string().optional(),
  images: z.array(placeImageSchema).optional(),
});
type Campground = z.infer<typeof campgroundSchema>;

const campgroundsResponseSchema = z.object({
  data: z.array(campgroundSchema).default([]),
});

async function fetchCampgroundsForState(
  state: string,
  query?: string,
): Promise<Campground[]> {
  const cKey = cacheKey("nps:dataset", {
    kind: "campgrounds",
    state,
    q: query ?? "",
  });
  const cached = await cacheGet<Campground[]>(cKey);
  if (cached) return cached;
  const url = new URL(`${NPS_BASE}/campgrounds`);
  url.searchParams.set("stateCode", state);
  url.searchParams.set("limit", String(NPS_PAGE_LIMIT));
  if (query) url.searchParams.set("q", query.trim());
  url.searchParams.set("api_key", env.NPS_API_KEY ?? "");
  try {
    const res = await fetch(url, {
      headers: env.NPS_API_KEY ? { "X-Api-Key": env.NPS_API_KEY } : {},
      signal: AbortSignal.timeout(NPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    const raw = await res.json();
    const parsed = campgroundsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await cacheSet(cKey, "nps:dataset", [], 1);
      return [];
    }
    await cacheSet(cKey, "nps:dataset", parsed.data.data, 14);
    return parsed.data.data;
  } catch (err) {
    logger.warn("nps campgrounds fetch failed", { state, err: String(err) });
    return [];
  }
}

function campgroundToCandidate(c: Campground): RawCandidate | null {
  if (!c.latitude || !c.longitude) return null;
  const lat = Number(c.latitude);
  const lng = Number(c.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  const image = c.images?.find((i) => i.url)?.url ?? null;
  return {
    externalId: `campground-${c.id}`,
    source: "nps-places",
    lat,
    lng,
    name: c.name,
    description: c.description?.slice(0, 280) ?? null,
    knownImageUrl: image,
    tags: {
      "nps:campground_id": c.id,
      "nps:type": "campground",
      ...(c.parkCode ? { "nps:park_code": c.parkCode } : {}),
    },
    associatedFilms: [],
    sourceUrl: c.url ?? null,
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

    /**
     * Build the per-state fetch fan-out for one endpoint. Always
     * fetches the broad state slice; layers a combined-OR query and
     * per-token queries when scene_tokens are distinctive.
     */
    function fanOut<T>(
      fetchFn: (state: string, query?: string) => Promise<T[]>,
    ): Array<Promise<T[]>> {
      const fetches: Array<Promise<T[]>> = [];
      for (const s of states) {
        fetches.push(fetchFn(s).catch(() => []));
        if (npsQuery.joined) {
          fetches.push(fetchFn(s, npsQuery.joined).catch(() => []));
          if (npsQuery.list.length > 1) {
            for (const tok of npsQuery.list) {
              fetches.push(fetchFn(s, tok).catch(() => []));
            }
          }
        }
      }
      return fetches;
    }

    const allPlaces: Place[] = [];
    const allParks: Park[] = [];
    const allArticles: Article[] = [];
    const allPeople: Person[] = [];
    const allCampgrounds: Campground[] = [];
    try {
      const [placesResults, parksResults, articlesResults, peopleResults, campResults] =
        await Promise.all([
          Promise.all(fanOut<Place>(fetchPlacesForState)),
          Promise.all(fanOut<Park>(fetchParksForState)),
          Promise.all(fanOut<Article>(fetchArticlesForState)),
          Promise.all(fanOut<Person>(fetchPeopleForState)),
          Promise.all(fanOut<Campground>(fetchCampgroundsForState)),
        ]);
      for (const list of placesResults) allPlaces.push(...list);
      for (const list of parksResults) allParks.push(...list);
      for (const list of articlesResults) allArticles.push(...list);
      for (const list of peopleResults) allPeople.push(...list);
      for (const list of campResults) allCampgrounds.push(...list);
    } catch (err) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    /**
     * Apply the bbox filter to a candidate that has lat/lng already
     * normalised. Drops out-of-area entries silently (per-state
     * fetches are union-of-state, not bbox-bound).
     */
    function inBbox(c: { lat: number; lng: number } | null): boolean {
      if (!c) return false;
      return (
        c.lat >= input.bbox.south &&
        c.lat <= input.bbox.north &&
        c.lng >= input.bbox.west &&
        c.lng <= input.bbox.east
      );
    }

    const out: RawCandidate[] = [];
    const seen = new Set<string>();

    for (const place of allPlaces) {
      const dedupeKey = `place-${place.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (!inBbox(placeCoord(place))) continue;
      const c = placeToCandidate(place);
      if (c) out.push(c);
    }

    for (const park of allParks) {
      const dedupeKey = `park-${park.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const c = parkToCandidate(park);
      if (c && inBbox({ lat: c.lat, lng: c.lng })) out.push(c);
    }

    for (const article of allArticles) {
      const dedupeKey = `article-${article.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (!inBbox(articleCoord(article))) continue;
      const c = articleToCandidate(article);
      if (c) out.push(c);
    }

    for (const person of allPeople) {
      const dedupeKey = `person-${person.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (!inBbox(personCoord(person))) continue;
      const c = personToCandidate(person);
      if (c) out.push(c);
    }

    for (const camp of allCampgrounds) {
      const dedupeKey = `campground-${camp.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const c = campgroundToCandidate(camp);
      if (c && inBbox({ lat: c.lat, lng: c.lng })) out.push(c);
    }

    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
