// ---------------------------------------------------------------------------
// Multi-token keyword extraction for upstream APIs.
//
// Why this file exists: NPS, RIDB, and Wikipedia full-text all accept a
// single ?q=... / ?query=... parameter and run their own BM25-flavoured
// scoring over title + body. Previously each provider cherry-picked the
// SINGLE longest scene token and dropped everything else, which silently
// killed recall: for "horse statue" we sent "statue" (6 chars > "horse"
// at 5) and lost every horse-only article.
//
// Today we surface the top-N distinctive tokens, return them both as a
// space-joined OR-style query (the natural input to MediaWiki / NPS /
// RIDB full-text scoring) and as an explicit list so providers that can
// fan out multiple parallel keyword queries can do so.
//
// Pure functions — covered by unit tests.
// ---------------------------------------------------------------------------

/**
 * Words that don't discriminate locations and would only dilute the
 * keyword pool. Same blacklist used by the subject filter and tag-
 * overlap scorer; kept in sync intentionally.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "with",
  "and",
  "or",
  "park",
  "tree",
  "trees",
  "grass",
  "sky",
  "background",
  "outdoor",
  "exterior",
  "interior",
  "building",
  "house",
  "old",
  "new",
  "big",
  "small",
  "large",
  "tiny",
  "modern",
  "ancient",
  "rural",
  "urban",
  "suburban",
  "industrial",
  "wilderness",
  "waterfront",
  "rustic",
]);

export type KeywordExtractionOptions = {
  /** Drop tokens shorter than this (default 4 — "art" / "old" too generic). */
  minLength?: number;
  /** Maximum number of tokens to return (default 3). */
  maxTokens?: number;
  /** When true, multi-word phrases are kept as-is; when false, dropped. */
  allowPhrases?: boolean;
};

export type KeywordExtraction = {
  /** Top-N distinct tokens, longest first (rough IDF proxy). */
  list: string[];
  /**
   * Space-joined query string suitable for ?q= / ?query= /
   * gsrsearch=. MediaWiki, NPS, and RIDB all run OR-style scoring
   * across these on title + body.
   */
  joined: string;
};

/**
 * Extract a focused list of distinctive scene tokens for upstream
 * keyword search. Strategy:
 *   1. Lowercase + de-dupe.
 *   2. Drop tokens in the generic blacklist.
 *   3. Drop tokens shorter than `minLength` chars.
 *   4. Optionally drop multi-word phrases.
 *   5. Sort by length descending (proxy for "more discriminative"),
 *      take the top `maxTokens`.
 *
 * Returns both the explicit list and a space-joined string so callers
 * can pick whichever shape their API expects.
 */
export function extractKeywords(
  sceneTokens: ReadonlyArray<string>,
  opts: KeywordExtractionOptions = {},
): KeywordExtraction {
  const minLength = opts.minLength ?? 4;
  const maxTokens = opts.maxTokens ?? 3;
  const allowPhrases = opts.allowPhrases ?? false;

  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of sceneTokens) {
    const norm = raw.trim().toLowerCase();
    if (norm.length === 0) continue;
    if (norm.length < minLength) continue;
    if (GENERIC_TOKENS.has(norm)) continue;
    if (!allowPhrases && /\s/.test(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    cleaned.push(norm);
  }

  const ranked = [...cleaned].sort((a, b) => b.length - a.length).slice(0, maxTokens);
  return { list: ranked, joined: ranked.join(" ") };
}
