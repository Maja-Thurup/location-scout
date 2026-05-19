import { z } from "zod";

import { type Bbox } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
import type {
  AssociatedFilm,
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Wikidata SPARQL — filming-location provider (P915).
//
// P915 ("filming location") connects films / TV episodes / TV series to
// the actual real-world place where they were shot. As of April 2026 the
// property is populated on ~36k items, skewed toward famous productions.
//
// We turn this around: given a bbox, find every item that *appears as a
// filming location of some film*, and surface the location AS a
// candidate, attaching the films as `associatedFilms[]` for the
// "Famous films shot here" badge.
//
// SPARQL endpoint: https://query.wikidata.org/sparql
// License: CC0 for the data. Wikimedia images CC BY-SA.
// ---------------------------------------------------------------------------

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const SPARQL_TIMEOUT_MS = 18_000;

/**
 * Find anything that's been used as a filming location inside the bbox,
 * along with the films that shot there. Returns one row per (location,
 * film) pair; we group in code.
 *
 * The query joins:
 * - The location (?location, P625 coord, schema:description, P18 image)
 * - Each film that points at it via P915 (?film, P1476 title, P577 release date)
 * - Optional IMDb id (P345) for fallback joining to TMDb
 */
/**
 * Wikidata classes that represent macro / administrative regions —
 * cities, neighborhoods, boroughs, states, etc. P915 is sometimes set on
 * THESE entities (e.g. "Brooklyn" itself is the filming location of many
 * movies), but they're useless as candidates because they're enormous
 * areas, not specific filmable spots.
 *
 * The exact-instance check uses `wdt:P31 ?type` (one level), NOT
 * `wdt:P31/wdt:P279*` (transitive subclass). We don't want to accidentally
 * exclude legitimate buildings that happen to be located IN a city.
 */
const EXCLUDE_TYPES = [
  "wd:Q515",       // city
  "wd:Q1093829",   // city in the United States
  "wd:Q1549591",   // big city
  "wd:Q3957",      // town
  "wd:Q5119",      // capital
  "wd:Q7930989",   // city/town
  "wd:Q15284",     // municipality
  "wd:Q486972",    // human settlement
  "wd:Q3257686",   // locality
  "wd:Q44613",     // monastery (oddly broad — exclude)
  "wd:Q484170",    // commune
  "wd:Q2074737",   // arrondissement
  "wd:Q123705",    // neighborhood
  "wd:Q2983893",   // quarter (urban)
  "wd:Q3957420",   // borough
  "wd:Q41535",     // borough of New York City
  "wd:Q149621",    // district
  "wd:Q1149652",   // administrative territorial entity
  "wd:Q56061",     // administrative territorial entity (general)
  "wd:Q35657",     // U.S. state
  "wd:Q16464",     // demographic neighborhood
];

function buildSparqlQuery(bbox: Bbox, limit: number): string {
  const sw = `Point(${bbox.west} ${bbox.south})`;
  const ne = `Point(${bbox.east} ${bbox.north})`;
  return `
SELECT DISTINCT
  ?location ?locationLabel ?locationDescription ?coord ?image
  ?film ?filmLabel ?filmDate ?filmImdb
WHERE {
  SERVICE wikibase:box {
    ?location wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "${sw}"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "${ne}"^^geo:wktLiteral .
  }
  ?film wdt:P915 ?location .
  # Exclude macro entities (cities, neighborhoods, boroughs, ...).
  # P915 is sometimes set on these because they're "where the movie was
  # set" — but they're not filmable spots, they're whole regions.
  FILTER NOT EXISTS {
    ?location wdt:P31 ?excludedType .
    VALUES ?excludedType { ${EXCLUDE_TYPES.join(" ")} }
  }
  OPTIONAL { ?film wdt:P577 ?filmDate . }
  OPTIONAL { ?film wdt:P345 ?filmImdb . }
  OPTIONAL { ?location wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${Math.max(1, Math.min(limit, 300))}
`.trim();
}

const bindingsSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        location: z.object({ value: z.string() }),
        locationLabel: z.object({ value: z.string() }).optional(),
        locationDescription: z.object({ value: z.string() }).optional(),
        coord: z.object({ value: z.string() }),
        image: z.object({ value: z.string() }).optional(),
        film: z.object({ value: z.string() }),
        filmLabel: z.object({ value: z.string() }).optional(),
        filmDate: z.object({ value: z.string() }).optional(),
        filmImdb: z.object({ value: z.string() }).optional(),
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
  const last = uri.split("/").pop();
  return last ?? uri;
}
function rewriteCommonsThumb(url: string, width = 1024): string {
  if (url.includes("Special:FilePath/")) {
    return url.includes("?") ? `${url}&width=${width}` : `${url}?width=${width}`;
  }
  return url;
}
function yearFromIso(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(-?\d{4})/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isNaN(n) ? null : n;
}

async function executeSparql(query: string): Promise<unknown> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
    },
    signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikidata P915 SPARQL HTTP ${res.status}`);
  }
  return res.json();
}

export const wikidataFilmingLocationProvider: CandidateProvider = {
  name: "wikidata-filming-location",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox } = input;

    const cKey = cacheKey("wikidata:sparql", { kind: "filming-location-v2-no-macro", bbox });
    const cached = await cacheGet<RawCandidate[]>(cKey);
    if (cached) {
      return { candidates: cached, elapsedMs: Date.now() - t0, error: null };
    }

    const query = buildSparqlQuery(bbox, 200);
    let raw: unknown;
    try {
      raw = await executeSparql(query);
    } catch (err) {
      logger.warn("wikidata-filming-location: SPARQL fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], elapsedMs: Date.now() - t0, error: String(err) };
    }

    const parsed = bindingsSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("wikidata-filming-location: schema mismatch", {
        issue: parsed.error.issues[0]?.message,
      });
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: "schema_mismatch",
      };
    }

    // Group rows by location Q-id (one row per (location, film) pair).
    const byLocation = new Map<string, RawCandidate>();
    for (const b of parsed.data.results.bindings) {
      const point = parseWktPoint(b.coord.value);
      if (!point) continue;
      const locationQid = qidFromUri(b.location.value);
      const filmQid = qidFromUri(b.film.value);
      const film: AssociatedFilm = {
        wikidataQid: filmQid,
        title: b.filmLabel?.value ?? "Untitled film",
        year: yearFromIso(b.filmDate?.value),
        imdbId: b.filmImdb?.value ?? null,
      };

      const existing = byLocation.get(locationQid);
      if (existing) {
        const films = existing.associatedFilms as AssociatedFilm[];
        if (!films.some((f) => f.wikidataQid === filmQid)) films.push(film);
      } else {
        byLocation.set(locationQid, {
          externalId: locationQid,
          source: "wikidata-filming-location",
          lat: point.lat,
          lng: point.lng,
          name: b.locationLabel?.value ?? null,
          description: b.locationDescription?.value ?? null,
          knownImageUrl: b.image?.value ? rewriteCommonsThumb(b.image.value) : null,
          tags: { "wikidata:qid": locationQid, "filming:source": "wikidata-p915" },
          associatedFilms: [film],
          sourceUrl: `https://www.wikidata.org/wiki/${locationQid}`,
        });
      }
    }

    const out = Array.from(byLocation.values());
    await cacheSet(cKey, "wikidata:sparql", out, 7);

    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
