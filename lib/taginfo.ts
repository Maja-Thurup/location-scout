import { z } from "zod";

import { cacheGet, cacheKey, cacheSet, type TTLDays } from "@/lib/cache";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// taginfo OpenStreetMap API client.
//
// taginfo (https://taginfo.openstreetmap.org/taginfo/apidoc) is the
// canonical statistics service for OSM tags: every tag's global count,
// every value distribution, every wiki description, every co-occurring
// key. We use it for:
//
//   1. Synonym discovery (replaces a Claude prompt round-trip):
//      `key/values?key=tourism` → ["artwork", "attraction", "viewpoint",
//      "museum", ...] with per-value counts.
//
//   2. Tag validation: before sending an `osm_tags_alternatives` set to
//      Overpass, look up its global count. Tags with <100 OSM uses
//      world-wide will return zero on Overpass — we drop them early.
//
//   3. Subject dictionary: `key/values?key=artwork_subject` is the
//      gold-standard subject-noun list for sculptures (horse, eagle,
//      Liberty, Washington, ...) — discovered by the OSM community and
//      kept fresh by them.
//
//   4. Description text for IDF weighting: `key/wiki_pages` returns the
//      wiki page text describing what a tag means. We use it offline
//      to seed the lib/providers/tag-overlap.ts IDF table with values
//      grounded in real-world data, not hand-tuned guesses.
//
// API: free, no auth, JSON. Rate-limit: please add a polite User-Agent.
// ---------------------------------------------------------------------------

const TAGINFO_BASE = "https://taginfo.openstreetmap.org/api/4";
const TAGINFO_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)";

type FetchOpts = {
  /** Cache TTL in days. Defaults to 30 — tag stats churn slowly. */
  ttlDays?: TTLDays;
};

async function fetchTaginfo<T>(
  endpoint: string,
  params: Record<string, string | number>,
  schema: z.ZodType<T>,
  opts: FetchOpts = {},
): Promise<T | null> {
  const cKey = cacheKey("taginfo", { endpoint, params });
  const cached = await cacheGet<T>(cKey);
  if (cached) return cached;

  const url = new URL(`${TAGINFO_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TAGINFO_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("taginfo HTTP error", { endpoint, status: res.status });
      return null;
    }
    const raw = await res.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("taginfo schema mismatch", {
        endpoint,
        err: parsed.error.issues[0]?.message,
      });
      return null;
    }
    await cacheSet(cKey, "taginfo", parsed.data, opts.ttlDays ?? 30);
    return parsed.data;
  } catch (err) {
    logger.warn("taginfo fetch failed", { endpoint, err: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// /api/4/key/values — values for a key, sorted by global count desc.
// ---------------------------------------------------------------------------

const keyValuesSchema = z.object({
  total: z.number(),
  page: z.number().optional(),
  rp: z.number().optional(),
  data: z.array(
    z.object({
      value: z.string(),
      count: z.number(),
      fraction: z.number(),
      in_wiki: z.boolean(),
      description: z.string().optional(),
    }),
  ),
});

export type TaginfoKeyValue = z.infer<typeof keyValuesSchema>["data"][number];

/**
 * List the most-used values for a single OSM key. e.g. for
 * `key=tourism` returns artwork, attraction, viewpoint, hotel,
 * museum... with counts and (when present) wiki descriptions.
 *
 * Used by the offline dictionary builder to seed our subject-synonym
 * tables with values discovered from real OSM data, not hand-curated
 * guesses.
 */
export async function fetchKeyValues(input: {
  key: string;
  limit?: number;
  /** Sort order. Default "count_all" (most-used first). */
  sortby?: "value" | "count_all";
}): Promise<TaginfoKeyValue[] | null> {
  const data = await fetchTaginfo(
    "/key/values",
    {
      key: input.key,
      page: 1,
      rp: input.limit ?? 200,
      sortname: input.sortby ?? "count_all",
      sortorder: "desc",
    },
    keyValuesSchema,
  );
  return data?.data ?? null;
}

// ---------------------------------------------------------------------------
// /api/4/keys/all — every OSM key with global count.
// ---------------------------------------------------------------------------

const keysAllSchema = z.object({
  total: z.number(),
  page: z.number().optional(),
  rp: z.number().optional(),
  data: z.array(
    z.object({
      key: z.string(),
      count_all: z.number(),
      count_all_fraction: z.number().optional(),
      values_all: z.number().optional(),
      in_wiki: z.boolean().optional(),
      in_josm: z.boolean().optional(),
    }),
  ),
});

/**
 * Pull a page of all keys sorted by global-use count desc. The full
 * keyspace is huge (~70k unique keys); for the dictionary builder we
 * pull the top 1000 — anything below that is too rare to contribute
 * meaningful retrieval signal.
 */
export async function fetchAllKeys(input: {
  page?: number;
  perPage?: number;
} = {}): Promise<z.infer<typeof keysAllSchema>["data"] | null> {
  const data = await fetchTaginfo(
    "/keys/all",
    {
      page: input.page ?? 1,
      rp: input.perPage ?? 500,
      sortname: "count_all",
      sortorder: "desc",
    },
    keysAllSchema,
  );
  return data?.data ?? null;
}

// ---------------------------------------------------------------------------
// /api/4/key/combinations — keys frequently used alongside a target key.
// ---------------------------------------------------------------------------

const keyCombinationsSchema = z.object({
  total: z.number(),
  data: z.array(
    z.object({
      other_key: z.string(),
      together_count: z.number(),
      to_fraction: z.number().optional(),
      from_fraction: z.number().optional(),
    }),
  ),
});

/**
 * "What other keys go with this one?". For `key=tourism` the answer
 * is `name`, `artwork_type`, `artwork_subject`, `wikidata`, ... —
 * each with the fraction of `tourism=*` objects that also have it.
 * We use this to discover deep-tag clusters (`artwork_subject` for
 * sculpture subject lookups).
 */
export async function fetchKeyCombinations(input: {
  key: string;
  limit?: number;
}): Promise<z.infer<typeof keyCombinationsSchema>["data"] | null> {
  const data = await fetchTaginfo(
    "/key/combinations",
    {
      key: input.key,
      page: 1,
      rp: input.limit ?? 50,
      sortname: "together_count",
      sortorder: "desc",
    },
    keyCombinationsSchema,
  );
  return data?.data ?? null;
}

// ---------------------------------------------------------------------------
// /api/4/key/prevalent_values — top values for a key as a single
// hash (lighter than full /key/values when we only need names).
// ---------------------------------------------------------------------------

const prevalentValuesSchema = z.object({
  data: z.array(
    z.object({
      value: z.string(),
      count: z.number(),
      fraction: z.number(),
    }),
  ),
});

export async function fetchPrevalentValues(input: {
  key: string;
  limit?: number;
}): Promise<z.infer<typeof prevalentValuesSchema>["data"] | null> {
  const data = await fetchTaginfo(
    "/key/prevalent_values",
    {
      key: input.key,
      min_fraction: 0.001,
    },
    prevalentValuesSchema,
  );
  if (!data) return null;
  return data.data.slice(0, input.limit ?? 100);
}

// ---------------------------------------------------------------------------
// /api/4/key/wiki_pages — English wiki description for a key.
// ---------------------------------------------------------------------------

const keyWikiPagesSchema = z.object({
  data: z.array(
    z.object({
      lang: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      image: z
        .object({
          title: z.string().optional(),
          image_url: z.string().optional(),
        })
        .optional(),
      on_node: z.boolean().optional(),
      on_way: z.boolean().optional(),
      on_area: z.boolean().optional(),
      on_relation: z.boolean().optional(),
    }),
  ),
});

export async function fetchKeyWikiPages(input: {
  key: string;
}): Promise<z.infer<typeof keyWikiPagesSchema>["data"] | null> {
  const data = await fetchTaginfo(
    "/key/wiki_pages",
    { key: input.key },
    keyWikiPagesSchema,
    { ttlDays: 90 },
  );
  return data?.data ?? null;
}

/**
 * Look up the English description for a key from the wiki, returning
 * null when the wiki has no English entry. Used by the dictionary
 * builder to seed IDF weights with real-world descriptions.
 */
export async function fetchKeyDescription(key: string): Promise<string | null> {
  const pages = await fetchKeyWikiPages({ key });
  if (!pages) return null;
  const en = pages.find((p) => p.lang === "en");
  return en?.description?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// /api/4/tag/wiki_pages — same as above but for a key=value pair.
// ---------------------------------------------------------------------------

const tagWikiPagesSchema = keyWikiPagesSchema;

export async function fetchTagWikiPages(input: {
  key: string;
  value: string;
}): Promise<z.infer<typeof tagWikiPagesSchema>["data"] | null> {
  const data = await fetchTaginfo(
    "/tag/wiki_pages",
    { key: input.key, value: input.value },
    tagWikiPagesSchema,
    { ttlDays: 90 },
  );
  return data?.data ?? null;
}
