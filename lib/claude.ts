import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Models
//
// We prefer the cheapest capable model for the hot path (parsing). Vision
// scoring (Phase 2) will use Sonnet because the task is harder.
// ---------------------------------------------------------------------------

export const CLAUDE_MODELS = {
  parsing: "claude-haiku-4-5" as const,
  vision: "claude-sonnet-4-6" as const,
} as const;

// ---------------------------------------------------------------------------
// Output schema
//
// The shape of what Claude returns for a scene-parse call. Drives:
//   - Overpass query building (osm_tags)
//   - Google Places text search (google_query, google_types)
//   - Geocoding (city)
//   - Future visual scoring (visual)
// ---------------------------------------------------------------------------

export const interiorExteriorSchema = z.enum(["interior", "exterior", "both"]);

export const locationKindSchema = z.enum([
  "urban",
  "suburban",
  "rural",
  "industrial",
  "wilderness",
  "waterfront",
  "mixed",
]);

export const sceneAnalysisSchema = z.object({
  /**
   * Single primary OSM tag map, e.g. { building: "warehouse" }.
   * Kept for backwards-compat with cached entries from the M3 era.
   * The pipeline now reads `osm_tags_alternatives` first; this is the
   * fallback if alternatives is empty.
   */
  osm_tags: z.record(z.string(), z.string()),

  /**
   * Multiple alternative OSM tag-sets, ordered most-likely first. Each entry
   * is a STANDALONE filter that is run as part of a UNION Overpass query.
   * The pipeline aggregates all matches across alternatives into one
   * candidate pool, then visual-reranks them.
   *
   * Pinterest-Lens style "candidate generation → visual reranking":
   * generate broadly (high recall), narrow with vision (high precision).
   *
   * Common pattern: 4-8 alternatives covering the main classifier (building,
   * landuse, natural, leisure, ...) plus close synonyms.
   */
  osm_tags_alternatives: z
    .array(z.record(z.string(), z.string()))
    .default([]),

  /**
   * Free-text Google Places search query. Used ONLY for the "View all on
   * Google Maps" link surfaced in the UI and as a B2 fallback when OSM
   * returns zero. The main retrieval no longer relies on this.
   */
  google_query: z.string().min(1),

  /** Google Places API "types" filter (e.g. ["storage", "warehouse"]). */
  google_types: z.array(z.string()),

  /** Canonical city, "City, ST" preferred. */
  city: z.string().min(1),

  /** Prose visual descriptor — one or two sentences for the vision scorer. */
  visual: z.string().min(1),

  /**
   * Discrete visual/setting/mood tokens for vision scoring AND future
   * embedding-based retrieval. Aim for 5-15 short, concrete words.
   *
   * Examples (per scene):
   *   "old blue building outside of town with trees in the back"
   *     -> ["blue", "weathered", "old", "rural", "suburban", "wooden",
   *         "house", "trees", "forest", "outside_town"]
   *   "abandoned brick warehouse, Brooklyn"
   *     -> ["brick", "warehouse", "industrial", "abandoned", "weathered",
   *         "boarded_up", "graffiti", "urban"]
   *   "neon-lit diner with phone booth"
   *     -> ["neon", "diner", "chrome", "phone_booth", "retro", "urban"]
   *
   * These tokens are NOT OSM tags — they're free-text descriptors used by
   * the vision scorer to look for specific cues in candidate photos.
   */
  scene_tokens: z.array(z.string()).default([]),

  /**
   * Negative/contradicting tokens — things that, if visible in a photo,
   * mean the photo CANNOT be a match. The vision scorer subtracts heavily
   * when these are observed. Aim for 3-8 anti-tokens that capture the
   * obvious lookalikes / wrong subjects we don't want.
   *
   * Examples:
   *   "an old blue building outside of town with trees in the back"
   *     -> ["modern", "new_construction", "high_rise", "townhouse_row",
   *         "office_block", "skyscraper", "dense_urban"]
   *   "abandoned brick warehouse, Brooklyn"
   *     -> ["modern", "renovated", "shiny_glass", "hotel", "luxury_condo"]
   *   "bench on a wooded path"
   *     -> ["highway", "parking_lot", "indoor", "industrial"]
   *
   * Empty array = no specific anti-matches (the scorer does its best with
   * the positive tokens alone).
   */
  anti_tokens: z.array(z.string()).default([]),

  /** Broad setting category — informs the candidate-generation strategy. */
  location_kind: locationKindSchema.nullable().default(null),

  /** Optional mood tag (gritty, romantic, noir, ...). */
  mood: z.string().nullable(),

  /** Optional time-of-day tag (day, night, dusk, dawn). */
  time_of_day: z.string().nullable(),

  /** Optional interior/exterior/both. */
  interior_exterior: interiorExteriorSchema.nullable(),

  /**
   * Optional list of Mapillary `object_value` classes implied by the scene.
   * Used as a free pre-filter signal: "show me coords where the cameras
   * actually saw a bench / fire hydrant / cobblestone / etc."
   *
   * Examples: ["object--bench", "marking--surface--cobblestone",
   * "object--street-light", "object--bike-rack", "object--fire-hydrant"].
   *
   * Empty array means "no specific objects implied"; we won't hit the
   * Mapillary detections endpoint in that case.
   */
  mapillary_classes: z.array(z.string()).default([]),
});

export type SceneAnalysis = z.infer<typeof sceneAnalysisSchema>;
export type LocationKind = z.infer<typeof locationKindSchema>;

/**
 * Resolve the final list of OSM tag alternatives the pipeline should run.
 * Falls back to a single-element list of `osm_tags` when Claude (or a stale
 * cache) didn't supply alternatives.
 */
export function resolveOsmTagAlternatives(
  analysis: Pick<SceneAnalysis, "osm_tags" | "osm_tags_alternatives">,
): Array<Record<string, string>> {
  if (analysis.osm_tags_alternatives.length > 0) {
    return analysis.osm_tags_alternatives;
  }
  if (Object.keys(analysis.osm_tags).length > 0) {
    return [analysis.osm_tags];
  }
  return [];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a location-scouting assistant for film and video production.

Given a scene description (or short script excerpt) and an optional location hint, decompose the scene into MANY structured retrieval signals as JSON. The downstream pipeline does "candidate generation → visual reranking" (Pinterest Lens style): we generate broadly, then a vision model picks the best matches. So your job is to be EXPANSIVE, not conservative — emit every reasonable variation.

Return ONLY a single JSON object, no prose, no code fences. The schema is:

{
  "osm_tags": { "<osm_key>": "<value>" },
  "osm_tags_alternatives": [ { "<osm_key>": "<value>" }, ... ],
  "google_query": "string suitable for Google Places text search",
  "google_types": ["string", "..."],
  "city": "City, ST (United States)",
  "visual": "1-2 sentence visual descriptor",
  "scene_tokens": ["short", "discrete", "tokens"],
  "anti_tokens": ["short", "negative", "tokens"],
  "location_kind": "urban|suburban|rural|industrial|wilderness|waterfront|mixed" | null,
  "mood": "string or null",
  "time_of_day": "string or null",
  "interior_exterior": "interior" | "exterior" | "both" | null,
  "mapillary_classes": ["string", "..."]
}

Guidance for fields:

- osm_tags: a SINGLE primary classifier — usually the first entry of
  osm_tags_alternatives. Kept for backwards compatibility.

- osm_tags_alternatives: THE MAIN RETRIEVAL FIELD. Emit 4-8 alternative
  tag-sets. Each is run as part of a UNION Overpass query — features
  matching ANY alternative become a candidate. Order most-likely first.

  Each alternative MUST be a complete, runnable filter that, run alone,
  would return real-world matches. Do not combine multiple keys unless
  BOTH are commonly tagged together in OSM (which is rare).

  Available primary classifier keys (use as the first key of an alternative):
    building, amenity, landuse, natural, leisure, historic, shop, tourism,
    man_made, highway, waterway, railway, aeroway, office, place, public_transport.

  Common building values:    house, residential, detached, semidetached_house,
    apartments, terrace, garage, warehouse, industrial, commercial, retail,
    office, hotel, hospital, school, church, chapel, cathedral, civic,
    barn, stable, farm_auxiliary, shed, cabin, bungalow, ruins.
  Common amenity values:     restaurant, cafe, bar, pub, fast_food, food_court,
    place_of_worship, theatre, cinema, library, school, university, hospital,
    pharmacy, fuel, parking, post_office, fire_station, police, townhall.
  Common landuse values:     residential, commercial, industrial, retail,
    farmland, farmyard, forest, meadow, orchard, vineyard, military, brownfield,
    cemetery, recreation_ground, allotments, construction, quarry.
  Common natural values:     wood, tree, tree_row, scrub, heath, grassland,
    bare_rock, beach, cliff, water, wetland, marsh.
  Common leisure values:     park, garden, playground, pitch, golf_course,
    nature_reserve, marina, sports_centre, swimming_pool, common.
  Common historic values:    house, building, castle, monument, ruins,
    archaeological_site, memorial, manor, fort, wayside_cross,
    aircraft, ship, boundary_stone, milestone, tomb.
  Common tourism values:     attraction, viewpoint, museum, artwork,
    gallery, theme_park, zoo, aquarium, picnic_site, camp_site,
    hostel, hotel, motel.
  Common man_made values:    tower, lighthouse, water_tower, bridge,
    pier, chimney, obelisk, silo, windmill, watermill, observatory.

  Values MUST be lowercase, single-word OSM-canonical values.

  Examples (notice how each alternative is a STANDALONE filter):

    Scene: "an old blue building outside of town with trees in the back"
    -> [
         { "building": "house" },
         { "building": "detached" },
         { "building": "residential" },
         { "building": "barn" },
         { "building": "farm_auxiliary" },
         { "landuse": "residential" },
         { "landuse": "farmland" },
         { "natural": "wood" }
       ]

    Scene: "abandoned brick warehouse, Brooklyn"
    -> [
         { "building": "warehouse" },
         { "building": "industrial" },
         { "building": "commercial" },
         { "landuse": "industrial" },
         { "landuse": "brownfield" },
         { "man_made": "works" }
       ]

    Scene: "diner conversation at night"
    -> [
         { "amenity": "restaurant" },
         { "amenity": "cafe" },
         { "amenity": "fast_food" },
         { "shop": "convenience" }
       ]

    Scene: "neon-lit street corner in Tokyo style"
    -> [
         { "shop": "convenience" },
         { "amenity": "restaurant" },
         { "amenity": "bar" },
         { "highway": "primary" },
         { "highway": "secondary" }
       ]

    Scene: "bench on a wooded path"
    -> [
         { "leisure": "park" },
         { "natural": "wood" },
         { "landuse": "forest" },
         { "leisure": "nature_reserve" }
       ]

    Scene: "old stone church in a small town"
    -> [
         { "building": "church" },
         { "amenity": "place_of_worship" },
         { "historic": "church" },
         { "building": "chapel" }
       ]

    Scene: "a big statue of a horse in the middle of the park"
    -> [
         { "historic": "monument" },
         { "historic": "memorial" },
         { "tourism": "artwork" },
         { "man_made": "statue" },
         { "tourism": "attraction" }
       ]
    (NOTE: include "leisure=park" only if the prompt is ABOUT a park.
    Here the subject is the statue; the park is incidental.)

    Scene: "scenic mountain overlook with pine trees"
    -> [
         { "tourism": "viewpoint" },
         { "natural": "peak" },
         { "natural": "wood" },
         { "leisure": "nature_reserve" }
       ]

  Color, age, material, condition, story-count, and similar visual filters
  do NOT belong here — they are sparsely tagged in OSM and would collapse
  the result set. Encode those in scene_tokens instead; the vision scorer
  uses them for ranking.

- google_query: a short text query a film scout would type, including the
  city. Used for the "View all on Google Maps" link in the UI; not for
  primary retrieval.

- google_types: 0-3 strings from Google Places "types" enum. Empty is fine.
  Examples: storage, warehouse, restaurant, cafe, bar, lodging,
  movie_theater, museum, library, church, park, parking, tourist_attraction.

- city: canonical "City, ST" form derived from the location hint. Hint may
  be a city ("Brooklyn"), city+state ("Brooklyn, NY"), neighborhood
  ("Williamsburg"), or street address. Always normalize to the underlying
  "City, ST". If no hint and the scene implies a setting, pick a sensible
  US city (LA, NYC, Atlanta, Detroit, Miami, ...).

- visual: 1-2 sentences capturing what a candidate photo should show.
  Concrete and specific — colors, materials, era, framing.

- scene_tokens: 5-15 short, discrete words/phrases for vision matching and
  future embedding retrieval. Use snake_case for multi-word tokens. Mix:
  COLORS (blue, navy, red, weathered, faded), MATERIALS (brick, wood,
  stone, concrete, metal), AGE/CONDITION (old, abandoned, decayed,
  renovated, modern), SETTING (urban, rural, suburban, wooded,
  outside_town, roadside), OBJECTS (trees, fence, porch, signage), MOOD
  (gritty, peaceful, noir).

  Be expansive. 5 is the floor; 10-15 is ideal.

  Examples:
    "an old blue building outside of town with trees in the back"
      -> ["blue", "navy", "weathered", "old", "rural", "suburban",
          "wooden", "house", "barn", "trees", "forest", "outside_town",
          "roadside", "peeling_paint"]
    "abandoned brick warehouse, broken windows"
      -> ["brick", "warehouse", "industrial", "abandoned", "broken_windows",
          "boarded_up", "graffiti", "weathered", "decayed", "urban", "gritty"]
    "neon-lit diner with phone booth"
      -> ["neon", "diner", "chrome", "formica", "booth", "phone_booth",
          "retro", "70s", "urban", "night"]

- anti_tokens: 3-8 negative tokens — things that, if visibly present in a
  photo, CONTRADICT the scene and should kill the score. Pick the obvious
  "lookalike traps" that Mapillary/Street View commonly returns when our
  candidate generation misfires.

  Be specific to the scene's contradictions. Don't list random opposites.

  Examples:
    "an old blue building outside of town with trees in the back"
      -> ["modern", "new_construction", "high_rise", "townhouse_row",
          "office_block", "skyscraper", "dense_urban"]
    "abandoned brick warehouse, Brooklyn"
      -> ["modern", "renovated", "shiny_glass", "luxury_condo", "hotel"]
    "Victorian row house"
      -> ["modern", "ranch_house", "bungalow", "high_rise"]
    "diner conversation at night"
      -> ["fine_dining", "chain_restaurant", "fast_food_drive_thru",
          "office_lobby"]
    "bench on a wooded path"
      -> ["highway", "parking_lot", "indoor", "industrial", "intersection"]
    "neon-lit diner"
      -> ["daylight", "no_signage", "office_building", "fine_dining"]

  Empty array is acceptable for very generic scenes; otherwise emit at least
  3.

- location_kind: pick one of the enum values that best fits, or null.
    urban       — city center, dense streets, mid/high-rise
    suburban    — residential blocks, single-family homes, strip malls
    rural       — small town, farmland, country roads, isolated buildings
    industrial  — warehouses, factories, ports, rail yards
    wilderness  — forests, mountains, deserts, off-grid
    waterfront  — beach, harbor, river, lakeshore, marsh
    mixed       — scene crosses categories
  This signal informs candidate generation strategy.

- mood: optional one-word vibe ("gritty", "romantic", "noir", ...).
- time_of_day: optional ("day", "night", "dawn", "dusk", "golden_hour").
- interior_exterior: pick one if obvious from the scene; null if unclear.

- mapillary_classes: ZERO to FOUR canonical Mapillary "object_value" strings
  for objects/materials specifically called out in the scene. Use ONLY for
  things Mapillary's car-mounted cameras actually see at street level.

  Available canonical values (use exactly these, no others):
    "object--bench", "object--bike-rack", "object--fire-hydrant",
    "object--mailbox", "object--manhole", "object--phone-booth",
    "object--street-light", "object--trash-can", "object--traffic-cone",
    "object--parking-meter", "object--catch-basin",
    "marking--surface--cobblestone", "marking--surface--brick"

  Trees, buildings, and most natural features are NOT detected by Mapillary
  — emit empty array for those.

  Examples:
    "cobblestone alley with bike racks" -> ["marking--surface--cobblestone", "object--bike-rack"]
    "neon-lit diner with phone booth"   -> ["object--phone-booth"]
    "bench on a wooded path"            -> ["object--bench"]
    "abandoned brick warehouse"         -> []
    "old blue building with trees"      -> []

If the input is ambiguous or unsafe, still return a best-effort JSON object.
Never refuse and never explain.`;

// ---------------------------------------------------------------------------
// JSON extraction
//
// Even with a strict prompt, models sometimes wrap output in code fences,
// prepend a sentence, or add trailing commentary. This extractor is
// deliberately forgiving.
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;
const FIRST_OBJECT_RE = /\{[\s\S]*\}/;

export function extractJsonBlock(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();

  // 1) Try a fenced block first (```json ... ``` or ``` ... ```).
  const fenced = FENCE_RE.exec(trimmed);
  if (fenced && fenced[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{")) return candidate;
  }

  // 2) Otherwise greedy-match the first { ... } block.
  const obj = FIRST_OBJECT_RE.exec(trimmed);
  if (obj) return obj[0];

  // 3) Last resort: maybe the whole thing is bare JSON.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  return null;
}

export type ParseFailure = {
  reason: "no_json_found" | "invalid_json" | "schema_mismatch";
  raw: string;
  detail?: string;
};

export type ParseResult =
  | { ok: true; value: SceneAnalysis }
  | { ok: false; failure: ParseFailure };

/**
 * Pure function: take a Claude text response, return either a validated
 * SceneAnalysis or a structured failure. Used directly by the API route
 * and by unit tests.
 */
export function parseSceneAnalysis(rawText: string): ParseResult {
  const block = extractJsonBlock(rawText);
  if (!block) {
    return {
      ok: false,
      failure: { reason: "no_json_found", raw: rawText },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return {
      ok: false,
      failure: { reason: "invalid_json", raw: rawText, detail: String(err) },
    };
  }

  const result = sceneAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      failure: {
        reason: "schema_mismatch",
        raw: rawText,
        detail: result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    };
  }

  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// Anthropic client + scene analysis
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export type AnalyzeSceneInput = {
  sceneText: string;
  /**
   * Free-text location hint from the user. Can be a city, "City, State",
   * neighborhood, or full street address. Claude is told to canonicalize it
   * into a City, ST form for downstream geocoding.
   */
  location?: string;
};

export type AnalyzeSceneResult = {
  analysis: SceneAnalysis;
  modelUsed: string;
  attempts: 1 | 2;
};

const ANALYZE_TIMEOUT_MS = 30_000;

function buildUserMessage(input: AnalyzeSceneInput): string {
  const locHint = input.location
    ? `\n\nLocation hint (canonicalize to City, ST): ${input.location}`
    : "";
  return `Scene description:\n${input.sceneText.trim()}${locHint}`;
}

async function callClaude(
  userMessage: string,
  systemSuffix = "",
): Promise<string> {
  const client = getClient();
  const response = await client.messages.create(
    {
      model: CLAUDE_MODELS.parsing,
      max_tokens: 1024,
      system: SYSTEM_PROMPT + systemSuffix,
      messages: [{ role: "user", content: userMessage }],
    },
    { timeout: ANALYZE_TIMEOUT_MS },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text block");
  }
  return textBlock.text;
}

/**
 * Run the full scene-analysis pipeline against Claude.
 *
 * Strategy:
 *   1. First attempt with the standard prompt.
 *   2. If parsing fails, retry once with a strict reminder appended.
 *   3. If retry also fails, throw.
 *
 * The caller (the API route) is responsible for caching successful
 * results and rate-limiting incoming requests.
 */
export async function analyzeScene(
  input: AnalyzeSceneInput,
): Promise<AnalyzeSceneResult> {
  const userMessage = buildUserMessage(input);

  const first = await callClaude(userMessage);
  const firstParse = parseSceneAnalysis(first);
  if (firstParse.ok) {
    return {
      analysis: firstParse.value,
      modelUsed: CLAUDE_MODELS.parsing,
      attempts: 1,
    };
  }

  logger.warn("claude parse failed, retrying with stricter prompt", {
    reason: firstParse.failure.reason,
    detail: firstParse.failure.detail,
  });

  const second = await callClaude(
    userMessage,
    "\n\nIMPORTANT: Your previous response could not be parsed. " +
      "Return ONLY a valid JSON object that matches the schema exactly. " +
      "No code fences, no explanation, no trailing commentary.",
  );
  const secondParse = parseSceneAnalysis(second);
  if (secondParse.ok) {
    return {
      analysis: secondParse.value,
      modelUsed: CLAUDE_MODELS.parsing,
      attempts: 2,
    };
  }

  logger.error("claude parse failed after retry", {
    reason: secondParse.failure.reason,
    detail: secondParse.failure.detail,
  });
  throw new Error(
    `Claude returned an unparseable response (${secondParse.failure.reason}).`,
  );
}
