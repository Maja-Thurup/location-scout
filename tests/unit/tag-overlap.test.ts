import { describe, expect, it } from "vitest";

import {
  buildCandidateText,
  combinedRank,
  isHighConfidence,
  tagOverlapScore,
} from "@/lib/providers/tag-overlap";
import type { MergedCandidate, ProviderName } from "@/lib/providers/types";

function merged(partial: Partial<MergedCandidate>): MergedCandidate {
  return {
    id: "x:1",
    primarySource: "wikidata-landmark" as ProviderName,
    sources: ["wikidata-landmark"],
    externalIds: { "wikidata-landmark": "Q1" },
    perSourceRank: { "wikidata-landmark": 0 },
    lat: 40.7,
    lng: -74,
    name: null,
    description: null,
    knownImageUrl: null,
    tags: {},
    associatedFilms: [],
    sourceUrl: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// tagOverlapScore — the core test of the horse-statue case
// ---------------------------------------------------------------------------

describe("tagOverlapScore", () => {
  const horseTokens = [
    "horse",
    "statue",
    "monument",
    "park",
    "equestrian",
    "bronze",
    "trees",
    "open_space",
  ];

  it("a real horse monument scores HIGH on the horse-statue prompt", () => {
    const c = merged({
      name: "Simon Bolívar Monument",
      description: "equestrian statue of Simón Bolívar in Central Park",
    });
    const o = tagOverlapScore(c, horseTokens);
    // "horse" itself doesn't appear in the text, but "equestrian" is in
    // the same scene_tokens list; matching it captures the intent.
    expect(o.matched).toContain("statue");
    expect(o.matched).toContain("monument");
    expect(o.matched).toContain("equestrian");
    expect(o.matched).toContain("park");
    // IDF-weighted: equestrian=3.0 + statue=1.5 + monument=0.8 + park=0.5
    // = 5.8 — a strong "this is the horse monument" signal.
    expect(o.score).toBeGreaterThanOrEqual(5);
  });

  it("NYU scores ZERO on the horse-statue prompt", () => {
    const c = merged({
      name: "New York University",
      description: "private university in the New York metropolitan area",
    });
    const o = tagOverlapScore(c, horseTokens);
    expect(o.matched.length).toBe(0);
    expect(o.score).toBe(0);
  });

  it("Woolworth Building scores ZERO on the horse-statue prompt", () => {
    const c = merged({
      name: "Woolworth Building",
      description: "skyscraper in New York City",
    });
    const o = tagOverlapScore(c, horseTokens);
    expect(o.matched.length).toBe(0);
    expect(o.score).toBe(0);
  });

  // Anti-tokens were dropped — score is now strictly the sum of IDF-
  // weighted positive matches.

  it("generic descriptors are filtered (don't reward 'urban' or 'day')", () => {
    const c = merged({
      name: "Some random building",
      description: "urban day exterior",
      tags: { setting: "urban" },
    });
    const o = tagOverlapScore(c, ["urban", "day", "exterior"]);
    expect(o.matched.length).toBe(0);
  });

  it("compound tokens match across underscore / space / hyphen variants", () => {
    const c1 = merged({ name: "Phone Booth Plaza", description: null });
    const c2 = merged({ name: "Phone-booth Plaza", description: null });
    const c3 = merged({ name: "phone_booth plaza", description: null });
    const tokens = ["phone_booth"];
    expect(tagOverlapScore(c1, tokens).score).toBeGreaterThan(0);
    expect(tagOverlapScore(c2, tokens).score).toBeGreaterThan(0);
    expect(tagOverlapScore(c3, tokens).score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// combinedRank
// ---------------------------------------------------------------------------

describe("combinedRank", () => {
  it("higher RRF + higher overlap => higher combined score", () => {
    const low = combinedRank(0.01, { matched: [], score: 0 });
    const high = combinedRank(0.05, {
      matched: ["a", "b", "c"],
      score: 3,
    });
    expect(high).toBeGreaterThan(low);
  });

  it("score=0 produces no boost (just rrfScore returned)", () => {
    const zeroOverlap = combinedRank(0.05, { matched: [], score: 0 });
    expect(zeroOverlap).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// isHighConfidence
// ---------------------------------------------------------------------------

describe("isHighConfidence", () => {
  it("triggers when top overlap >= 2.0 + at least 6 candidates with overlap >= 0.5 + 4+ tokens", () => {
    const result = isHighConfidence({
      topOverlap: { matched: ["a", "b", "c"], score: 3.5 },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["x"],
        score: 0.8,
      })),
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(true);
  });

  it("returns false when scene tokens are vague (<4 distinctive)", () => {
    const result = isHighConfidence({
      topOverlap: { matched: ["a", "b", "c"], score: 3.5 },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["x"],
        score: 0.8,
      })),
      sceneTokens: ["urban", "day"], // both generic
    });
    expect(result).toBe(false);
  });

  it("returns false when top overlap is weak (< 2.0 IDF-weighted)", () => {
    const result = isHighConfidence({
      topOverlap: { matched: ["a"], score: 0.8 },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["a"],
        score: 0.8,
      })),
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(false);
  });

  it("returns false when fewer than 6 candidates have meaningful overlap", () => {
    const result = isHighConfidence({
      topOverlap: { matched: ["a", "b", "c"], score: 3.5 },
      poolOverlaps: [
        { matched: ["a"], score: 0.8 },
        { matched: ["a"], score: 0.8 },
      ],
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(false);
  });

  it("uses IDF weighting — rare tokens like 'equestrian' alone clear the bar", () => {
    // A candidate with the SINGLE rare match "equestrian" (weight 3.0)
    // should already exceed the top-score threshold (2.0). This is the
    // payoff of TF-IDF: one strong discriminator beats five fluff words.
    const result = isHighConfidence({
      topOverlap: { matched: ["equestrian"], score: 3.0 },
      poolOverlaps: Array.from({ length: 7 }, () => ({
        matched: ["statue"],
        score: 1.5,
      })),
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCandidateText smoke
// ---------------------------------------------------------------------------

describe("buildCandidateText", () => {
  it("concatenates name + description + tag values", () => {
    const c = merged({
      name: "Simon Bolívar Monument",
      description: "equestrian statue",
      tags: { historic: "monument", tourism: "artwork" },
    });
    const text = buildCandidateText(c);
    expect(text).toContain("simon bolívar monument");
    expect(text).toContain("equestrian statue");
    expect(text).toContain("monument");
    expect(text).toContain("artwork");
  });
});
