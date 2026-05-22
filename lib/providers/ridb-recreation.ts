import { z } from "zod";

import type { Bbox } from "@/lib/bbox";
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
// Recreation.gov RIDB provider — federal recreation sites.
//
// Covers NPS + USFS + BLM facilities, recreation areas, campgrounds,
// trailheads. Has lat/lng on most records. Useful for prompts like
// "scenic mountain overlook", "wilderness campsite", "secluded river
// bend" where Wikidata + Wikipedia have sparse coverage.
//
// API: https://ridb.recreation.gov/api/v1   (X-Api-Key header)
// Supports geographic queries via `latitude` + `longitude` + `radius`
// — but NOT bbox. Strategy: query the bbox center with a radius
// covering the whole bbox (clamped to 200 mi, the API's max).
//
// Cached 14 days. No-op when RIDB_API_KEY is missing.
// ---------------------------------------------------------------------------

const RIDB_BASE = "https://ridb.recreation.gov/api/v1";
const RIDB_TIMEOUT_MS = 15_000;
const RIDB_PAGE_LIMIT = 50; // API max
const RIDB_RADIUS_MAX_MILES = 200;
const RIDB_PAGES_PER_QUERY = 4; // 4 * 50 = up to 200 results per endpoint

const facilitySchema = z.object({
  FacilityID: z.union([z.string(), z.number()]).transform((v) => String(v)),
  FacilityName: z.string().optional(),
  FacilityDescription: z.string().optional(),
  FacilityLatitude: z.number().optional(),
  FacilityLongitude: z.number().optional(),
  FacilityTypeDescription: z.string().optional(),
  Keywords: z.string().optional(),
  ParentRecAreaID: z.union([z.string(), z.number()]).optional(),
  // Cover photo URL when present (RIDB returns these inconsistently).
  MEDIA: z
    .array(
      z.object({
        URL: z.string().optional(),
        MediaType: z.string().optional(),
        Title: z.string().optional(),
        IsPrimary: z.boolean().optional(),
      }),
    )
    .optional(),
});

const recAreaSchema = z.object({
  RecAreaID: z.union([z.string(), z.number()]).transform((v) => String(v)),
  RecAreaName: z.string().optional(),
  RecAreaDescription: z.string().optional(),
  RecAreaLatitude: z.number().optional(),
  RecAreaLongitude: z.number().optional(),
  Keywords: z.string().optional(),
  MEDIA: z
    .array(
      z.object({
        URL: z.string().optional(),
        MediaType: z.string().optional(),
        IsPrimary: z.boolean().optional(),
      }),
    )
    .optional(),
});

type Facility = z.infer<typeof facilitySchema>;
type RecArea = z.infer<typeof recAreaSchema>;

const facilityResponseSchema = z.object({
  RECDATA: z.array(facilitySchema).default([]),
});

const recAreaResponseSchema = z.object({
  RECDATA: z.array(recAreaSchema).default([]),
});

function bboxRadiusMiles(bbox: Bbox): number {
  // Half-diagonal in miles, clamped to the API max.
  const dLat = bbox.north - bbox.south;
  const dLng = bbox.east - bbox.west;
  const cosLat = Math.cos(((bbox.north + bbox.south) / 2) * (Math.PI / 180));
  const latMiles = (dLat * 69) / 2;
  const lngMiles = (dLng * 69 * cosLat) / 2;
  const half = Math.sqrt(latMiles * latMiles + lngMiles * lngMiles);
  return Math.min(RIDB_RADIUS_MAX_MILES, Math.ceil(half));
}

function bboxCenter(bbox: Bbox): { lat: number; lng: number } {
  return {
    lat: (bbox.north + bbox.south) / 2,
    lng: (bbox.east + bbox.west) / 2,
  };
}

async function fetchPagedRidb<T>(
  endpoint: "facilities" | "recareas",
  bbox: Bbox,
  schema: z.ZodType<{ RECDATA: T[] }>,
  query?: string,
): Promise<T[]> {
  const center = bboxCenter(bbox);
  const radius = bboxRadiusMiles(bbox);
  const cKey = cacheKey("ridb:dataset", {
    endpoint,
    lat: Math.round(center.lat * 100) / 100,
    lng: Math.round(center.lng * 100) / 100,
    radius,
    query: query ?? "",
  });
  const cached = await cacheGet<T[]>(cKey);
  if (cached) return cached;

  const all: T[] = [];
  for (let page = 0; page < RIDB_PAGES_PER_QUERY; page++) {
    const url = new URL(`${RIDB_BASE}/${endpoint}`);
    url.searchParams.set("latitude", String(center.lat));
    url.searchParams.set("longitude", String(center.lng));
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("limit", String(RIDB_PAGE_LIMIT));
    url.searchParams.set("offset", String(page * RIDB_PAGE_LIMIT));
    if (query && query.trim()) {
      // RIDB API accepts ?query=<keyword> for full-text search across
      // facility/recarea names + descriptions + keywords.
      url.searchParams.set("query", query.trim());
    }
    url.searchParams.set("apikey", env.RIDB_API_KEY ?? "");

    let raw: unknown;
    try {
      const res = await fetch(url, {
        headers: env.RIDB_API_KEY ? { "X-Api-Key": env.RIDB_API_KEY } : {},
        signal: AbortSignal.timeout(RIDB_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn("ridb HTTP error", { endpoint, status: res.status, page });
        break;
      }
      raw = await res.json();
    } catch (err) {
      logger.warn("ridb fetch failed", {
        endpoint,
        err: err instanceof Error ? err.message : String(err),
      });
      break;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) break;
    all.push(...parsed.data.RECDATA);
    if (parsed.data.RECDATA.length < RIDB_PAGE_LIMIT) break; // last page
  }

  await cacheSet(cKey, "ridb:dataset", all, 14);
  return all;
}

/**
 * Build the RIDB ?query= keyword string from scene_tokens. The RIDB
 * full-text search runs over FacilityName + FacilityDescription +
 * Keywords (and the equivalent for RecAreas); like MediaWiki it does
 * an OR-style match so a multi-token query gives strictly higher
 * recall than the single-longest token we sent before.
 */
function extractRidbQuery(sceneTokens: ReadonlyArray<string>): {
  joined: string | null;
  list: string[];
} {
  const { list, joined } = extractKeywords(sceneTokens, {
    minLength: 4,
    maxTokens: 3,
  });
  return { joined: joined.length > 0 ? joined : null, list };
}

function facilityToCandidate(f: Facility): RawCandidate | null {
  if (
    f.FacilityLatitude == null ||
    f.FacilityLongitude == null ||
    !Number.isFinite(f.FacilityLatitude) ||
    !Number.isFinite(f.FacilityLongitude) ||
    (f.FacilityLatitude === 0 && f.FacilityLongitude === 0)
  ) {
    return null;
  }
  const image =
    f.MEDIA?.find(
      (m) => m.URL && (m.MediaType ?? "").toLowerCase().includes("image"),
    )?.URL ?? null;
  const tags: Record<string, string> = { "ridb:facility_id": f.FacilityID };
  if (f.FacilityTypeDescription) tags["ridb:type"] = f.FacilityTypeDescription;
  if (f.Keywords) tags["ridb:keywords"] = f.Keywords.slice(0, 200);
  return {
    externalId: `facility-${f.FacilityID}`,
    source: "ridb-recreation",
    lat: f.FacilityLatitude,
    lng: f.FacilityLongitude,
    name: f.FacilityName ?? null,
    description: f.FacilityDescription
      ? f.FacilityDescription.slice(0, 280).replace(/\s+/g, " ")
      : null,
    knownImageUrl: image,
    tags,
    associatedFilms: [],
    sourceUrl: `https://www.recreation.gov/camping/gateways/${f.FacilityID}`,
  };
}

function recAreaToCandidate(r: RecArea): RawCandidate | null {
  if (
    r.RecAreaLatitude == null ||
    r.RecAreaLongitude == null ||
    !Number.isFinite(r.RecAreaLatitude) ||
    !Number.isFinite(r.RecAreaLongitude) ||
    (r.RecAreaLatitude === 0 && r.RecAreaLongitude === 0)
  ) {
    return null;
  }
  const image = r.MEDIA?.find((m) => m.URL)?.URL ?? null;
  const tags: Record<string, string> = { "ridb:rec_area_id": r.RecAreaID };
  if (r.Keywords) tags["ridb:keywords"] = r.Keywords.slice(0, 200);
  return {
    externalId: `recarea-${r.RecAreaID}`,
    source: "ridb-recreation",
    lat: r.RecAreaLatitude,
    lng: r.RecAreaLongitude,
    name: r.RecAreaName ?? null,
    description: r.RecAreaDescription
      ? r.RecAreaDescription.slice(0, 280).replace(/\s+/g, " ")
      : null,
    knownImageUrl: image,
    tags,
    associatedFilms: [],
    sourceUrl: `https://www.recreation.gov/gateways/${r.RecAreaID}`,
  };
}

// ---------------------------------------------------------------------------
// /media endpoint — per-facility / per-recarea media list. Returns more
// images than the embedded `MEDIA[]` field on the parent record, with
// titles + credits. Used at card-time by the enrich-locations route to
// build a richer photos carousel.
// ---------------------------------------------------------------------------

const mediaItemSchema = z.object({
  EntityMediaID: z.union([z.string(), z.number()]).transform((v) => String(v)),
  EntityID: z.union([z.string(), z.number()]).optional().transform((v) =>
    v == null ? null : String(v),
  ),
  EntityType: z.string().optional(),
  MediaType: z.string().optional(),
  URL: z.string().optional(),
  Title: z.string().optional(),
  Subtitle: z.string().optional(),
  Description: z.string().optional(),
  Credits: z.string().optional(),
  IsPrimary: z.boolean().optional(),
  IsPreview: z.boolean().optional(),
});

export type RidbMedia = {
  id: string;
  url: string;
  title: string | null;
  credit: string | null;
  isPrimary: boolean;
};

const mediaResponseSchema = z.object({
  RECDATA: z.array(mediaItemSchema).default([]),
});

/**
 * Fetch the media list for a single RIDB entity (facility or recarea).
 * Cached 14 days. Returns up to ~20 images per entity (the API caps at
 * 50; we trim to keep payloads light). When the API key is missing or
 * the entity has no media we return an empty array silently.
 */
export async function fetchRidbMedia(input: {
  entityKind: "facilities" | "recareas";
  entityId: string;
}): Promise<RidbMedia[]> {
  if (!env.RIDB_API_KEY) return [];
  const cKey = cacheKey("ridb:dataset", {
    kind: "media",
    entityKind: input.entityKind,
    entityId: input.entityId,
  });
  const cached = await cacheGet<RidbMedia[]>(cKey);
  if (cached) return cached;

  const url = new URL(`${RIDB_BASE}/${input.entityKind}/${input.entityId}/media`);
  url.searchParams.set("limit", "20");
  url.searchParams.set("apikey", env.RIDB_API_KEY ?? "");

  try {
    const res = await fetch(url, {
      headers: env.RIDB_API_KEY ? { "X-Api-Key": env.RIDB_API_KEY } : {},
      signal: AbortSignal.timeout(RIDB_TIMEOUT_MS),
    });
    if (!res.ok) {
      await cacheSet(cKey, "ridb:dataset", [], 1);
      return [];
    }
    const raw = await res.json();
    const parsed = mediaResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await cacheSet(cKey, "ridb:dataset", [], 1);
      return [];
    }
    const out: RidbMedia[] = [];
    for (const m of parsed.data.RECDATA) {
      if (!m.URL) continue;
      // RIDB returns videos / pdfs / fact sheets too; keep only images.
      if (m.MediaType && !m.MediaType.toLowerCase().includes("image")) continue;
      out.push({
        id: m.EntityMediaID,
        url: m.URL,
        title: m.Title ?? m.Subtitle ?? null,
        credit: m.Credits ?? null,
        isPrimary: m.IsPrimary ?? false,
      });
    }
    // Sort primary-first so callers can use [0] as the canonical image.
    out.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    await cacheSet(cKey, "ridb:dataset", out, 14);
    return out;
  } catch (err) {
    logger.warn("ridb media fetch failed", {
      entityKind: input.entityKind,
      entityId: input.entityId,
      err: String(err),
    });
    return [];
  }
}

export const ridbRecreationProvider: CandidateProvider = {
  name: "ridb-recreation",
  // Federal recreation data is US-only; the radius search just won't
  // return anything in non-US bboxes, so let it run everywhere.
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    if (!env.RIDB_API_KEY) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: null,
        debug: {
          skipReason: "RIDB_API_KEY not set",
          request: { endpoint: RIDB_BASE },
        },
      };
    }
    const ridbQuery = extractRidbQuery(input.sceneTokens);

    try {
      // Run unfiltered + keyword-filtered passes in parallel. The
      // unfiltered slice maintains broad coverage; the keyword slice
      // surfaces specific hits that wouldn't fit in the page cap.
      // We also fan out per-token slices when the user's prompt has
      // multiple distinctive nouns to insure against BM25 dominance
      // collapses (one keyword suppressing the other in ranking).
      const facilityFetches: Array<Promise<Facility[]>> = [
        fetchPagedRidb<Facility>("facilities", input.bbox, facilityResponseSchema),
      ];
      const recAreaFetches: Array<Promise<RecArea[]>> = [
        fetchPagedRidb<RecArea>("recareas", input.bbox, recAreaResponseSchema),
      ];
      if (ridbQuery.joined) {
        facilityFetches.push(
          fetchPagedRidb<Facility>(
            "facilities",
            input.bbox,
            facilityResponseSchema,
            ridbQuery.joined,
          ),
        );
        recAreaFetches.push(
          fetchPagedRidb<RecArea>(
            "recareas",
            input.bbox,
            recAreaResponseSchema,
            ridbQuery.joined,
          ),
        );
        if (ridbQuery.list.length > 1) {
          for (const tok of ridbQuery.list) {
            facilityFetches.push(
              fetchPagedRidb<Facility>(
                "facilities",
                input.bbox,
                facilityResponseSchema,
                tok,
              ),
            );
            recAreaFetches.push(
              fetchPagedRidb<RecArea>(
                "recareas",
                input.bbox,
                recAreaResponseSchema,
                tok,
              ),
            );
          }
        }
      }
      const [facilityChunks, recAreaChunks] = await Promise.all([
        Promise.all(facilityFetches),
        Promise.all(recAreaFetches),
      ]);
      const facilities: Facility[] = facilityChunks.flat();
      const recAreas: RecArea[] = recAreaChunks.flat();

      const out: RawCandidate[] = [];
      for (const f of facilities) {
        if (
          f.FacilityLatitude != null &&
          f.FacilityLongitude != null &&
          (f.FacilityLatitude < input.bbox.south ||
            f.FacilityLatitude > input.bbox.north ||
            f.FacilityLongitude < input.bbox.west ||
            f.FacilityLongitude > input.bbox.east)
        ) {
          continue;
        }
        const c = facilityToCandidate(f);
        if (c) out.push(c);
      }
      for (const r of recAreas) {
        if (
          r.RecAreaLatitude != null &&
          r.RecAreaLongitude != null &&
          (r.RecAreaLatitude < input.bbox.south ||
            r.RecAreaLatitude > input.bbox.north ||
            r.RecAreaLongitude < input.bbox.west ||
            r.RecAreaLongitude > input.bbox.east)
        ) {
          continue;
        }
        const c = recAreaToCandidate(r);
        if (c) out.push(c);
      }
      return {
        candidates: out,
        elapsedMs: Date.now() - t0,
        error: null,
        debug: {
          request: {
            endpoint: RIDB_BASE,
            keywordQuery: ridbQuery.joined,
            keywordTokens: ridbQuery.list,
            endpoints: ["facilities", "recareas"],
          },
        },
      };
    } catch (err) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
        debug: { request: { endpoint: RIDB_BASE, keywordQuery: ridbQuery.joined } },
      };
    }
  },
};
