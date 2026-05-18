import { describe, expect, it } from "vitest";

import {
  buildDeepLinks,
  preferredAppForUserAgent,
} from "@/lib/deep-links";

const BROOKLYN = { lat: 40.6782, lng: -73.9442 };

describe("buildDeepLinks", () => {
  it("emits all four URLs with valid origins", () => {
    const links = buildDeepLinks(BROOKLYN);
    expect(links.googleMaps).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
    expect(links.directions).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\//);
    expect(links.appleMaps).toMatch(/^https:\/\/maps\.apple\.com\//);
    expect(links.waze).toMatch(/^https:\/\/waze\.com\/ul\?/);
  });

  it("encodes coordinates with 6 decimal precision", () => {
    const links = buildDeepLinks(BROOKLYN);
    expect(links.directions).toContain("destination=40.678200%2C-73.944200");
    expect(links.appleMaps).toContain("ll=40.678200%2C-73.944200");
    expect(links.waze).toContain("ll=40.678200%2C-73.944200");
  });

  it("uses coords (not label) as Google query when no Place ID — fixes 'all OSM cards link to same address' bug", () => {
    const links = buildDeepLinks({
      ...BROOKLYN,
      label: "Warehouse (OSM)", // generic, would all collide if used as query
    });
    expect(links.googleMaps).toContain("query=40.678200%2C-73.944200");
    expect(links.googleMaps).not.toContain("query=Warehouse");
  });

  it("Apple Maps still uses the label for the pin tooltip", () => {
    const links = buildDeepLinks({
      ...BROOKLYN,
      label: "Joe's Pizza",
    });
    expect(links.appleMaps).toContain("q=Joe%27s+Pizza");
  });

  it("Google Maps DOES use the label as query when a Google Place ID is supplied", () => {
    const links = buildDeepLinks({
      ...BROOKLYN,
      label: "Williamsburg Bridge",
      googlePlaceId: "ChIJxyz123",
    });
    expect(links.googleMaps).toContain("query=Williamsburg+Bridge");
    expect(links.googleMaps).toContain("query_place_id=ChIJxyz123");
    expect(links.directions).toContain("destination_place_id=ChIJxyz123");
    // Apple/Waze don't accept Google Place IDs.
    expect(links.appleMaps).not.toContain("ChIJxyz123");
    expect(links.waze).not.toContain("ChIJxyz123");
  });

  it("Waze URL always sets navigate=yes", () => {
    expect(buildDeepLinks(BROOKLYN).waze).toContain("navigate=yes");
  });
});

describe("preferredAppForUserAgent", () => {
  it("picks Apple Maps on iOS", () => {
    expect(
      preferredAppForUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari",
      ),
    ).toBe("appleMaps");
  });

  it("defaults to Google Maps on Android", () => {
    expect(
      preferredAppForUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120"),
    ).toBe("googleMaps");
  });

  it("defaults to Google Maps on desktop / unknown", () => {
    expect(
      preferredAppForUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
      ),
    ).toBe("googleMaps");
    expect(preferredAppForUserAgent(undefined)).toBe("googleMaps");
  });
});
