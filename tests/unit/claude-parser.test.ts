import { describe, expect, it } from "vitest";

import {
  extractJsonBlock,
  parseSceneAnalysis,
  resolveOsmTagAlternatives,
} from "@/lib/claude";

// ---------------------------------------------------------------------------
// Realistic fixtures of what `claude-haiku-4-5` returns for parse-scene.
// 3 happy paths (clean JSON, fenced JSON, JSON with leading prose),
// 2 malformed (truncated JSON, schema mismatch / missing required keys).
// ---------------------------------------------------------------------------

const cleanJson = `{
  "osm_tags": { "building": "warehouse", "building:material": "brick", "abandoned": "yes" },
  "google_query": "abandoned brick warehouse Brooklyn industrial",
  "google_types": ["storage", "warehouse"],
  "city": "Brooklyn, NY",
  "visual": "exposed brick walls, large industrial windows",
  "mood": "gritty",
  "time_of_day": "night",
  "interior_exterior": "interior"
}`;

const fencedJson = "```json\n" + cleanJson + "\n```";

const prefixedJson =
  "Sure! Here is the analysis:\n\n" +
  cleanJson +
  "\n\nLet me know if you need anything else.";

// Double-comma + trailing comma = syntactically invalid JSON, but braces
// are balanced so our extractor recognizes it as a JSON candidate before
// JSON.parse rejects it.
const malformedJson = `{
  "osm_tags": {,, "building": "warehouse" },
  "google_query": "warehouse Brooklyn",,
  "google_types": ["storage"],
}`;

const wrongSchemaJson = `{
  "osm_tags": "warehouse",
  "google_query": "warehouse",
  "city": "Brooklyn, NY"
}`; // osm_tags should be an object, missing required fields

// ---------------------------------------------------------------------------
// extractJsonBlock
// ---------------------------------------------------------------------------

describe("extractJsonBlock", () => {
  it("extracts a clean JSON object", () => {
    const out = extractJsonBlock(cleanJson);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).city).toBe("Brooklyn, NY");
  });

  it("strips ```json fences", () => {
    const out = extractJsonBlock(fencedJson);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).city).toBe("Brooklyn, NY");
  });

  it("handles JSON wrapped in prose", () => {
    const out = extractJsonBlock(prefixedJson);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).city).toBe("Brooklyn, NY");
  });

  it("returns null when no JSON object is present", () => {
    expect(extractJsonBlock("Sorry, I can't help with that.")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractJsonBlock("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSceneAnalysis
// ---------------------------------------------------------------------------

describe("parseSceneAnalysis", () => {
  it("succeeds on clean JSON", () => {
    const r = parseSceneAnalysis(cleanJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.osm_tags.building).toBe("warehouse");
      expect(r.value.google_types).toEqual(["storage", "warehouse"]);
      expect(r.value.interior_exterior).toBe("interior");
      expect(r.value.mood).toBe("gritty");
      // New Path A fields default when absent.
      expect(r.value.osm_tags_alternatives).toEqual([]);
      expect(r.value.scene_tokens).toEqual([]);
      expect(r.value.location_kind).toBeNull();
      expect(r.value.mapillary_classes).toEqual([]);
    }
  });

  it("succeeds on rich JSON with osm_tags_alternatives, scene_tokens and location_kind", () => {
    const richJson = JSON.stringify({
      osm_tags: { building: "house" },
      osm_tags_alternatives: [
        { building: "house" },
        { building: "detached" },
        { landuse: "residential" },
        { natural: "wood" },
      ],
      google_query: "old blue house rural NY",
      google_types: ["lodging"],
      city: "New York, NY",
      visual: "weathered blue-painted house, trees in background, rural setting",
      scene_tokens: [
        "blue",
        "weathered",
        "old",
        "rural",
        "wooden",
        "house",
        "trees",
        "outside_town",
      ],
      anti_tokens: ["modern", "high_rise", "townhouse_row"],
      location_kind: "rural",
      mood: "nostalgic",
      time_of_day: "day",
      interior_exterior: "exterior",
      mapillary_classes: [],
    });
    const r = parseSceneAnalysis(richJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.osm_tags_alternatives).toHaveLength(4);
      expect(r.value.osm_tags_alternatives[0]).toEqual({ building: "house" });
      expect(r.value.scene_tokens).toContain("blue");
      expect(r.value.scene_tokens).toContain("trees");
      expect(r.value.anti_tokens).toEqual([
        "modern",
        "high_rise",
        "townhouse_row",
      ]);
      expect(r.value.location_kind).toBe("rural");
    }
  });

  it("anti_tokens defaults to empty array when missing", () => {
    const json = JSON.stringify({
      osm_tags: { building: "house" },
      google_query: "house",
      google_types: [],
      city: "New York, NY",
      visual: "a house",
      mood: null,
      time_of_day: null,
      interior_exterior: null,
    });
    const r = parseSceneAnalysis(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.anti_tokens).toEqual([]);
  });

  it("rejects an unknown location_kind value", () => {
    const json = JSON.stringify({
      osm_tags: { building: "house" },
      google_query: "house",
      google_types: [],
      city: "New York, NY",
      visual: "a house",
      location_kind: "moon_base", // not in enum
      mood: null,
      time_of_day: null,
      interior_exterior: null,
    });
    const r = parseSceneAnalysis(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("schema_mismatch");
  });

  it("succeeds on fenced JSON", () => {
    const r = parseSceneAnalysis(fencedJson);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.city).toBe("Brooklyn, NY");
  });

  it("succeeds on JSON with surrounding prose", () => {
    const r = parseSceneAnalysis(prefixedJson);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.city).toBe("Brooklyn, NY");
  });

  it("fails with no_json_found on plain prose", () => {
    const r = parseSceneAnalysis("I'd be happy to help with location scouting.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("no_json_found");
  });

  it("fails with invalid_json on syntactically broken JSON", () => {
    const r = parseSceneAnalysis(malformedJson);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("invalid_json");
  });

  it("fails with schema_mismatch when required keys are wrong-typed", () => {
    const r = parseSceneAnalysis(wrongSchemaJson);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toBe("schema_mismatch");
      expect(r.failure.detail).toBeTruthy();
    }
  });

  it("accepts nullable optional fields explicitly set to null", () => {
    const json = JSON.stringify({
      osm_tags: { building: "diner" },
      google_query: "diner Manhattan late night",
      google_types: ["restaurant"],
      city: "New York, NY",
      visual: "neon signage, chrome stools",
      mood: null,
      time_of_day: null,
      interior_exterior: null,
    });
    const r = parseSceneAnalysis(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mood).toBeNull();
      expect(r.value.time_of_day).toBeNull();
      expect(r.value.interior_exterior).toBeNull();
    }
  });

  it("resolveOsmTagAlternatives prefers alternatives when present", () => {
    const alts = resolveOsmTagAlternatives({
      osm_tags: { building: "house" },
      osm_tags_alternatives: [
        { building: "detached" },
        { landuse: "residential" },
      ],
    });
    expect(alts).toHaveLength(2);
    expect(alts[0]).toEqual({ building: "detached" });
  });

  it("resolveOsmTagAlternatives falls back to osm_tags when alternatives empty", () => {
    const alts = resolveOsmTagAlternatives({
      osm_tags: { building: "warehouse", "building:material": "brick" },
      osm_tags_alternatives: [],
    });
    expect(alts).toHaveLength(1);
    expect(alts[0]).toEqual({
      building: "warehouse",
      "building:material": "brick",
    });
  });

  it("resolveOsmTagAlternatives returns empty when both empty", () => {
    const alts = resolveOsmTagAlternatives({
      osm_tags: {},
      osm_tags_alternatives: [],
    });
    expect(alts).toEqual([]);
  });

  it("rejects an unknown interior_exterior value", () => {
    const json = JSON.stringify({
      osm_tags: { building: "loft" },
      google_query: "loft soho",
      google_types: [],
      city: "New York, NY",
      visual: "industrial loft, large windows",
      mood: null,
      time_of_day: null,
      interior_exterior: "outside", // <- not in the enum
    });
    const r = parseSceneAnalysis(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("schema_mismatch");
  });
});
