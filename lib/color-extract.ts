import sharp from "sharp";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Free dominant-color extraction.
//
// Used as a prefilter before paid vision calls: when Claude's `visual`
// mentions a color (e.g., "yellow building"), we extract the dominant
// color from each candidate's photo and drop those that don't match.
//
// Cost: zero. Speed: ~50-150 ms per image including the fetch.
// ---------------------------------------------------------------------------

export type ColorWord =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "brown"
  | "grey"
  | "black"
  | "white";

export type ColorAnalysis = {
  dominantRgb: { r: number; g: number; b: number };
  hueDeg: number;
  saturation: number;
  lightness: number;
  /** Best-matching color word from our discrete palette. */
  word: ColorWord;
};

const COLOR_FETCH_TIMEOUT_MS = 8_000;
const COLOR_FETCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Pull the central crop of an image, downsample to ~3x3 and average to find
 * the dominant color. Cropping to the center skips most sky / road and
 * focuses on the building/scene subject.
 *
 * Cached 30 days by image URL.
 */
export async function extractDominantColor(imageUrl: string): Promise<ColorAnalysis | null> {
  const k = cacheKey("google:place-photo", { kind: "color", url: imageUrl });
  const cached = await cacheGet<ColorAnalysis>(k);
  if (cached) return cached;

  let bytes: Uint8Array;
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(COLOR_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      logger.warn("color-extract fetch non-ok", { status: res.status });
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > COLOR_FETCH_MAX_BYTES) return null;
    bytes = new Uint8Array(buf);
  } catch (err) {
    logger.warn("color-extract fetch threw", { err: String(err) });
    return null;
  }

  let stats: sharp.Stats;
  try {
    // Resize to a small center crop, average channels, get stats.
    stats = await sharp(bytes)
      .resize(64, 64, { fit: "cover", position: "center" })
      .stats();
  } catch (err) {
    logger.warn("color-extract sharp threw", { err: String(err) });
    return null;
  }

  const r = Math.round(stats.channels[0]?.mean ?? 0);
  const g = Math.round(stats.channels[1]?.mean ?? 0);
  const b = Math.round(stats.channels[2]?.mean ?? 0);

  const { h, s, l } = rgbToHsl(r, g, b);
  const word = hslToColorWord(h, s, l);
  const result: ColorAnalysis = {
    dominantRgb: { r, g, b },
    hueDeg: h,
    saturation: s,
    lightness: l,
    word,
  };

  await cacheSet(k, "google:place-photo", result, 30);
  return result;
}

// ---------------------------------------------------------------------------
// Color-space helpers
// ---------------------------------------------------------------------------

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let s = 0;
  let h = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

/**
 * Discrete color names from continuous HSL. Tuned for buildings:
 * - Very low saturation -> grey/black/white based on lightness
 * - Otherwise hue ranges (red 0-15+345, orange 15-40, yellow 40-65, green 65-170,
 *   blue 170-260, purple 260-300, pink 300-345)
 */
function hslToColorWord(h: number, s: number, l: number): ColorWord {
  if (l < 0.15) return "black";
  if (l > 0.92) return "white";
  if (s < 0.12) return "grey";

  // Brown is the awkward zone: orange-ish hue but low lightness/saturation.
  if (h >= 15 && h < 45 && l < 0.45) return "brown";

  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 65) return "yellow";
  if (h < 170) return "green";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

// ---------------------------------------------------------------------------
// Color words found in a scene description
// ---------------------------------------------------------------------------

/**
 * Subject-attached color patterns. The color must be adjacent to a SUBJECT
 * NOUN (building, house, barn, wall, facade, ...) or appear as a "X-painted"
 * / "X-colored" prefix. This avoids matching background colors like
 * "framed by green space" or "blue sky".
 *
 * The previous implementation matched any color word anywhere in the text,
 * which produced a green-color filter for any scene that mentioned trees,
 * grass, or "green space" — exactly the bug that wrecked the
 * "horse statue in green park" search.
 */
const SUBJECT_NOUN_GROUP =
  "(?:building|buildings|house|houses|home|cottage|cabin|barn|shed|warehouse|factory|farmhouse|townhouse|mansion|chateau|villa|church|chapel|cathedral|tower|wall|walls|facade|fa[çc]ade|roof|door|window|paint|painted|colou?red|brick|bricks|stone|wood|wooden|timber|siding|trim|exterior|tile|tiles|tiled|column|columns|awning|awnings|dome|domes|spire|spires|gate|gates|gateway|fence|fences|mill|silo|lighthouse|pillar|pillars|post|posts)";

const COLOR_PATTERNS: ReadonlyArray<{ word: ColorWord; pattern: RegExp }> = [
  // Each pattern matches "<color> <subject-noun>" OR "<color>-<adjective>"
  // (e.g. "red-painted", "blue-walled", "green-roofed").
  {
    word: "red",
    pattern: new RegExp(
      `\\b(red|crimson|scarlet|burgundy|maroon)(?:[- ]painted|[- ]colou?red|[- ]walled|[- ]roofed|[- ]tiled|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "orange",
    pattern: new RegExp(
      `\\b(orange|terracotta|rust|copper)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "yellow",
    pattern: new RegExp(
      `\\b(yellow|gold(?:en)?|amber|mustard|cream|beige|tan|sand|sandstone)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "green",
    pattern: new RegExp(
      `\\b(green|olive|emerald|sage|mint)(?:[- ]painted|[- ]colou?red|[- ]walled|[- ]roofed|[- ]tiled|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "blue",
    pattern: new RegExp(
      `\\b(blue|navy|azure|cobalt|teal)(?:[- ]painted|[- ]colou?red|[- ]walled|[- ]roofed|[- ]tiled|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "purple",
    pattern: new RegExp(
      `\\b(purple|violet|lavender|mauve|plum)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "pink",
    pattern: new RegExp(
      `\\b(pink|rose|salmon|coral)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "brown",
    pattern: new RegExp(
      `\\b(brown|chocolate)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "grey",
    pattern: new RegExp(
      `\\b(gr[ae]y|silver|charcoal|ash|concrete)(?:[- ]painted|[- ]colou?red|[- ]walled|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "black",
    pattern: new RegExp(
      `\\b(black|jet|onyx)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
  {
    word: "white",
    pattern: new RegExp(
      `\\b(white|ivory|off-white|chalk)(?:[- ]painted|[- ]colou?red|\\s+${SUBJECT_NOUN_GROUP})`,
      "i",
    ),
  },
];

/**
 * Background phrases that should never trigger a subject-color filter,
 * even if a color word appears nearby. This is a defense-in-depth
 * blacklist on top of the subject-attachment requirement above.
 */
const BACKGROUND_PHRASE_RE =
  /\b(green\s+(?:space|grass|lawn|meadow|park|field|landscape|foliage)|blue\s+(?:sky|water|ocean|sea|lake|river)|white\s+(?:snow|sky|clouds?)|forest|trees|woods?|grass|meadow|sky|clouds?|garden|hills?)\b/i;

/**
 * Find the first SUBJECT color word mentioned in `text`. Returns null when
 * the text only mentions background colors (sky/grass/trees/...).
 *
 * IMPORTANT: callers should pass the user's RAW scene text, NOT Claude's
 * `visual` prose. Claude tends to weave background colors into its visual
 * description ("framed by green space"), and that's exactly the false
 * positive we want to avoid.
 */
export function parseColorFromVisual(text: string | null | undefined): ColorWord | null {
  if (!text) return null;
  for (const { word, pattern } of COLOR_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    // If the match overlaps a known background phrase, skip it.
    const matchedSlice = text.slice(
      Math.max(0, m.index - 8),
      Math.min(text.length, m.index + m[0].length + 8),
    );
    if (BACKGROUND_PHRASE_RE.test(matchedSlice)) continue;
    return word;
  }
  return null;
}

/**
 * "Close enough" color matching tolerant of lighting variation. Yellow buildings
 * photographed in shade often look closer to brown; we accept the neighbours
 * to avoid false rejections.
 */
const COLOR_NEIGHBOURS: Record<ColorWord, ReadonlyArray<ColorWord>> = {
  red: ["red", "orange", "brown", "pink"],
  orange: ["orange", "yellow", "red", "brown"],
  yellow: ["yellow", "orange", "white", "brown"],
  green: ["green", "yellow"],
  blue: ["blue", "purple", "grey"],
  purple: ["purple", "blue", "pink"],
  pink: ["pink", "red", "purple", "white"],
  brown: ["brown", "orange", "red", "grey"],
  grey: ["grey", "white", "black", "brown"],
  black: ["black", "grey"],
  white: ["white", "grey", "yellow"],
};

export function colorMatches(target: ColorWord, observed: ColorWord): boolean {
  if (target === observed) return true;
  return COLOR_NEIGHBOURS[target].includes(observed);
}
