import { synonymsFor } from "@/lib/subject-synonyms";
import type { MergedCandidate, WikidataFacts } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Relevance tiers — sort order for subject-specific prompts.
//
// Tier 0: user's subject (horse, lighthouse, …) appears in name,
//         Wikidata P180 depicts, artwork_subject tag, or description.
// Tier 1: statue / sculpture / memorial class without the subject.
// Tier 2: everything else (parks, generic monuments, wrong-famous sites).
//
// OSM tagging reference (taginfo / wiki):
//   tourism=artwork + artwork_subject=*  — subject noun on the node
//   historic=memorial + memorial=statue  — memorial subtype
//   amenity=statue (deprecated, still mapped)
//   sculpture:type=equestrian            — common on equestrian pieces
//
// Sort: lower tier first, then combined RRF+overlap score, then distance.
// ---------------------------------------------------------------------------

export type RelevanceTier = 0 | 1 | 2;

const STATUE_BLOB_RE =
  /\b(?:equestrian|statue|sculpture|bust|figurine|monument|memorial|artwork|public_art)\b/i;

const STATUE_TAG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["tourism", "artwork"],
  ["historic", "memorial"],
  ["historic", "monument"],
  ["amenity", "statue"],
];

function expandedSubjectTerms(seeds: ReadonlyArray<string>): Set<string> {
  const out = new Set<string>();
  for (const s of seeds) {
    const norm = s.trim().toLowerCase();
    if (norm.length < 3) continue;
    out.add(norm);
    const syn = synonymsFor(norm);
    if (syn) {
      for (const x of syn) {
        if (x.length >= 3) out.add(x.toLowerCase());
      }
    }
  }
  return out;
}

function textHasSubject(text: string, terms: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const t of terms) {
    if (lower.includes(t)) return true;
  }
  return false;
}

function depictsHasSubject(facts: WikidataFacts | undefined, terms: Set<string>): boolean {
  if (!facts?.depicts?.length) return false;
  return facts.depicts.some((d) => textHasSubject(d, terms));
}

function tagsHaveArtworkSubject(
  tags: Record<string, string>,
  terms: Set<string>,
): boolean {
  const subj = tags["artwork_subject"]?.trim().toLowerCase();
  if (!subj) return false;
  return textHasSubject(subj, terms);
}

function tagsMatchStatueClass(tags: Record<string, string>): boolean {
  for (const [k, v] of STATUE_TAG_PAIRS) {
    if (tags[k]?.toLowerCase() === v) return true;
  }
  if (tags["artwork_type"]?.toLowerCase() === "statue") return true;
  if (tags["sculpture:type"]?.toLowerCase() === "equestrian") return true;
  if (tags["memorial"]?.toLowerCase() === "statue") return true;
  return false;
}

function blobHasStatueClass(blob: string): boolean {
  return STATUE_BLOB_RE.test(blob);
}

export type RelevanceTierInput = {
  candidate: MergedCandidate;
  /** Expanded subject keywords (horse, equestrian, …). Empty → no tier-0 bias. */
  subjectTerms: ReadonlyArray<string>;
  /** Claude's pipe-separated name regex, when present. */
  subjectNameRegex?: string | null;
};

/**
 * Classify a merged candidate into tier 0 / 1 / 2 for sorting.
 * When `subjectTerms` is empty, only statue-class (tier 1) vs other (tier 2)
 * applies — useful for generic "statue in a park" prompts without an animal.
 */
export function computeRelevanceTier(input: RelevanceTierInput): RelevanceTier {
  const { candidate, subjectTerms, subjectNameRegex } = input;
  const c = candidate;
  const parts: string[] = [];
  if (c.name) parts.push(c.name);
  if (c.description) parts.push(c.description);
  for (const v of Object.values(c.tags)) {
    if (v) parts.push(v);
  }
  if (c.wikidataFacts?.altLabels?.length) {
    parts.push(...c.wikidataFacts.altLabels);
  }
  const blob = parts.join(" \u2022 ");

  const terms = expandedSubjectTerms(subjectTerms);
  const hasSubject = terms.size > 0;

  if (hasSubject) {
    if (c.name && subjectNameRegex) {
      try {
        if (new RegExp(subjectNameRegex, "i").test(c.name)) return 0;
      } catch {
        /* ignore bad regex */
      }
    }
    if (c.name && textHasSubject(c.name, terms)) return 0;
    if (depictsHasSubject(c.wikidataFacts, terms)) return 0;
    if (tagsHaveArtworkSubject(c.tags, terms)) return 0;
    if (textHasSubject(blob, terms)) return 0;
  }

  if (tagsMatchStatueClass(c.tags) || blobHasStatueClass(blob)) return 1;

  return 2;
}

/** Lower tier sorts first (more relevant). */
export function compareRelevanceTiers(a: RelevanceTier, b: RelevanceTier): number {
  return a - b;
}
