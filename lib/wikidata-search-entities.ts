import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// MediaWiki / Wikidata wbsearchentities — free-text → Q-id resolver.
//
// Wikibase GraphQL doesn't support free-text label search. To turn a
// user-typed noun ("horse", "lion", "MLK", "Roman amphitheater", "art
// deco") into a Q-id we hit the legacy MediaWiki Action API:
//
//   GET https://www.wikidata.org/w/api.php
//     ?action=wbsearchentities
//     &search=<term>
//     &language=en
//     &type=item
//     &limit=5
//     &format=json
//
// The first hit (highest relevance) is the Q-id we use for downstream
// SPARQL P180 queries and Wikibase GraphQL itemsById fetches.
//
// Cached 30 days — the noun → Q-id mapping is stable for years.
// Generic for any prompt; the SUBJECT_QIDS dictionary in
// wikidata-landmark.ts now serves as a fast in-process cache for
// common nouns. Anything not in that dictionary falls through here.
//
// License: CC0 for Wikidata data. No API key required. Polite
// User-Agent strongly recommended.
// ---------------------------------------------------------------------------

const API = "https://www.wikidata.org/w/api.php";
const TIMEOUT_MS = 8_000;

const responseSchema = z.object({
  search: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
        match: z
          .object({
            type: z.string().optional(),
            text: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

export type WbSearchEntitiesHit = {
  qid: string;
  label: string | null;
  description: string | null;
};

/**
 * In-process fast cache. Survives a single request only — Redis-backed
 * `cacheGet`/`cacheSet` handles cross-request persistence.
 */
const memoCache = new Map<string, WbSearchEntitiesHit[] | null>();

function memoKey(term: string, lang: string, type: string, limit: number): string {
  return `${type}|${lang}|${limit}|${term.toLowerCase().trim()}`;
}

/**
 * Search Wikidata for items matching a free-text noun. Returns up to
 * `limit` hits ordered by relevance, or `null` on transient failure.
 * Returns `[]` (empty array) when the API succeeded but had no hits.
 */
export async function wbSearchEntities(
  term: string,
  options: {
    /** ISO language code. Default: "en". */
    lang?: string;
    /** "item" (default) | "property" | "sense". */
    type?: "item" | "property" | "sense";
    /** Max hits to return. Default: 5. */
    limit?: number;
  } = {},
): Promise<WbSearchEntitiesHit[] | null> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];

  const lang = options.lang ?? "en";
  const type = options.type ?? "item";
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));

  const memo = memoKey(trimmed, lang, type, limit);
  const inProc = memoCache.get(memo);
  if (inProc !== undefined) return inProc;

  const k = cacheKey("wikidata:rest", {
    kind: "wbsearchentities-v1",
    term: trimmed.toLowerCase(),
    lang,
    type,
    limit,
  });
  const cached = await cacheGet<WbSearchEntitiesHit[]>(k);
  if (cached) {
    memoCache.set(memo, cached);
    return cached;
  }

  const url = new URL(API);
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("search", trimmed);
  url.searchParams.set("language", lang);
  url.searchParams.set("uselang", lang);
  url.searchParams.set("type", type);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  let raw: unknown;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("wbsearchentities HTTP error", {
        term: trimmed,
        status: res.status,
      });
      return null;
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("wbsearchentities fetch failed", {
      term: trimmed,
      err: String(err),
    });
    return null;
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("wbsearchentities schema mismatch", {
      term: trimmed,
      issue: parsed.error.issues[0]?.message,
    });
    return null;
  }

  const hits: WbSearchEntitiesHit[] = parsed.data.search
    .filter((h) => /^Q\d+$/.test(h.id))
    .map((h) => ({
      qid: h.id,
      label: h.label ?? null,
      description: h.description ?? null,
    }));

  memoCache.set(memo, hits);
  await cacheSet(k, "wikidata:rest", hits, 30);
  return hits;
}

/**
 * Resolve a single user-typed noun to its top Q-id, or null when there
 * is no match. Use this when you only need the canonical Q-id (e.g.
 * for the P180-depicts SPARQL arm). Cached 30 days.
 */
export async function resolveSubjectQid(
  term: string,
  options: { lang?: string } = {},
): Promise<string | null> {
  const hits = await wbSearchEntities(term, { lang: options.lang, limit: 1 });
  if (!hits || hits.length === 0) return null;
  return hits[0]!.qid;
}

/**
 * Resolve a list of nouns to Q-ids in parallel. Skips terms that fail
 * to resolve. Use for the planner's `query_hints.depicts_qids`.
 */
export async function resolveSubjectQids(
  terms: ReadonlyArray<string>,
  options: { lang?: string } = {},
): Promise<string[]> {
  const unique = Array.from(
    new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2)),
  );
  const results = await Promise.all(
    unique.map((t) => resolveSubjectQid(t, options)),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const qid of results) {
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);
    out.push(qid);
  }
  return out;
}
