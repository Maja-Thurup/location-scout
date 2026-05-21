// ---------------------------------------------------------------------------
// OSM scene filters — drop false positives from broad name-regex Overpass
// queries on sculpture/monument prompts.
//
// "name=horse|equestrian|..." matches Seahorse NYC, Light Horse Tavern,
// Horseshoe Bar, etc. Those are amenity=restaurant|bar, not statues.
// Sending MORE tag alternatives (e.g. amenity=bar) would make this worse.
// ---------------------------------------------------------------------------

const SCULPTURE_SCENE_HINTS = new Set([
  "statue",
  "sculpture",
  "monument",
  "memorial",
  "artwork",
  "equestrian",
  "bust",
  "figurine",
]);

/** Food/drink OSM amenities that are never filming subjects for statue prompts. */
export const COMMERCIAL_FOOD_AMENITIES = new Set([
  "bar",
  "pub",
  "biergarten",
  "restaurant",
  "cafe",
  "fast_food",
  "food_court",
  "nightclub",
  "ice_cream",
]);

const STATUE_TAG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["tourism", "artwork"],
  ["historic", "memorial"],
  ["historic", "monument"],
  ["amenity", "statue"],
];

export function sceneImpliesSculptureOrMonument(
  sceneTokens: ReadonlyArray<string>,
): boolean {
  return sceneTokens.some((t) => SCULPTURE_SCENE_HINTS.has(t.trim().toLowerCase()));
}

export function tagsMatchStatueClass(tags: Record<string, string>): boolean {
  for (const [k, v] of STATUE_TAG_PAIRS) {
    if (tags[k]?.toLowerCase() === v) return true;
  }
  if (tags["artwork_type"]?.toLowerCase() === "statue") return true;
  if (tags["sculpture:type"]?.toLowerCase() === "equestrian") return true;
  if (tags["memorial"]?.toLowerCase() === "statue") return true;
  return false;
}

export function isCommercialFoodAmenity(tags: Record<string, string>): boolean {
  const a = tags["amenity"]?.trim().toLowerCase();
  return Boolean(a && COMMERCIAL_FOOD_AMENITIES.has(a));
}

/**
 * Drop OSM hits that matched only because "horse" appears inside a
 * restaurant name (Seahorse, Light Horse Tavern, …).
 */
export function shouldExcludeOsmCommercialOnSculptureScene(
  tags: Record<string, string>,
  sceneTokens: ReadonlyArray<string>,
): boolean {
  if (!sceneImpliesSculptureOrMonument(sceneTokens)) return false;
  if (!isCommercialFoodAmenity(tags)) return false;
  return !tagsMatchStatueClass(tags);
}

/**
 * Subject term appears as its own word in a place name (not inside
 * "seahorse" or "horseshoe").
 */
export function subjectTermInName(name: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 3) return false;
  if (/\s/.test(t)) {
    return name.toLowerCase().includes(t);
  }
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(name);
}

export function nameMatchesSubjectTerms(
  name: string,
  terms: Iterable<string>,
): boolean {
  for (const term of terms) {
    if (subjectTermInName(name, term)) return true;
  }
  return false;
}
