import { z } from "zod";

import { type Bbox, bboxToOverpass } from "@/lib/bbox";
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
  /** All osmTags ANDed together matched at least one feature. */
  | "strict"
  /** Strict match returned 0; we re-queried with only the primary classifier. */
  | "primary_only"
  /** Both attempts returned 0. */
  | "empty";

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
  /** When matchMode === "primary_only", the single tag we matched on. */
  primaryTag: { key: string; value: string } | null;
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
        // wraps and assigns matchMode. We default to "strict" here so single-
        // call use of executeOverpass still satisfies the type.
        matchMode: "strict",
        primaryTag: null,
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
 * High-level helper: build query from inputs, execute, return candidates.
 *
 * If the strict ALL-tag query returns no results AND multiple tags were
 * provided, we automatically retry once with just the primary classifier
 * tag (e.g. "building=warehouse") so the user always gets a starting set
 * to scan. The result's `matchMode` indicates which path returned data.
 */
export async function searchOsm(input: {
  bbox: Bbox;
  osmTags: OsmTags;
  limit?: number;
}): Promise<OverpassSearchResult> {
  // Try strict first.
  const strictQuery = buildOverpassQuery(input);
  const strictResult = await executeOverpass(strictQuery);

  if (strictResult.candidates.length > 0) {
    return { ...strictResult, matchMode: "strict", primaryTag: null };
  }

  const tagCount = Object.keys(input.osmTags).length;
  if (tagCount <= 1) {
    // Already tried with just one tag; nothing looser available.
    return { ...strictResult, matchMode: "empty", primaryTag: null };
  }

  const primary = pickPrimaryTag(input.osmTags);
  if (!primary) {
    return { ...strictResult, matchMode: "empty", primaryTag: null };
  }

  logger.info("overpass strict match empty, falling back to primary tag only", {
    primaryKey: primary.key,
    primaryValue: primary.value,
    droppedCount: tagCount - 1,
  });

  const looseQuery = buildOverpassQuery({
    bbox: input.bbox,
    osmTags: { [primary.key]: primary.value },
    limit: input.limit,
  });
  const looseResult = await executeOverpass(looseQuery);

  return {
    ...looseResult,
    matchMode: looseResult.candidates.length > 0 ? "primary_only" : "empty",
    primaryTag: primary,
  };
}
