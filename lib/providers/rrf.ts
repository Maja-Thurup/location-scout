import type { MergedCandidate, ProviderName } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF) — combine ranked lists from multiple
// retrievers into one unified ranking without score normalization.
//
// References:
// - Cormack et al. 2009 "Reciprocal Rank Fusion outperforms Condorcet
//   and individual Rank Learning Methods"
// - Microsoft Azure AI Search hybrid scoring docs
// - Elasticsearch / OpenSearch RRF implementations
//
// Formula:
//   score(d) = Σ over retrievers r where d appears:
//                weight[r] * 1 / (K + rank_r(d))
//
// where K=60 is the conventional dampening constant. Lower K boosts the
// top of each list; higher K flattens. K=60 is a strong default.
// ---------------------------------------------------------------------------

const RRF_K = 60;

/**
 * Per-retriever weight. Higher = the retriever's top-of-list contributes
 * more to the final score. Tuned by hand for our data:
 *
 * - OSM (the named-only, structural-tag survivors after the noise
 *   filter) is still informative but produces a lot of generic
 *   buildings, so we give it less weight than curated sources.
 * - Wikipedia and Wikidata articles represent places that someone
 *   thought worth writing about — strong default trust.
 * - NYC Scenes / SF Films are book-curated film locations. They run as
 *   POST-CARD ENRICHERS, not retrievers, so they don't appear in this
 *   weights table. (Kept here as 0 for safety in case a caller wires
 *   them into the search registry.)
 *
 * Weights are intentionally close (0.5–1.5) — RRF's strength is that it
 * doesn't need precisely tuned weights. Big differences (10×) cause
 * one retriever to dominate even when its rank is poor.
 */
const DEFAULT_RRF_WEIGHTS: Record<ProviderName, number> = {
  osm: 0.6,
  "wikidata-landmark": 1.2,
  "wikipedia-geosearch": 1.2,
  // Film-history sources never participate in RRF retrieval ranking —
  // see lib/providers/registry.ts (DEFAULT_CONTENT_PROVIDERS vs
  // FILM_HISTORY_PROVIDERS). Weights here are zero so any accidental
  // cross-wiring contributes nothing to ranking.
  "wikidata-filming-location": 0,
  "nyc-scenes-from-the-city": 0,
  "sf-film-locations": 0,
};

/**
 * Boost adjustments based on the user's query intent (location_kind).
 * For example, a "rural" prompt should weight OSM higher because OSM
 * tag completeness shines in rural areas where Wikipedia coverage is
 * sparse. An "urban" prompt should weight Wikipedia and Wikidata
 * higher (where city landmarks live).
 *
 * Multiplicative on top of DEFAULT_RRF_WEIGHTS.
 */
const INTENT_BOOSTS: Record<
  string,
  Partial<Record<ProviderName, number>>
> = {
  rural: {
    osm: 1.5,
    "wikidata-landmark": 0.8,
    "wikipedia-geosearch": 0.9,
  },
  wilderness: {
    osm: 1.3,
    "wikidata-landmark": 0.8,
    "wikipedia-geosearch": 1.0,
  },
  urban: {
    osm: 0.7,
    "wikidata-landmark": 1.3,
    "wikipedia-geosearch": 1.3,
  },
  industrial: {
    osm: 1.2,
    "wikidata-landmark": 0.9,
    "wikipedia-geosearch": 0.9,
  },
  waterfront: {
    osm: 1.0,
    "wikidata-landmark": 1.1,
    "wikipedia-geosearch": 1.1,
  },
  suburban: {
    osm: 1.0,
    "wikidata-landmark": 1.0,
    "wikipedia-geosearch": 1.0,
  },
  mixed: {
    osm: 1.0,
    "wikidata-landmark": 1.0,
    "wikipedia-geosearch": 1.0,
  },
};

/** Resolve the effective weight for a provider given the query's location_kind. */
export function resolveWeight(
  provider: ProviderName,
  locationKind: string | null,
): number {
  const base = DEFAULT_RRF_WEIGHTS[provider] ?? 0;
  const boost = locationKind ? INTENT_BOOSTS[locationKind]?.[provider] ?? 1 : 1;
  return base * boost;
}

export type RrfRanked<T> = T & {
  /** RRF score in [0, ~Σweights/61]. Higher = better. */
  rrfScore: number;
};

/**
 * Compute RRF score for each merged candidate. Candidates that contributed
 * from MULTIPLE retrievers (e.g. both Wikipedia AND Wikidata) get a
 * naturally higher score because their rank-scores from each retriever
 * sum.
 *
 * Pure function — covered by unit tests.
 */
export function rrfRank<T extends MergedCandidate>(
  candidates: ReadonlyArray<T>,
  locationKind: string | null = null,
): RrfRanked<T>[] {
  return candidates.map((c) => {
    let score = 0;
    for (const source of c.sources) {
      const rank = c.perSourceRank[source];
      if (rank == null) continue;
      const weight = resolveWeight(source, locationKind);
      if (weight <= 0) continue;
      score += weight * (1 / (RRF_K + rank));
    }
    return { ...c, rrfScore: score };
  });
}
