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
// Wikipedia GeoSearch + page-summary provider.
//
// MediaWiki's GeoSearch API
// (https://www.mediawiki.org/wiki/API:Geosearch) returns Wikipedia pages
// with geo-coordinates inside a bbox. We then enrich the top results
// with the REST page summary endpoint to pull a short description and
// the "originalimage" / "thumbnail" URL — Wikipedia editors curate
// good photos for landmark articles, and that's a much better default
// thumbnail than what Mapillary returns at the centroid.
//
// Free, no API key. Polite User-Agent strongly recommended.
// License: CC BY-SA — surface attribution for descriptions and images.
// ---------------------------------------------------------------------------

const GEOSEARCH_BASE = "https://en.wikipedia.org/w/api.php";
const SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary";
const TIMEOUT_MS = 12_000;

const geosearchSchema = z.object({
  query: z.object({
    geosearch: z
      .array(
        z.object({
          pageid: z.number(),
          title: z.string(),
          lat: z.number(),
          lon: z.number(),
          // Wikipedia tags pages with type="landmark" / "edu" / "city" /
          // "isle" etc. Useful as a coarse filter to avoid retrieving the
          // article for the whole city when we want individual landmarks.
          type: z.string().optional(),
          name: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

type GeosearchRow = {
  pageid: number;
  title: string;
  lat: number;
  lon: number;
  type?: string;
  name?: string;
};

const summarySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  extract: z.string().optional(),
  thumbnail: z
    .object({
      source: z.string(),
    })
    .optional(),
  originalimage: z
    .object({
      source: z.string(),
    })
    .optional(),
  content_urls: z
    .object({ desktop: z.object({ page: z.string() }).optional() })
    .optional(),
});

/**
 * Wikipedia GeoData "type" field — keep landmark-like classes only.
 * Filters out "city", "country", "adm1st" (states/provinces) which would
 * otherwise blanket the bbox with non-actionable results.
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

async function fetchGeosearch(bbox: Bbox): Promise<GeosearchRow[]> {
  // gsbbox format: "topleft|bottomright" = "north|west|south|east"
  // Wikipedia documents `top|left|bottom|right` = N|W|S|E.
  const gsbbox = `${bbox.north}|${bbox.west}|${bbox.south}|${bbox.east}`;
  const url = new URL(GEOSEARCH_BASE);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "geosearch");
  url.searchParams.set("gsbbox", gsbbox);
  url.searchParams.set("gslimit", "50");
  url.searchParams.set("gsprop", "type|name");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const res = await fetch(url, {
    headers: {
      "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikipedia geosearch HTTP ${res.status}`);
  }
  const json = await res.json();
  const parsed = geosearchSchema.safeParse(json);
  return parsed.success ? parsed.data.query.geosearch : [];
}

async function fetchSummary(
  title: string,
): Promise<{
  description: string | null;
  imageUrl: string | null;
  pageUrl: string | null;
}> {
  const url = `${SUMMARY_BASE}/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { description: null, imageUrl: null, pageUrl: null };
    }
    const json = await res.json();
    const parsed = summarySchema.safeParse(json);
    if (!parsed.success) return { description: null, imageUrl: null, pageUrl: null };
    return {
      description: parsed.data.description ?? parsed.data.extract ?? null,
      imageUrl: parsed.data.originalimage?.source ?? parsed.data.thumbnail?.source ?? null,
      pageUrl: parsed.data.content_urls?.desktop?.page ?? null,
    };
  } catch {
    return { description: null, imageUrl: null, pageUrl: null };
  }
}

export const wikipediaGeosearchProvider: CandidateProvider = {
  name: "wikipedia-geosearch",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox } = input;

    const cKey = cacheKey("wikipedia:geosearch", { kind: "v1", bbox });
    const cached = await cacheGet<RawCandidate[]>(cKey);
    if (cached) {
      return { candidates: cached, elapsedMs: Date.now() - t0, error: null };
    }

    let rows: GeosearchRow[];
    try {
      rows = await fetchGeosearch(bbox);
    } catch (err) {
      logger.warn("wikipedia-geosearch: fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], elapsedMs: Date.now() - t0, error: String(err) };
    }

    // Drop overly broad types (cities, countries, ...). Empty `type` is
    // kept — many notable buildings have no type set.
    const filtered = rows.filter((r) => !r.type || KEEP_TYPES.has(r.type));

    // Cap detail-fetch concurrency: enrich the top 30 with summary
    // (description + image). Beyond that, we still surface the
    // candidate but without the rich text/image.
    const TOP_FOR_DETAILS = 30;
    const enrichedTop = await Promise.all(
      filtered.slice(0, TOP_FOR_DETAILS).map(async (r) => {
        const detail = await fetchSummary(r.title);
        return { row: r, detail };
      }),
    );
    const minimalRest = filtered.slice(TOP_FOR_DETAILS).map((r) => ({
      row: r,
      detail: { description: null, imageUrl: null, pageUrl: null },
    }));

    const out: RawCandidate[] = [...enrichedTop, ...minimalRest].map(
      ({ row, detail }) => {
        const tags: Record<string, string> = {};
        if (row.type) tags["wikipedia:type"] = row.type;
        return {
          externalId: String(row.pageid),
          source: "wikipedia-geosearch",
          lat: row.lat,
          lng: row.lon,
          name: row.name ?? row.title,
          description: detail.description,
          knownImageUrl: detail.imageUrl,
          tags,
          associatedFilms: [],
          sourceUrl:
            detail.pageUrl ??
            `https://en.wikipedia.org/?curid=${row.pageid}`,
        };
      },
    );

    await cacheSet(cKey, "wikipedia:geosearch", out, 7);
    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
