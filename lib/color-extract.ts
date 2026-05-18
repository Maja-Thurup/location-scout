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

const COLOR_PATTERNS: ReadonlyArray<{ word: ColorWord; pattern: RegExp }> = [
  { word: "red", pattern: /\b(red|crimson|scarlet|burgundy|maroon)\b/i },
  { word: "orange", pattern: /\b(orange|terracotta|rust|copper)\b/i },
  { word: "yellow", pattern: /\b(yellow|gold(?:en)?|amber|mustard|cream|beige|tan|sand|sandstone)\b/i },
  { word: "green", pattern: /\b(green|olive|emerald|sage|forest|mint)\b/i },
  { word: "blue", pattern: /\b(blue|navy|azure|cobalt|teal)\b/i },
  { word: "purple", pattern: /\b(purple|violet|lavender|mauve|plum)\b/i },
  { word: "pink", pattern: /\b(pink|rose|salmon|coral)\b/i },
  { word: "brown", pattern: /\b(brown|chocolate|tan(?: building)?|wood(?:en)?|brick(?:work)?)\b/i },
  { word: "grey", pattern: /\b(gr[ae]y|silver|charcoal|ash|stone(?:-grey)?|concrete)\b/i },
  { word: "black", pattern: /\b(black|jet|onyx)\b/i },
  { word: "white", pattern: /\b(white|ivory|off-white|cream(?:-?white)?|chalk)\b/i },
];

/** Find the first color word mentioned in `text`. Returns null when none. */
export function parseColorFromVisual(text: string | null | undefined): ColorWord | null {
  if (!text) return null;
  for (const { word, pattern } of COLOR_PATTERNS) {
    if (pattern.test(text)) return word;
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
