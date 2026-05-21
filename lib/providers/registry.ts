import type { Bbox } from "@/lib/bbox";
import { logger } from "@/lib/logger";
import { npsPlacesProvider } from "@/lib/providers/nps-places";
import { nycScenesProvider } from "@/lib/providers/nyc-scenes";
import { ownDbProvider } from "@/lib/providers/own-db";
import { ridbRecreationProvider } from "@/lib/providers/ridb-recreation";
import { sfFilmLocationsProvider } from "@/lib/providers/sf-films";
import { socrataMunicipalProvider } from "@/lib/providers/socrata-municipal";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderName,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";
import { wikidataFilmingLocationProvider } from "@/lib/providers/wikidata-filming-location";
import { wikidataLandmarkProvider } from "@/lib/providers/wikidata-landmark";
import { wikipediaGeosearchProvider } from "@/lib/providers/wikipedia-geosearch";

// ---------------------------------------------------------------------------
// Provider registry — split into TWO categories.
//
// 1. DEFAULT_CONTENT_PROVIDERS: pure-content sources. They return
//    candidates based on WHAT IS THERE (a building, a monument, a park,
//    a viewpoint). Used for every search regardless of intent. These are
//    the only sources that influence ranking.
//
// 2. FILM_HISTORY_PROVIDERS: pure-film-history sources. They return
//    locations based on FILMS that were shot there (Wikidata P915, NYC
//    Scenes from the City, SF Films Locations). They're INTENTIONALLY
//    excluded from the default search pool because film-history is
//    irrelevant to most prompts ("horse statue in a park" doesn't care
//    whether NYU has hosted movie shoots). Instead, these run as a
//    POST-CARD ENRICHMENT step: for each card we surface, attach any
//    films linked to that exact coord (within 50 m). They are also the
//    retrievers for a future "find me filming locations" search mode
//    where the user explicitly wants film-history-driven results.
//
// The OSM provider is intentionally NOT in either registry. OSM lives
// in the search-osm route handler with its own tiered-relaxation logic.
// ---------------------------------------------------------------------------

export const DEFAULT_CONTENT_PROVIDERS: ReadonlyArray<CandidateProvider> = [
  // M6: own-db runs FIRST. It's a single Postgres query with sub-100ms
  // latency. Its candidates carry their original-source metadata so RRF
  // weights and dedupe priority work normally. When the table is empty
  // (fresh deploy, no imports yet) this no-ops and the live providers
  // below carry the search.
  ownDbProvider,
  wikidataLandmarkProvider,
  wikipediaGeosearchProvider,
  // M7: scenic live sources. Each gracefully no-ops when its optional API
  // key is missing or the bbox is non-US (where applicable).
  npsPlacesProvider,
  ridbRecreationProvider,
  // Socrata municipal datasets — NYC public art / landmarks, SF
  // historic sites, Chicago landmarks. Empty fast-path when bbox
  // doesn't overlap any registered dataset.
  socrataMunicipalProvider,
];

export const FILM_HISTORY_PROVIDERS: ReadonlyArray<CandidateProvider> = [
  wikidataFilmingLocationProvider,
  nycScenesProvider,
  sfFilmLocationsProvider,
];

/**
 * Backwards-compat: the old `PROVIDERS` symbol resolves to default
 * content providers only. Anything that previously imported PROVIDERS
 * keeps working without contributing film-history rows to the search.
 */
export const PROVIDERS = DEFAULT_CONTENT_PROVIDERS;

async function runProviderList(
  list: ReadonlyArray<CandidateProvider>,
  input: ProviderInput,
  label: string,
): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
}> {
  const eligible = list.filter((p) => p.supportsBbox(input.bbox));

  const results = await Promise.all(
    eligible.map((p) =>
      p.search(input).catch(
        (err): ProviderResult => ({
          candidates: [],
          elapsedMs: 0,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    ),
  );

  const merged: RawCandidate[] = [];
  const perProvider: Record<string, { count: number; ms: number; error: string | null }> =
    {};
  for (let i = 0; i < eligible.length; i++) {
    const p = eligible[i]!;
    const r = results[i]!;
    merged.push(...r.candidates);
    perProvider[p.name] = {
      count: r.candidates.length,
      ms: r.elapsedMs,
      error: r.error,
    };
    if (r.error) {
      logger.warn(`${label} provider failed (continuing)`, {
        provider: p.name,
        error: r.error,
      });
    }
  }

  return {
    candidates: merged,
    perProvider: perProvider as Record<
      ProviderName,
      { count: number; ms: number; error: string | null }
    >,
  };
}

/**
 * Run every DEFAULT_CONTENT provider whose `supportsBbox` matches the
 * requested area, in parallel. This is the search-time entry point.
 *
 * Excludes film-history sources by design — those are post-card
 * enrichers and a future explicit search mode, not a default ranking
 * signal. Films should be METADATA on a card, not the reason a card
 * exists.
 */
export async function runProviders(input: ProviderInput): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
}> {
  return runProviderList(DEFAULT_CONTENT_PROVIDERS, input, "default-content");
}

/**
 * Run every FILM_HISTORY provider whose `supportsBbox` matches the bbox.
 * Used by the enrichment route to attach film metadata to cards by
 * coord proximity AFTER the search has already chosen them.
 */
export async function runFilmHistoryProviders(input: ProviderInput): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
}> {
  return runProviderList(FILM_HISTORY_PROVIDERS, input, "film-history");
}

/**
 * For routes that want to know which providers WOULD have run for a bbox
 * without actually running them (e.g. UI hints).
 */
export function eligibleProviders(bbox: Bbox): ReadonlyArray<ProviderName> {
  return DEFAULT_CONTENT_PROVIDERS.filter((p) => p.supportsBbox(bbox)).map(
    (p) => p.name,
  );
}
