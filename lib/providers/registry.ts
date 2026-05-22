import type { Bbox } from "@/lib/bbox";
import { logger } from "@/lib/logger";
import { buildSourceDebugEntry } from "@/lib/source-debug";
import type { SourceDebugEntry } from "@/lib/source-debug";
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
// ---------------------------------------------------------------------------

export const DEFAULT_CONTENT_PROVIDERS: ReadonlyArray<CandidateProvider> = [
  ownDbProvider,
  wikidataLandmarkProvider,
  wikipediaGeosearchProvider,
  npsPlacesProvider,
  ridbRecreationProvider,
  socrataMunicipalProvider,
];

export const FILM_HISTORY_PROVIDERS: ReadonlyArray<CandidateProvider> = [
  wikidataFilmingLocationProvider,
  nycScenesProvider,
  sfFilmLocationsProvider,
];

export const PROVIDERS = DEFAULT_CONTENT_PROVIDERS;

function providerDebugKey(p: CandidateProvider): string {
  return p.debugKey ?? p.name;
}

function providerDisplayName(p: CandidateProvider): string {
  return p.displayName ?? p.name;
}

async function runProviderList(
  list: ReadonlyArray<CandidateProvider>,
  input: ProviderInput,
  label: string,
  collectSourceDebug: boolean,
): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
  sourceDebug: SourceDebugEntry[];
}> {
  const sourceDebug: SourceDebugEntry[] = [];
  const merged: RawCandidate[] = [];
  const perProvider: Record<string, { count: number; ms: number; error: string | null }> =
    {};

  for (const p of list) {
    const key = providerDebugKey(p);
    const display = providerDisplayName(p);

    if (!p.supportsBbox(input.bbox)) {
      const entry = buildSourceDebugEntry({
        sourceKey: key,
        displayName: display,
        ms: 0,
        error: null,
        skipped: true,
        skipReason: "bbox not supported by this provider",
        request: { bbox: input.bbox },
        candidates: [],
      });
      if (collectSourceDebug) sourceDebug.push(entry);
      perProvider[p.name] = { count: 0, ms: 0, error: null };
      continue;
    }

    let r: ProviderResult;
    try {
      r = await p.search(input);
    } catch (err) {
      r = {
        candidates: [],
        elapsedMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

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

    if (collectSourceDebug) {
      const dbg = r.debug;
      const skipReason = dbg?.skipReason ?? null;
      sourceDebug.push(
        buildSourceDebugEntry({
          sourceKey: key,
          displayName: display,
          ms: r.elapsedMs,
          error: r.error,
          skipReason,
          skipped: Boolean(skipReason),
          fromCache: dbg?.fromCache ?? false,
          request: {
            bbox: input.bbox,
            sceneTokens: input.sceneTokens,
            locationKind: input.locationKind,
            ...(dbg?.request ?? {}),
          },
          candidates: r.candidates,
          notes: dbg?.notes ?? null,
        }),
      );
    }
  }

  return {
    candidates: merged,
    perProvider: perProvider as Record<
      ProviderName,
      { count: number; ms: number; error: string | null }
    >,
    sourceDebug,
  };
}

export async function runProviders(
  input: ProviderInput,
  options?: { developerMode?: boolean },
): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
  sourceDebug: SourceDebugEntry[];
}> {
  return runProviderList(
    DEFAULT_CONTENT_PROVIDERS,
    input,
    "default-content",
    options?.developerMode ?? false,
  );
}

export async function runFilmHistoryProviders(
  input: ProviderInput,
  options?: { developerMode?: boolean },
): Promise<{
  candidates: RawCandidate[];
  perProvider: Record<ProviderName, { count: number; ms: number; error: string | null }>;
  sourceDebug: SourceDebugEntry[];
}> {
  return runProviderList(
    FILM_HISTORY_PROVIDERS,
    input,
    "film-history",
    options?.developerMode ?? false,
  );
}

export function eligibleProviders(bbox: Bbox): ReadonlyArray<ProviderName> {
  return DEFAULT_CONTENT_PROVIDERS.filter((p) => p.supportsBbox(bbox)).map(
    (p) => p.name,
  );
}
