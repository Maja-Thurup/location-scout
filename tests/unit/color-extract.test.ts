import { describe, expect, it } from "vitest";

import {
  colorMatches,
  parseColorFromVisual,
  type ColorWord,
} from "@/lib/color-extract";

// ---------------------------------------------------------------------------
// parseColorFromVisual
// ---------------------------------------------------------------------------

describe("parseColorFromVisual", () => {
  it("returns null on empty input", () => {
    expect(parseColorFromVisual(null)).toBeNull();
    expect(parseColorFromVisual(undefined)).toBeNull();
    expect(parseColorFromVisual("")).toBeNull();
  });

  it("identifies primary colors", () => {
    expect(parseColorFromVisual("a yellow building")).toBe("yellow");
    expect(parseColorFromVisual("dark blue facade")).toBe("blue");
    expect(parseColorFromVisual("vivid red bricks")).toBe("red");
    expect(parseColorFromVisual("dense green forest")).toBe("green");
    expect(parseColorFromVisual("violet mood")).toBe("purple");
  });

  it("recognizes color synonyms", () => {
    expect(parseColorFromVisual("a golden facade")).toBe("yellow");
    expect(parseColorFromVisual("burgundy door")).toBe("red");
    expect(parseColorFromVisual("a teal awning")).toBe("blue");
    expect(parseColorFromVisual("ivory column")).toBe("white");
    expect(parseColorFromVisual("charcoal exterior")).toBe("grey");
    expect(parseColorFromVisual("salmon walls")).toBe("pink");
    expect(parseColorFromVisual("mustard paint job")).toBe("yellow");
  });

  it("returns the first color when multiple are mentioned", () => {
    // Pattern order goes red→orange→yellow→green→blue→purple→pink→brown→grey→black→white
    // so 'green' beats 'red' would be wrong; 'red' is checked first.
    expect(parseColorFromVisual("a red and blue building")).toBe("red");
  });

  it("ignores color words inside other words", () => {
    expect(parseColorFromVisual("Dark Knight")).toBeNull(); // 'Dark' isn't in our list
    expect(parseColorFromVisual("amber alert")).toBe("yellow"); // 'amber' is a yellow synonym
  });
});

// ---------------------------------------------------------------------------
// colorMatches (neighbour-tolerant matching)
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
