import { describe, expect, it } from "vitest";

import { resolveWeight, rrfRank } from "@/lib/providers/rrf";
import type { MergedCandidate, ProviderName } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function merged(partial: Partial<MergedCandidate>): MergedCandidate {
  return {
    id: "x:1",
    primarySource: "osm" as ProviderName,
    sources: ["osm"],
    externalIds: { osm: "way/1" },
    perSourceRank: { osm: 0 },
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
// rrfRank
// ---------------------------------------------------------------------------

describe("rrfRank", () => {
  it("a candidate from one retriever at rank 0 gets a positive rrfScore", () => {
    const ranked = rrfRank([
      merged({
        id: "wikidata-landmark:Q42",
        primarySource: "wikidata-landmark",
        sources: ["wikidata-landmark"],
        externalIds: { "wikidata-landmark": "Q42" },
        perSourceRank: { "wikidata-landmark": 0 },
      }),
    ]);
    expect(ranked[0]!.rrfScore).toBeGreaterThan(0);
  });

  it("multi-source candidates score HIGHER than single-source at the same rank", () => {
    const single = rrfRank([
      merged({
        id: "wikidata-landmark:Q42",
        primarySource: "wikidata-landmark",
        sources: ["wikidata-landmark"],
        externalIds: { "wikidata-landmark": "Q42" },
        perSourceRank: { "wikidata-landmark": 0 },
      }),
    ])[0]!;

    const multi = rrfRank([
      merged({
        id: "wikidata-landmark:Q42",
        primarySource: "wikidata-landmark",
        sources: ["wikidata-landmark", "wikipedia-geosearch", "osm"],
        externalIds: {
          "wikidata-landmark": "Q42",
          "wikipedia-geosearch": "12345",
          osm: "way/1",
        },
        perSourceRank: {
          "wikidata-landmark": 0,
          "wikipedia-geosearch": 0,
          osm: 0,
        },
      }),
    ])[0]!;

    expect(multi.rrfScore).toBeGreaterThan(single.rrfScore);
  });

  it("rank 0 scores higher than rank 10 within the same retriever", () => {
    const top = rrfRank([
      merged({
        primarySource: "wikidata-landmark",
        sources: ["wikidata-landmark"],
        externalIds: { "wikidata-landmark": "Q1" },
        perSourceRank: { "wikidata-landmark": 0 },
      }),
    ])[0]!;
    const bottom = rrfRank([
      merged({
        primarySource: "wikidata-landmark",
        sources: ["wikidata-landmark"],
        externalIds: { "wikidata-landmark": "Q1" },
        perSourceRank: { "wikidata-landmark": 10 },
      }),
    ])[0]!;
    expect(top.rrfScore).toBeGreaterThan(bottom.rrfScore);
  });

  it("film-history sources are zero-weighted (cannot influence ranking)", () => {
    const onlyFilm = rrfRank([
      merged({
        id: "wikidata-filming-location:Q60",
        primarySource: "wikidata-filming-location",
        sources: ["wikidata-filming-location"],
        externalIds: { "wikidata-filming-location": "Q60" },
        perSourceRank: { "wikidata-filming-location": 0 },
      }),
    ])[0]!;
    expect(onlyFilm.rrfScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveWeight (intent boosts)
// ---------------------------------------------------------------------------

describe("resolveWeight", () => {
  it("rural location_kind boosts OSM and demotes Wikipedia/Wikidata", () => {
    const osmRural = resolveWeight("osm", "rural");
    const osmUrban = resolveWeight("osm", "urban");
    expect(osmRural).toBeGreaterThan(osmUrban);

    const wpRural = resolveWeight("wikipedia-geosearch", "rural");
    const wpUrban = resolveWeight("wikipedia-geosearch", "urban");
    expect(wpUrban).toBeGreaterThan(wpRural);
  });

  it("returns 0 for film-history providers regardless of intent", () => {
    expect(resolveWeight("wikidata-filming-location", "urban")).toBe(0);
    expect(resolveWeight("nyc-scenes-from-the-city", "rural")).toBe(0);
    expect(resolveWeight("sf-film-locations", null)).toBe(0);
  });

  it("null location_kind uses base weights only", () => {
    const base = resolveWeight("osm", null);
    const urban = resolveWeight("osm", "urban");
    expect(base).not.toBe(urban);
    expect(base).toBeGreaterThan(0);
  });
});
