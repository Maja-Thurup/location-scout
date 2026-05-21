import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
import { EMPTY_WIKIDATA_FACTS, type WikidataFacts } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Wikidata REST API — single-Q-item fact enrichment.
//
// Why we have BOTH SPARQL and REST clients:
//   - SPARQL (lib/providers/wikidata-landmark.ts) runs at retrieval
//     time, aggregates dozens of items at once, and pulls the same
//     OPTIONAL block over a bbox.
//   - REST (this file) runs at CARD time on candidates that have a
//     Q-id but no facts yet (e.g. an OSM node tagged `wikidata=Q1234`
//     that didn't pass through the SPARQL provider). One round-trip
//     per Q-id, cached 7 days. Used by the enrich-locations route.
//
// Endpoint: https://www.wikidata.org/w/rest.php/wikibase/v1
// No API key. Polite User-Agent recommended.
// License: CC0 for data, CC BY-SA for Wikipedia text.
// ---------------------------------------------------------------------------

const REST_BASE = "https://www.wikidata.org/w/rest.php/wikibase/v1";
const REST_TIMEOUT_MS = 12_000;

const PROPERTY_OF_INTEREST = {
  inception: "P571",
  creator: "P170",
  architect: "P84",
  architectV2: "P5398",
  material: "P186",
  genre: "P136",
  depicts: "P180",
  namedAfter: "P138",
  partOf: "P361",
  hasPart: "P527",
  commonsCategory: "P373",
} as const;

const valueSchema = z.object({
  type: z.string(),
  content: z.unknown(),
});

const statementSchema = z.object({
  property: z.object({ id: z.string() }),
  value: valueSchema.optional(),
});

const itemSchema = z.object({
  id: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
  descriptions: z.record(z.string(), z.string()).optional(),
  aliases: z.record(z.string(), z.array(z.string())).optional(),
  statements: z.record(z.string(), z.array(statementSchema)).optional(),
});

type WikibaseItem = z.infer<typeof itemSchema>;

/**
 * Resolve a Wikidata Q-id reference to a human-readable label by
 * fetching the linked item's English label. We cache the resolution
 * indefinitely (Q-id → label mappings change rarely) so multiple
 * cards referring to the same creator/material/etc share the lookup.
 */
async function resolveQidLabel(qid: string): Promise<string | null> {
  const k = cacheKey("wikidata:rest", { kind: "label", qid });
  const cached = await cacheGet<string | null>(k);
  if (cached !== null) return cached;
  try {
    const url = `${REST_BASE}/entities/items/${qid}/labels/en`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 is normal — many qids don't have an English label.
      await cacheSet(k, "wikidata:rest", null, 30);
      return null;
    }
    const text = await res.text();
    let value: string | null = null;
    try {
      // Endpoint returns a bare JSON string ("\"Bronze\"") for that
      // single label.
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") value = parsed;
    } catch {
      value = null;
    }
    await cacheSet(k, "wikidata:rest", value, 30);
    return value;
  } catch (err) {
    logger.warn("wikidata REST label fetch failed", { qid, err: String(err) });
    return null;
  }
}

/**
 * Extract the inner Q-id from a Wikibase REST statement value of type
 * "wikibase-entityid". Other value types (string, time, monolingual
 * text) are passed back as-is.
 */
function readStatementValue(
  v: z.infer<typeof valueSchema> | undefined,
): { qid?: string; raw?: string } {
  if (!v) return {};
  const c = v.content as unknown;
  if (typeof c === "string") return { raw: c };
  if (c && typeof c === "object") {
    const obj = c as Record<string, unknown>;
    if (typeof obj.id === "string" && /^Q\d+$/.test(obj.id)) {
      return { qid: obj.id };
    }
    if (typeof obj.time === "string") return { raw: obj.time };
    if (typeof obj.text === "string") return { raw: obj.text };
  }
  return {};
}

/**
 * Convert a list of statement values (qid OR raw) into a deduped
 * label list, resolving qids via the REST label endpoint when needed.
 * Caps at `max` entries to keep card payloads light.
 */
async function valuesToLabels(
  vals: Array<{ qid?: string; raw?: string }>,
  max = 3,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of vals) {
    if (out.length >= max) break;
    let label: string | null = null;
    if (v.qid) {
      label = await resolveQidLabel(v.qid);
    } else if (v.raw) {
      label = v.raw;
    }
    if (!label) continue;
    const norm = label.trim();
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function readStatementValues(
  item: WikibaseItem,
  pid: string,
): Array<{ qid?: string; raw?: string }> {
  const list = item.statements?.[pid];
  if (!list) return [];
  return list.map((s) => readStatementValue(s.value));
}

/**
 * Normalise inception P571 to a 4-digit year. SPARQL returns ISO
 * datetimes; the REST API returns Wikibase time literals like
 * "+1885-10-28T00:00:00Z". Same trim either way.
 */
function normaliseYear(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^[+-]?(\d{1,4})/);
  return m ? m[1]! : null;
}

/**
 * Fetch a Wikidata item via the REST API and project it onto our
 * WikidataFacts shape. Cached 7 days. Returns EMPTY_WIKIDATA_FACTS
 * when the item is unreachable rather than null so callers can
 * memoize without juggling two empty states.
 */
export async function fetchWikidataFacts(qid: string): Promise<WikidataFacts> {
  if (!/^Q\d+$/.test(qid)) return EMPTY_WIKIDATA_FACTS;
  const k = cacheKey("wikidata:rest", { kind: "facts-v1", qid });
  const cached = await cacheGet<WikidataFacts>(k);
  if (cached) return cached;

  let item: WikibaseItem | null = null;
  try {
    const url = `${REST_BASE}/entities/items/${qid}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await cacheSet(k, "wikidata:rest", EMPTY_WIKIDATA_FACTS, 7);
      return EMPTY_WIKIDATA_FACTS;
    }
    const raw = await res.json();
    const parsed = itemSchema.safeParse(raw);
    if (!parsed.success) {
      await cacheSet(k, "wikidata:rest", EMPTY_WIKIDATA_FACTS, 1);
      return EMPTY_WIKIDATA_FACTS;
    }
    item = parsed.data;
  } catch (err) {
    logger.warn("wikidata REST fetch failed", { qid, err: String(err) });
    return EMPTY_WIKIDATA_FACTS;
  }

  const inceptionRaw =
    readStatementValues(item, PROPERTY_OF_INTEREST.inception)[0]?.raw ?? null;
  // Architects come from EITHER P84 or P5398 — union them.
  const architectsRaw = [
    ...readStatementValues(item, PROPERTY_OF_INTEREST.architect),
    ...readStatementValues(item, PROPERTY_OF_INTEREST.architectV2),
  ];
  const [
    creators,
    architects,
    materials,
    genres,
    depicts,
    namedAfter,
    partOf,
    hasParts,
  ] = await Promise.all([
    valuesToLabels(readStatementValues(item, PROPERTY_OF_INTEREST.creator)),
    valuesToLabels(architectsRaw),
    valuesToLabels(readStatementValues(item, PROPERTY_OF_INTEREST.material)),
    valuesToLabels(readStatementValues(item, PROPERTY_OF_INTEREST.genre)),
    valuesToLabels(
      readStatementValues(item, PROPERTY_OF_INTEREST.depicts),
      6,
    ),
    valuesToLabels(readStatementValues(item, PROPERTY_OF_INTEREST.namedAfter)),
    valuesToLabels(readStatementValues(item, PROPERTY_OF_INTEREST.partOf)),
    valuesToLabels(readStatementValues(item, PROPERTY_OF_INTEREST.hasPart)),
  ]);

  const commonsCategoryRaw = readStatementValues(
    item,
    PROPERTY_OF_INTEREST.commonsCategory,
  )[0]?.raw ?? null;

  const altLabels = (item.aliases?.en ?? []).slice(0, 8);

  const facts: WikidataFacts = {
    inception: normaliseYear(inceptionRaw),
    creators,
    architects,
    materials,
    genres,
    depicts,
    namedAfter,
    partOf,
    hasParts,
    commonsCategory: commonsCategoryRaw ?? null,
    altLabels,
  };

  await cacheSet(k, "wikidata:rest", facts, 7);
  return facts;
}

/**
 * Card-time enrichment helper: when a cluster has a Q-id but its
 * facts payload is sparse (no inception, no creators), fetch the
 * REST API to fill it in. Cheap because most cards either already
 * have facts (Wikidata SPARQL) or have no Q-id at all.
 */
export async function enrichWikidataFacts(input: {
  qid: string | null | undefined;
  existing: WikidataFacts | undefined;
}): Promise<WikidataFacts | undefined> {
  const qid = input.qid?.trim();
  if (!qid) return input.existing;
  // If we already have a meaty payload, skip the round-trip.
  const e = input.existing;
  if (
    e &&
    (e.inception ||
      e.creators.length > 0 ||
      e.architects.length > 0 ||
      e.materials.length > 0 ||
      e.depicts.length > 0)
  ) {
    return e;
  }
  return fetchWikidataFacts(qid);
}
