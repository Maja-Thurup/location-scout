import type { Bbox } from "@/lib/bbox";
import { logger } from "@/lib/logger";
import { nycScenesProvider } from "@/lib/providers/nyc-scenes";
import { sfFilmLocationsProvider } from "@/lib/providers/sf-films";
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
// Provider registry — Phase 2a candidate sources.
//
// The OSM provider is intentionally NOT in this registry. OSM lives in
// the existing search-osm route handler, and the registry is wired in
// alongside it. Keeping OSM separate preserves the tiered relaxation
// logic specific to Overpass without forcing every provider to model it.
// ---------------------------------------------------------------------------

export const PROVIDERS: ReadonlyArray<CandidateProvider> = [
  wikidataLandmarkProvider,
  wikidataFilmingLocationProvider,
  wikipediaGeosearchProvider,
  nycScenesProvider,
  sfFilmLocationsProvider,
];

/**
 * Run every provider whose `supportsBbox` matches the requested area, in
 * parallel. Each provider's failures are isolated — one provider erroring
 * never breaks the others.
 *
 * Returns the merged raw candidates (NOT YET deduped — that happens
 * in `mergeCandidates` once OSM contributes its own results).
 */
export async function runProviders(input: ProviderInput): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
}> {
  const eligible = PROVIDERS.filter((p) => p.supportsBbox(input.bbox));

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
      logger.warn("provider failed (continuing)", { provider: p.name, error: r.error });
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
 * For routes that want to know which providers WOULD have run for a bbox
 * without actually running them (e.g. UI hints).
 */
export function eligibleProviders(bbox: Bbox): ReadonlyArray<ProviderName> {
  return PROVIDERS.filter((p) => p.supportsBbox(bbox)).map((p) => p.name);
}
