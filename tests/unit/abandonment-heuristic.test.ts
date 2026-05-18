import { describe, expect, it } from "vitest";

import { sceneImpliesAbandonment } from "@/app/api/search-osm/route";

describe("sceneImpliesAbandonment (B1 trigger)", () => {
  it("returns true when osm_tags include abandoned=yes", () => {
    expect(
      sceneImpliesAbandonment({
        osmTags: { building: "warehouse", abandoned: "yes" },
      }),
    ).toBe(true);
  });

  it("returns true when osm_tags include ruins=yes or disused=yes", () => {
    expect(sceneImpliesAbandonment({ osmTags: { ruins: "yes" } })).toBe(true);
    expect(sceneImpliesAbandonment({ osmTags: { disused: "yes" } })).toBe(true);
  });

  it("returns false when osm_tags include abandoned=no", () => {
    expect(
      sceneImpliesAbandonment({
        osmTags: { building: "warehouse", abandoned: "no" },
      }),
    ).toBe(false);
  });

  it("returns true when google_query mentions abandonment phrases", () => {
    expect(
      sceneImpliesAbandonment({
        osmTags: { building: "house" },
        googleQuery: "boarded-up house Detroit",
      }),
    ).toBe(true);
    expect(
      sceneImpliesAbandonment({
        osmTags: { building: "house" },
        googleQuery: "derelict mansion Savannah",
      }),
    ).toBe(true);
    expect(
      sceneImpliesAbandonment({
        osmTags: { building: "house" },
        googleQuery: "decayed factory Cleveland",
      }),
    ).toBe(true);
  });

  it("returns false for clean scenes", () => {
    expect(
      sceneImpliesAbandonment({
        osmTags: { amenity: "restaurant" },
        googleQuery: "diner Manhattan late night",
      }),
    ).toBe(false);
  });

  it("returns true when an OSM tag VALUE contains abandonment language", () => {
    expect(
      sceneImpliesAbandonment({
        osmTags: { building: "warehouse", note: "currently abandoned" },
      }),
    ).toBe(true);
  });
});
