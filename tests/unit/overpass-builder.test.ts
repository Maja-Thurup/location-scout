import { describe, expect, it } from "vitest";

import { bboxFromRadius, isReasonableBbox } from "@/lib/bbox";
import { buildOverpassQuery } from "@/lib/overpass";

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
