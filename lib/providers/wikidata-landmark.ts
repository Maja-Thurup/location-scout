import { z } from "zod";

import { type Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Wikidata SPARQL — generic landmark / heritage / building provider.
//
// Returns notable buildings, monuments, churches, museums, ruins, historic
// houses, etc. inside the bbox. Each item carries a Wikipedia-quality
// description and (often) a Wikimedia Commons photo URL — both are far
// stronger inputs to the vision scorer than raw OSM tags.
//
// SPARQL endpoint: https://query.wikidata.org/sparql
// No API key. Generous rate limits with a polite User-Agent.
// License: CC0 for data. Wikimedia images are CC BY-SA — surface
// attribution wherever they're displayed.
// ---------------------------------------------------------------------------

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const SPARQL_TIMEOUT_MS = 15_000;

/**
 * Wikidata classes we accept as "filming-location-relevant landmarks". Mix
 * of generic buildings and culturally interesting subclasses. The
 * `wdt:P31/wdt:P279*` pattern matches anything that *is an instance of
 * something that is a subclass-of (transitively) one of these classes*,
 * which covers most variants without us having to enumerate.
 *
 * Q-ID            What it is
 * --------------- --------------------------------
 * wd:Q41176       building
 * wd:Q35112127    architectural structure
 * wd:Q33506       museum
 * wd:Q839954      archaeological site
 * wd:Q15040597    historic site
 * wd:Q386724      work of art / monument (covers monuments, statues)
 * wd:Q57821       fortification (forts, castles)
 * wd:Q16970       church
 * wd:Q3947        house (single-family / townhouse / etc.)
 * wd:Q1248784     railway station
 * wd:Q150784      lighthouse
 * wd:Q108325      hotel
 *
 * We deliberately exclude very generic classes (Q4022 = body of water,
 * Q22698 = park) because the vision pipeline already handles those
 * via OSM and Wikipedia geosearch.
 */
const TARGET_CLASSES = [
  "wd:Q41176",
  "wd:Q35112127",
  "wd:Q33506",
  "wd:Q839954",
  "wd:Q15040597",
  "wd:Q386724",
  "wd:Q57821",
  "wd:Q16970",
  "wd:Q3947",
  "wd:Q1248784",
  "wd:Q150784",
  "wd:Q108325",
];

/**
 * Same macro-region exclusion list as the filming-location provider.
 * Even when targeting buildings/heritage, the `wdt:P279*` transitive
 * subclass walk can pull in a "human settlement" hit when a city
 * coincidentally has P31=museum (oddly common via redirects).
 */
const EXCLUDE_MACRO_TYPES = [
  "wd:Q515",       // city
  "wd:Q1093829",   // city in the United States
  "wd:Q1549591",
  "wd:Q3957",
  "wd:Q5119",
  "wd:Q15284",
  "wd:Q486972",
  "wd:Q3257686",
  "wd:Q484170",
  "wd:Q123705",    // neighborhood
  "wd:Q41535",     // NYC borough
  "wd:Q149621",
  "wd:Q1149652",
  "wd:Q35657",     // US state
];

function buildSparqlQuery(bbox: Bbox, limit: number): string {
  const sw = `Point(${bbox.west} ${bbox.south})`;
  const ne = `Point(${bbox.east} ${bbox.north})`;
  return `
SELECT DISTINCT ?item ?itemLabel ?itemDescription ?coord ?image ?article WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "${sw}"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "${ne}"^^geo:wktLiteral .
  }
  VALUES ?type { ${TARGET_CLASSES.join(" ")} }
  ?item wdt:P31/wdt:P279* ?type .
  FILTER NOT EXISTS {
    ?item wdt:P31 ?excludedType .
    VALUES ?excludedType { ${EXCLUDE_MACRO_TYPES.join(" ")} }
  }
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${Math.max(1, Math.min(limit, 200))}
`.trim();
}

const sparqlBindingsSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: z.object({ value: z.string() }),
        itemLabel: z.object({ value: z.string() }).optional(),
        itemDescription: z.object({ value: z.string() }).optional(),
        coord: z.object({ value: z.string() }),
        image: z.object({ value: z.string() }).optional(),
        article: z.object({ value: z.string() }).optional(),
      }),
    ),
  }),
});

const POINT_RE = /^Point\(([-0-9.]+)\s+([-0-9.]+)\)$/;

function parseWktPoint(s: string): { lat: number; lng: number } | null {
  const m = POINT_RE.exec(s);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

function qidFromUri(uri: string): string {
  // Wikidata item URIs: http://www.wikidata.org/entity/Q123
  const last = uri.split("/").pop();
  return last ?? uri;
}

async function executeSparql(query: string): Promise<unknown> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      // Wikidata asks for a polite User-Agent identifying the project.
      "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
    },
    signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikidata SPARQL HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Wikimedia images come as `http://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg`.
 * That URL 302-redirects to the actual upload URL, which our image
 * fetcher can follow. We rewrite to a thumbnail URL so we get an
 * appropriate-size image cheaply.
 *
 * Format: `https://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg?width=800`.
 */
function rewriteCommonsThumb(url: string, width = 1024): string {
  // Replace any "/Special:FilePath/..." with the same plus ?width=N.
  if (url.includes("Special:FilePath/")) {
    return url.includes("?") ? `${url}&width=${width}` : `${url}?width=${width}`;
  }
  return url;
}

export const wikidataLandmarkProvider: CandidateProvider = {
  name: "wikidata-landmark",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox } = input;

    const cKey = cacheKey("wikidata:sparql", {
      kind: "landmark-v2-no-macro",
      bbox,
      classes: TARGET_CLASSES,
    });

    const cached = await cacheGet<RawCandidate[]>(cKey);
    if (cached) {
      return { candidates: cached, elapsedMs: Date.now() - t0, error: null };
    }

    const query = buildSparqlQuery(bbox, 100);
    let raw: unknown;
    try {
      raw = await executeSparql(query);
    } catch (err) {
      logger.warn("wikidata-landmark provider: SPARQL fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], elapsedMs: Date.now() - t0, error: String(err) };
    }

    const parsed = sparqlBindingsSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("wikidata-landmark provider: schema mismatch", {
        issue: parsed.error.issues[0]?.message,
      });
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: "schema_mismatch",
      };
    }

    const out: RawCandidate[] = [];
    for (const b of parsed.data.results.bindings) {
      const point = parseWktPoint(b.coord.value);
      if (!point) continue;
      const qid = qidFromUri(b.item.value);
      out.push({
        externalId: qid,
        source: "wikidata-landmark",
        lat: point.lat,
        lng: point.lng,
        name: b.itemLabel?.value ?? null,
        description: b.itemDescription?.value ?? null,
        knownImageUrl: b.image?.value ? rewriteCommonsThumb(b.image.value) : null,
        tags: { "wikidata:qid": qid },
        associatedFilms: [],
        sourceUrl: b.article?.value ?? `https://www.wikidata.org/wiki/${qid}`,
      });
    }

    // 7-day cache: SPARQL results don't change often and we want fast
    // re-renders for the same bbox.
    await cacheSet(cKey, "wikidata:sparql", out, 7);

    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
