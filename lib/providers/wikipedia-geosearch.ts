import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
import { extractKeywords } from "@/lib/providers/keywords";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Wikipedia geosearch + page metadata in ONE combined query.
//
// MediaWiki's Action API lets us combine a `geosearch` generator with
// `pageimages`, `pageterms`, and `pageprops` props in a single request:
//
//   ?action=query
//   &generator=geosearch&ggsbbox=N|W|S|E&ggslimit=50
//   &prop=pageimages|pageterms|pageprops
//   &piprop=thumbnail|original&pithumbsize=1024
//   &wbptterms=description
//   &ppprop=wikibase_item
//
// Returns, in one round-trip, every Wikipedia page in the bbox with:
//   - title, pageid, lat/lng                  (geosearch)
//   - thumbnail URL                           (pageimages)
//   - description                             (pageterms)
//   - Wikidata Q-id (`wikibase_item`)         (pageprops)
//
// That Q-id is the key: it's what TMDb's /find endpoint accepts to
// resolve film posters when the article is about a film, and it's what
// the dedupe step uses to merge with Wikidata-source candidates.
//
// Free, no API key. Polite User-Agent strongly recommended (MediaWiki
// rate-limits aggressive scrapers without one).
// License: CC BY-SA 4.0 — surface attribution wherever description /
// image is displayed.
// ---------------------------------------------------------------------------

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const TIMEOUT_MS = 15_000;

/**
 * Wikipedia GeoData "type" field — keep landmark-like classes only.
 * Filters out "city", "country", "adm1st" (states/provinces) which would
 * blanket the bbox with non-actionable results.
 */
const KEEP_TYPES = new Set([
  "landmark",
  "edu",
  "railwaystation",
  "airport",
  "mountain",
  "waterbody",
  "isle",
  "river",
  "forest",
  "glacier",
  "event",
]);

const combinedResponseSchema = z.object({
  query: z
    .object({
      pages: z
        .record(
          z.string(),
          z.object({
            pageid: z.number(),
            title: z.string(),
            coordinates: z
              .array(
                z.object({
                  lat: z.number(),
                  lon: z.number(),
                  type: z.string().optional(),
                  name: z.string().optional(),
                }),
              )
              .optional(),
            thumbnail: z
              .object({
                source: z.string(),
                width: z.number().optional(),
                height: z.number().optional(),
              })
              .optional(),
            original: z
              .object({
                source: z.string(),
              })
              .optional(),
            terms: z
              .object({
                description: z.array(z.string()).optional(),
                label: z.array(z.string()).optional(),
              })
              .optional(),
            pageprops: z
              .object({
                wikibase_item: z.string().optional(),
              })
              .optional(),
          }),
        )
        .default({}),
    })
    .default({ pages: {} }),
});

/**
 * Build a `generator=geosearch` URL — pages with coords inside the bbox.
 */
function buildGeosearchUrl(bbox: ProviderInput["bbox"]): URL {
  const gsbbox = `${bbox.north}|${bbox.west}|${bbox.south}|${bbox.east}`;
  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("generator", "geosearch");
  url.searchParams.set("ggsbbox", gsbbox);
  url.searchParams.set("ggslimit", "500");
  url.searchParams.set("ggsprop", "type|name");
  url.searchParams.set("prop", "pageimages|pageterms|pageprops|coordinates");
  url.searchParams.set("piprop", "thumbnail|original");
  url.searchParams.set("pithumbsize", "1024");
  url.searchParams.set("wbptterms", "description");
  url.searchParams.set("ppprop", "wikibase_item");
  return url;
}

/**
 * Build a `generator=search` URL — full-text search over Wikipedia
 * articles, sorted by distance from the bbox center, with the same
 * pageimages/pageterms/coordinates props attached. The `srsort=relevance`
 * mode combined with our post-filter (article must have coords INSIDE
 * the bbox) gives us the user's keyword as a real retrieval signal,
 * not just a tag-overlap reranker.
 */
function buildFullTextSearchUrl(
  bbox: ProviderInput["bbox"],
  searchTerm: string,
): URL {
  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", searchTerm);
  url.searchParams.set("gsrnamespace", "0");
  // 50 results — the searchresult relevance ordering is high-quality
  // even at low limit, and we still post-filter by bbox so we don't
  // want a giant working set.
  url.searchParams.set("gsrlimit", "50");
  url.searchParams.set("gsrsort", "relevance");
  url.searchParams.set("prop", "pageimages|pageterms|pageprops|coordinates");
  url.searchParams.set("piprop", "thumbnail|original");
  url.searchParams.set("pithumbsize", "1024");
  url.searchParams.set("wbptterms", "description");
  url.searchParams.set("ppprop", "wikibase_item");
  // Coords prop: if a page has multiple coords (rare), keep the primary.
  url.searchParams.set("colimit", "max");
  return url;
}

async function fetchAndParse(
  url: URL,
): Promise<z.infer<typeof combinedResponseSchema> | { error: string }> {
  let raw: unknown;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    raw = await res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = combinedResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `schema_mismatch:${parsed.error.issues[0]?.message ?? ""}` };
  }
  return parsed.data;
}

function pageToCandidate(
  pageIdStr: string,
  page: z.infer<typeof combinedResponseSchema>["query"]["pages"][string],
  bbox: ProviderInput["bbox"],
): RawCandidate | null {
  if (pageIdStr.startsWith("-")) return null;
  const coord = page.coordinates?.[0];
  if (!coord) return null;
  // CRITICAL post-filter: full-text search returns articles with coords
  // ANYWHERE on Earth that match the keyword. We only want the ones
  // physically inside the bbox.
  if (
    coord.lat < bbox.south ||
    coord.lat > bbox.north ||
    coord.lon < bbox.west ||
    coord.lon > bbox.east
  ) {
    return null;
  }
  if (coord.type && !KEEP_TYPES.has(coord.type)) return null;

  const description = page.terms?.description?.[0] ?? null;
  const thumb = page.thumbnail?.source ?? page.original?.source ?? null;
  const qid = page.pageprops?.wikibase_item ?? null;
  const tags: Record<string, string> = {};
  if (coord.type) tags["wikipedia:type"] = coord.type;
  if (qid) tags["wikidata:qid"] = qid;

  return {
    externalId: String(page.pageid),
    source: "wikipedia-geosearch",
    lat: coord.lat,
    lng: coord.lon,
    name: coord.name ?? page.title,
    description,
    knownImageUrl: thumb,
    tags,
    associatedFilms: [],
    sourceUrl: `https://en.wikipedia.org/?curid=${page.pageid}`,
  };
}

/**
 * Build the keyword string for the full-text search from scene_tokens.
 * Delegates to the shared multi-token helper so NPS, RIDB, and we all
 * speak the same dialect — top-3 distinctive tokens, joined with
 * spaces. MediaWiki's BM25 ranks pages by how many of these tokens
 * hit; a multi-token query gives strictly higher recall than picking
 * a single longest token.
 */
function buildSearchTerm(sceneTokens: ReadonlyArray<string>): string | null {
  const { joined } = extractKeywords(sceneTokens, {
    minLength: 3,
    maxTokens: 3,
  });
  return joined.length > 0 ? joined : null;
}

export const wikipediaGeosearchProvider: CandidateProvider = {
  name: "wikipedia-geosearch",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox, sceneTokens } = input;

    // Self-skip when the planner asked us to gate on the upstream
    // Q-id pool AND that pool already covers the bbox. Saves a full
    // MediaWiki round-trip when Wikidata + OSM already produced
    // candidates with sitelinks (which lib/wikipedia-extracts will
    // pick up directly from sitelinks.enwiki).
    if (
      input.queryHints?.wikipediaRunOnlyWhenNoQids === true &&
      (input.queryHints.wikipediaUpstreamQids?.length ?? 0) > 0
    ) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: null,
        debug: {
          skipReason: `gated by retrieval_plan: ${input.queryHints.wikipediaUpstreamQids?.length ?? 0} upstream Q-ids — extracts handled via sitelinks`,
          request: {
            api: WIKIPEDIA_API,
            run_only_when_no_qids: true,
            upstreamQidCount: input.queryHints.wikipediaUpstreamQids?.length ?? 0,
          },
        },
      };
    }

    const searchTerm = buildSearchTerm(sceneTokens);

    const cKey = cacheKey("wikipedia:geosearch", {
      kind: "v4-geosearch+fulltext",
      bbox,
      searchTerm: searchTerm ?? "",
    });
    const debugRequest = {
      api: WIKIPEDIA_API,
      searchTerm,
      geosearchUrl: buildGeosearchUrl(bbox),
      fullTextUrl: searchTerm ? buildFullTextSearchUrl(bbox, searchTerm) : null,
    };

    const cached = await cacheGet<RawCandidate[]>(cKey);
    if (cached) {
      return {
        candidates: cached,
        elapsedMs: Date.now() - t0,
        error: null,
        debug: { fromCache: true, request: debugRequest },
      };
    }

    // Run geosearch (broad bbox sweep) + optionally full-text search
    // (keyword-driven, post-filtered to bbox) in parallel.
    type FetchResult = Awaited<ReturnType<typeof fetchAndParse>>;
    const requests: Array<Promise<FetchResult>> = [
      fetchAndParse(buildGeosearchUrl(bbox)),
    ];
    if (searchTerm) {
      requests.push(fetchAndParse(buildFullTextSearchUrl(bbox, searchTerm)));
    }
    const settled = await Promise.allSettled(requests);

    const merged = new Map<string, RawCandidate>();
    let anySucceeded = false;
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!;
      const kind = i === 0 ? "geosearch" : "fulltext";
      if (r.status !== "fulfilled") {
        logger.warn("wikipedia-geosearch query failed", {
          kind,
          err: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
        continue;
      }
      if ("error" in r.value) {
        logger.warn("wikipedia-geosearch query error", { kind, err: r.value.error });
        continue;
      }
      anySucceeded = true;
      for (const [pageIdStr, page] of Object.entries(r.value.query.pages)) {
        const c = pageToCandidate(pageIdStr, page, bbox);
        if (!c) continue;
        if (!merged.has(c.externalId)) merged.set(c.externalId, c);
      }
    }

    if (!anySucceeded) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: "all_queries_failed",
        debug: { request: debugRequest },
      };
    }

    const out = Array.from(merged.values());
    await cacheSet(cKey, "wikipedia:geosearch", out, 7);
    return {
      candidates: out,
      elapsedMs: Date.now() - t0,
      error: null,
      debug: { request: debugRequest },
    };
  },
};
