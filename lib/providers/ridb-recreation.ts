import { z } from "zod";

import type { Bbox } from "@/lib/bbox";
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
): Promise<T[]> {
  const center = bboxCenter(bbox);
  const radius = bboxRadiusMiles(bbox);
  const cKey = cacheKey("ridb:dataset", {
    endpoint,
    lat: Math.round(center.lat * 100) / 100,
    lng: Math.round(center.lng * 100) / 100,
    radius,
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

export const ridbRecreationProvider: CandidateProvider = {
  name: "ridb-recreation",
  // Federal recreation data is US-only; the radius search just won't
  // return anything in non-US bboxes, so let it run everywhere.
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    if (!env.RIDB_API_KEY) {
      return { candidates: [], elapsedMs: Date.now() - t0, error: null };
    }
    try {
      const [facilities, recAreas] = await Promise.all([
        fetchPagedRidb<Facility>("facilities", input.bbox, facilityResponseSchema),
        fetchPagedRidb<RecArea>("recareas", input.bbox, recAreaResponseSchema),
      ]);

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
      return { candidates: out, elapsedMs: Date.now() - t0, error: null };
    } catch (err) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
