import { nameMatchesSubjectTerms } from "@/lib/osm-scene-filter";
import { synonymsFor } from "@/lib/subject-synonyms";
import type { MergedCandidate } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Tag-overlap scoring — the bridge between prompt-derived scene tokens
// and candidate text fields.
//
// For "horse statue in a park" Claude emits scene_tokens drawn directly
// from the prompt: ["horse", "statue", "park", "horse statue"]. A
// candidate's name + description + tag values forms its TEXT BLOB. We
// count which scene_tokens appear in the blob and weight each match by
// its IDF (rare tokens like "horse" or "statue" outweigh common ones
// like "park").
//
// Why this matters: for confident, content-rich prompts ("horse statue",
// "abandoned brick warehouse", "lighthouse on a cliff") the BEST
// candidates have scene_token matches in their NAME alone. Vision
// scoring is unnecessary noise when text retrieval already nails the
// answer — free tier skips vision entirely; deep tier keeps it.
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

/**
 * Approximate Inverse Document Frequency weights — chosen by hand based on
 * how often each token would appear in a candidate's name/description in
 * a typical city.
 *
 * Methodology (Salton-McGill TF-IDF, Robertson BM25 background):
 *   IDF(t) ≈ log(N / df(t)) where df(t) is the document frequency of
 *   token t. We approximate df by intuition for city-scale data:
 *
 *   - "park", "monument", "house", "building" — appear in HUNDREDS of
 *     candidates per city. Low weight (0.5).
 *   - "statue", "sculpture", "memorial", "fountain" — appear in TENS.
 *     Medium weight (1.0 default).
 *   - "equestrian", "obelisk", "lighthouse", "carousel", "phone_booth",
 *     "cobblestone" — appear in single digits. Very high weight (3.0).
 *
 * Tokens not in this table get the default weight (1.0).
 *
 * Reference for the underlying ranking literature:
 *   - Salton & McGill 1983, "Introduction to Modern Information Retrieval"
 *   - Robertson et al. 1994, "Okapi at TREC-3" (BM25)
 *   - Cormack et al. 2009, "Reciprocal Rank Fusion outperforms Condorcet"
 */
const TOKEN_IDF_WEIGHTS: ReadonlyMap<string, number> = new Map([
  // Very rare = strongly discriminative
  ["equestrian", 3.0],
  ["obelisk", 3.0],
  ["lighthouse", 3.0],
  ["carousel", 3.0],
  ["phone_booth", 3.0],
  ["cobblestone", 3.0],
  ["belltower", 3.0],
  ["clocktower", 3.0],
  ["windmill", 3.0],
  ["watermill", 3.0],
  ["aqueduct", 3.0],
  ["amphitheater", 3.0],
  ["pagoda", 3.0],
  ["bandstand", 3.0],
  ["minaret", 3.0],
  ["gazebo", 2.5],
  ["pavilion", 2.0],
  ["arch", 2.0],
  ["pier", 2.0],
  ["mausoleum", 2.5],
  ["tomb", 2.5],
  ["crypt", 2.5],
  ["abandoned", 2.0],
  ["ruins", 2.5],
  ["ruined", 2.5],
  ["graffiti", 2.0],
  ["boarded_up", 2.5],
  ["peeling_paint", 2.5],
  ["industrial", 1.5],
  ["warehouse", 2.0],
  ["factory", 2.0],
  ["smokestack", 3.0],
  ["silo", 2.5],
  ["barn", 2.0],
  ["farmhouse", 2.0],
  // Compound subject tokens (tightly bound, very discriminative)
  ["horse_statue", 3.0],
  ["fire_hydrant", 2.5],
  ["water_tower", 2.5],
  ["pump_house", 2.5],

  // Animal subject nouns. When these appear in scene_tokens the user
  // typically wants the literal thing — not just any "memorial" or
  // "statue". Weighted high so Sherman/Joan/Bolívar (whose blobs
  // contain "horse" / "horseback") leapfrog Statue of Liberty.
  ["horse", 2.5],
  ["dog", 2.5],
  ["cat", 2.5],
  ["lion", 2.5],
  ["eagle", 2.5],
  ["buffalo", 2.5],
  ["bear", 2.5],
  ["tiger", 2.5],
  ["whale", 2.5],
  ["horseback", 2.5], // very common synonym in monument descriptions
  ["rider", 2.0],
  ["jockey", 2.5],
  ["cavalry", 2.5],
  ["knight", 2.5],

  // Medium specificity
  ["statue", 1.5],
  ["sculpture", 1.5],
  ["fountain", 1.5],
  ["memorial", 1.0],
  ["monument", 0.8], // very common in city candidate text
  ["bridge", 1.2],
  ["tower", 1.2],
  ["church", 1.0],
  ["chapel", 1.5],
  ["cathedral", 1.5],
  ["museum", 1.0],
  ["library", 1.5],

  // Common = low discriminative power
  ["park", 0.5],
  ["building", 0.4],
  ["house", 0.5],
  ["square", 0.6],
  ["plaza", 0.7],
  ["road", 0.3],
  ["street", 0.3],
  ["highway", 0.5],

  // Colors and materials are usually NOT in the candidate text;
  // they'd come from the photo. Low weight here.
  ["bronze", 0.6],
  ["copper", 0.6],
  ["marble", 0.7],
  ["sandstone", 0.7],
  ["limestone", 0.7],
  ["red", 0.3],
  ["blue", 0.3],
  ["yellow", 0.3],
  ["green", 0.3],

  // Aggregated nouns
  ["landmark", 0.5],
  ["public_art", 0.7],
  ["artwork", 0.7],
]);

const DEFAULT_TOKEN_WEIGHT = 1.0;

/** Look up a token's IDF weight; default 1.0 for unknown tokens. */
function idfWeight(token: string): number {
  const normalized = token.toLowerCase().trim();
  return TOKEN_IDF_WEIGHTS.get(normalized) ?? DEFAULT_TOKEN_WEIGHT;
}

/**
 * Tag keys whose VALUE we surface verbatim into the blob (not as
 * "key=value"). These hold the subject/type/era nouns the ranking
 * matcher actually reads. Same family for any prompt — the prompt
 * parse fills in the value.
 */
const BLOB_VALUE_KEYS: ReadonlyArray<string> = [
  "name",
  "name:en",
  "alt_name",
  "alt_name:en",
  "loc_name",
  "was:name",
  "old_name",
  "official_name",
  "subject",
  "subject:en",
  "artwork_subject",
  "artwork_type",
  "statue",
  "memorial",
  "historic",
  "historic:civilization",
  "building:architecture",
  "tourism",
  "leisure",
  "man_made",
  "amenity",
  "natural",
  "shop",
  "inscription",
  "inscription:en",
  "memorial:text",
  "artist_name",
];

/** Convert a candidate's text fields into a single lowercased blob. */
export function buildCandidateText(c: MergedCandidate): string {
  const parts: string[] = [];
  if (c.name) parts.push(c.name);
  if (c.description) parts.push(c.description);
  if (c.wikidataFacts?.depicts?.length) {
    parts.push(...c.wikidataFacts.depicts);
  }
  if (c.wikidataFacts?.altLabels?.length) {
    parts.push(...c.wikidataFacts.altLabels);
  }
  if (c.wikidataFacts?.namedAfter?.length) {
    parts.push(...c.wikidataFacts.namedAfter);
  }
  if (c.wikidataFacts?.materials?.length) {
    parts.push(...c.wikidataFacts.materials);
  }
  if (c.wikidataFacts?.genres?.length) {
    parts.push(...c.wikidataFacts.genres);
  }
  // Surface high-signal tag values verbatim so synonym expansion
  // ("equestrian" → "horse") matches both name AND structured tags.
  for (const k of BLOB_VALUE_KEYS) {
    const v = c.tags[k];
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  // Append every remaining tag's value. We catch anything not in the
  // value-keys list above (e.g. building:material, surface, …) so the
  // matcher still sees rare but discriminative attributes.
  const seen = new Set<string>(BLOB_VALUE_KEYS);
  for (const [k, v] of Object.entries(c.tags)) {
    if (seen.has(k)) continue;
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
  // Layer in synonyms from the dictionary — "horse" picks up
  // "equestrian", "horseback", "rider", "cavalry", ... so a candidate
  // whose text contains those words still scores positive. Without
  // this layer the IDF-weighted overlap would silently miss a third
  // of horse-statue candidates whose Wikidata description literally
  // says "equestrian statue of ...".
  const syn = synonymsFor(lower);
  if (syn) {
    for (const s of syn) {
      if (s && s.length > 0) variants.add(s);
    }
  }
  return [...variants];
}

/**
 * Count tag-overlap between scene tokens and a candidate's text blob.
 * Generic descriptors are filtered out before counting. Returns both
 * the list of matched tokens AND the IDF-weighted score so callers
 * can present matches honestly while ranking by importance.
 */
function countMatches(
  tokens: ReadonlyArray<string>,
  haystack: string,
  conceptTokenWeights?: ReadonlyMap<string, number>,
): { matched: string[]; weightedScore: number } {
  const matched: string[] = [];
  let weightedScore = 0;
  for (const t of tokens) {
    const lower = t.toLowerCase().trim();
    if (lower.length === 0) continue;
    if (GENERIC_TOKENS.has(lower)) continue;
    const conceptMul = conceptTokenWeights?.get(lower);
    const variants = tokenAlternates(lower);
    for (const v of variants) {
      if (haystack.includes(v)) {
        matched.push(lower);
        const base = idfWeight(lower);
        weightedScore += conceptMul != null ? base * conceptMul : base;
        break;
      }
    }
  }
  return { matched, weightedScore };
}

export type TagOverlapScore = {
  /** Distinctive scene_tokens matched in name+description+tags. */
  matched: ReadonlyArray<string>;
  /**
   * OSM classifier alternatives from Claude that match this candidate's
   * tags (e.g. tourism=artwork, leisure=park).
   */
  matchedOsmAlternatives: ReadonlyArray<string>;
  /**
   * Total prompt tag hits = scene token matches + OSM alternative matches.
   * Primary sort key: more hits rank higher (3 beats 1).
   */
  hitCount: number;
  /** Whether the candidate's NAME matches the subject name-regex. Metadata only. */
  subjectNameMatched?: boolean;
  hasImage?: boolean;
  /** IDF-weighted score — tiebreaker after hitCount, not a 2.5× name boost. */
  score: number;
};

export type TagOverlapOptions = {
  /** Claude `osm_tags_alternatives` — each matching key=value adds one hit. */
  osmTagsAlternatives?: ReadonlyArray<Record<string, string>>;
  /** Pipe-separated name synonyms from the `name` alternative. */
  subjectNameRegex?: string | null;
  /** Per-token multipliers from retrieval_plan concepts (overrides flat IDF). */
  conceptTokenWeights?: ReadonlyMap<string, number>;
};

/**
 * Count how many Overpass alternatives match the candidate's OSM tags
 * (and optionally the name-regex alternative).
 */
export function countOsmAlternativeHits(
  candidate: MergedCandidate,
  alternatives: ReadonlyArray<Record<string, string>>,
  subjectNameRegex: string | null | undefined,
): { matched: string[]; count: number } {
  const matched: string[] = [];
  for (const alt of alternatives) {
    for (const [k, v] of Object.entries(alt)) {
      if (!k || !v) continue;
      if (k === "name") {
        if (candidate.name && subjectNameRegex) {
          try {
            const parts = subjectNameRegex.split("|").map((p) => p.trim());
            if (nameMatchesSubjectTerms(candidate.name, parts)) {
              matched.push("name≈subject");
            }
          } catch {
            /* bad regex */
          }
        }
        continue;
      }
      const tagVal = candidate.tags[k];
      if (tagVal && tagVal.toLowerCase() === v.toLowerCase()) {
        matched.push(`${k}=${v}`);
      }
    }
  }
  return { matched, count: matched.length };
}

export function tagOverlapScore(
  candidate: MergedCandidate,
  sceneTokens: ReadonlyArray<string>,
  opts: TagOverlapOptions = {},
): TagOverlapScore {
  const blob = buildCandidateText(candidate);
  const positive = countMatches(sceneTokens, blob, opts.conceptTokenWeights);

  // OSM `artwork_subject=*` is the community's subject tag (taginfo).
  // When it matches a scene token, add a strong flat boost — often present
  // on horse/eagle sculptures where the name omits the animal.
  const artworkSubject = candidate.tags["artwork_subject"]?.trim().toLowerCase();
  let artworkSubjectBoost = 0;
  if (artworkSubject) {
    for (const t of sceneTokens) {
      const norm = t.toLowerCase().trim();
      if (norm.length < 3 || GENERIC_TOKENS.has(norm)) continue;
      const variants = tokenAlternates(norm);
      if (variants.some((v) => artworkSubject.includes(v))) {
        artworkSubjectBoost = Math.max(artworkSubjectBoost, idfWeight(norm) * 1.5);
        break;
      }
    }
  }

  // Subject-name match: does the candidate's NAME match Claude's
  // synonym regex? "Equestrian Statue of George Washington" → YES;
  // "Statue of Liberty" → NO; "Pulitzer Memorial Fountain" → NO.
  let subjectNameMatched = false;
  if (opts.subjectNameRegex && candidate.name) {
    try {
      const parts = opts.subjectNameRegex.split("|").map((p) => p.trim());
      subjectNameMatched = nameMatchesSubjectTerms(candidate.name, parts);
    } catch {
      subjectNameMatched = false;
    }
  }

  const hasImage = Boolean(candidate.knownImageUrl);

  const osmHits = countOsmAlternativeHits(
    candidate,
    opts.osmTagsAlternatives ?? [],
    opts.subjectNameRegex,
  );

  const hitCount = positive.matched.length + osmHits.count;

  let score = positive.weightedScore + artworkSubjectBoost;
  if (hasImage) score += 0.5;

  return {
    matched: positive.matched,
    matchedOsmAlternatives: osmHits.matched,
    hitCount,
    subjectNameMatched,
    hasImage,
    score,
  };
}

/**
 * Compare candidates for final ranking: most prompt tag hits first, then
 * IDF-weighted score, then RRF, then distance.
 */
export function compareByTagHits(
  a: {
    hitCount: number;
    tagOverlapScore: number;
    rrfScore: number;
    distanceMeters: number;
  },
  b: {
    hitCount: number;
    tagOverlapScore: number;
    rrfScore: number;
    distanceMeters: number;
  },
): number {
  if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
  if (b.tagOverlapScore !== a.tagOverlapScore) {
    return b.tagOverlapScore - a.tagOverlapScore;
  }
  if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
  return a.distanceMeters - b.distanceMeters;
}

/** @deprecated Sort with compareByTagHits — hit count is the primary key. */
export function combinedRank(
  rrfScore: number,
  overlap: TagOverlapScore,
): number {
  const overlapBoost = Math.max(0, overlap.score) * 0.5;
  return rrfScore + overlapBoost;
}

// ---------------------------------------------------------------------------
// Skip-vision confidence gate
// ---------------------------------------------------------------------------

/**
 * Decide whether the IDF-weighted overlap signal is strong enough to skip
 * vision scoring entirely. Used by the M5 free tier (vision is paid) and
 * as a latency optimization on the deep tier.
 *
 * Heuristic (calibrated against the IDF weight ranges):
 *   - Top candidate's weighted overlap >= 2.0
 *     (e.g. one rare match like "equestrian"=3.0 OR three common matches
 *     like "monument"+"park"+"landmark"=1.8)
 *   - AND the user supplied at least 4 distinctive scene tokens
 *   - AND we have at least 6 candidates with weighted overlap >= 0.5
 *     (any meaningful match — even a single common-token hit)
 *
 * Returns false (= run vision) when the prompt is vague or when our
 * candidate pool is sparse on token matches.
 */
export const HIGH_CONFIDENCE_TOP_SCORE = 2.0;
export const MIN_USEFUL_OVERLAP_SCORE = 0.5;

export function isHighConfidence(args: {
  topOverlap: TagOverlapScore | null;
  poolOverlaps: ReadonlyArray<TagOverlapScore>;
  sceneTokens: ReadonlyArray<string>;
}): boolean {
  const distinctiveTokens = args.sceneTokens.filter(
    (t) => !GENERIC_TOKENS.has(t.toLowerCase()),
  );
  if (distinctiveTokens.length < 4) return false;
  if (!args.topOverlap || args.topOverlap.hitCount < 3) {
    return false;
  }
  if (args.topOverlap.score < HIGH_CONFIDENCE_TOP_SCORE) {
    return false;
  }
  const withOverlap = args.poolOverlaps.filter(
    (o) => o.score >= MIN_USEFUL_OVERLAP_SCORE,
  ).length;
  return withOverlap >= 6;
}
