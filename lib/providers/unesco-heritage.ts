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

const UNESCO_BASE =
  "https://data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/records";
const UNESCO_PAGE_LIMIT = 100; // Opendatasoft v2.1 hard cap
const UNESCO_TIMEOUT_MS = 30_000;

/**
 * Schema is intentionally narrow — the real Opendatasoft v2.1 record has
 * 60+ fields; we only consume the handful that map to our candidate
 * shape. Fields verified against a live sample.
 */
const siteSchema = z.object({
  id_no: z.union([z.number(), z.string()]).optional(),
  uuid: z.string().optional(),
  name_en: z.string().optional(),
  short_description_en: z.string().optional(),
  description_en: z.string().optional(),
  /** ISO category: "Cultural" / "Natural" / "Mixed". */
  category: z.string().optional(),
  /** Year inscribed. */
  date_inscribed: z.union([z.number(), z.string()]).optional(),
  /** State Party (country) names. */
  states_names: z.array(z.string()).optional(),
  iso_codes: z.string().optional(),
  region: z.string().optional(),
  /** Geo coords (Opendatasoft v2.1 records endpoint). */
  coordinates: z
    .object({ lat: z.number().optional(), lon: z.number().optional() })
    .optional(),
  main_image_url: z.string().optional(),
});

type Site = z.infer<typeof siteSchema>;

function siteCoord(s: Site): { lat: number; lng: number } | null {
  if (s.coordinates?.lat != null && s.coordinates?.lon != null) {
    return { lat: s.coordinates.lat, lng: s.coordinates.lon };
  }
  return null;
}

async function fetchAllSites(): Promise<Site[]> {
  const cKey = cacheKey("unesco:dataset", { kind: "whc-v1" });
  const cached = await cacheGet<Site[]>(cKey);
  if (cached) return cached;

  // Page through the records endpoint (Opendatasoft v2.1 caps limit at 100).
  const out: Site[] = [];
  try {
    let offset = 0;
    while (true) {
      const url = `${UNESCO_BASE}?limit=${UNESCO_PAGE_LIMIT}&offset=${offset}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
        },
        signal: AbortSignal.timeout(UNESCO_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn("unesco HTTP error", { status: res.status, offset });
        break;
      }
      const raw = (await res.json()) as {
        results?: unknown[];
      };
      const results = Array.isArray(raw.results) ? raw.results : [];
      for (const item of results) {
        const parsed = siteSchema.safeParse(item);
        if (parsed.success) out.push(parsed.data);
      }
      if (results.length < UNESCO_PAGE_LIMIT) break;
      offset += UNESCO_PAGE_LIMIT;
    }
  } catch (err) {
    logger.warn("unesco fetch failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    if (out.length === 0) return [];
  }

  await cacheSet(cKey, "unesco:dataset", out, 30);
  return out;
}

function siteToCandidate(s: Site): RawCandidate | null {
  const coord = siteCoord(s);
  if (!coord) return null;
  const id = String(s.id_no ?? s.uuid ?? `${s.name_en}-${coord.lat}`);
  const description =
    s.short_description_en ??
    (s.description_en
      ? s.description_en.slice(0, 320).replace(/\s+/g, " ")
      : null);
  const tags: Record<string, string> = {
    "unesco:world_heritage": "yes",
  };
  if (s.category) tags["unesco:category"] = s.category;
  if (s.date_inscribed) tags["unesco:inscribed"] = String(s.date_inscribed);
  if (s.states_names && s.states_names.length > 0) {
    tags["unesco:state_party"] = s.states_names.join(", ");
  }
  if (s.iso_codes) tags["unesco:iso"] = s.iso_codes;
  if (s.region) tags["unesco:region"] = s.region;
  return {
    externalId: id,
    source: "unesco-heritage",
    lat: coord.lat,
    lng: coord.lng,
    name: s.name_en ?? null,
    description,
    knownImageUrl: s.main_image_url ?? null,
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
