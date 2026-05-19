import { describe, expect, it } from "vitest";

import {
  colorMatches,
  parseColorFromVisual,
  type ColorWord,
} from "@/lib/color-extract";

// ---------------------------------------------------------------------------
// parseColorFromVisual
//
// The matcher is INTENTIONALLY strict: a color word must be attached to a
// subject noun (building, house, wall, paint, ...) OR appear as a hyphenated
// adjective (`yellow-painted`, `red-walled`). This is the fix for the
// horse-statue bug where "framed by green space" / "in a green park"
// triggered a green color filter and threw out every actually-matching
// candidate.
// ---------------------------------------------------------------------------

describe("parseColorFromVisual", () => {
  it("returns null on empty input", () => {
    expect(parseColorFromVisual(null)).toBeNull();
    expect(parseColorFromVisual(undefined)).toBeNull();
    expect(parseColorFromVisual("")).toBeNull();
  });

  it("identifies subject-attached colors", () => {
    expect(parseColorFromVisual("a yellow building")).toBe("yellow");
    expect(parseColorFromVisual("dark blue facade")).toBe("blue");
    expect(parseColorFromVisual("vivid red brick")).toBe("red");
    expect(parseColorFromVisual("an old blue house")).toBe("blue");
    expect(parseColorFromVisual("white-painted cottage")).toBe("white");
    expect(parseColorFromVisual("a red-roofed church")).toBe("red");
  });

  it("recognizes color synonyms when subject-attached", () => {
    expect(parseColorFromVisual("a golden facade")).toBe("yellow");
    expect(parseColorFromVisual("burgundy door")).toBe("red");
    expect(parseColorFromVisual("ivory wall")).toBe("white");
    expect(parseColorFromVisual("charcoal exterior")).toBe("grey");
    expect(parseColorFromVisual("salmon walls")).toBe("pink");
    expect(parseColorFromVisual("mustard paint job")).toBe("yellow");
  });

  // -------------------------------------------------------------------------
  // BUG REGRESSION TESTS — the cases that were producing junk results
  // -------------------------------------------------------------------------

  it("does NOT fire on background-color phrases (the horse-statue bug)", () => {
    // The exact prompt that ate our search results.
    expect(
      parseColorFromVisual("A big statue of a horse in the middle of the park"),
    ).toBeNull();
    // Claude's "visual" prose for the same prompt.
    expect(
      parseColorFromVisual(
        "Bronze equestrian statue framed by green space and trees",
      ),
    ).toBeNull();
    // Other common background-color phrasings.
    expect(parseColorFromVisual("framed by green space")).toBeNull();
    expect(parseColorFromVisual("trees and lush green lawn")).toBeNull();
    expect(parseColorFromVisual("blue sky overhead")).toBeNull();
    expect(parseColorFromVisual("white snow on the ground")).toBeNull();
    expect(parseColorFromVisual("the forest behind it")).toBeNull();
  });

  it("does NOT fire on bare color words without a subject", () => {
    expect(parseColorFromVisual("violet mood")).toBeNull();
    expect(parseColorFromVisual("amber alert")).toBeNull();
    expect(parseColorFromVisual("Dark Knight")).toBeNull();
    // "green park" is just describing the surroundings, not a green subject.
    expect(parseColorFromVisual("a horse in a green park")).toBeNull();
  });

  it("DOES fire on subject-attached colors even with background prose nearby", () => {
    // "old blue building" with "trees in the back" — the user's M3 prompt.
    expect(
      parseColorFromVisual(
        "an old blue building outside of town with trees in the back",
      ),
    ).toBe("blue");
    // Subject takes precedence over background.
    expect(
      parseColorFromVisual("yellow farmhouse against blue sky"),
    ).toBe("yellow");
    // Even when the background phrase comes first.
    expect(
      parseColorFromVisual("trees in front of the red-painted barn"),
    ).toBe("red");
  });

  it("returns null for plain prompts with no color intent", () => {
    expect(parseColorFromVisual("an abandoned warehouse, Brooklyn")).toBeNull();
    expect(parseColorFromVisual("a diner late at night")).toBeNull();
    expect(parseColorFromVisual("scenic mountain overlook")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// colorMatches (neighbour-tolerant matching) — unchanged behavior
// ---------------------------------------------------------------------------

describe("colorMatches", () => {
  it("trivially matches identical colors", () => {
    const allColors: ColorWord[] = [
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "brown",
      "grey",
      "black",
      "white",
    ];
    for (const c of allColors) {
      expect(colorMatches(c, c)).toBe(true);
    }
  });

  it("yellow tolerates orange / brown / white as 'close enough'", () => {
    expect(colorMatches("yellow", "orange")).toBe(true);
    expect(colorMatches("yellow", "brown")).toBe(true);
    expect(colorMatches("yellow", "white")).toBe(true);
  });

  it("yellow rejects blue, green, purple", () => {
    expect(colorMatches("yellow", "blue")).toBe(false);
    expect(colorMatches("yellow", "green")).toBe(false);
    expect(colorMatches("yellow", "purple")).toBe(false);
  });

  it("brown is bidirectional with orange / red / grey", () => {
    expect(colorMatches("brown", "orange")).toBe(true);
    expect(colorMatches("brown", "red")).toBe(true);
    expect(colorMatches("brown", "grey")).toBe(true);
    expect(colorMatches("brown", "blue")).toBe(false);
  });

  it("grey accepts white, black, brown", () => {
    expect(colorMatches("grey", "white")).toBe(true);
    expect(colorMatches("grey", "black")).toBe(true);
    expect(colorMatches("grey", "brown")).toBe(true);
    expect(colorMatches("grey", "yellow")).toBe(false);
  });

  it("black does not match white", () => {
    expect(colorMatches("black", "white")).toBe(false);
  });
});
