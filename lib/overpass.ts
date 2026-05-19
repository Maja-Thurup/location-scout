import { z } from "zod";

import { type Bbox, bboxToOverpass, expandBbox } from "@/lib/bbox";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OsmTags = Record<string, string>;

export type OsmCandidate = {
  /** "type/id" — e.g. "way/12345". Stable identifier across runs. */
  id: string;
  type: "node" | "way" | "relation";
  /** OSM-internal numeric id (without type prefix). */
  osmId: number;
  lat: number;
  lng: number;
  tags: OsmTags;
  name: string | null;
};

export type MatchMode =
  /** All osmTags ANDed together matched ≥ THRESHOLD features in the requested bbox. */
  | "strict"
  /** Strict match was sparse; re-queried with only the primary classifier. */
  | "primary_only"
  /** Primary-tag-only was still sparse; expanded the bbox 2× or 4× to find more. */
  | "primary_only_expanded"
  /** Every tier returned below threshold; we ship whatever we got (may be 0). */
  | "best_effort";

export type OverpassSearchResult = {
  candidates: OsmCandidate[];
  /** Total returned by Overpass (may be larger than `candidates.length` if we cap). */
  rawCount: number;
  /** Which mirror succeeded, for observability. */
  mirror: string;
  /** Wall-clock ms spent talking to Overpass. */
  elapsedMs: number;
  /** How strict the matching was (set by `searchOsm`, not `executeOverpass`). */
  matchMode: MatchMode;
  /** When matchMode is a primary-only variant, the single tag we matched on. */
  primaryTag: { key: string; value: string } | null;
  /** Multiplier applied to the user's bbox (1 = unchanged, 2 = 2x, 4 = 4x). */
  expansionMultiplier: 1 | 2 | 4;
  /** The bbox actually queried after any expansion. Same as input if multiplier=1. */
  effectiveBbox: Bbox;
};

// ---------------------------------------------------------------------------
// Mirrors. Public Overpass instances rotate health regularly; we try the
// best one first, fall back to the others on transient failure.
// ---------------------------------------------------------------------------

const MIRRORS: ReadonlyArray<string> = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

const OVERPASS_TIMEOUT_MS = 25_000;
/** Hard cap on candidates returned to the client. Map gets cluttered past this. */
export const MAX_CANDIDATES = 60;

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

/**
 * Tags whose VALUES are likely to vary in case (e.g. "Brick" vs "brick").
 * For these we generate a case-insensitive regex match. Other tags use
 * exact-match so the query stays cheap.
 */
const CASE_INSENSITIVE_KEYS = new Set([
  "building:material",
  "building:colour",
  "roof:material",
  "roof:shape",
  "surface",
  "building:architecture",
]);

/**
 * Tags whose value should match by *prefix* across multiple OSM canonical
 * spellings. (E.g. user types "abandoned" — we want to match "yes", "true",
 * etc. but not "abandoned:building".)
 *
 * Currently empty; kept as an extension point for future tag massaging.
 */
const PREFIX_KEYS = new Set<string>();

function tagFilter(key: string, value: string): string {
  // Quote everything; OSM is fine with quoted strings.
  const safeKey = key.replace(/"/g, '\\"');
  const safeValue = value.replace(/"/g, '\\"');

  if (PREFIX_KEYS.has(key)) {
    return `["${safeKey}"~"^${safeValue}",i]`;
  }
  if (CASE_INSENSITIVE_KEYS.has(key)) {
    return `["${safeKey}"~"^${safeValue}$",i]`;
  }
  return `["${safeKey}"="${safeValue}"]`;
}

/**
 * Build an Overpass QL query for nodes/ways/relations matching ALL of the
 * given tags within `bbox`. Returns the raw OQL string.
 *
 * Pure function — covered by unit tests.
 */
export function buildOverpassQuery(input: {
  bbox: Bbox;
  osmTags: OsmTags;
  /** Cap on total elements returned by Overpass. Defaults to 200. */
  limit?: number;
}): string {
  const filterParts = Object.entries(input.osmTags)
    .filter(([k, v]) => k.length > 0 && v.length > 0)
    .map(([k, v]) => tagFilter(k, v))
    .join("");

  if (!filterParts) {
    throw new Error("buildOverpassQuery: at least one OSM tag is required");
  }

  const bboxStr = bboxToOverpass(input.bbox);
  const limit = input.limit ?? 200;

  return [
    `[out:json][timeout:25];`,
    `(`,
    `  node${filterParts}${bboxStr};`,
    `  way${filterParts}${bboxStr};`,
    `  relation${filterParts}${bboxStr};`,
    `);`,
    `out center tags ${limit};`,
  ].join("\n");
}

/**
 * Build a UNION Overpass QL query that returns the OR of multiple tag-set
 * alternatives within `bbox`. Each alternative is run independently — a
 * feature only needs to match ONE alternative to be returned.
 *
 * This is the Pinterest-Lens "candidate generation" stage: cast a wide net
 * across plausible OSM mappings of the user's visual prompt, then let the
 * vision scorer narrow precision.
 *
 * Example for "old blue building outside of town with trees in the back":
 *
 *   alternatives = [
 *     { building: "house" },
 *     { building: "detached" },
 *     { landuse: "residential" },
 *     { natural: "wood" }
 *   ]
 *
 * produces a single Overpass call that returns the union of all four sets.
 * Empty alternatives are skipped; throws if all alternatives are empty.
 */
export function buildUnionOverpassQuery(input: {
  bbox: Bbox;
  osmTagsAlternatives: ReadonlyArray<OsmTags>;
  /** Cap on total elements returned by Overpass across all alternatives. */
  limit?: number;
}): string {
  const validAlternatives = input.osmTagsAlternatives
    .map((alt) =>
      Object.entries(alt)
        .filter(([k, v]) => k.length > 0 && v.length > 0)
        .map(([k, v]) => tagFilter(k, v))
        .join(""),
    )
    .filter((s) => s.length > 0);

  if (validAlternatives.length === 0) {
    throw new Error(
      "buildUnionOverpassQuery: at least one non-empty alternative is required",
    );
  }

  const bboxStr = bboxToOverpass(input.bbox);
  const limit = input.limit ?? 200;

  const lines: string[] = [`[out:json][timeout:25];`, `(`];
  for (const filterParts of validAlternatives) {
    lines.push(`  node${filterParts}${bboxStr};`);
    lines.push(`  way${filterParts}${bboxStr};`);
    lines.push(`  relation${filterParts}${bboxStr};`);
  }
  lines.push(`);`);
  lines.push(`out center tags ${limit};`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Execute query against Overpass with mirror fallback
// ---------------------------------------------------------------------------

const overpassResponseSchema = z.object({
  version: z.number().optional(),
  generator: z.string().optional(),
  elements: z.array(
    z.union([
      z.object({
        type: z.literal("node"),
        id: z.number(),
        lat: z.number(),
        lon: z.number(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
      z.object({
        type: z.literal("way"),
        id: z.number(),
        center: z.object({ lat: z.number(), lon: z.number() }).optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
      z.object({
        type: z.literal("relation"),
        id: z.number(),
        center: z.object({ lat: z.number(), lon: z.number() }).optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
    ]),
  ),
});

function deriveName(tags: OsmTags | undefined): string | null {
  if (!tags) return null;
  return tags.name ?? tags["name:en"] ?? tags.brand ?? tags.operator ?? null;
}

async function fetchFromMirror(
  mirror: string,
  query: string,
): Promise<{ status: number; bodyText: string }> {
  const res = await fetch(mirror, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
  });
  return { status: res.status, bodyText: await res.text() };
}

/**
 * Run an Overpass query against the mirror list.
 * On any non-2xx or non-JSON response, falls through to the next mirror.
 * Throws only if every mirror fails.
 */
export async function executeOverpass(query: string): Promise<OverpassSearchResult> {
  const t0 = Date.now();
  let lastError: unknown = null;

  for (const mirror of MIRRORS) {
    try {
      const { status, bodyText } = await fetchFromMirror(mirror, query);

      if (status === 429 || status >= 500) {
        logger.warn("overpass mirror returned non-success", { mirror, status });
        lastError = new Error(`HTTP ${status} from ${mirror}`);
        continue;
      }
      if (status !== 200) {
        logger.warn("overpass mirror returned unexpected status", { mirror, status });
        lastError = new Error(`HTTP ${status} from ${mirror}`);
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(bodyText);
      } catch {
        logger.warn("overpass mirror returned non-JSON", {
          mirror,
          preview: bodyText.slice(0, 200),
        });
        lastError = new Error(`Non-JSON from ${mirror}`);
        continue;
      }

      const parsed = overpassResponseSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn("overpass response failed schema validation", {
          mirror,
          issue: parsed.error.issues[0]?.message,
        });
        lastError = new Error(`Schema mismatch from ${mirror}`);
        continue;
      }

      const candidates: OsmCandidate[] = [];
      for (const el of parsed.data.elements) {
        let lat: number;
        let lng: number;

        if (el.type === "node") {
          lat = el.lat;
          lng = el.lon;
        } else if (el.center) {
          lat = el.center.lat;
          lng = el.center.lon;
        } else {
          continue;
        }

        candidates.push({
          id: `${el.type}/${el.id}`,
          type: el.type,
          osmId: el.id,
          lat,
          lng,
          tags: el.tags ?? {},
          name: deriveName(el.tags),
        });

        if (candidates.length >= MAX_CANDIDATES) break;
      }

      return {
        candidates,
        rawCount: parsed.data.elements.length,
        mirror,
        elapsedMs: Date.now() - t0,
        // executeOverpass doesn't know about matching strategy — searchOsm
        // wraps it and assigns matchMode/expansion. Defaults below let
        // single-call use of executeOverpass still satisfy the type.
        matchMode: "strict",
        primaryTag: null,
        expansionMultiplier: 1,
        effectiveBbox: { south: 0, west: 0, north: 0, east: 0 }, // overwritten by searchOsm
      };
    } catch (err) {
      logger.warn("overpass mirror threw", {
        mirror,
        err: String(err),
      });
      lastError = err;
      // try next mirror
    }
  }

  throw new Error(
    `All Overpass mirrors failed. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ---------------------------------------------------------------------------
// Tiered fallback: prefer the strict ALL-tag match; if zero, retry with just
// the most diagnostic tag so the user always sees *something* relevant.
// ---------------------------------------------------------------------------

/**
 * Priority order for picking the "primary" classifier tag when falling back
 * to a loose match. The first key in this list that appears in `osmTags`
 * is treated as the primary classifier — usually one of these answers
 * "what kind of thing is this?".
 */
const PRIMARY_KEY_ORDER: ReadonlyArray<string> = [
  "building",
  "amenity",
  "shop",
  "tourism",
  "historic",
  "leisure",
  "landuse",
  "natural",
  "man_made",
  "highway",
  "railway",
  "waterway",
  "aeroway",
  "office",
];

export function pickPrimaryTag(
  osmTags: OsmTags,
): { key: string; value: string } | null {
  for (const k of PRIMARY_KEY_ORDER) {
    if (k in osmTags && osmTags[k]) {
      return { key: k, value: osmTags[k]! };
    }
  }
  // Fallback to the first non-empty tag in declaration order.
  for (const [k, v] of Object.entries(osmTags)) {
    if (v) return { key: k, value: v };
  }
  return null;
}

/**
 * Below this many candidates a tier is considered "sparse" and we escalate
 * to the next, looser tier. Above it, we ship the result as-is.
 *
 * Industry pattern: Elasticsearch's "min_should_match" + e-commerce search
 * tier-relaxation literature both use a small fixed minimum (typically
 * 3-10). Five gives the user a real shortlist without forcing
 * over-expansion in dense areas.
 */
const SPARSE_THRESHOLD = 5;

/** Multipliers applied progressively when ring-expanding the bbox. */
const EXPANSION_RING: ReadonlyArray<2 | 4> = [2, 4];

/**
 * High-level helper: build query from inputs, execute, return candidates.
 *
 * Implements the industry-standard tier-relaxation + expanding-ring
 * pattern so the user "always gets a result, the closest possible":
 *
 *   Tier 1: strict ALL-tag match in the requested bbox.
 *           If >= SPARSE_THRESHOLD, return.
 *   Tier 2: primary classifier tag only, same bbox.
 *           If >= SPARSE_THRESHOLD, return.
 *   Tier 3: primary classifier tag only, expand bbox 2× then 4×.
 *           First expansion that yields >= SPARSE_THRESHOLD wins.
 *   Tier 4: best-effort — return whatever the largest expansion got
 *           (may be 0 in genuinely empty parts of the map).
 */
export async function searchOsm(input: {
  bbox: Bbox;
  osmTags: OsmTags;
  limit?: number;
}): Promise<OverpassSearchResult> {
  // Tier 1: strict.
  const strictQuery = buildOverpassQuery(input);
  const strictResult = await executeOverpass(strictQuery);

  if (strictResult.candidates.length >= SPARSE_THRESHOLD) {
    return {
      ...strictResult,
      matchMode: "strict",
      primaryTag: null,
      expansionMultiplier: 1,
      effectiveBbox: input.bbox,
    };
  }

  const tagCount = Object.keys(input.osmTags).length;
  const primary = tagCount > 1 ? pickPrimaryTag(input.osmTags) : null;

  // Tier 2: primary tag only, same bbox. Skipped when only one tag was sent.
  let primaryResult: OverpassSearchResult | null = null;
  if (primary) {
    logger.info("overpass strict sparse, retrying with primary tag only", {
      primaryKey: primary.key,
      primaryValue: primary.value,
      strictCount: strictResult.candidates.length,
    });
    primaryResult = await executeOverpass(
      buildOverpassQuery({
        bbox: input.bbox,
        osmTags: { [primary.key]: primary.value },
        limit: input.limit,
      }),
    );

    if (primaryResult.candidates.length >= SPARSE_THRESHOLD) {
      return {
        ...primaryResult,
        matchMode: "primary_only",
        primaryTag: primary,
        expansionMultiplier: 1,
        effectiveBbox: input.bbox,
      };
    }
  }

  // Tier 3: expanding ring on the primary tag only. (Skipped when no
  // primary tag could be picked.)
  const baselineForBestEffort = primaryResult ?? strictResult;
  const tagsForExpansion: OsmTags = primary
    ? { [primary.key]: primary.value }
    : input.osmTags;

  let lastExpanded: OverpassSearchResult = baselineForBestEffort;
  let lastBbox = input.bbox;
  let lastMultiplier: 1 | 2 | 4 = 1;

  for (const multiplier of EXPANSION_RING) {
    const expandedBbox = expandBbox(input.bbox, multiplier);
    logger.info("overpass expanding bbox", {
      multiplier,
      threshold: SPARSE_THRESHOLD,
    });

    const expanded = await executeOverpass(
      buildOverpassQuery({
        bbox: expandedBbox,
        osmTags: tagsForExpansion,
        limit: input.limit,
      }),
    );
    lastExpanded = expanded;
    lastBbox = expandedBbox;
    lastMultiplier = multiplier;

    if (expanded.candidates.length >= SPARSE_THRESHOLD) {
      return {
        ...expanded,
        matchMode: "primary_only_expanded",
        primaryTag: primary,
        expansionMultiplier: multiplier,
        effectiveBbox: expandedBbox,
      };
    }
  }

  // Tier 4: best-effort. Return whichever attempt produced the most
  // candidates (or just the last one if all empty).
  const candidatePool: ReadonlyArray<{
    result: OverpassSearchResult;
    bbox: Bbox;
    multiplier: 1 | 2 | 4;
    primaryUsed: boolean;
  }> = [
    { result: strictResult, bbox: input.bbox, multiplier: 1, primaryUsed: false },
    ...(primaryResult
      ? [
          {
            result: primaryResult,
            bbox: input.bbox,
            multiplier: 1 as const,
            primaryUsed: true,
          },
        ]
      : []),
    { result: lastExpanded, bbox: lastBbox, multiplier: lastMultiplier, primaryUsed: !!primary },
  ];

  const winner = candidatePool.reduce((acc, entry) =>
    entry.result.candidates.length > acc.result.candidates.length ? entry : acc,
  );

  return {
    ...winner.result,
    matchMode: "best_effort",
    primaryTag: winner.primaryUsed ? primary : null,
    expansionMultiplier: winner.multiplier,
    effectiveBbox: winner.bbox,
  };
}

// ---------------------------------------------------------------------------
// Rich-tag search: PARALLEL queries over multiple alternative tag-sets with
// expanding-ring fallback. This is the new primary entry point used when
// Claude emits `osm_tags_alternatives`. Implements the "candidate
// generation" stage of the Pinterest-Lens pattern — high recall, the
// vision scorer handles precision downstream.
//
// Why parallel-per-alternative instead of one giant UNION:
//   - A UNION query with 8 alternatives over a city-sized bbox forces
//     Overpass to do 8 full geographic scans inside one transaction.
//     Each transaction has a 25s timeout, so big cities (NYC,
//     Los Angeles, ...) reliably time out.
//   - Running each alternative as its own small query is fast (each
//     completes in 1-3s for typical primary classifiers) and lets us
//     succeed partially when one alternative is slow or empty.
//   - Failures of individual alternatives are logged and skipped; the
//     overall search still returns whatever succeeded.
// ---------------------------------------------------------------------------

export type RichSearchResult = OverpassSearchResult & {
  /** How many of the supplied alternatives we attempted. */
  alternativesTried: number;
  /** How many alternatives returned successfully (vs threw). */
  alternativesSucceeded: number;
};

/** Element cap per alternative. Total candidate pool is then capped at MAX_CANDIDATES. */
const RICH_PER_ALT_LIMIT = 30;
/** How many alternative queries to run concurrently against Overpass. */
const RICH_CONCURRENCY = 3;

/**
 * Run all alternatives in parallel against Overpass and merge their
 * candidate lists. Deduplicates by candidate id (`type/osmId`), preserving
 * insertion order so downstream sorting keeps the closest matches first.
 *
 * Throws only when EVERY alternative threw — partial successes return the
 * accumulated set.
 */
async function executeAlternativesParallel(input: {
  bbox: Bbox;
  osmTagsAlternatives: ReadonlyArray<OsmTags>;
  perAltLimit: number;
  concurrency: number;
}): Promise<
  Pick<OverpassSearchResult, "candidates" | "rawCount" | "mirror" | "elapsedMs"> & {
    successCount: number;
    failureCount: number;
    attempted: number;
  }
> {
  const t0 = Date.now();

  const valid = input.osmTagsAlternatives.filter(
    (alt) => Object.entries(alt).some(([k, v]) => k && v),
  );
  if (valid.length === 0) {
    throw new Error(
      "executeAlternativesParallel: no non-empty alternatives provided",
    );
  }

  const merged: OsmCandidate[] = [];
  const seen = new Set<string>();
  let totalRaw = 0;
  let lastMirror = "(none)";
  let successCount = 0;
  let failureCount = 0;

  let idx = 0;
  const concurrency = Math.min(input.concurrency, valid.length);

  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= valid.length) return;
      // Stop early if we've already hit the global candidate cap.
      if (merged.length >= MAX_CANDIDATES) return;

      const alt = valid[i]!;
      try {
        const r = await executeOverpass(
          buildOverpassQuery({
            bbox: input.bbox,
            osmTags: alt,
            limit: input.perAltLimit,
          }),
        );
        successCount++;
        lastMirror = r.mirror;
        totalRaw += r.rawCount;
        for (const c of r.candidates) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          merged.push(c);
          if (merged.length >= MAX_CANDIDATES) return;
        }
      } catch (err) {
        failureCount++;
        logger.warn("rich alternative query failed (continuing)", {
          alt,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  if (successCount === 0) {
    throw new Error(
      `All ${failureCount} alternative Overpass queries failed`,
    );
  }

  return {
    candidates: merged,
    rawCount: totalRaw,
    mirror: lastMirror,
    elapsedMs: Date.now() - t0,
    successCount,
    failureCount,
    attempted: valid.length,
  };
}

/**
 * Run parallel queries over `osmTagsAlternatives` in the requested bbox.
 * If sparse, expand the bbox 2× then 4× (same EXPANSION_RING as single-tag
 * search). Always returns whatever the largest expansion got.
 *
 * No "primary tag relaxation" tier here — relaxation is implicit because
 * each alternative is already a single-key filter (or close to it). The
 * expanding ring still handles spatial sparsity.
 */
export async function searchOsmRich(input: {
  bbox: Bbox;
  osmTagsAlternatives: ReadonlyArray<OsmTags>;
  limit?: number;
}): Promise<RichSearchResult> {
  const perAltLimit = input.limit ?? RICH_PER_ALT_LIMIT;

  // Tier 1: parallel alternatives in the original bbox.
  const base = await executeAlternativesParallel({
    bbox: input.bbox,
    osmTagsAlternatives: input.osmTagsAlternatives,
    perAltLimit,
    concurrency: RICH_CONCURRENCY,
  });

  logger.info("overpass rich tier 1 done", {
    alternatives: base.attempted,
    success: base.successCount,
    failure: base.failureCount,
    candidates: base.candidates.length,
    ms: base.elapsedMs,
  });

  if (base.candidates.length >= SPARSE_THRESHOLD) {
    return {
      candidates: base.candidates,
      rawCount: base.rawCount,
      mirror: base.mirror,
      elapsedMs: base.elapsedMs,
      matchMode: "strict",
      primaryTag: null,
      expansionMultiplier: 1,
      effectiveBbox: input.bbox,
      alternativesTried: base.attempted,
      alternativesSucceeded: base.successCount,
    };
  }

  // Tier 2: expanding ring (same parallel pattern over all alternatives).
  let lastResult = base;
  let lastBbox = input.bbox;
  let lastMultiplier: 1 | 2 | 4 = 1;

  for (const multiplier of EXPANSION_RING) {
    const expandedBbox = expandBbox(input.bbox, multiplier);
    logger.info("overpass rich expanding bbox", {
      multiplier,
      threshold: SPARSE_THRESHOLD,
      alternatives: input.osmTagsAlternatives.length,
    });
    const expanded = await executeAlternativesParallel({
      bbox: expandedBbox,
      osmTagsAlternatives: input.osmTagsAlternatives,
      perAltLimit,
      concurrency: RICH_CONCURRENCY,
    });
    lastResult = expanded;
    lastBbox = expandedBbox;
    lastMultiplier = multiplier;

    if (expanded.candidates.length >= SPARSE_THRESHOLD) {
      return {
        candidates: expanded.candidates,
        rawCount: expanded.rawCount,
        mirror: expanded.mirror,
        elapsedMs: expanded.elapsedMs,
        matchMode: "primary_only_expanded",
        primaryTag: null,
        expansionMultiplier: multiplier,
        effectiveBbox: expandedBbox,
        alternativesTried: expanded.attempted,
        alternativesSucceeded: expanded.successCount,
      };
    }
  }

  // Tier 3: best-effort.
  return {
    candidates: lastResult.candidates,
    rawCount: lastResult.rawCount,
    mirror: lastResult.mirror,
    elapsedMs: lastResult.elapsedMs,
    matchMode: "best_effort",
    primaryTag: null,
    expansionMultiplier: lastMultiplier,
    effectiveBbox: lastBbox,
    alternativesTried: lastResult.attempted,
    alternativesSucceeded: lastResult.successCount,
  };
}
