import { describe, expect, it } from "vitest";

import {
  compareRelevanceTiers,
  computeRelevanceTier,
} from "@/lib/providers/relevance-tier";
import type { MergedCandidate } from "@/lib/providers/types";

function merged(partial: Partial<MergedCandidate>): MergedCandidate {
  return {
    id: "wikidata-landmark:Q1",
    primarySource: "wikidata-landmark",
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

describe("computeRelevanceTier", () => {
  const horseTerms = ["horse", "equestrian", "stallion"];

  it("tier 0 for equestrian statue in name", () => {
    const tier = computeRelevanceTier({
      candidate: merged({
        name: "Equestrian Statue of George Washington",
      }),
      subjectTerms: horseTerms,
      subjectNameRegex: "horse|equestrian",
    });
    expect(tier).toBe(0);
  });

  it("tier 0 when Wikidata depicts horse", () => {
    const tier = computeRelevanceTier({
      candidate: merged({
        name: "America's Response Monument",
        wikidataFacts: {
          inception: null,
          creators: [],
          architects: [],
          materials: [],
          genres: [],
          depicts: ["horse", "soldier"],
          namedAfter: [],
          partOf: [],
          hasParts: [],
          commonsCategory: null,
          altLabels: [],
        },
      }),
      subjectTerms: horseTerms,
    });
    expect(tier).toBe(0);
  });

  it("tier 1 for generic statue without horse", () => {
    const tier = computeRelevanceTier({
      candidate: merged({
        name: "Statue of Liberty",
        description: "monument in New York",
      }),
      subjectTerms: horseTerms,
    });
    expect(tier).toBe(1);
  });

  it("tier 1 for OSM artwork tag without subject", () => {
    const tier = computeRelevanceTier({
      candidate: merged({
        name: "William Shakespeare",
        tags: { tourism: "artwork" },
      }),
      subjectTerms: horseTerms,
    });
    expect(tier).toBe(1);
  });

  it("tier 2 for non-statue building", () => {
    const tier = computeRelevanceTier({
      candidate: merged({
        name: "Woolworth Building",
        description: "skyscraper in Manhattan",
      }),
      subjectTerms: horseTerms,
    });
    expect(tier).toBe(2);
  });
});

describe("compareRelevanceTiers", () => {
  it("sorts tier 0 before tier 1", () => {
    expect(compareRelevanceTiers(0, 1)).toBeLessThan(0);
  });
});
