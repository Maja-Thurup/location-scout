import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  EMPTY_WIKIDATA_FACTS,
  type WikidataFacts,
} from "@/lib/providers/types";
import { fetchWikidataFacts } from "@/lib/wikidata-rest";

// ---------------------------------------------------------------------------
// Wikibase GraphQL — bulk facts + sitelinks fetcher.
//
// Endpoint: https://wikidata.org/w/wbgraphql.php
// (a.k.a. Wikibase GraphQL — the official replacement for the legacy
// REST entity API; see https://www.wikidata.org/wiki/Wikidata:Wikibase_GraphQL)
//
// Why a dedicated helper:
//   - Bulk: one GraphQL POST returns up to 50 items in a single
//     response. The REST API loops one call per Q-id (12+ on a busy
//     search). One round-trip vs N. The plan's central "single round
//     trip facts + sitelinks" win.
//   - Sitelinks: returns the enwiki article title in the same payload,
//     so the Wikipedia-extracts helper (lib/wikipedia-extracts.ts) can
//     skip the geosearch round-trip entirely.
//
// Stability: upstream marks the endpoint as "not yet stable", so we
// gate it behind env.WIKIDATA_GRAPHQL_ENABLED. When disabled we fall
// back to the REST fact-fetcher per Q-id (lib/wikidata-rest.ts).
//
// License: CC0 for Wikidata data. Polite User-Agent recommended.
// ---------------------------------------------------------------------------

const ENDPOINT = "https://www.wikidata.org/w/wbgraphql.php";
const TIMEOUT_MS = 12_000;
const MAX_BATCH = 50;
export const WIKIDATA_GRAPHQL_BATCH_SIZE = MAX_BATCH;

const QUERY = `
  query items($ids: [String!]!) {
    itemsById(ids: $ids) {
      id
      label(languageCode: "en")
      description(languageCode: "en")
      altLabels: aliases(languageCode: "en")
      sitelinks { siteId title }
      coords: statements(propertyId: "P625") {
        value { ... on GlobeCoordinateValue { latitude longitude } }
      }
      depicts: statements(propertyId: "P180") {
        value { ... on ItemValue { id label(languageCode: "en") } }
      }
      creators: statements(propertyId: "P170") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      architectsA: statements(propertyId: "P84") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      architectsB: statements(propertyId: "P5398") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      materials: statements(propertyId: "P186") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      genres: statements(propertyId: "P136") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      namedAfter: statements(propertyId: "P138") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      partOf: statements(propertyId: "P361") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      hasParts: statements(propertyId: "P527") {
        value { ... on ItemValue { label(languageCode: "en") } }
      }
      inception: statements(propertyId: "P571") {
        value { ... on TimeValue { time } }
      }
      image: statements(propertyId: "P18") {
        value { ... on StringValue { content } }
      }
      commonsCategory: statements(propertyId: "P373") {
        value { ... on StringValue { content } }
      }
    }
  }
`;

// Schema is intentionally permissive — Wikibase GraphQL is in flux
// and we don't want a single shape change to cause cache misses.
const itemValueSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    time: z.string().optional(),
    content: z.string().optional(),
  })
  .partial();

const statementSchema = z
  .object({
    value: itemValueSchema.optional().nullable(),
  })
  .partial();

const sitelinkSchema = z
  .object({
    siteId: z.string(),
    title: z.string(),
  })
  .partial();

const itemSchema = z.object({
  id: z.string(),
  label: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  altLabels: z.array(z.string()).optional().nullable(),
  sitelinks: z.array(sitelinkSchema).optional().nullable(),
  coords: z.array(statementSchema).optional().nullable(),
  depicts: z.array(statementSchema).optional().nullable(),
  creators: z.array(statementSchema).optional().nullable(),
  architectsA: z.array(statementSchema).optional().nullable(),
  architectsB: z.array(statementSchema).optional().nullable(),
  materials: z.array(statementSchema).optional().nullable(),
  genres: z.array(statementSchema).optional().nullable(),
  namedAfter: z.array(statementSchema).optional().nullable(),
  partOf: z.array(statementSchema).optional().nullable(),
  hasParts: z.array(statementSchema).optional().nullable(),
  inception: z.array(statementSchema).optional().nullable(),
  image: z.array(statementSchema).optional().nullable(),
  commonsCategory: z.array(statementSchema).optional().nullable(),
});

const responseSchema = z.object({
  data: z
    .object({
      itemsById: z.array(itemSchema).optional().nullable(),
    })
    .optional()
    .nullable(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      }),
    )
    .optional()
    .nullable(),
});

type Item = z.infer<typeof itemSchema>;

export type WikidataItemBundle = {
  qid: string;
  label: string | null;
  description: string | null;
  altLabels: string[];
  enwikiTitle: string | null;
  facts: WikidataFacts;
  imageUrl: string | null;
  coord: { lat: number; lng: number } | null;
};

function pickLabels(stmts: Array<z.infer<typeof statementSchema>> | null | undefined, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of stmts ?? []) {
    const lbl = s.value?.label;
    if (!lbl) continue;
    const norm = lbl.trim();
    const key = norm.toLowerCase();
    if (!norm || seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
    if (out.length >= max) break;
  }
  return out;
}

function pickFirstString(stmts: Array<z.infer<typeof statementSchema>> | null | undefined): string | null {
  for (const s of stmts ?? []) {
    const v = s.value;
    if (v?.content) return v.content;
    if (v?.label) return v.label;
  }
  return null;
}

function pickInception(stmts: Array<z.infer<typeof statementSchema>> | null | undefined): string | null {
  for (const s of stmts ?? []) {
    const t = s.value?.time;
    if (typeof t !== "string") continue;
    const m = t.match(/^[+-]?(\d{1,4})/);
    if (m) return m[1]!;
  }
  return null;
}

function pickCoord(stmts: Array<z.infer<typeof statementSchema>> | null | undefined): { lat: number; lng: number } | null {
  for (const s of stmts ?? []) {
    const v = s.value;
    if (
      v &&
      typeof v.latitude === "number" &&
      typeof v.longitude === "number"
    ) {
      return { lat: v.latitude, lng: v.longitude };
    }
  }
  return null;
}

function buildEnwikiTitle(
  sitelinks: Array<z.infer<typeof sitelinkSchema>> | null | undefined,
): string | null {
  for (const sl of sitelinks ?? []) {
    if (sl.siteId === "enwiki" && sl.title) return sl.title;
  }
  return null;
}

function buildCommonsImageUrl(stmts: Array<z.infer<typeof statementSchema>> | null | undefined): string | null {
  const filename = pickFirstString(stmts);
  if (!filename) return null;
  // P18 stores the bare Commons filename; build a Special:FilePath URL
  // that 302-redirects to the actual image (same approach as the
  // SPARQL provider).
  const safe = filename.replace(/ /g, "_");
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(safe)}`;
}

function itemToBundle(item: Item): WikidataItemBundle {
  const architects = [
    ...pickLabels(item.architectsA, 3),
    ...pickLabels(item.architectsB, 3),
  ];
  // Dedupe architects across the two property paths.
  const archSeen = new Set<string>();
  const dedupedArchitects: string[] = [];
  for (const a of architects) {
    const key = a.toLowerCase();
    if (archSeen.has(key)) continue;
    archSeen.add(key);
    dedupedArchitects.push(a);
    if (dedupedArchitects.length >= 3) break;
  }

  const facts: WikidataFacts = {
    inception: pickInception(item.inception),
    creators: pickLabels(item.creators, 3),
    architects: dedupedArchitects,
    materials: pickLabels(item.materials, 3),
    genres: pickLabels(item.genres, 3),
    depicts: pickLabels(item.depicts, 6),
    namedAfter: pickLabels(item.namedAfter, 3),
    partOf: pickLabels(item.partOf, 3),
    hasParts: pickLabels(item.hasParts, 3),
    commonsCategory: pickFirstString(item.commonsCategory),
    altLabels: (item.altLabels ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 8),
  };
  return {
    qid: item.id,
    label: item.label ?? null,
    description: item.description ?? null,
    altLabels: facts.altLabels.slice(),
    enwikiTitle: buildEnwikiTitle(item.sitelinks),
    facts,
    imageUrl: buildCommonsImageUrl(item.image),
    coord: pickCoord(item.coords),
  };
}

async function executeBatch(
  ids: ReadonlyArray<string>,
): Promise<Map<string, WikidataItemBundle>> {
  const out = new Map<string, WikidataItemBundle>();
  if (ids.length === 0) return out;

  let raw: unknown;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      body: JSON.stringify({ query: QUERY, variables: { ids: [...ids] } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("wikidata GraphQL HTTP error", { status: res.status });
      return out;
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("wikidata GraphQL fetch failed", { err: String(err) });
    return out;
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("wikidata GraphQL schema mismatch", {
      issue: parsed.error.issues[0]?.message,
    });
    return out;
  }
  const errs = parsed.data.errors ?? [];
  if (errs.length > 0) {
    logger.warn("wikidata GraphQL returned errors", {
      message: errs[0]?.message ?? "unknown",
      count: errs.length,
    });
  }

  const items = parsed.data.data?.itemsById ?? [];
  for (const item of items) {
    if (!/^Q\d+$/.test(item.id)) continue;
    out.set(item.id, itemToBundle(item));
  }
  return out;
}

/**
 * Fetch labels, facts, P18 image, and sitelinks for a list of Q-ids in
 * one or more 50-item batches. Cached 7 days per Q-id.
 *
 * When `env.WIKIDATA_GRAPHQL_ENABLED` is false (default) we fall back
 * to the REST fact fetcher (lib/wikidata-rest.ts) per Q-id. The REST
 * path doesn't return sitelinks, so `enwikiTitle` will be null in
 * fallback mode — the geosearch provider remains the source of truth
 * in that case.
 */
export async function fetchWikidataItemsById(
  qids: ReadonlyArray<string>,
): Promise<Map<string, WikidataItemBundle>> {
  const out = new Map<string, WikidataItemBundle>();
  const unique = Array.from(
    new Set(qids.map((q) => q.trim().toUpperCase()).filter((q) => /^Q\d+$/.test(q))),
  );
  if (unique.length === 0) return out;

  // Per-Q-id cache lookup first.
  const missing: string[] = [];
  await Promise.all(
    unique.map(async (qid) => {
      const k = cacheKey("wikidata:rest", { kind: "graphql-bundle-v1", qid });
      const cached = await cacheGet<WikidataItemBundle>(k);
      if (cached) {
        out.set(qid, cached);
      } else {
        missing.push(qid);
      }
    }),
  );

  if (missing.length === 0) return out;

  if (!env.WIKIDATA_GRAPHQL_ENABLED) {
    // REST fallback: fetch facts per Q-id; we lack sitelinks so the
    // bundle's enwikiTitle stays null. Cache via REST's own cache so
    // we don't double-write the GraphQL key when the flag flips.
    await Promise.all(
      missing.map(async (qid) => {
        const facts = await fetchWikidataFacts(qid);
        const bundle: WikidataItemBundle = {
          qid,
          label: null,
          description: null,
          altLabels: facts.altLabels.slice(),
          enwikiTitle: null,
          facts,
          imageUrl: null,
          coord: null,
        };
        out.set(qid, bundle);
      }),
    );
    return out;
  }

  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += MAX_BATCH) {
    batches.push(missing.slice(i, i + MAX_BATCH));
  }
  const settled = await Promise.allSettled(
    batches.map((batch) => executeBatch(batch)),
  );
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status !== "fulfilled") continue;
    for (const [qid, bundle] of r.value) {
      out.set(qid, bundle);
      const k = cacheKey("wikidata:rest", { kind: "graphql-bundle-v1", qid });
      await cacheSet(k, "wikidata:rest", bundle, 7);
    }
  }

  // Q-ids the GraphQL endpoint didn't return — fall through to REST so
  // the consumer always gets a (possibly empty) facts payload.
  const stillMissing = missing.filter((q) => !out.has(q));
  if (stillMissing.length > 0) {
    await Promise.all(
      stillMissing.map(async (qid) => {
        const facts = await fetchWikidataFacts(qid);
        out.set(qid, {
          qid,
          label: null,
          description: null,
          altLabels: facts.altLabels.slice(),
          enwikiTitle: null,
          facts: facts ?? EMPTY_WIKIDATA_FACTS,
          imageUrl: null,
          coord: null,
        });
      }),
    );
  }

  return out;
}
