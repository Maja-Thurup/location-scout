import { describe, expect, it } from "vitest";

import {
  bboxCenter,
  bboxFromRadius,
  distanceMeters,
  expandBbox,
  isBboxOverlapping,
  isReasonableBbox,
  metersToMiles,
} from "@/lib/bbox";

const BROOKLYN = { lat: 40.6782, lng: -73.9442 };

describe("expandBbox", () => {
  it("doubles width and height when multiplier=2", () => {
    const original = bboxFromRadius(BROOKLYN, 10);
    const expanded = expandBbox(original, 2);

    const dLatOrig = original.north - original.south;
    const dLatExp = expanded.north - expanded.south;
    expect(dLatExp / dLatOrig).toBeCloseTo(2, 1);

    const dLngOrig = original.east - original.west;
    const dLngExp = expanded.east - expanded.west;
    expect(dLngExp / dLngOrig).toBeCloseTo(2, 1);
  });

  it("preserves the centroid", () => {
    const original = bboxFromRadius(BROOKLYN, 10);
    const expanded = expandBbox(original, 4);
    const c1 = bboxCenter(original);
    const c2 = bboxCenter(expanded);
    expect(c2.lat).toBeCloseTo(c1.lat, 4);
    expect(c2.lng).toBeCloseTo(c1.lng, 4);
  });

  it("clamps to maxRadiusMiles to prevent runaway expansion", () => {
    // Start at 60 mi radius, expand 4x = 240 mi, clamped to 100.
    const big = bboxFromRadius(BROOKLYN, 60);
    const expanded = expandBbox(big, 4, 100);
    expect(isReasonableBbox(expanded)).toBe(true);
    // height should be ~ 200 miles total = ~2.9 degrees, not 480 mi / 7 deg
    expect(expanded.north - expanded.south).toBeLessThan(3.5);
  });
});

describe("distanceMeters (haversine)", () => {
  it("is zero for identical points", () => {
    expect(distanceMeters(BROOKLYN, BROOKLYN)).toBeCloseTo(0, 0);
  });

  it("matches a known distance: Brooklyn -> Times Square ~9 km", () => {
    const timesSquare = { lat: 40.758, lng: -73.9855 };
    const m = distanceMeters(BROOKLYN, timesSquare);
    // Real value is ~9.5 km
    expect(metersToMiles(m)).toBeGreaterThan(5);
    expect(metersToMiles(m)).toBeLessThan(8);
  });

  it("symmetric: d(a,b) == d(b,a)", () => {
    const a = { lat: 40, lng: -74 };
    const b = { lat: 40.1, lng: -73.9 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 4);
  });

  it("approximates 1 degree of latitude as ~111 km", () => {
    const a = { lat: 40, lng: 0 };
    const b = { lat: 41, lng: 0 };
    const km = distanceMeters(a, b) / 1000;
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });
});

describe("isBboxOverlapping", () => {
  const NYC = { south: 40.4, west: -74.3, north: 41.0, east: -73.7 };
  const LA = { south: 33.7, west: -118.7, north: 34.3, east: -118.1 };
  const PART_OF_NYC = { south: 40.7, west: -74.1, north: 40.8, east: -73.9 };

  it("identical bboxes overlap", () => {
    expect(isBboxOverlapping(NYC, NYC)).toBe(true);
  });

  it("inner bbox overlaps with the outer one", () => {
    expect(isBboxOverlapping(NYC, PART_OF_NYC)).toBe(true);
    expect(isBboxOverlapping(PART_OF_NYC, NYC)).toBe(true);
  });

  it("disjoint cities do NOT overlap", () => {
    expect(isBboxOverlapping(NYC, LA)).toBe(false);
    expect(isBboxOverlapping(LA, NYC)).toBe(false);
  });

  it("edge-touching boxes count as overlapping", () => {
    const east = { south: 40, west: -74, north: 41, east: -73 };
    const adjacent = { south: 40, west: -73, north: 41, east: -72 };
    expect(isBboxOverlapping(east, adjacent)).toBe(true);
  });
});
