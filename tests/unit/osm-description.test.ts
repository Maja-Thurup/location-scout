import { describe, expect, it } from "vitest";

import { deriveOsmDescription, extractOsmWikidataQid } from "@/lib/osm-description";

describe("deriveOsmDescription", () => {
  it("reads description tag", () => {
    expect(
      deriveOsmDescription({ description: "Bronze equestrian statue", name: "X" }),
    ).toBe("Bronze equestrian statue");
  });

  it("falls back to wikipedia tag", () => {
    expect(deriveOsmDescription({ wikipedia: "en:Some Monument" })).toBe(
      "Wikipedia: Some Monument",
    );
  });
});

describe("extractOsmWikidataQid", () => {
  it("normalizes Q-id", () => {
    expect(extractOsmWikidataQid({ wikidata: "q7841560" })).toBe("Q7841560");
  });
});
