import { describe, expect, it } from "vitest";

import type { SceneAnalysis } from "@/lib/claude";
import {
  computeEnrichRankTier,
  deriveRetrievalPlan,
  getOsmExtraArms,
  getWikidataClassesQids,
  getWikidataDepictsQids,
  shouldGateWikipediaOnQids,
  shouldRunMapillaryBboxSearch,
  shouldSkipEnrichBboxDetectionFilter,
} from "@/lib/retrieval-plan";

function minimalAnalysis(overrides: Partial<SceneAnalysis> = {}): SceneAnalysis {
  return {
    osm_tags: { tourism: "artwork" },
    osm_tags_alternatives: [{ tourism: "artwork" }, { historic: "monument" }],
    google_query: "statue park NY",
    google_types: [],
    city: "New York, NY",
    visual: "A statue in a park with trees behind it.",
    scene_tokens: ["statue", "park", "trees", "behind"],
    location_kind: "urban",
    mood: null,
    time_of_day: null,
    interior_exterior: "exterior",
    mapillary_classes: [],
    ...overrides,
  };
}

describe("deriveRetrievalPlan", () => {
  it("uses point_images for statue with background tokens", () => {
    const plan = deriveRetrievalPlan(minimalAnalysis());
    expect(plan.mapillary.mode).toBe("point_images");
    expect(plan.enrich_strategy).toBe("subject_then_mapillary_then_background");
    expect(shouldRunMapillaryBboxSearch(plan)).toBe(false);
    expect(shouldSkipEnrichBboxDetectionFilter(plan)).toBe(true);
    expect(plan.ranking.tier_mapillary_with_background_first).toBe(true);
  });

  it("uses bbox_objects for bench scene", () => {
    const plan = deriveRetrievalPlan(
      minimalAnalysis({
        scene_tokens: ["bench", "cobblestone"],
        visual: "Bench on cobblestone street",
      }),
    );
    expect(plan.mapillary.mode).toBe("bbox_objects");
    expect(shouldRunMapillaryBboxSearch(plan)).toBe(true);
  });
});

describe("computeEnrichRankTier", () => {
  it("tier 1 when Mapillary and background match", () => {
    expect(
      computeEnrichRankTier({
        mapillaryAttached: true,
        backgroundMatchCount: 1,
        backgroundRequested: true,
        tagHitCount: 3,
        hasCuratedImage: false,
      }),
    ).toBe(1);
  });

  it("tier 2 when Mapillary only", () => {
    expect(
      computeEnrichRankTier({
        mapillaryAttached: true,
        backgroundMatchCount: 0,
        backgroundRequested: true,
        tagHitCount: 2,
        hasCuratedImage: false,
      }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// query_hints — surfaces extra OSM arms and Wikidata Q-id hints from the
// scene analysis so providers can self-tune without hard-coding.
// ---------------------------------------------------------------------------

describe("retrieval_plan query_hints", () => {
  it("synthesises OSM extra_arms from subject-family alternatives", () => {
    const plan = deriveRetrievalPlan(
      minimalAnalysis({
        // Generic for any prompt: a parser-emitted subject-family arm
        // for a custom noun would also flow through.
        osm_tags_alternatives: [
          { tourism: "artwork" },
          { artwork_subject: "horse" },
          { statue: "horse" },
        ],
      }),
    );
    const arms = getOsmExtraArms(plan);
    const armPairs = arms.map((a) => Object.entries(a)[0]!);
    expect(armPairs).toContainEqual(["artwork_subject", "horse"]);
    expect(armPairs).toContainEqual(["statue", "horse"]);
    // Generic tourism=artwork is NOT a subject-family arm; should be
    // absent from extra_arms (still in the main alternatives list).
    expect(armPairs).not.toContainEqual(["tourism", "artwork"]);
  });

  it("returns empty arms when no subject-family alternatives exist", () => {
    const plan = deriveRetrievalPlan(
      minimalAnalysis({
        osm_tags_alternatives: [
          { tourism: "artwork" },
          { historic: "monument" },
        ],
      }),
    );
    expect(getOsmExtraArms(plan)).toEqual([]);
  });

  it("gates wikipedia-geosearch on upstream Q-ids by default", () => {
    const plan = deriveRetrievalPlan(minimalAnalysis());
    expect(shouldGateWikipediaOnQids(plan)).toBe(true);
  });

  it("exposes empty depicts/classes Q-id arrays when planner has none", () => {
    const plan = deriveRetrievalPlan(minimalAnalysis());
    expect(getWikidataDepictsQids(plan)).toEqual([]);
    expect(getWikidataClassesQids(plan)).toEqual([]);
  });
});
