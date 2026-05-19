import type { Bbox } from "@/lib/bbox";
import type { LocationKind } from "@/lib/claude";

/**
 * Provider identity. Add a new value here when introducing a new
 * CandidateProvider so the registry, source-priority list, and
 * UI source pills all stay in sync.
 */
export type ProviderName =
  /** Existing Path A: OSM tag UNION over Claude alternatives. */
  | "osm"
  /** Wikidata SPARQL — buildings, heritage, monuments, museums, ruins. */
  | "wikidata-landmark"
  /** Wikidata SPARQL — items linked from films via P915 (filming location). */
  | "wikidata-filming-location"
  /** Wikipedia geosearch — articles with geo-tags inside the bbox. */
  | "wikipedia-geosearch"
  /** NYC "Scenes from the City" curated dataset (qb3k-n8mm). */
  | "nyc-scenes-from-the-city"
  /** SF film locations dataset (yitu-d5am). */
  | "sf-film-locations";

/**
 * Compact "famous films" reference attached to a candidate by the
 * filming-location providers. Title comes straight from the source; the
 * Wikidata Q-id (when present) is what TMDb's /find endpoint accepts to
 * resolve poster + year + popularity later.
 */
export type AssociatedFilm = {
  /** Wikidata Q-id of the FILM (not the location). */
  wikidataQid: string | null;
  title: string;
  year: number | null;
  /**
   * Optional IMDb tt-id, when the source supplies one (some Wikidata
   * P915 query results already include it via P345). Used as a fallback
   * external ID for TMDb when no Q-id is available.
   */
  imdbId: string | null;
};

/**
 * Single candidate location returned by any provider. Providers vary in
 * how richly they fill these fields — OSM has tags but no description,
 * Wikidata has descriptions + images, NYC Scenes has films attached.
 * The dedupe step merges candidates by proximity, taking the best
 * non-null value from each input.
 */
export type RawCandidate = {
  /** Stable provider-scoped id. Final candidate id = `${source}:${externalId}`. */
  externalId: string;
  source: ProviderName;
  lat: number;
  lng: number;

  /** Display name (Wikidata label, NYC scene name, OSM derived name, ...). */
  name: string | null;
  /** Short description for the vision scorer. Wikidata schema:description, NYC fun_facts, ... */
  description: string | null;
  /** Pre-curated photo URL (Wikimedia Commons, NYC Open Data, ...). When present, scoring can skip Mapillary. */
  knownImageUrl: string | null;

  /** OSM-style tag map — used for badges and Overpass-flavored display. */
  tags: Record<string, string>;

  /** Films linked to this location, when the provider supplies them. */
  associatedFilms: ReadonlyArray<AssociatedFilm>;

  /** Origin URL, when applicable (Wikipedia article, NYC Open Data record, ...). */
  sourceUrl: string | null;
};

/**
 * Merged candidate after dedupe. `sources` is the list of providers that
 * contributed. Other fields are the merged best values.
 */
export type MergedCandidate = Omit<RawCandidate, "externalId" | "source"> & {
  /** Stable id used everywhere downstream: `${primarySource}:${externalId}`. */
  id: string;
  /** All providers that produced this candidate (for source pills). */
  sources: ReadonlyArray<ProviderName>;
  /**
   * The provider whose coords + name we ended up using as the canonical
   * record. Sorted by source priority in dedupe.ts.
   */
  primarySource: ProviderName;
  /**
   * Per-provider externalIds, kept for debugging and so TMDb / future
   * enrichers can query each source's own id.
   */
  externalIds: Partial<Record<ProviderName, string>>;
  /**
   * Rank of this candidate in each contributing provider's ORIGINAL
   * returned list (0-indexed: 0 = first result the provider returned).
   * Drives Reciprocal Rank Fusion (RRF) ranking downstream.
   */
  perSourceRank: Partial<Record<ProviderName, number>>;
};

export type ProviderInput = {
  bbox: Bbox;
  /** Tokens / location kind let providers tailor their queries. */
  sceneTokens: ReadonlyArray<string>;
  antiTokens: ReadonlyArray<string>;
  locationKind: LocationKind | null;
  /**
   * Pre-resolved alternatives from Claude. The OSM provider uses these;
   * other providers may ignore them.
   */
  osmTagsAlternatives: ReadonlyArray<Record<string, string>>;
};

export type ProviderResult = {
  candidates: RawCandidate[];
  /** Wall-clock time spent in this provider, for observability. */
  elapsedMs: number;
  /** Hard error, if any — surfaced for debugging but never throws. */
  error: string | null;
};

export interface CandidateProvider {
  name: ProviderName;
  /** Cheap geographic gate so we don't fire NYC-only providers in Brooklyn-NM. */
  supportsBbox(bbox: Bbox): boolean;
  /** Run a single candidate query. Must never throw — return `{ error }` instead. */
  search(input: ProviderInput): Promise<ProviderResult>;
}
