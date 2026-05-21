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
 * of generic buildings, monuments, and sculptures. The `wdt:P31/wdt:P279*`
 * pattern matches anything that *is an instance of something that is a
 * subclass-of (transitively) one of these classes*, but the transitive
 * walk through Wikidata's class graph is fragile — many monument items
 * have a P31 chain that doesn't reach Q386724 (work of art) cleanly.
 * So we list specific monument/sculpture/memorial classes EXPLICITLY.
 *
 * Q-ID            What it is
 * --------------- --------------------------------
 * Architectural / structures:
 *   Q41176        building
 *   Q35112127     architectural structure
 *   Q33506        museum
 *   Q839954       archaeological site
 *   Q15040597     historic site
 *   Q57821        fortification (forts, castles)
 *   Q16970        church
 *   Q3947         house (single-family / townhouse / etc.)
 *   Q1248784     railway station
 *   Q150784       lighthouse
 *   Q108325       hotel
 * Monuments / sculpture / public art (added M4.2):
 *   Q386724       work of art (root class)
 *   Q179700       monument
 *   Q860861       sculpture
 *   Q190619       equestrian statue  <-- direct-match for horse statue prompts
 *   Q4989906      memorial (sometimes used)
 *   Q5707594      memorial (alternative class)
 *   Q1093829      visual artwork
 *   Q5029076      column / pillar (obelisk class)
 *   Q12277        obelisk
 */
const TARGET_CLASSES = [
  "wd:Q41176",
  "wd:Q35112127",
  "wd:Q33506",
  "wd:Q839954",
  "wd:Q15040597",
  "wd:Q57821",
  "wd:Q16970",
  "wd:Q3947",
  "wd:Q1248784",
  "wd:Q150784",
  "wd:Q108325",
  "wd:Q386724",
  "wd:Q179700",
  "wd:Q860861",
  "wd:Q190619",
  "wd:Q4989906",
  "wd:Q5707594",
  "wd:Q1093829",
  "wd:Q5029076",
  "wd:Q12277",
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

/**
 * Wikidata properties pulled in OPTIONAL blocks so we surface card-
 * ready facts (year built, sculptor, material, genre, named-after,
 * Commons gallery) without losing candidates that don't have them.
 *
 *   P571   inception (year built / created)
 *   P170   creator (sculptor / artist)
 *   P84    architect
 *   P5398  building period architect (used for older heritage)
 *   P186   made from material (bronze, marble, stone)
 *   P136   genre (art / architecture genre)
 *   P138   named after (statue named after a person)
 *   P361   part of (parent location, e.g. Central Park)
 *   P527   has part (sub-elements; rarely useful)
 *   P373   Commons category (gallery slug)
 *
 * GROUP_CONCAT collapses multiple values per item into a single
 * delimited string so SPARQL still returns one row per item.
 */
function buildSparqlQuery(bbox: Bbox, limit: number): string {
  const sw = `Point(${bbox.west} ${bbox.south})`;
  const ne = `Point(${bbox.east} ${bbox.north})`;
  return `
SELECT DISTINCT
  ?item ?itemLabel ?itemDescription ?coord ?image ?article ?sitelinks
  ?inception ?commonsCat
  (GROUP_CONCAT(DISTINCT ?creatorLabel; SEPARATOR="|") AS ?creators)
  (GROUP_CONCAT(DISTINCT ?architectLabel; SEPARATOR="|") AS ?architects)
  (GROUP_CONCAT(DISTINCT ?materialLabel; SEPARATOR="|") AS ?materials)
  (GROUP_CONCAT(DISTINCT ?genreLabel; SEPARATOR="|") AS ?genres)
  (GROUP_CONCAT(DISTINCT ?depictsLabel; SEPARATOR="|") AS ?depicts)
  (GROUP_CONCAT(DISTINCT ?namedAfterLabel; SEPARATOR="|") AS ?namedAfter)
  (GROUP_CONCAT(DISTINCT ?partOfLabel; SEPARATOR="|") AS ?partOf)
  (GROUP_CONCAT(DISTINCT ?hasPartLabel; SEPARATOR="|") AS ?hasParts)
  (GROUP_CONCAT(DISTINCT ?altLabel; SEPARATOR="|") AS ?altLabels)
WHERE {
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
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P373 ?commonsCat . }
  OPTIONAL { ?item wdt:P170 ?creator .
             ?creator rdfs:label ?creatorLabel . FILTER(LANG(?creatorLabel) = "en") }
  OPTIONAL { ?item wdt:P84 ?architect .
             ?architect rdfs:label ?architectLabel . FILTER(LANG(?architectLabel) = "en") }
  OPTIONAL { ?item wdt:P5398 ?architect2 .
             ?architect2 rdfs:label ?architectLabel . FILTER(LANG(?architectLabel) = "en") }
  OPTIONAL { ?item wdt:P186 ?material .
             ?material rdfs:label ?materialLabel . FILTER(LANG(?materialLabel) = "en") }
  OPTIONAL { ?item wdt:P136 ?genre .
             ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en") }
  OPTIONAL { ?item wdt:P180 ?depicts .
             ?depicts rdfs:label ?depictsLabel . FILTER(LANG(?depictsLabel) = "en") }
  OPTIONAL { ?item wdt:P138 ?namedAfter .
             ?namedAfter rdfs:label ?namedAfterLabel . FILTER(LANG(?namedAfterLabel) = "en") }
  OPTIONAL { ?item wdt:P361 ?partOf .
             ?partOf rdfs:label ?partOfLabel . FILTER(LANG(?partOfLabel) = "en") }
  OPTIONAL { ?item wdt:P527 ?hasPart .
             ?hasPart rdfs:label ?hasPartLabel . FILTER(LANG(?hasPartLabel) = "en") }
  OPTIONAL { ?item skos:altLabel ?altLabel . FILTER(LANG(?altLabel) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?item ?itemLabel ?itemDescription ?coord ?image ?article ?sitelinks ?inception ?commonsCat
ORDER BY DESC(BOUND(?image)) DESC(?sitelinks) ?item
LIMIT ${Math.max(1, Math.min(limit, 500))}
`.trim();
}

/**
 * Subject Q-id lookup table for `wdt:P180` (depicts) queries.
 *
 * Wikidata's "depicts" property links an artwork (sculpture, painting,
 * etc.) to the THINGS it portrays. For "horse statue" we want every
 * sculpture with `wdt:P180 = Q726 (horse)`. This is dramatically more
 * precise than a free-text search.
 *
 * The table is intentionally small and high-value — common subjects
 * that motion-picture scouts ask for. Unrecognized tokens fall through
 * to the label-regex fallback below.
 */
const SUBJECT_QIDS: Record<string, string> = {
  horse: "Q726",
  dog: "Q144",
  cat: "Q146",
  lion: "Q140",
  eagle: "Q2092297",
  ship: "Q11446",
  boat: "Q35872",
  bicycle: "Q11442",
  car: "Q1420",
  airplane: "Q197",
  woman: "Q467",
  man: "Q8441",
  child: "Q7569",
  soldier: "Q4991371",
  president: "Q11696",
  general: "Q11774891",
  king: "Q12097",
  queen: "Q116",
  buffalo: "Q156854",
  bear: "Q3010",
  tiger: "Q19939",
  whale: "Q160", // generic mammal but covers many memorial sculptures
  ship_wheel: "Q1142935",
  cannon: "Q81210",
  obelisk: "Q12277",
  cross: "Q1366580", // Christian cross
  angel: "Q235113",
  fountain: "Q483453",
  arch: "Q12277", // archway / triumphal arch
};

/**
 * Build a P180 query that finds artworks (sculpture/monument/painting)
 * inside the bbox whose `wdt:P180` matches one of `subjectQids`. Joins
 * to the same wikibase:box service for spatial filtering.
 */
function buildP180Query(
  bbox: Bbox,
  subjectQids: ReadonlyArray<string>,
  limit: number,
): string {
  const sw = `Point(${bbox.west} ${bbox.south})`;
  const ne = `Point(${bbox.east} ${bbox.north})`;
  const subjects = subjectQids.map((q) => `wd:${q}`).join(" ");
  return `
SELECT DISTINCT
  ?item ?itemLabel ?itemDescription ?coord ?image ?article ?sitelinks
WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "${sw}"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "${ne}"^^geo:wktLiteral .
  }
  VALUES ?subject { ${subjects} }
  ?item wdt:P180 ?subject .
  FILTER NOT EXISTS {
    ?item wdt:P31 ?excludedType .
    VALUES ?excludedType { ${EXCLUDE_MACRO_TYPES.join(" ")} }
  }
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(BOUND(?image)) DESC(?sitelinks) ?item
LIMIT ${Math.max(1, Math.min(limit, 200))}
`.trim();
}

/**
 * Label-regex fallback: when scene_tokens contain a word we don't have
 * a Q-id for, run a regex against the item's English label inside the
 * bbox. Catches "lighthouse", "windmill", "carousel" (no canonical
 * Q-id needed) and gives the same per-source ranking signal as the
 * class-based and P180 queries.
 */
function buildLabelRegexQuery(
  bbox: Bbox,
  pattern: string,
  limit: number,
): string {
  const sw = `Point(${bbox.west} ${bbox.south})`;
  const ne = `Point(${bbox.east} ${bbox.north})`;
  // Escape backslashes for SPARQL string literal.
  const escaped = pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `
SELECT DISTINCT
  ?item ?itemLabel ?itemDescription ?coord ?image ?article ?sitelinks
WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "${sw}"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "${ne}"^^geo:wktLiteral .
  }
  ?item rdfs:label ?label .
  FILTER(LANG(?label) = "en")
  FILTER(REGEX(LCASE(STR(?label)), "${escaped}", "i"))
  FILTER NOT EXISTS {
    ?item wdt:P31 ?excludedType .
    VALUES ?excludedType { ${EXCLUDE_MACRO_TYPES.join(" ")} }
  }
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(BOUND(?image)) DESC(?sitelinks) ?item
LIMIT ${Math.max(1, Math.min(limit, 200))}
`.trim();
}

/**
 * Pull subject keywords from the user's scene_tokens. Returns matching
 * Q-ids for P180 lookup AND any leftover keywords for the label-regex
 * fallback.
 */
function extractSubjects(sceneTokens: ReadonlyArray<string>): {
  qids: string[];
  regexFallbackTerms: string[];
} {
  const qids = new Set<string>();
  const fallback = new Set<string>();
  for (const t of sceneTokens) {
    const norm = t.trim().toLowerCase();
    if (!norm) continue;
    // Skip tokens that are too generic to be useful subjects.
    if (
      ["the", "a", "an", "of", "in", "with", "and", "or", "park", "tree",
       "trees", "grass", "sky", "background", "outdoor", "exterior",
       "interior", "building", "house"].includes(norm)
    ) {
      continue;
    }
    // Single words go through both pipelines; phrases just regex.
    const isPhrase = /\s/.test(norm);
    const lookup = SUBJECT_QIDS[norm];
    if (lookup) {
      qids.add(lookup);
    } else if (!isPhrase && norm.length >= 4) {
      // 4+ chars only — short words ("art", "old") match too broadly.
      fallback.add(norm);
    }
  }
  return {
    qids: Array.from(qids),
    regexFallbackTerms: Array.from(fallback).slice(0, 3),
  };
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
        // Card-ready Wikidata facts (all OPTIONAL — most items only
        // fill a subset). GROUP_CONCAT delimits multi-value props with
        // "|" so we can split client-side without re-fetching.
        inception: z.object({ value: z.string() }).optional(),
        commonsCat: z.object({ value: z.string() }).optional(),
        creators: z.object({ value: z.string() }).optional(),
        architects: z.object({ value: z.string() }).optional(),
        materials: z.object({ value: z.string() }).optional(),
        genres: z.object({ value: z.string() }).optional(),
        depicts: z.object({ value: z.string() }).optional(),
        namedAfter: z.object({ value: z.string() }).optional(),
        partOf: z.object({ value: z.string() }).optional(),
        hasParts: z.object({ value: z.string() }).optional(),
        altLabels: z.object({ value: z.string() }).optional(),
      }),
    ),
  }),
});

/**
 * Split a SPARQL GROUP_CONCAT-delimited string ("a|b|c") into a unique,
 * trimmed, max-3-element array. Keeps the card payload light — three
 * creators / materials / genres is plenty for any UI surface.
 */
function splitFacts(s: string | undefined, max = 3): string[] {
  if (!s) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split("|")) {
    const t = raw.trim();
    if (!t) continue;
    const norm = t.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Normalise an inception literal to a 4-digit year string when
 * possible. SPARQL returns ISO datetimes ("1885-10-28T00:00:00Z") for
 * P571 — we surface the year only on the card.
 */
function normaliseInception(s: string | undefined): string | null {
  if (!s) return null;
  const yearMatch = s.match(/^-?(\d{1,4})/);
  return yearMatch ? yearMatch[1]! : s;
}

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

/**
 * Parse a SPARQL response into RawCandidates. Pure helper.
 *
 * Populates the Wikidata facts payload from the OPTIONAL props
 * harvested by the SPARQL query so the card can surface year built,
 * sculptor, material, genre, named-after, Commons gallery, and alt
 * labels without an extra REST round-trip per candidate.
 */
function parseSparqlBindings(raw: unknown): RawCandidate[] | null {
  const parsed = sparqlBindingsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const out: RawCandidate[] = [];
  for (const b of parsed.data.results.bindings) {
    const point = parseWktPoint(b.coord.value);
    if (!point) continue;
    const qid = qidFromUri(b.item.value);
    const facts = {
      inception: normaliseInception(b.inception?.value),
      creators: splitFacts(b.creators?.value),
      architects: splitFacts(b.architects?.value),
      materials: splitFacts(b.materials?.value),
      genres: splitFacts(b.genres?.value),
      depicts: splitFacts(b.depicts?.value, 5),
      namedAfter: splitFacts(b.namedAfter?.value),
      partOf: splitFacts(b.partOf?.value),
      hasParts: splitFacts(b.hasParts?.value),
      commonsCategory: b.commonsCat?.value ?? null,
      altLabels: splitFacts(b.altLabels?.value, 6),
    };
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
      wikidataFacts: facts,
    });
  }
  return out;
}

export const wikidataLandmarkProvider: CandidateProvider = {
  name: "wikidata-landmark",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox, sceneTokens } = input;

    const subjects = extractSubjects(sceneTokens);

    const cKey = cacheKey("wikidata:sparql", {
      kind: "landmark-v5-facts-enriched",
      bbox,
      classes: TARGET_CLASSES,
      subjectQids: [...subjects.qids].sort(),
      regexFallbackTerms: [...subjects.regexFallbackTerms].sort(),
    });

    const cached = await cacheGet<RawCandidate[]>(cKey);
    if (cached) {
      return { candidates: cached, elapsedMs: Date.now() - t0, error: null };
    }

    // Build the queries we want to run in parallel:
    //   1. Class-based bbox query (existing behaviour) — broad recall
    //      across all monuments / buildings / heritage sites.
    //   2. P180-depicts query — laser-precise for "horse statue" type
    //      prompts when we recognise the subject.
    //   3. Label-regex fallback — for prompts whose subject isn't in
    //      our Q-id table ("lighthouse", "windmill") so the user's
    //      keyword still drives retrieval.
    const queries: Array<{ kind: string; sparql: string }> = [
      { kind: "class-bbox", sparql: buildSparqlQuery(bbox, 500) },
    ];
    if (subjects.qids.length > 0) {
      queries.push({
        kind: "p180-depicts",
        sparql: buildP180Query(bbox, subjects.qids, 200),
      });
    }
    if (subjects.regexFallbackTerms.length > 0) {
      // Combine fallback terms into one disjunctive regex to keep us
      // at one extra round-trip rather than N.
      const pattern = subjects.regexFallbackTerms
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      queries.push({
        kind: "label-regex",
        sparql: buildLabelRegexQuery(bbox, pattern, 200),
      });
    }

    const results = await Promise.allSettled(
      queries.map((q) => executeSparql(q.sparql).then((raw) => ({ kind: q.kind, raw }))),
    );

    const merged = new Map<string, RawCandidate>();
    let anySucceeded = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status !== "fulfilled") {
        logger.warn("wikidata-landmark provider: query failed", {
          kind: queries[i]?.kind ?? "unknown",
          err: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
        continue;
      }
      const parsed = parseSparqlBindings(r.value.raw);
      if (!parsed) {
        logger.warn("wikidata-landmark provider: schema mismatch", {
          kind: r.value.kind,
        });
        continue;
      }
      anySucceeded = true;
      // Earlier queries (class-bbox at index 0) take precedence on
      // duplicates so the broad-recall results keep their Q-id ordering;
      // P180 / label-regex fill in misses without overriding the seed.
      for (const c of parsed) {
        if (!merged.has(c.externalId)) merged.set(c.externalId, c);
      }
    }

    if (!anySucceeded) {
      return { candidates: [], elapsedMs: Date.now() - t0, error: "all_queries_failed" };
    }

    const out = Array.from(merged.values());
    await cacheSet(cKey, "wikidata:sparql", out, 7);
    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
