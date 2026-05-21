import { describe, expect, it } from "vitest";

import {
  shouldExcludeOsmCommercialOnSculptureScene,
  subjectTermInName,
} from "@/lib/osm-scene-filter";
import { wrapNameRegexWithWordBoundaries } from "@/lib/overpass";

describe("subjectTermInName", () => {
  it("matches whole word horse in equestrian context", () => {
    expect(subjectTermInName("Light Horse Tavern", "horse")).toBe(true);
  });

  it("does not match horse inside seahorse or horseshoe", () => {
    expect(subjectTermInName("Seahorse NYC", "horse")).toBe(false);
    expect(subjectTermInName("Vazacs Horseshoe Bar", "horse")).toBe(false);
  });

  it("matches equestrian as a word", () => {
    expect(subjectTermInName("Equestrian Statue of Washington", "equestrian")).toBe(
      true,
    );
  });
});

describe("shouldExcludeOsmCommercialOnSculptureScene", () => {
  const statueScene = ["horse", "statue", "park"];

  it("drops bar/restaurant without artwork tags on statue prompts", () => {
    expect(
      shouldExcludeOsmCommercialOnSculptureScene(
        { amenity: "bar" },
        statueScene,
      ),
    ).toBe(true);
    expect(
      shouldExcludeOsmCommercialOnSculptureScene(
        { amenity: "restaurant" },
        statueScene,
      ),
    ).toBe(true);
  });

  it("keeps tourism=artwork even when also tagged amenity (rare)", () => {
    expect(
      shouldExcludeOsmCommercialOnSculptureScene(
        { amenity: "restaurant", tourism: "artwork" },
        statueScene,
      ),
    ).toBe(false);
  });
});

describe("wrapNameRegexWithWordBoundaries", () => {
  it("wraps single-token alternatives with word boundaries", () => {
    expect(wrapNameRegexWithWordBoundaries("horse|equestrian")).toBe(
      "\\bhorse\\b|\\bequestrian\\b",
    );
    expect(wrapNameRegexWithWordBoundaries("horse|equestrian")).toBe(
      "\\bhorse\\b|\\bequestrian\\b",
    );
  });
});
