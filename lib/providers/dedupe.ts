import { distanceMeters } from "@/lib/bbox";
import type {
  AssociatedFilm,
  MergedCandidate,
  ProviderName,
  RawCandidate,
} from "@/lib/providers/types";

/**
 * Source priority — used both to pick which input becomes the canonical
 * record (coords, name) AND to break dedupe ties when two providers
 * disagree on which entry is "richer".
 *
 * Higher index = higher priority. Curated/structured data beats raw OSM.
 *
 * Rationale (most-priority first):
 * - NYC Scenes from the City: book-curated, hand-verified iconic scenes
 * - UNESCO World Heritage: 1,248 globally significant places (handpicked)
 * - SF Film Locations: curated municipal dataset
 * - NPS /places: curated US national park / scenic place metadata
 * - Wikidata P915: structured film-location property, citation-backed
 * - Wikidata generic: structured heritage/landmark data, less specific
 * - Wikipedia geosearch: notable places by virtue of having an article
 * - RIDB recreation: utility-grade federal recreation data
 * - OSM: raw tag-driven, lowest curated signal
 */
const SOURCE_PRIORITY: ReadonlyArray<ProviderName> = [
  "osm",
  "ridb-recreation",
  "wikipedia-geosearch",
  "wikidata-landmark",
  "own-db",
  "wikidata-filming-location",
  "nrhp",
  "nps-places",
  "sf-film-locations",
  "nhl",
  "unesco-heritage",
  "nyc-scenes-from-the-city",
];

function priorityOf(p: ProviderName): number {
  const idx = SOURCE_PRIORITY.indexOf(p);
  return idx === -1 ? -1 : idx;
}

/**
 * Two candidates are considered the same place when their coordinates are
 * within `proximityMeters`. 50m is generous enough to merge the OSM
 * polygon centroid with the Wikidata point and the curated film record,
 * tight enough to keep distinct nearby buildings separate.
 */
// 30m is tight enough to NOT merge unrelated statues in the same plaza
// (Pulitzer Fountain and Sherman Memorial sit ~40m apart at Grand Army
// Plaza in NYC, so 50m would incorrectly fold them into one cluster
// with the wrong name + photo). Same-entity hits across providers
// (Wikidata Q-id + OSM node + Wikipedia article for the same statue)
// are virtually always within 10-15m.
const DEFAULT_PROXIMITY_METERS = 30;

/**
 * Merge a list of raw candidates from multiple providers into a
 * deduplicated, source-tagged list.
 *
 * Strategy:
 * 1. Compute each raw's RANK within its source provider (0-based,
 *    matches the order each provider's `search()` returned). Used for
 *    Reciprocal Rank Fusion downstream.
 * 2. Sort raws by descending source priority so the highest-priority
 *    record is the seed for any cluster.
 * 3. For each raw, find an existing merged whose canonical coord is
 *    within `proximityMeters`. If found, MERGE in. Otherwise create a
 *    new merged record.
 * 4. When merging, take the highest-priority non-null value for each
 *    field. Tags are union'd. Films deduped by Q-id / title.
 *    Per-source rank stays the rank from each provider's own list.
 *
 * Pure function — covered by unit tests.
 */
export function mergeCandidates(
  raws: ReadonlyArray<RawCandidate>,
  proximityMeters: number = DEFAULT_PROXIMITY_METERS,
): MergedCandidate[] {
  // Compute per-source rank by walking the raws in arrival order — the
  // first time we see a (source, externalId) pair, that index within
  // the source is its rank.
  const rankByExternalId = new Map<string, number>();
  const seenCountPerSource = new Map<ProviderName, number>();
  for (const raw of raws) {
    const key = `${raw.source}\t${raw.externalId}`;
    if (rankByExternalId.has(key)) continue;
    const rank = seenCountPerSource.get(raw.source) ?? 0;
    rankByExternalId.set(key, rank);
    seenCountPerSource.set(raw.source, rank + 1);
  }

  // Sort highest-priority first so cluster seeds win on coords + canonical name.
  const sorted = [...raws].sort(
    (a, b) => priorityOf(b.source) - priorityOf(a.source),
  );

  const merged: MergedCandidate[] = [];

  for (const raw of sorted) {
    const rawKey = `${raw.source}\t${raw.externalId}`;
    const rawRank = rankByExternalId.get(rawKey) ?? 0;

    const cluster = merged.find(
      (m) =>
        distanceMeters({ lat: m.lat, lng: m.lng }, { lat: raw.lat, lng: raw.lng }) <
        proximityMeters,
    );

    if (cluster) {
      // Augment the cluster with this lower-priority record.
      if (!cluster.sources.includes(raw.source)) {
        (cluster.sources as ProviderName[]).push(raw.source);
      }
      cluster.externalIds[raw.source] = raw.externalId;
      // Track the BEST (lowest = best) rank from each contributing source.
      const existingRank = cluster.perSourceRank[raw.source];
      cluster.perSourceRank[raw.source] =
        existingRank == null ? rawRank : Math.min(existingRank, rawRank);
      cluster.name = pickRicher(cluster.name, raw.name);
      cluster.description = pickRicher(cluster.description, raw.description);
      cluster.knownImageUrl = cluster.knownImageUrl ?? raw.knownImageUrl;
      cluster.sourceUrl = cluster.sourceUrl ?? raw.sourceUrl;
      cluster.tags = unionTags(cluster.tags, raw.tags);
      cluster.associatedFilms = mergeFilms(cluster.associatedFilms, raw.associatedFilms);
      // Coord precision: prefer the contributing record with the most
      // precise coords. OSM nodes (`node/...`) are typically point-
      // precise (1 m). UNESCO and Wikipedia coords are often centroids
      // of multi-acre areas (50-100 m+ off). When a more-precise source
      // joins the cluster, swap the cluster's coords to its.
      if (coordPrecisionRank(raw) > coordPrecisionRank(coordOwnerOfCluster(cluster))) {
        cluster.lat = raw.lat;
        cluster.lng = raw.lng;
        // Track which source the coords came from so subsequent merges
        // can compare correctly.
        (cluster as ClusterWithCoordOwner)._coordOwner = raw.source;
      }
    } else {
      const fresh: ClusterWithCoordOwner = {
        id: `${raw.source}:${raw.externalId}`,
        primarySource: raw.source,
        sources: [raw.source],
        externalIds: { [raw.source]: raw.externalId },
        perSourceRank: { [raw.source]: rawRank },
        lat: raw.lat,
        lng: raw.lng,
        name: raw.name,
        description: raw.description,
        knownImageUrl: raw.knownImageUrl,
        tags: { ...raw.tags },
        associatedFilms: raw.associatedFilms,
        sourceUrl: raw.sourceUrl,
        _coordOwner: raw.source,
      };
      merged.push(fresh);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Coord precision helpers
// ---------------------------------------------------------------------------

/**
 * Per-source coord precision rank. Higher = more precise.
 *
 *   OSM node            5  point-precise (1m)
 *   NPS / Wikidata      4  curated point coords (5-20m)
 *   SF Films / RIDB     4  point coords from official datasets
 *   Wikidata-P915       3  filming-location coord (variable)
 *   NYC Scenes          3  curated but point coords
 *   Wikipedia geosearch 2  often a region centroid (10-100m off)
 *   UNESCO              1  often a multi-acre site centroid (100m+ off)
 *
 * Ties on rank fall through to the cluster's existing coords.
 */
type ClusterWithCoordOwner = MergedCandidate & {
  _coordOwner?: ProviderName;
};

function coordPrecisionRank(input: {
  source: ProviderName;
  externalId?: string;
} | { source?: ProviderName }): number {
  const source = "source" in input ? input.source : undefined;
  // OSM node ids look like "node/12345"; ways/relations are polygon
  // centroids and less precise.
  const externalId =
    "externalId" in input && typeof input.externalId === "string"
      ? input.externalId
      : "";
  if (source === "osm") {
    return externalId.startsWith("node/") ? 5 : 3;
  }
  if (source === "nps-places") return 4;
  if (source === "wikidata-landmark") return 4;
  if (source === "ridb-recreation") return 4;
  if (source === "sf-film-locations") return 4;
  if (source === "nrhp" || source === "nhl") return 4;
  if (source === "wikidata-filming-location") return 3;
  if (source === "nyc-scenes-from-the-city") return 3;
  if (source === "own-db") return 3;
  if (source === "wikipedia-geosearch") return 2;
  if (source === "unesco-heritage") return 1;
  return 0;
}

function coordOwnerOfCluster(cluster: MergedCandidate): {
  source?: ProviderName;
  externalId?: string;
} {
  const c = cluster as ClusterWithCoordOwner;
  const owner = c._coordOwner ?? cluster.primarySource;
  return { source: owner, externalId: cluster.externalIds[owner] };
}

/**
 * Pick the more informative of two strings. Both null -> null. One null -> the
 * other. Both non-null -> the longer (more descriptive). Trims whitespace.
 */
function pickRicher(a: string | null, b: string | null): string | null {
  const aT = a?.trim() ?? "";
  const bT = b?.trim() ?? "";
  if (!aT && !bT) return null;
  if (!aT) return bT;
  if (!bT) return aT;
  return bT.length > aT.length ? bT : aT;
}

function unionTags(
  a: Record<string, string>,
  b: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!out[k] && v) out[k] = v;
  }
  return out;
}

/** Dedupe films by Wikidata Q-id when present, otherwise by title+year. */
function mergeFilms(
  a: ReadonlyArray<AssociatedFilm>,
  b: ReadonlyArray<AssociatedFilm>,
): AssociatedFilm[] {
  const out: AssociatedFilm[] = [...a];
  for (const f of b) {
    const dup = out.find((x) =>
      f.wikidataQid && x.wikidataQid
        ? x.wikidataQid === f.wikidataQid
        : x.title.toLowerCase() === f.title.toLowerCase() && x.year === f.year,
    );
    if (!dup) {
      out.push(f);
    } else {
      // Prefer the entry with more identifiers populated.
      dup.wikidataQid = dup.wikidataQid ?? f.wikidataQid;
      dup.imdbId = dup.imdbId ?? f.imdbId;
      dup.year = dup.year ?? f.year;
    }
  }
  return out;
}
