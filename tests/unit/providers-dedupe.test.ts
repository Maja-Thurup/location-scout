import { describe, expect, it } from "vitest";

import {
  mergeCandidates,
  namesMatchForMerge,
  normalizePlaceName,
} from "@/lib/providers/dedupe";
import type { RawCandidate } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function raw(partial: Partial<RawCandidate>): RawCandidate {
  return {
    externalId: "x",
    source: "osm",
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
// mergeCandidates
// ---------------------------------------------------------------------------

describe("mergeCandidates", () => {
  it("returns one merged record per cluster", () => {
    const out = mergeCandidates([
      raw({ source: "osm", externalId: "way/1", lat: 40.700, lng: -74.000 }),
      // 30m east — within 50m proximity threshold
      raw({
        source: "wikidata-landmark",
        externalId: "Q1",
        lat: 40.700,
        lng: -73.99965,
        name: "Tribeca Building",
      }),
      // 200m away — distinct cluster
      raw({ source: "osm", externalId: "way/2", lat: 40.702, lng: -74.0 }),
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]!.sources).toContain("osm");
    expect(out[0]!.sources).toContain("wikidata-landmark");
    expect(out[0]!.name).toBe("Tribeca Building");
  });

  it("uses the highest-priority source as the cluster seed and the most-precise coords (OSM node > NYC Scenes)", () => {
    const out = mergeCandidates([
      raw({ source: "osm", externalId: "node/1", lat: 40.700, lng: -74.0, name: "OSM building" }),
      raw({
        source: "wikidata-landmark",
        externalId: "Q1",
        lat: 40.7001,
        lng: -74.0001,
        name: "Wikidata name",
      }),
      raw({
        source: "nyc-scenes-from-the-city",
        externalId: "scene-12",
        lat: 40.7002,
        lng: -74.0002,
        name: "Tribeca Diner (Goodfellas)",
      }),
    ]);

    expect(out).toHaveLength(1);
    // Display priority: NYC Scenes wins (highest source priority for
    // canonical name + film attribution).
    expect(out[0]!.primarySource).toBe("nyc-scenes-from-the-city");
    // Coord precision: OSM node beats NYC Scenes centroid (rank 5 vs 3).
    // The user navigates to the OSM-precise pin, not the centroid.
    expect(out[0]!.lat).toBeCloseTo(40.700, 4);
  });

  it("OSM way (polygon centroid) does NOT win coord precision over Wikidata point", () => {
    const out = mergeCandidates([
      raw({ source: "osm", externalId: "way/1", lat: 40.700, lng: -74.0 }),
      raw({
        source: "wikidata-landmark",
        externalId: "Q1",
        lat: 40.7001,
        lng: -74.0001,
        name: "Wikidata name",
      }),
    ]);
    expect(out).toHaveLength(1);
    // OSM way (polygon centroid) is rank 3, Wikidata is rank 4 -> Wikidata wins.
    expect(out[0]!.lat).toBeCloseTo(40.7001, 4);
  });

  it("merges associatedFilms across providers (dedupe by Q-id)", () => {
    const goodfellasQid = "Q11576";
    const out = mergeCandidates([
      raw({
        source: "wikidata-filming-location",
        externalId: "Q1",
        lat: 40.7,
        lng: -74,
        associatedFilms: [
          { wikidataQid: goodfellasQid, title: "Goodfellas", year: 1990, imdbId: null },
          { wikidataQid: "Q42", title: "Other Film", year: 2000, imdbId: null },
        ],
      }),
      raw({
        source: "nyc-scenes-from-the-city",
        externalId: "scene-12",
        lat: 40.70005,
        lng: -74.00005,
        associatedFilms: [
          // Same film as Wikidata, but only with title + year (no Q-id).
          { wikidataQid: null, title: "GoodFellas", year: 1990, imdbId: null },
          // A different film unique to NYC dataset.
          { wikidataQid: null, title: "Mean Streets", year: 1973, imdbId: null },
        ],
      }),
    ]);

    expect(out).toHaveLength(1);
    const films = out[0]!.associatedFilms;
    expect(films.length).toBe(3);
    expect(films.find((f) => f.wikidataQid === goodfellasQid)).toBeDefined();
    expect(films.find((f) => f.title.toLowerCase() === "mean streets")).toBeDefined();
  });

  it("Q-id cross-merge: OSM tourism=artwork node tagged wikidata=Q1 merges with the wikidata-landmark candidate even when 200m apart", () => {
    // Real-world example: OSM node for "Equestrian Statue of Bolívar"
    // has tag wikidata=Q12345; Wikidata's coord is the centroid of the
    // surrounding plaza (200m away from OSM's actual point). Without
    // Q-id merging these would be 2 cards.
    const out = mergeCandidates([
      raw({
        source: "wikidata-landmark",
        externalId: "Q12345",
        lat: 40.700,
        lng: -74.000,
        name: "Equestrian Statue of Bolívar",
        knownImageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/bolivar.jpg",
      }),
      raw({
        source: "osm",
        externalId: "node/55555",
        // 200m east — way outside the 30m proximity threshold
        lat: 40.700,
        lng: -73.997,
        name: null,
        tags: { tourism: "artwork", wikidata: "Q12345" },
      }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toContain("osm");
    expect(out[0]!.sources).toContain("wikidata-landmark");
    expect(out[0]!.name).toBe("Equestrian Statue of Bolívar");
  });

  it("Q-id cross-merge ignores tags that are not Q-id format", () => {
    // OSM `wikidata=foo` (broken data) should not match Q-id index;
    // falls back to proximity-only merge.
    const out = mergeCandidates([
      raw({
        source: "wikidata-landmark",
        externalId: "Q1",
        lat: 40.7,
        lng: -74,
      }),
      raw({
        source: "osm",
        externalId: "node/1",
        lat: 40.71, // 1km away — proximity won't merge
        lng: -74,
        tags: { wikidata: "not-a-qid" },
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps non-null knownImageUrl across the merge", () => {
    const out = mergeCandidates([
      raw({
        source: "wikidata-landmark",
        externalId: "Q1",
        lat: 40.7,
        lng: -74,
        knownImageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/foo.jpg",
      }),
      raw({
        source: "osm",
        externalId: "way/1",
        lat: 40.7001,
        lng: -74.0001,
        knownImageUrl: null,
      }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.knownImageUrl).toContain("FilePath/foo.jpg");
  });

  it("treats records >50m apart as distinct clusters", () => {
    const out = mergeCandidates([
      raw({ source: "osm", externalId: "way/1", lat: 40.7, lng: -74 }),
      // ~120m east
      raw({ source: "osm", externalId: "way/2", lat: 40.7, lng: -73.9986 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("composes id as `${primarySource}:${externalId}`", () => {
    const out = mergeCandidates([
      raw({ source: "wikidata-landmark", externalId: "Q42", lat: 40.7, lng: -74 }),
    ]);
    expect(out[0]!.id).toBe("wikidata-landmark:Q42");
  });

  it("handles empty input gracefully", () => {
    expect(mergeCandidates([])).toEqual([]);
  });

  it("merges same display name within 50m across providers", () => {
    const out = mergeCandidates([
      raw({
        source: "wikipedia-geosearch",
        externalId: "page-1",
        lat: 40.6892,
        lng: -74.0445,
        name: "Statue of Liberty",
        tags: { "wikidata:qid": "Q142" },
      }),
      raw({
        source: "wikidata-landmark",
        externalId: "Q142",
        lat: 40.68925,
        lng: -74.0446,
        name: "Statue of Liberty",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toContain("wikipedia-geosearch");
    expect(out[0]!.sources).toContain("wikidata-landmark");
  });
});

describe("normalizePlaceName / namesMatchForMerge", () => {
  it("strips parentheticals", () => {
    expect(
      normalizePlaceName("Equestrian Statue of George Washington (New York City)"),
    ).toBe("equestrian statue of george washington");
  });

  it("matches long substring names", () => {
    const a = normalizePlaceName("Statue of Liberty")!;
    const b = normalizePlaceName("The Statue of Liberty National Monument")!;
    expect(namesMatchForMerge(a, b)).toBe(true);
  });
});
