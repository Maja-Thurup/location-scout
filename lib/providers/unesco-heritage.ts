import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// UNESCO World Heritage Sites provider.
//
// The full dataset is ~1,248 properties globally — small enough to fetch
// once and filter in-memory by bbox. Refreshed monthly.
//
// API: UNESCO DataHub / Opendatasoft
//   https://data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/exports/json
// License: open (UNESCO publishes the dataset with no usage restrictions).
// No API key required.
// ---------------------------------------------------------------------------

const UNESCO_DATASET_URL =
  "https://data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/exports/json";
const UNESCO_TIMEOUT_MS = 30_000;

/**
 * Schema is generous — the real export has many more fields, but we
 * only consume a handful and let zod ignore the rest. Fields tested
 * against a sample of the live dataset.
 */
const siteSchema = z.object({
  id_no: z.union([z.number(), z.string()]).optional(),
  unique_number: z.union([z.number(), z.string()]).optional(),
  name_en: z.string().optional(),
  short_description_en: z.string().optional(),
  /** Fallback: a longer description when short is missing. */
  long_description_en: z.string().optional(),
  /** ISO category: "Cultural" / "Natural" / "Mixed". */
  category: z.string().optional(),
  category_short: z.string().optional(),
  /** Year inscribed. */
  date_inscribed: z.union([z.number(), z.string()]).optional(),
  /** State Party (country) name. */
  states_name_en: z.string().optional(),
  /** GeoJSON Point lat/lng — variant 1. */
  longitude: z.union([z.number(), z.string()]).optional(),
  latitude: z.union([z.number(), z.string()]).optional(),
  /** Geo shape variant 2 (older snapshots). */
  geo_point_2d: z
    .object({ lat: z.number().optional(), lon: z.number().optional() })
    .optional(),
});

type Site = z.infer<typeof siteSchema>;

function siteCoord(s: Site): { lat: number; lng: number } | null {
  if (s.geo_point_2d?.lat != null && s.geo_point_2d?.lon != null) {
    return { lat: s.geo_point_2d.lat, lng: s.geo_point_2d.lon };
  }
  if (s.latitude != null && s.longitude != null) {
    const lat = Number(s.latitude);
    const lng = Number(s.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

async function fetchAllSites(): Promise<Site[]> {
  const cKey = cacheKey("unesco:dataset", { kind: "whc-v1" });
  const cached = await cacheGet<Site[]>(cKey);
  if (cached) return cached;

  let raw: unknown;
  try {
    const res = await fetch(UNESCO_DATASET_URL, {
      headers: {
        "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(UNESCO_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("unesco HTTP error", { status: res.status });
      // Cache the empty result for a day so we don't hammer on failure.
      await cacheSet(cKey, "unesco:dataset", [], 1);
      return [];
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("unesco fetch failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // The export endpoint returns either an array directly or { results: [] }
  // depending on Opendatasoft's API version. Handle both.
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === "object" && "results" in raw) {
    const results = (raw as { results?: unknown }).results;
    if (Array.isArray(results)) arr = results;
  }

  const out: Site[] = [];
  for (const item of arr) {
    const parsed = siteSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }

  await cacheSet(cKey, "unesco:dataset", out, 30);
  return out;
}

function siteToCandidate(s: Site): RawCandidate | null {
  const coord = siteCoord(s);
  if (!coord) return null;
  const id = String(s.unique_number ?? s.id_no ?? `${s.name_en}-${coord.lat}`);
  const description =
    s.short_description_en ??
    (s.long_description_en
      ? s.long_description_en.slice(0, 320).replace(/\s+/g, " ")
      : null);
  const tags: Record<string, string> = {
    "unesco:world_heritage": "yes",
  };
  if (s.category_short) tags["unesco:category"] = s.category_short;
  else if (s.category) tags["unesco:category"] = s.category;
  if (s.date_inscribed) tags["unesco:inscribed"] = String(s.date_inscribed);
  if (s.states_name_en) tags["unesco:state_party"] = s.states_name_en;
  return {
    externalId: id,
    source: "unesco-heritage",
    lat: coord.lat,
    lng: coord.lng,
    name: s.name_en ?? null,
    description,
    knownImageUrl: null,
    tags,
    associatedFilms: [],
    sourceUrl: `https://whc.unesco.org/en/list/${s.id_no ?? ""}`,
  };
}

export const unescoHeritageProvider: CandidateProvider = {
  name: "unesco-heritage",
  // Global dataset; 1,248 sites total. Cheap to filter in-memory.
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    let sites: Site[];
    try {
      sites = await fetchAllSites();
    } catch (err) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const out: RawCandidate[] = [];
    for (const s of sites) {
      const coord = siteCoord(s);
      if (!coord) continue;
      if (
        coord.lat < input.bbox.south ||
        coord.lat > input.bbox.north ||
        coord.lng < input.bbox.west ||
        coord.lng > input.bbox.east
      ) {
        continue;
      }
      const c = siteToCandidate(s);
      if (c) out.push(c);
    }
    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
