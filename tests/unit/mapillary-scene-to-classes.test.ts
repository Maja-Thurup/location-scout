import { describe, expect, it } from "vitest";

import { mapSceneToMapillary } from "@/lib/mapillary/scene-to-classes";
import {
  bboxAreaDeg2,
  shouldSkipTiledMapillarySearch,
  splitBboxIntoTiles,
  tileAreaDeg2,
} from "@/lib/mapillary/tiles";

describe("mapSceneToMapillary", () => {
  it("maps park tokens to vegetation and pedestrian-area", () => {
    const plan = mapSceneToMapillary({
      sceneTokens: ["horse", "statue", "park", "grass"],
    });
    expect(plan.unmatchedTokens).toContain("horse");
    expect(plan.unmatchedTokens).toContain("statue");
    expect(plan.imageScanClasses).toContain("nature--vegetation");
    expect(plan.bboxClasses).toContain("construction--flat--pedestrian-area");
  });

  it("merges Claude mapillary_classes", () => {
    const plan = mapSceneToMapillary({
      sceneTokens: [],
      mapillaryClasses: ["object--bench"],
    });
    expect(plan.bboxClasses).toContain("object--bench");
  });

  it("puts building in image-scan not bbox", () => {
    const plan = mapSceneToMapillary({ sceneTokens: ["building", "urban"] });
    expect(plan.imageScanClasses).toContain("construction--structure--building");
    expect(plan.bboxClasses).not.toContain("construction--structure--building");
  });
});

describe("shouldSkipTiledMapillarySearch", () => {
  it("skips city-scale bboxes", () => {
    const la = { south: 33.7, west: -118.7, north: 34.3, east: -118.1 };
    expect(bboxAreaDeg2(la)).toBeGreaterThan(0.02);
    expect(shouldSkipTiledMapillarySearch(la)).toBe(true);
  });

  it("allows neighborhood-scale bboxes", () => {
    const small = { south: 34.05, west: -118.28, north: 34.08, east: -118.24 };
    expect(shouldSkipTiledMapillarySearch(small)).toBe(false);
  });
});

describe("splitBboxIntoTiles", () => {
  it("returns single tile for small bbox", () => {
    const tiles = splitBboxIntoTiles(
      { south: 51.5, west: -0.13, north: 51.51, east: -0.12 },
      0.01,
      40,
    );
    expect(tiles.length).toBe(1);
    expect(tileAreaDeg2(tiles[0]!)).toBeLessThanOrEqual(0.01);
  });

  it("splits large bbox into multiple tiles", () => {
    const tiles = splitBboxIntoTiles(
      { south: 33.7, west: -118.7, north: 34.3, east: -118.1 },
      0.009,
      40,
    );
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(40);
    for (const t of tiles) {
      expect(tileAreaDeg2(t)).toBeLessThanOrEqual(0.009 + 1e-6);
    }
  });
});
