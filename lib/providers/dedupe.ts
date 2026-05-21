import { distanceMeters } from "@/lib/bbox";
import type {
  AssociatedFilm,
  MergedCandidate,
  ProviderName,
  RawCandidate,
  WikidataFacts,
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

/** Looser radius when normalized display names match (Wikipedia centroid vs OSM pin). */
const NAME_MATCH_PROXIMITY_METERS = 50;

/**
 * Normalize a place name for cross-source dedupe. Strips parentheticals,
 * punctuation, and diacritics so "Equestrian Statue of George Washington
 * (New York City)" matches Wikipedia/Wikidata variants.
 */
export function normalizePlaceName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 0 ? base : null;
}

/** True when two normalized names are the same place (equality or long substring). */
export function namesMatchForMerge(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 10) return false;
  return longer.includes(shorter);
}

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
  // Cross-source merge index: every cluster that knows a Wikidata
  // Q-id (either from being seeded by wikidata-landmark, or from
  // having an OSM/Wikipedia tag pointing to one) is reachable here
  // by Q-id. This lets a downstream OSM `tourism=artwork` node with
  // tag `wikidata=Q1234` merge with the canonical Wikidata cluster
  // even when proximity-merging would have failed (e.g. Wikidata's
  // coord is the centroid of a memorial garden 80m from the OSM
  // node's pin).
  const clusterByQid = new Map<string, MergedCandidate>();

  for (const raw of sorted) {
    const rawKey = `${raw.source}\t${raw.externalId}`;
    const rawRank = rankByExternalId.get(rawKey) ?? 0;
    const rawQid = qidFromRaw(raw);

    // Cross-source merge: try Q-id first (definitive), fall back to
    // proximity match (heuristic, prone to false-merges in dense
    // urban areas).
    let cluster: MergedCandidate | undefined =
      rawQid ? clusterByQid.get(rawQid) : undefined;
    if (!cluster) {
      cluster = merged.find(
        (m) =>
          distanceMeters({ lat: m.lat, lng: m.lng }, { lat: raw.lat, lng: raw.lng }) <
          proximityMeters,
      );
    }

    const normRawName = normalizePlaceName(raw.name);
    if (!cluster && normRawName) {
      cluster = merged.find((m) => {
        const normCluster = normalizePlaceName(m.name);
        if (!normCluster || !namesMatchForMerge(normRawName, normCluster)) {
          return false;
        }
        return (
          distanceMeters(
            { lat: m.lat, lng: m.lng },
            { lat: raw.lat, lng: raw.lng },
          ) < NAME_MATCH_PROXIMITY_METERS
        );
      });
    }

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
      // Wikidata facts: prefer the cluster's existing facts (Wikidata
      // landmark provider runs early and has the canonical SPARQL
      // payload); fill nulls/empties from the joining raw so an OSM
      // record that arrived first doesn't shadow Wikidata's data.
      cluster.wikidataFacts = mergeFacts(cluster.wikidataFacts, raw.wikidataFacts);
      // Coord precision: prefer the contributing record with the most
      // precise coords. OSM nodes (`node/...`) are typically point-
      // precise (1 m). UNESCO and Wikipedia coords are often centroids
      // of multi-acre areas (50-100 m+ off). When a more-precise source
      // joins the cluster, swap the cluster's coords to its.
      if (coordPrecisionRank(raw) > coordPrecisionRank(coordOwnerOfCluster(cluster))) {
        cluster.lat = raw.lat;
        cluster.lng = raw.lng;
        (cluster as ClusterWithCoordOwner)._coordOwner = raw.source;
      }
      // Register the Q-id pointer if this raw introduced one.
      if (rawQid && !clusterByQid.has(rawQid)) {
        clusterByQid.set(rawQid, cluster);
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
        wikidataFacts: raw.wikidataFacts,
        _coordOwner: raw.source,
      };
      merged.push(fresh);
      if (rawQid) clusterByQid.set(rawQid, fresh);
    }
  }

  return merged;
}

/**
 * Pull a Wikidata Q-id from a RawCandidate. Sources:
 *   1. wikidata-landmark uses the Q-id AS its externalId
 *   2. wikipedia-geosearch tags the candidate with `wikidata:qid` (set
 *      from MediaWiki's `pageprops.wikibase_item`)
 *   3. OSM nodes/ways have a `wikidata` tag for famous entities (e.g.
 *      Sherman Memorial OSM node has `wikidata=Q1346181`)
 *   4. wikidata-filming-location uses Q-id as externalId too
 *
 * Returns `null` when the raw has no Q-id we can use for cross-source
 * merging — falls back to proximity-only matching downstream.
 */
function qidFromRaw(raw: RawCandidate): string | null {
  if (raw.source === "wikidata-landmark" || raw.source === "wikidata-filming-location") {
    if (/^Q\d+$/.test(raw.externalId)) return raw.externalId;
  }
  const tagQid = raw.tags["wikidata"] ?? raw.tags["wikidata:qid"];
  if (typeof tagQid === "string" && /^Q\d+$/.test(tagQid)) {
    return tagQid;
  }
  return null;
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

/**
 * Field-wise merge of two Wikidata fact payloads. The cluster's
 * existing fact wins on string fields (inception, commonsCategory) so
 * the canonical Wikidata source isn't shadowed by a downstream raw
 * with sparser data; for array fields we union, dedupe, and cap.
 */
function mergeFacts(
  a: WikidataFacts | undefined,
  b: WikidataFacts | undefined,
): WikidataFacts | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const merge = (
    x: ReadonlyArray<string>,
    y: ReadonlyArray<string>,
    cap = 5,
  ): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of [...x, ...y]) {
      const norm = v.trim();
      if (!norm) continue;
      const key = norm.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(norm);
      if (out.length >= cap) break;
    }
    return out;
  };
  return {
    inception: a.inception ?? b.inception,
    commonsCategory: a.commonsCategory ?? b.commonsCategory,
    creators: merge(a.creators, b.creators),
    architects: merge(a.architects, b.architects),
    materials: merge(a.materials, b.materials),
    genres: merge(a.genres, b.genres),
    depicts: merge(a.depicts, b.depicts, 6),
    namedAfter: merge(a.namedAfter, b.namedAfter),
    partOf: merge(a.partOf, b.partOf),
    hasParts: merge(a.hasParts, b.hasParts),
    altLabels: merge(a.altLabels, b.altLabels, 8),
  };
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
