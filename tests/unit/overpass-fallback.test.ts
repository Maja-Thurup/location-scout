import { describe, expect, it } from "vitest";

import { pickPrimaryTag } from "@/lib/overpass";

describe("pickPrimaryTag", () => {
  it("picks `building` ahead of `building:material`", () => {
    expect(
      pickPrimaryTag({
        building: "warehouse",
        "building:material": "brick",
        abandoned: "yes",
      }),
    ).toEqual({ key: "building", value: "warehouse" });
  });

  it("picks `amenity` for restaurant-like scenes", () => {
    expect(
      pickPrimaryTag({
        amenity: "restaurant",
        cuisine: "diner",
      }),
    ).toEqual({ key: "amenity", value: "restaurant" });
  });

  it("falls through to `natural` when no buildings/amenities present", () => {
    expect(
      pickPrimaryTag({
        natural: "wood",
        leaf_type: "broadleaved",
      }),
    ).toEqual({ key: "natural", value: "wood" });
  });

  it("respects the priority order (building > amenity > shop > tourism > ...)", () => {
    expect(
      pickPrimaryTag({
        amenity: "restaurant",
        shop: "convenience",
        building: "yes",
      }),
    ).toEqual({ key: "building", value: "yes" });
  });

  it("returns null on empty input", () => {
    expect(pickPrimaryTag({})).toBeNull();
  });

  it("falls through to first declared tag if none are in the priority list", () => {
    expect(
      pickPrimaryTag({
        weird_custom_key: "value",
        another: "thing",
      }),
    ).toEqual({ key: "weird_custom_key", value: "value" });
  });

  it("ignores empty values when picking primary", () => {
    expect(
      pickPrimaryTag({
        building: "",
        amenity: "library",
      }),
    ).toEqual({ key: "amenity", value: "library" });
  });
});
