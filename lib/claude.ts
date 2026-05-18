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

export const sceneAnalysisSchema = z.object({
  /** OSM tag map, e.g. { building: "warehouse", "building:material": "brick" }. */
  osm_tags: z.record(z.string(), z.string()),

  /** Free-text Google Places search query. */
  google_query: z.string().min(1),

  /** Google Places API "types" filter (e.g. ["storage", "warehouse"]). */
  google_types: z.array(z.string()),

  /** Canonical city, "City, ST" preferred. */
  city: z.string().min(1),

  /** Visual descriptor, used later for Claude Vision re-ranking. */
  visual: z.string().min(1),

  /** Optional mood tag (gritty, romantic, noir, ...). */
  mood: z.string().nullable(),

  /** Optional time-of-day tag (day, night, dusk, dawn). */
  time_of_day: z.string().nullable(),

  /** Optional interior/exterior/both. */
  interior_exterior: interiorExteriorSchema.nullable(),
});

export type SceneAnalysis = z.infer<typeof sceneAnalysisSchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a location-scouting assistant for video production.

Given a scene description (or short script excerpt) and an optional city, extract structured filming requirements as JSON. Be concise and specific. Prefer real OSM tag keys and values that an OpenStreetMap query could match.

Return ONLY a single JSON object, no prose, no code fences. The schema is:

{
  "osm_tags": { "<osm_key>": "<value>" },
  "google_query": "string suitable for Google Places text search",
  "google_types": ["string", "..."],
  "city": "City, ST (United States)",
  "visual": "short visual descriptor for matching photos",
  "mood": "string or null",
  "time_of_day": "string or null",
  "interior_exterior": "interior" | "exterior" | "both" | null
}

Guidance for fields:

- osm_tags: pick the most diagnostic 1-4 tags. Common useful keys:
  building, building:material, building:colour, building:levels, abandoned,
  ruins, historic, amenity, landuse, natural, surface, leisure.
  Values must be lowercase, single-word OSM-canonical values
  ("brick" not "Bricks", "warehouse" not "old warehouse").
- google_query: a short text query a film scout would type, including the city.
- google_types: 0-3 strings from Google Places "types" enum
  (https://developers.google.com/maps/documentation/places/web-service/place-types).
  Examples: storage, warehouse, restaurant, cafe, bar, lodging,
  movie_theater, museum, library, church, park, parking. Empty array is fine.
- city: canonical "City, ST" form. If the user provided a city, normalize it
  (e.g. "brooklyn" -> "Brooklyn, NY"). If no city was given and the scene
  text implies one, use it; otherwise fall back to a sensible US city
  matching the mood (LA, NYC, Atlanta, ...).
- visual: 1-2 short phrases capturing what a candidate photo should show.
- mood: optional one-word vibe ("gritty", "romantic", "noir", ...).
- time_of_day: optional ("day", "night", "dawn", "dusk", "golden_hour").
- interior_exterior: pick one if obvious from the scene; null if unclear.

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
  city?: string;
};

export type AnalyzeSceneResult = {
  analysis: SceneAnalysis;
  modelUsed: string;
  attempts: 1 | 2;
};

const ANALYZE_TIMEOUT_MS = 30_000;

function buildUserMessage(input: AnalyzeSceneInput): string {
  const cityHint = input.city ? `\n\nCity hint (canonicalize): ${input.city}` : "";
  return `Scene description:\n${input.sceneText.trim()}${cityHint}`;
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
