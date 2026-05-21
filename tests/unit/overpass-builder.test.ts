import { describe, expect, it } from "vitest";

import { bboxFromRadius, isReasonableBbox } from "@/lib/bbox";
import {
  buildOverpassQuery,
  buildUnionOverpassQuery,
  wrapNameRegexWithWordBoundaries,
} from "@/lib/overpass";

const BROOKLYN_BBOX = {
  south: 40.5707,
  west: -74.0431,
  north: 40.7395,
  east: -73.8334,
};

describe("buildOverpassQuery", () => {
  it("builds a brick warehouse query for Brooklyn", () => {
    const q = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { building: "warehouse", "building:material": "brick" },
    });

    expect(q).toContain("[out:json][timeout:25]");
    // building=warehouse is exact-match
    expect(q).toContain('["building"="warehouse"]');
    // building:material is in the case-insensitive set
    expect(q).toContain('["building:material"~"^brick$",i]');
    expect(q).toContain("(40.570700,-74.043100,40.739500,-73.833400)");
    // queries all 3 element types
    expect(q).toContain("node");
    expect(q).toContain("way");
    expect(q).toContain("relation");
    expect(q).toContain("out center tags");
  });

  it("emits a case-insensitive regex for building:colour", () => {
    const q = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { building: "yes", "building:colour": "Green" },
    });
    expect(q).toContain('["building:colour"~"^Green$",i]');
  });

  it("queries forests (natural=wood) and rejects non-tag-bearing requests", () => {
    const q = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { natural: "wood" },
    });
    expect(q).toContain('["natural"="wood"]');

    expect(() =>
      buildOverpassQuery({ bbox: BROOKLYN_BBOX, osmTags: {} }),
    ).toThrowError(/at least one OSM tag/i);
  });

  it("escapes embedded double-quotes in tag keys and values", () => {
    const q = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { 'fake"key': 'value"with"quotes' },
    });
    expect(q).toContain('["fake\\"key"="value\\"with\\"quotes"]');
  });

  it("respects a custom limit", () => {
    const q = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { historic: "yes" },
      limit: 50,
    });
    expect(q).toContain("out center tags 50;");
  });

  it("cobblestone streets pattern: highway + surface", () => {
    const q = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { highway: "residential", surface: "cobblestone" },
    });
    expect(q).toContain('["highway"="residential"]');
    // surface is in the case-insensitive set
    expect(q).toContain('["surface"~"^cobblestone$",i]');
  });
});

describe("buildUnionOverpassQuery (Path A: rich-tag candidate generation)", () => {
  it("emits a UNION over multiple alternative tag-sets", () => {
    const q = buildUnionOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTagsAlternatives: [
        { building: "house" },
        { building: "detached" },
        { landuse: "residential" },
        { natural: "wood" },
      ],
    });

    expect(q).toContain("[out:json][timeout:25]");
    // Each alternative should appear as 3 element-type queries (node/way/relation)
    expect(q).toContain('node["building"="house"]');
    expect(q).toContain('way["building"="house"]');
    expect(q).toContain('relation["building"="house"]');
    expect(q).toContain('node["building"="detached"]');
    expect(q).toContain('node["landuse"="residential"]');
    expect(q).toContain('node["natural"="wood"]');
    // bbox must be the same on all
    expect(q.match(/40\.570700,-74\.043100,40\.739500,-73\.833400/g)?.length).toBe(12);
    expect(q).toContain("out center tags");
  });

  it("treats a single alternative the same way buildOverpassQuery would", () => {
    const single = buildOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTags: { building: "warehouse" },
    });
    const union = buildUnionOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTagsAlternatives: [{ building: "warehouse" }],
    });
    // Same shape — one element of each type, same filter, same bbox.
    expect(union).toContain('node["building"="warehouse"]');
    expect(union).toContain('way["building"="warehouse"]');
    expect(union).toContain('relation["building"="warehouse"]');
    expect(single).toContain('node["building"="warehouse"]');
  });

  it("uses word boundaries on name-keyword alternatives (horse statue prompts)", () => {
    const q = buildUnionOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTagsAlternatives: [
        { name: "horse|equestrian|cavalry" },
      ],
    });
    expect(q).toContain('["name"~"\\bhorse\\b|\\bequestrian\\b|\\bcavalry\\b",i]');
    expect(wrapNameRegexWithWordBoundaries("horse|equestrian")).toBe(
      "\\bhorse\\b|\\bequestrian\\b",
    );
  });

  it("preserves tagFilter case-insensitivity rules across alternatives", () => {
    const q = buildUnionOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTagsAlternatives: [
        { "building:colour": "blue" },
        { "building:material": "brick" },
      ],
    });
    // Both alternative keys are in the case-insensitive set
    expect(q).toContain('["building:colour"~"^blue$",i]');
    expect(q).toContain('["building:material"~"^brick$",i]');
  });

  it("skips empty alternatives but keeps the rest", () => {
    const q = buildUnionOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTagsAlternatives: [
        {},
        { building: "house" },
        { "": "ignored" },
        { landuse: "residential" },
      ],
    });
    expect(q).toContain('node["building"="house"]');
    expect(q).toContain('node["landuse"="residential"]');
    // Three element types per alternative × 2 valid alternatives = 6 lines
    expect((q.match(/^\s+(node|way|relation)\[/gm) ?? []).length).toBe(6);
  });

  it("throws when every alternative is empty", () => {
    expect(() =>
      buildUnionOverpassQuery({
        bbox: BROOKLYN_BBOX,
        osmTagsAlternatives: [{}, {}],
      }),
    ).toThrowError(/at least one non-empty alternative/i);
  });

  it("respects a custom limit shared across the union", () => {
    const q = buildUnionOverpassQuery({
      bbox: BROOKLYN_BBOX,
      osmTagsAlternatives: [{ building: "house" }, { landuse: "residential" }],
      limit: 50,
    });
    expect(q).toContain("out center tags 50;");
  });
});

describe("bboxFromRadius (M3 helpers)", () => {
  it("makes a sensible bbox around a Brooklyn point", () => {
    const center = { lat: 40.6782, lng: -73.9442 };
    const bbox = bboxFromRadius(center, 10);

    expect(bbox.south).toBeLessThan(center.lat);
    expect(bbox.north).toBeGreaterThan(center.lat);
    expect(bbox.west).toBeLessThan(center.lng);
    expect(bbox.east).toBeGreaterThan(center.lng);

    // 10 miles north-south = ~0.145 degrees latitude
    expect(bbox.north - bbox.south).toBeCloseTo(0.29, 2);

    expect(isReasonableBbox(bbox)).toBe(true);
  });

  it("rejects a bbox spanning the whole continent", () => {
    expect(
      isReasonableBbox({ south: 25, west: -125, north: 49, east: -66 }),
    ).toBe(false);
  });
});
