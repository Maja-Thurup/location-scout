import type { MergedCandidate } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Tag-overlap scoring — the missing piece between LLM-extracted scene
// tokens and candidate text fields.
//
// For "horse statue in a park" Claude emits scene_tokens like
// ["horse", "statue", "monument", "park", "equestrian", "bronze"] and
// anti_tokens like ["modern", "high_rise", "indoor"]. A candidate's
// name + description + tag values forms its TEXT BLOB. We count the
// scene_tokens that appear in the blob, minus a small penalty for
// each anti_token that appears.
//
// Why this matters: for confident, content-rich prompts ("horse statue",
// "abandoned brick warehouse", "lighthouse on a cliff") the BEST
// candidates have scene_token matches in their NAME alone. Vision
// scoring is unnecessary noise when text retrieval already nails the
// answer. M5's free tier will skip vision entirely when
// confidence is high; M5's deep tier will keep it.
//
// Pure functions — covered by unit tests.
// ---------------------------------------------------------------------------

/**
 * Generic-descriptor blacklist. These appear in many scenes and don't
 * meaningfully discriminate between candidates. Subtract them from
 * effective tokens so a candidate doesn't get rewarded for having
 * "outdoor" or "day" in its description.
 */
const GENERIC_TOKENS = new Set([
  "old",
  "new",
  "modern",
  "ancient",
  "weathered",
  "decayed",
  "worn",
  "rural",
  "urban",
  "suburban",
  "industrial",
  "wilderness",
  "waterfront",
  "rustic",
  "wooden",
  "brick",
  "stone",
  "concrete",
  "metal",
  "glass",
  "plaster",
  "bright",
  "dark",
  "shadowy",
  "sunny",
  "daylight",
  "day",
  "night",
  "dawn",
  "dusk",
  "big",
  "small",
  "large",
  "tiny",
  "outdoor",
  "indoor",
  "exterior",
  "interior",
  "public",
  "private",
  "residential",
  "commercial",
  "retro",
  "vintage",
  "contemporary",
  "open_space",
  "central_location",
  "pedestrian",
  "trees",
  "grass",
]);

/** Convert a candidate's text fields into a single lowercased blob. */
export function buildCandidateText(c: MergedCandidate): string {
  const parts: string[] = [];
  if (c.name) parts.push(c.name);
  if (c.description) parts.push(c.description);
  for (const v of Object.values(c.tags)) {
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  return parts.join(" \u2022 ").toLowerCase();
}

/**
 * Convert a scene token to a regex-friendly form. Underscored tokens
 * (e.g. "horse_statue") match either the underscore form OR space-
 * separated form ("horse statue") OR hyphenated form ("horse-statue").
 */
function tokenAlternates(token: string): string[] {
  const lower = token.toLowerCase().trim();
  if (lower.length === 0) return [];
  const flat = lower.replace(/_/g, " ");
  const variants = new Set<string>([lower, flat, flat.replace(/\s+/g, "-")]);
  return [...variants];
}

/**
 * Count tag-overlap between scene tokens and a candidate's text blob.
 * Generic descriptors are filtered out before counting.
 */
function countMatches(
  tokens: ReadonlyArray<string>,
  haystack: string,
): { matched: string[]; matchedCount: number } {
  const matched: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase().trim();
    if (lower.length === 0) continue;
    if (GENERIC_TOKENS.has(lower)) continue;
    const variants = tokenAlternates(lower);
    for (const v of variants) {
      if (haystack.includes(v)) {
        matched.push(lower);
        break;
      }
    }
  }
  return { matched, matchedCount: matched.length };
}

export type TagOverlapScore = {
  /** Distinctive scene tokens matched in name+description+tags. */
  matched: ReadonlyArray<string>;
  /** Anti-tokens visibly present in the same blob (penalty). */
  antiMatched: ReadonlyArray<string>;
  /**
   * Final overlap score = matched.count - 2 * antiMatched.count.
   * Negative scores are clamped to 0 by callers when used as a ranking
   * multiplier; the raw negative is still surfaced for debugging.
   */
  score: number;
};

export function tagOverlapScore(
  candidate: MergedCandidate,
  sceneTokens: ReadonlyArray<string>,
  antiTokens: ReadonlyArray<string>,
): TagOverlapScore {
  const blob = buildCandidateText(candidate);
  const positive = countMatches(sceneTokens, blob);
  const negative = countMatches(antiTokens, blob);
  return {
    matched: positive.matched,
    antiMatched: negative.matched,
    score: positive.matchedCount - 2 * negative.matchedCount,
  };
}

/**
 * Combined score for sorting: RRF rank-score + tag-overlap multiplier.
 *
 * The 0.15 multiplier was chosen so a candidate with 3 distinctive
 * token matches gets roughly the same score as a candidate that
 * appeared #1 in a high-weight retriever. Tunable.
 */
export function combinedRank(
  rrfScore: number,
  overlap: TagOverlapScore,
): number {
  const overlapBoost = Math.max(0, overlap.score) * 0.15;
  return rrfScore + overlapBoost;
}

// ---------------------------------------------------------------------------
// Skip-vision confidence gate
// ---------------------------------------------------------------------------

/**
 * Decide whether the tag-overlap signal is strong enough to skip vision
 * scoring entirely. Used by the M5 free tier (vision is paid) and as a
 * latency optimization on the deep tier.
 *
 * Heuristic:
 *   - Top candidate has matched >= 3 distinctive tokens
 *   - AND the user supplied at least 4 distinctive scene tokens (so the
 *     overlap measurement is meaningful)
 *   - AND we have at least 6 candidates with overlap >= 1
 *
 * Returns false (= run vision) when the prompt is vague or when our
 * candidate pool is sparse on token matches.
 */
export function isHighConfidence(args: {
  topOverlap: TagOverlapScore | null;
  poolOverlaps: ReadonlyArray<TagOverlapScore>;
  sceneTokens: ReadonlyArray<string>;
}): boolean {
  const distinctiveTokens = args.sceneTokens.filter(
    (t) => !GENERIC_TOKENS.has(t.toLowerCase()),
  );
  if (distinctiveTokens.length < 4) return false;
  if (!args.topOverlap || args.topOverlap.score < 3) return false;
  const withOverlap = args.poolOverlaps.filter((o) => o.score >= 1).length;
  return withOverlap >= 6;
}
