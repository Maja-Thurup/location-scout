import { describe, expect, it } from "vitest";

import {
  MAPILLARY_SEGMENTATION,
  MAPILLARY_TAXONOMY,
  allTaxonValues,
  bboxSearchableTaxonValues,
  isBboxSearchableClass,
  segmentationTaxonValues,
} from "@/lib/mapillary/taxonomy";

// ---------------------------------------------------------------------------
// Taxonomy invariants
// ---------------------------------------------------------------------------
//
// Mapillary's "Points" feature endpoint covers 44 fixed classes (see
// https://www.mapillary.com/developer/api-documentation/points). The
// segmentation classes (vegetation, mountain, building, water, …)
// live in a separate set because they're only available via per-image
// detection lookups, NOT via the bbox /map_features endpoint.

describe("Mapillary taxonomy", () => {
  it("ships the full Points list (44 entries) marked bbox-searchable", () => {
    // Soft floor — the upstream API may add classes; we want at least
    // the 44 documented today.
    expect(MAPILLARY_TAXONOMY.length).toBeGreaterThanOrEqual(44);
    for (const t of MAPILLARY_TAXONOMY) {
      expect(t.bboxSearchable).toBe(true);
    }
  });

  it("keeps segmentation-only classes out of the bbox-searchable set", () => {
    expect(MAPILLARY_SEGMENTATION.length).toBeGreaterThan(0);
    const bboxSet = new Set(bboxSearchableTaxonValues());
    for (const t of MAPILLARY_SEGMENTATION) {
      expect(t.bboxSearchable).toBe(false);
      expect(bboxSet.has(t.value)).toBe(false);
      expect(isBboxSearchableClass(t.value)).toBe(false);
    }
  });

  it("includes the canonical sign / banner / pole / traffic-light entries", () => {
    const expected = [
      "object--sign--advertisement",
      "object--sign--information",
      "object--sign--store",
      "object--banner",
      "object--bench",
      "object--support--utility-pole",
      "object--street-light",
      "object--traffic-light--general-single",
      "marking--discrete--arrow--straight",
      "marking--discrete--crosswalk-zebra",
      "construction--barrier--temporary",
    ];
    const seen = new Set(MAPILLARY_TAXONOMY.map((t) => t.value));
    for (const v of expected) expect(seen.has(v)).toBe(true);
  });

  it("includes the canonical segmentation classes for image_scan mode", () => {
    const expected = [
      "construction--structure--building",
      "nature--vegetation",
      "nature--mountain",
      "nature--water",
    ];
    const seen = new Set(segmentationTaxonValues());
    for (const v of expected) expect(seen.has(v)).toBe(true);
  });

  it("exposes a combined value listing for downstream lookups", () => {
    const all = allTaxonValues();
    expect(all.length).toBe(MAPILLARY_TAXONOMY.length + MAPILLARY_SEGMENTATION.length);
    for (const v of all) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
