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
   * Tokens extracted DIRECTLY from the user's prompt — distinct words and
   * useful sub-phrases the user actually wrote. NEVER inferred attributes
   * (no "bronze", "stone", "weathered" unless the user said so). NEVER
   * vague background nouns (no "trees" / "grass" unless the user said so).
   *
   * Both individual words AND multi-word phrases are valid; downstream
   * matching looks up each token's IDF weight and scores the candidate.
   *
   * Examples (note: NO inferred adjectives, NO Claude embellishment):
   *   "horse statue in a park"
   *     -> ["horse", "statue", "park", "horse statue", "horse in a park"]
   *   "abandoned brick warehouse, Brooklyn"
   *     -> ["abandoned", "brick", "warehouse", "abandoned warehouse",
   *         "brick warehouse"]
   *   "neon-lit diner with phone booth"
   *     -> ["neon", "diner", "phone booth", "neon diner"]
   *   "an old blue building outside of town with trees in the back"
   *     -> ["old", "blue", "building", "outside of town", "trees",
   *         "old blue building", "blue building"]
   *
   * The tokens drive both retrieval (per-source keyword queries) and
   * ranking (IDF-weighted tag-overlap against each candidate's name +
   * description + tags). Faithfulness to the user's wording is more
   * important than coverage — drop any tokens that aren't directly
   * derived from the prompt.
   */
  scene_tokens: z.array(z.string()).default([]),

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

  /**
   * Structured retrieval plan: which sources to run, Mapillary mode,
   * primary vs background concepts, and enrich strategy. Executed
   * deterministically in search-osm / enrich-locations.
   */
  retrieval_plan: z.record(z.string(), z.unknown()).optional(),
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
  "visual": "1-2 sentence visual descriptor (vision scorer ONLY)",
  "scene_tokens": ["tokens", "from", "the", "user's prompt"],
  "location_kind": "urban|suburban|rural|industrial|wilderness|waterfront|mixed" | null,
  "mood": "string or null",
  "time_of_day": "string or null",
  "interior_exterior": "interior" | "exterior" | "both" | null,
  "mapillary_classes": ["string", "..."],
  "retrieval_plan": { ... see retrieval_plan section below ... }
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

  SUBJECT-FAMILY ALTERNATIVES — when the prompt names a depicted/typed/
  historic noun (an animal, a person, a building style, an era, a
  faction…), in addition to the primary classifier emit Overpass arms
  on the SUBJECT key family below. These keys are present on hundreds
  of thousands of OSM features regardless of subject — generic for any
  prompt, no subject-specific code anywhere downstream.

  Subject keys (use the value derived from the user's prompt):
    "artwork_subject"        — free-text subject of public artwork.
                               Animal / person / event / abstract concept.
                               Example: "horse", "lion", "MLK", "Vietnam".
    "artwork_type"           — artwork subtype.
                               Example: "statue", "mural", "installation",
                               "bust", "relief", "graffiti".
    "statue"                 — statue subtype when prompt names a form.
                               Example: "equestrian", "bust", "figure",
                               "relief".
    "memorial"               — memorial subtype when prompt implies a
                               memorial. Example: "statue", "plaque",
                               "cross", "monument", "obelisk", "stone".
    "subject"                — open-text subject.
    "historic:civilization"  — era. Example: "roman", "greek", "aztec".
    "building:architecture"  — style. Example: "art_deco", "brutalist",
                               "gothic".

  Values may be regexes (pipe-separated alternates) — just like the
  "name" key. Matching is case-insensitive. Examples:

    Prompt mentions "horse" subject:
      { "artwork_subject": "horse|equestrian|cavalry|jockey|rider|knight" }

    Prompt names a person:
      { "artwork_subject": "martin luther king|mlk|king" }

    Prompt names a memorial form:
      { "memorial": "statue|memorial|monument|obelisk" }

    Prompt names an era:
      { "historic:civilization": "roman" }

    Prompt names a style:
      { "building:architecture": "art_deco|art deco" }

  Do NOT emit subject-family arms when the prompt has no specific noun
  (e.g. "an old building" — there's no subject; let the primary
  classifier handle it). Skip them rather than emitting weak/empty
  filters.

  NAME-KEYWORD ALTERNATIVES — when the prompt names a SPECIFIC subject
  whose match is more likely to be in the feature's NAME than its
  classifier tag (statues, monuments, lighthouses, windmills, named
  parks). Use the special key "name" with a regex of pipe-separated
  alternatives. The value is matched against the OSM "name" tag
  case-insensitively as a substring AND used downstream to boost any
  candidate whose name matches.

  CRITICAL RULES — read carefully:

  1. The name regex MUST contain ONLY synonyms of the user's SUBJECT.
     The "subject" is the THING the user is asking for: horse,
     lighthouse, windmill, carousel, fountain, etc.

  2. NEVER include the prompt's bare nouns "statue", "sculpture",
     "monument", "memorial", "artwork", "building" in the regex.
     Those are categories, not subjects. If you include them, the
     regex matches every "Statue of [X]" in the city — including
     Statue of Liberty for a HORSE prompt — and the downstream
     boost ranks unrelated entities at the top.

  3. NEVER use this alternative for GENERIC prompts ("a building
     in a park", "an old house") — there's no specific subject.
     Skip the name alternative entirely; tag-based filters handle
     these.

  Examples:

    Scene: "horse statue in a park" (subject = horse, form = statue)
    -> [
         { "tourism": "artwork" },
         { "historic": "memorial" },
         { "historic": "monument" },
         { "artwork_subject": "horse|equestrian|cavalry|jockey|rider|knight" },
         { "artwork_type": "statue|sculpture" },
         { "statue": "equestrian|figure" },
         { "memorial": "statue|monument" },
         { "name": "horse|equestrian|cavalry|jockey|rider|knight" },
         { "leisure": "park" }
       ]
    GOOD: subject-family arms emit the noun ("horse") on the OSM
          subject keys (artwork_subject / statue / memorial). The name
          regex stays subject-only — no "statue" trailing.
    BAD:  name regex with trailing "statue" — matches every "Statue
          of [X]" in the city, including non-horse statues.

    Scene: "old lighthouse on a cliff" (subject = lighthouse)
    -> [
         { "man_made": "lighthouse" },
         { "name": "lighthouse|light station|beacon" },
         { "natural": "cliff" }
       ]
    GOOD: regex = lighthouse synonyms.

    Scene: "dutch windmill in a field" (subject = windmill)
    -> [
         { "man_made": "windmill" },
         { "name": "windmill|mill" },
         { "landuse": "farmland" }
       ]

    Scene: "lion statue at a museum entrance" (subject = lion, form = statue)
    -> [
         { "tourism": "artwork" },
         { "historic": "monument" },
         { "artwork_subject": "lion|lions|leonine" },
         { "artwork_type": "statue|sculpture" },
         { "name": "lion|lions" },
         { "tourism": "museum" }
       ]

    Scene: "a carousel in a park" (subject = carousel)
    -> [
         { "tourism": "theme_park" },
         { "name": "carousel|merry-go-round" },
         { "leisure": "park" }
       ]

    Scene: "abandoned warehouse with broken windows" (NO specific
                                                      subject — the
                                                      subject IS
                                                      "warehouse"
                                                      which is
                                                      already an OSM
                                                      classifier)
    -> [
         { "building": "warehouse" },
         { "building": "industrial" },
         { "landuse": "industrial" },
         { "landuse": "brownfield" }
       ]
    No name alternative needed here — building=warehouse already
    handles it.

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
  Concrete and specific — colors, materials, era, framing. NOTE: this
  field is consumed ONLY by the vision scorer (deep-tier image
  ranking). It is NEVER used to derive scene_tokens for retrieval —
  see scene_tokens below.

- scene_tokens: tokens extracted DIRECTLY from the user's prompt.
  Distinct words AND useful sub-phrases the user wrote. CRITICAL RULES:
    1. NEVER invent attributes the user didn't say. If the prompt says
       "horse statue", DO NOT add "bronze" or "stone" — the user might
       want a wooden horse.
    2. NEVER add filler nouns describing the implied surroundings.
       "horse statue in a park" should NOT include "trees" or "grass"
       unless the user typed those words.
    3. ONLY pull from the user's wording (or trivial paraphrases like
       reordering words). Bigram/trigram phrases are OK when they appear
       in the prompt: "horse statue", "bronze statue", "old blue
       building" are valid; "weathered_paint" or "rural_setting" are
       NOT (unless the user said them).
    4. Faithfulness > coverage. 2 faithful tokens beat 10 inferred ones.
    5. Lowercase. Plain spaces between words for phrases (no underscores).

  Examples (notice the absence of inferred attributes):
    "horse statue in a park"
      -> ["horse", "statue", "park", "horse statue",
          "horse in a park"]
    "abandoned brick warehouse, Brooklyn"
      -> ["abandoned", "brick", "warehouse", "abandoned warehouse",
          "brick warehouse"]
    "neon-lit diner with phone booth"
      -> ["neon", "diner", "phone booth", "neon-lit diner"]
    "an old blue building outside of town with trees in the back"
      -> ["old", "blue", "building", "trees", "outside of town",
          "old blue building", "blue building"]
    "bench on a wooded path"
      -> ["bench", "wooded", "path", "wooded path", "bench on a path"]

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
  for objects / signs / markings the scene specifically calls out at
  street level. ONLY use the Points list below — these are the values
  /map_features accepts for bbox queries.

  Points (bbox-searchable; emit these for /map_features):
    Objects:           "object--bench", "object--bike-rack",
                       "object--billboard", "object--catch-basin",
                       "object--cctv-camera", "object--fire-hydrant",
                       "object--junction-box", "object--mailbox",
                       "object--manhole", "object--parking-meter",
                       "object--phone-booth", "object--street-light",
                       "object--trash-can", "object--traffic-cone",
                       "object--water-valve", "object--banner"
    Signs (non-traffic): "object--sign--advertisement",
                       "object--sign--information",
                       "object--sign--store"
    Supports / poles:  "object--support--pole",
                       "object--support--utility-pole",
                       "object--support--traffic-sign-frame"
    Traffic lights:    "object--traffic-light--general-upright",
                       "object--traffic-light--general-horizontal",
                       "object--traffic-light--general-single",
                       "object--traffic-light--pedestrians",
                       "object--traffic-light--cyclists",
                       "object--traffic-light--other"
    Pavement markings: "marking--surface--cobblestone",
                       "marking--surface--brick",
                       "marking--discrete--arrow--straight",
                       "marking--discrete--arrow--left",
                       "marking--discrete--arrow--right",
                       "marking--discrete--crosswalk-zebra",
                       "marking--discrete--stop-line",
                       "marking--discrete--symbol--bicycle",
                       "marking--discrete--text",
                       "marking--discrete--give-way-row",
                       "marking--discrete--give-way-single"
    Construction:      "construction--barrier--temporary",
                       "construction--flat--crosswalk-plain",
                       "construction--flat--driveway",
                       "construction--flat--pedestrian-area",
                       "construction--flat--sidewalk",
                       "construction--structure--bridge"

  Segmentation classes (NEVER emit for mapillary_classes — they are
  pixel-level, not bbox-queryable). These belong in the retrieval_plan
  background_concepts only:
    "construction--structure--building", "nature--mountain",
    "nature--sand", "nature--sky", "nature--snow", "nature--terrain",
    "nature--vegetation", "nature--water"

  Trees, buildings, mountains, water are NOT Points. They go into the
  retrieval_plan as background_concepts with verify_in mapillary_photo
  (which uses the per-image detections endpoint), never here.

  Examples:
    "cobblestone alley with bike racks" -> ["marking--surface--cobblestone", "object--bike-rack"]
    "neon-lit diner with phone booth"   -> ["object--phone-booth"]
    "bench on a wooded path"            -> ["object--bench"]
    "billboard above a sidewalk"        -> ["object--sign--advertisement", "construction--flat--sidewalk"]
    "abandoned brick warehouse"         -> []
    "old blue building with trees"      -> []
    "horse statue in a park"            -> []
    "mountain road at dusk"             -> []

- retrieval_plan: REQUIRED. Plans which data sources and Mapillary modes to use.
  Do NOT tune for one example — generalize from the user's prompt.

  {
    "primary_subject": {
      "type": "named_entity|osm_feature|street_object|landscape|interior|generic",
      "label": "short label",
      "osm_focus": true,
      "wikidata_focus": true
    },
    "enrich_strategy": "default|subject_then_mapillary_then_background|landscape_image_scan",
    "concepts": [
      { "id": "subject", "terms": ["..."], "role": "primary", "weight": 1.0, "verify_in": "none" },
      { "id": "setting", "terms": ["park"], "role": "setting", "weight": 0.25, "verify_in": "none" },
      { "id": "bg", "terms": ["trees"], "role": "background", "weight": 0.4, "verify_in": "mapillary_photo" }
    ],
    "dependencies": [{ "kind": "in_setting", "primary": "subject", "secondary": "setting" }],
    "sources": {
      "wikidata-landmark": { "enabled": true, "priority": 1.0 },
      "wikipedia-geosearch": { "enabled": true, "priority": 0.8 },
      "nps-places": { "enabled": false, "priority": 0, "reason": "optional short reason" },
      "ridb-recreation": { "enabled": false },
      "own-db": { "enabled": true, "priority": 0.8 }
    },
    "mapillary": {
      "mode": "none|point_images|bbox_objects|image_scan",
      "classes": [],
      "image_scan_required_classes": [],
      "min_classes_for_filter": 2,
      "use_for": ["attach_photos"],
      "not_for": ["find_subject"],
      "rationale": "one sentence"
    },
    "ranking": {
      "use_concept_weights": true,
      "tier_mapillary_with_background_first": false,
      "min_primary_overlap": 0.5
    }
  }

  Mapillary mode rules:
  - point_images: Find subject via OSM/Wikidata first; use Mapillary only to attach
    street photos at candidate coordinates. Use for statues, monuments, named artwork.
    Set use_for: ["attach_photos","background_verify"] when user wants trees/buildings
    IN THE BACKGROUND of the photo. NEVER use map_features to discover the subject.
  - bbox_objects: User names street-level objects (bench, hydrant, cobblestone) OR
    mapillary_classes non-empty. use_for may include find_subject.
  - image_scan: Scene needs pixel classes in the same frame (mountain + road, etc.).
    Fill image_scan_required_classes with canonical Mapillary values.
  - none: Mapillary adds no retrieval value (interiors, etc.).

  enrich_strategy:
  - subject_then_mapillary_then_background: monument/statue + optional background
    (trees, buildings behind). tier_mapillary_with_background_first: true.
  - landscape_image_scan: vista / road / mountain scenes.
  - default: everything else.

  Concept roles:
  - primary: what the filmmaker must find (statue, warehouse, diner).
  - setting: where it sits (park, plaza) — lower weight.
  - background: visual backdrop to verify IN PHOTOS (trees, buildings) — verify_in mapillary_photo.

  Examples:
  - "statue with trees behind it" -> enrich_strategy subject_then_mapillary_then_background,
    mapillary.mode point_images, background concept trees, tier_mapillary_with_background_first true.
  - "bench on cobblestone street" -> mapillary.mode bbox_objects, classes bench + cobblestone.
  - "mountain road at dusk" -> landscape_image_scan, image_scan mountain + road classes.

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
