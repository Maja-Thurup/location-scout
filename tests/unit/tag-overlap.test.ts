import { describe, expect, it } from "vitest";

import {
  buildCandidateText,
  compareByTagHits,
  combinedRank,
  countOsmAlternativeHits,
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

  it("hitCount ranks multi-token matches above single-token (bars vs statues)", () => {
    const subjectNameRegex = "horse|equestrian|cavalry|jockey|rider";
    const alts: Record<string, string>[] = [
      { tourism: "artwork" },
      { historic: "memorial" },
      { leisure: "park" },
      { name: subjectNameRegex },
    ];

    const joan = merged({
      name: "Equestrian Statue of Joan of Arc",
      description: "equestrian statue in Central Park",
      tags: { tourism: "artwork", historic: "memorial", leisure: "park" },
    });
    const bar = merged({
      name: "Light Horse Tavern",
      description: "amenity bar",
      tags: { amenity: "restaurant" },
    });

    const joanScore = tagOverlapScore(joan, horseTokens, {
      subjectNameRegex,
      osmTagsAlternatives: alts,
    });
    const barScore = tagOverlapScore(bar, horseTokens, {
      subjectNameRegex,
      osmTagsAlternatives: alts,
    });

    expect(joanScore.hitCount).toBeGreaterThan(barScore.hitCount);
    expect(
      compareByTagHits(
        {
          hitCount: joanScore.hitCount,
          tagOverlapScore: joanScore.score,
          rrfScore: 0.01,
          distanceMeters: 100,
        },
        {
          hitCount: barScore.hitCount,
          tagOverlapScore: barScore.score,
          rrfScore: 0.05,
          distanceMeters: 10,
        },
      ),
    ).toBeLessThan(0);
  });

  it("subject regex does NOT match in description-only -> no boost", () => {
    // Sherman Memorial: name is "Sherman Memorial" but description
    // mentions "horseback". We want strict NAME-match for the boost
    // (description-only matches still get IDF credit but no 2.5x).
    const sherman = merged({
      name: "Sherman Memorial",
      description: "bronze equestrian statue of Sherman on horseback",
    });
    const score = tagOverlapScore(sherman, horseTokens, {
      subjectNameRegex: "horse|equestrian",
    });
    expect(score.subjectNameMatched).toBe(false);
    // BUT the IDF score is still high because horse + equestrian +
    // statue + bronze are all in the description blob.
    expect(score.score).toBeGreaterThan(4);
  });

  it("knownImageUrl present -> +0.5 score", () => {
    const noImage = merged({ name: "Some Statue", knownImageUrl: null });
    const withImage = merged({
      name: "Some Statue",
      knownImageUrl: "https://example.com/img.jpg",
    });
    const a = tagOverlapScore(noImage, horseTokens);
    const b = tagOverlapScore(withImage, horseTokens);
    expect(b.hasImage).toBe(true);
    expect(b.score).toBeCloseTo(a.score + 0.5, 5);
  });

  it("countOsmAlternativeHits matches classifier tags on the node", () => {
    const c = merged({
      tags: { tourism: "artwork", historic: "memorial" },
    });
    const { count, matched } = countOsmAlternativeHits(
      c,
      [{ tourism: "artwork" }, { historic: "memorial" }, { leisure: "park" }],
      null,
    );
    expect(count).toBe(2);
    expect(matched).toContain("tourism=artwork");
    expect(matched).toContain("historic=memorial");
  });

  it("malformed regex does not crash -> no boost", () => {
    const c = merged({ name: "Equestrian Statue" });
    const score = tagOverlapScore(c, horseTokens, {
      subjectNameRegex: "[invalid(",
    });
    expect(score.subjectNameMatched).toBe(false);
    // Falls through to plain IDF score.
    expect(score.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// combinedRank
// ---------------------------------------------------------------------------

describe("combinedRank", () => {
  it("higher RRF + higher overlap => higher combined score", () => {
    const low = combinedRank(0.01, {
      matched: [],
      matchedOsmAlternatives: [],
      hitCount: 0,
      score: 0,
    });
    const high = combinedRank(0.05, {
      matched: ["a", "b", "c"],
      matchedOsmAlternatives: [],
      hitCount: 3,
      score: 3,
    });
    expect(high).toBeGreaterThan(low);
  });

  it("score=0 produces no boost (just rrfScore returned)", () => {
    const zeroOverlap = combinedRank(0.05, {
      matched: [],
      matchedOsmAlternatives: [],
      hitCount: 0,
      score: 0,
    });
    expect(zeroOverlap).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// isHighConfidence
// ---------------------------------------------------------------------------

describe("isHighConfidence", () => {
  it("triggers when top has 3+ tag hits, score >= 2.0, 6+ pool overlaps, 4+ tokens", () => {
    const result = isHighConfidence({
      topOverlap: {
        matched: ["a", "b", "c"],
        matchedOsmAlternatives: [],
        hitCount: 3,
        score: 3.5,
      },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["x"],
        matchedOsmAlternatives: [],
        hitCount: 1,
        score: 0.8,
      })),
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(true);
  });

  it("returns false when scene tokens are vague (<4 distinctive)", () => {
    const result = isHighConfidence({
      topOverlap: {
        matched: ["a", "b", "c"],
        matchedOsmAlternatives: [],
        hitCount: 3,
        score: 3.5,
      },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["x"],
        matchedOsmAlternatives: [],
        hitCount: 1,
        score: 0.8,
      })),
      sceneTokens: ["urban", "day"], // both generic
    });
    expect(result).toBe(false);
  });

  it("returns false when top has fewer than 3 tag hits", () => {
    const result = isHighConfidence({
      topOverlap: {
        matched: ["a", "b"],
        matchedOsmAlternatives: [],
        hitCount: 2,
        score: 3.5,
      },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["x"],
        matchedOsmAlternatives: [],
        hitCount: 1,
        score: 0.8,
      })),
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(false);
  });

  it("returns false when top overlap is weak (< 2.0 IDF-weighted)", () => {
    const result = isHighConfidence({
      topOverlap: {
        matched: ["a"],
        matchedOsmAlternatives: [],
        hitCount: 3,
        score: 0.8,
      },
      poolOverlaps: Array.from({ length: 8 }, () => ({
        matched: ["a"],
        matchedOsmAlternatives: [],
        hitCount: 1,
        score: 0.8,
      })),
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(false);
  });

  it("returns false when fewer than 6 candidates have meaningful overlap", () => {
    const result = isHighConfidence({
      topOverlap: {
        matched: ["a", "b", "c"],
        matchedOsmAlternatives: [],
        hitCount: 3,
        score: 3.5,
      },
      poolOverlaps: [
        {
          matched: ["a"],
          matchedOsmAlternatives: [],
          hitCount: 1,
          score: 0.8,
        },
        {
          matched: ["a"],
          matchedOsmAlternatives: [],
          hitCount: 1,
          score: 0.8,
        },
      ],
      sceneTokens: ["horse", "statue", "monument", "equestrian"],
    });
    expect(result).toBe(false);
  });

  it("uses IDF weighting — rare tokens like 'equestrian' alone clear the score bar", () => {
    const result = isHighConfidence({
      topOverlap: {
        matched: ["equestrian", "horse", "statue"],
        matchedOsmAlternatives: [],
        hitCount: 3,
        score: 3.0,
      },
      poolOverlaps: Array.from({ length: 7 }, () => ({
        matched: ["statue"],
        matchedOsmAlternatives: [],
        hitCount: 1,
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
