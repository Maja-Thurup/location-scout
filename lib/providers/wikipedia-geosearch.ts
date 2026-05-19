import { z } from "zod";

import type { Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
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

export const wikipediaGeosearchProvider: CandidateProvider = {
  name: "wikipedia-geosearch",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox } = input;

    // v2 cache namespace bump: response now has Q-id + thumbnail in one shot.
    const cKey = cacheKey("wikipedia:geosearch", { kind: "v2-combined", bbox });
    const cached = await cacheGet<RawCandidate[]>(cKey);
    if (cached) {
      return { candidates: cached, elapsedMs: Date.now() - t0, error: null };
    }

    // gsbbox format: "top|left|bottom|right" = N|W|S|E
    const gsbbox = `${bbox.north}|${bbox.west}|${bbox.south}|${bbox.east}`;
    const url = new URL(WIKIPEDIA_API);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");
    // Generator: every page with coords inside the bbox.
    url.searchParams.set("generator", "geosearch");
    url.searchParams.set("ggsbbox", gsbbox);
    url.searchParams.set("ggslimit", "50");
    url.searchParams.set("ggsprop", "type|name");
    // Props: image + description + Wikidata Q-id, all in this request.
    url.searchParams.set("prop", "pageimages|pageterms|pageprops|coordinates");
    url.searchParams.set("piprop", "thumbnail|original");
    url.searchParams.set("pithumbsize", "1024");
    url.searchParams.set("wbptterms", "description");
    url.searchParams.set("ppprop", "wikibase_item");

    let raw: unknown;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn("wikipedia-geosearch HTTP error", { status: res.status });
        return {
          candidates: [],
          elapsedMs: Date.now() - t0,
          error: `HTTP ${res.status}`,
        };
      }
      raw = await res.json();
    } catch (err) {
      logger.warn("wikipedia-geosearch fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], elapsedMs: Date.now() - t0, error: String(err) };
    }

    const parsed = combinedResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("wikipedia-geosearch schema mismatch", {
        issue: parsed.error.issues[0]?.message,
      });
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: "schema_mismatch",
      };
    }

    const out: RawCandidate[] = [];
    for (const [pageIdStr, page] of Object.entries(parsed.data.query.pages)) {
      // The "missing" / "invalid" sentinel pages have negative ids.
      if (pageIdStr.startsWith("-")) continue;
      // Pull coords from the geosearch generator output (under `coordinates`).
      const coord = page.coordinates?.[0];
      if (!coord) continue;
      // Skip overly broad types (cities, countries, ...).
      if (coord.type && !KEEP_TYPES.has(coord.type)) continue;

      const description = page.terms?.description?.[0] ?? null;
      const thumb = page.thumbnail?.source ?? page.original?.source ?? null;
      const qid = page.pageprops?.wikibase_item ?? null;

      const tags: Record<string, string> = {};
      if (coord.type) tags["wikipedia:type"] = coord.type;
      if (qid) tags["wikidata:qid"] = qid;

      out.push({
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
      });
    }

    await cacheSet(cKey, "wikipedia:geosearch", out, 7);
    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
