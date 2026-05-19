import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { CLAUDE_MODELS, extractJsonBlock } from "@/lib/claude";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Image-vs-scene scoring with Claude Haiku 4.5.
//
// Used to pick the "best matching" photo for a result card from among the
// available sources (Google Place Photo, Street View Static, Mapillary).
// The free tier is rate-limited at the API level; vision calls themselves
// are NOT charged against the user's daily parse_scene quota because
// they're tied to a search that already consumed quota.
//
// Cost target: Haiku 4.5 vision @ ~$0.001 per 800x800-ish image.
// ---------------------------------------------------------------------------

const VISION_TIMEOUT_MS = 20_000;
const VISION_CACHE_TTL_DAYS = 7;
/** Larger images cost more tokens. 1024 is the sweet spot for "is this a building?" */
const VISION_FETCH_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

const scoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().max(280),
});

export type VisionScore = z.infer<typeof scoreSchema>;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You are scoring filming-location photos for a video production scout.

Given a scene description (with optional discrete tokens AND anti-tokens for explicit cues) and a single photo, rate from 0-100 how well the photo matches the scene as a potential filming location.

Consider, in priority order:
- POSITIVE TOKENS in the brief (color, material, age, condition, setting, signature objects). Each token directly present in the photo adds confidence; each conspicuously absent token subtracts.
- ANTI-TOKENS (negative): if any anti-token is visibly present in the photo, the score MUST drop hard — the candidate cannot be a match. A photo of a brand-new high-rise apartment block is NEVER a match for "old blue building", regardless of any incidental blue paint.
- Building / subject TYPE (warehouse, diner, cathedral, house, barn, ...) — must match the scene's primary subject
- Materials (brick, glass, wood, concrete, stone, metal, ...)
- Color and condition (faded, weathered, peeling, freshly-painted)
- Setting / surroundings (urban / suburban / rural / wilderness / waterfront)
- Whether the photo actually SHOWS the subject (not just a road, sky, parked car, or unrelated foliage)
- How prominently the matching elements appear in the frame

Scoring rubric:
  90-100  most positive tokens visibly match + correct subject type + zero anti-tokens visible
  70-89   subject type matches; majority of positive tokens visible; no anti-tokens
  50-69   subject type matches but several positive tokens absent OR one mild anti-token visible
  30-49   subject loosely related (street near the right kind of building) OR anti-token present
  10-29   wrong subject type, OR multiple anti-tokens clearly visible
   0-9    completely unrelated, OR strong anti-token dominates the frame
           (e.g. asked for "old blue building", photo shows a glassy high-rise)

Anti-tokens are FATAL. A photo dominated by an anti-token must score <= 20, even
if it incidentally has a few positive tokens. Don't reward "blue paint somewhere
in the background" if the dominant subject contradicts the brief.

Return ONLY a JSON object: { "score": <integer 0-100>, "reason": "<one sentence — call out which key tokens hit or missed and which anti-tokens (if any) are visible>" }
No prose, no code fences, no explanation outside the JSON.`;

/**
 * Score a single image against a scene description.
 *
 * The image is fetched server-side and base64-encoded into the request,
 * which:
 *   1. Avoids leaking our Google API key in URLs we'd otherwise hand to
 *      Anthropic.
 *   2. Lets us follow redirects (Google Place Photos return 302s).
 *   3. Lets us reject huge / non-image payloads defensively.
 *
 * Returns null on any error so callers can fall back to source-priority
 * ordering rather than blowing up the whole search.
 *
 * `sceneTokens` (optional) is a list of short discrete words/phrases like
 * ["blue", "weathered", "rural", "trees"] that the model uses as the
 * primary checklist when scoring. Encourages tighter, more interpretable
 * scores than prose alone.
 *
 * `antiTokens` (optional) is the negative checklist — when any of these is
 * visibly present in the photo, the score is supposed to drop hard. Use
 * for the obvious lookalike traps (e.g. "modern", "high_rise", "townhouse"
 * for an "old blue building" prompt).
 */
export async function scoreImageMatch(args: {
  imageUrl: string;
  sceneDescription: string;
  sceneTokens?: ReadonlyArray<string>;
  antiTokens?: ReadonlyArray<string>;
}): Promise<VisionScore | null> {
  // Normalize tokens for cache stability: lowercase, deduped, sorted.
  const normTokens = Array.from(
    new Set((args.sceneTokens ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ).sort();
  const normAnti = Array.from(
    new Set((args.antiTokens ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ).sort();

  const cKey = cacheKey("claude:vision-score", {
    image: args.imageUrl,
    scene: args.sceneDescription.toLowerCase().trim(),
    tokens: normTokens,
    anti: normAnti,
  });
  const cached = await cacheGet<VisionScore>(cKey);
  if (cached) return cached;

  // Step 1: fetch the image bytes ourselves.
  let bytes: Uint8Array;
  let mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  try {
    const res = await fetch(args.imageUrl, {
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      logger.warn("vision: image fetch non-ok", {
        status: res.status,
        urlPreview: args.imageUrl.slice(0, 80),
      });
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    mediaType = pickMediaType(contentType);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > VISION_FETCH_MAX_BYTES) {
      logger.warn("vision: image too large", { bytes: buf.byteLength });
      return null;
    }
    bytes = new Uint8Array(buf);
  } catch (err) {
    logger.warn("vision: image fetch threw", {
      err: String(err),
      urlPreview: args.imageUrl.slice(0, 80),
    });
    return null;
  }

  // Step 2: base64 encode (Anthropic's vision input expects base64 strings).
  const base64 = bufferToBase64(bytes);

  // Step 3: ask Haiku.
  let raw: string;
  try {
    const response = await getClient().messages.create(
      {
        model: CLAUDE_MODELS.parsing, // Haiku 4.5
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64,
                },
              },
              {
                type: "text",
                text: buildVisionPrompt(args.sceneDescription, normTokens, normAnti),
              },
            ],
          },
        ],
      },
      { timeout: VISION_TIMEOUT_MS },
    );

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      logger.warn("vision: no text block in response");
      return null;
    }
    raw = textBlock.text;
  } catch (err) {
    logger.warn("vision: anthropic call threw", { err: String(err) });
    return null;
  }

  // Step 4: extract + validate JSON.
  const block = extractJsonBlock(raw);
  if (!block) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }

  const result = scoreSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn("vision: schema mismatch", { issue: result.error.issues[0]?.message });
    return null;
  }

  await cacheSet(cKey, "claude:vision-score", result.data, VISION_CACHE_TTL_DAYS);
  return result.data;
}

/**
 * Score multiple images against the same description in parallel, capped to
 * `concurrency` simultaneous in-flight requests.
 *
 * Returns one VisionScore per input (null where scoring failed). The output
 * order matches the input order.
 */
export async function scoreImagesParallel(args: {
  imageUrls: ReadonlyArray<string>;
  sceneDescription: string;
  sceneTokens?: ReadonlyArray<string>;
  antiTokens?: ReadonlyArray<string>;
  concurrency?: number;
}): Promise<Array<VisionScore | null>> {
  const concurrency = args.concurrency ?? 4;
  const out: Array<VisionScore | null> = new Array(args.imageUrls.length).fill(null);
  let idx = 0;

  async function worker(): Promise<void> {
    const i = idx++;
    if (i >= args.imageUrls.length) return;
    out[i] = await scoreImageMatch({
      imageUrl: args.imageUrls[i]!,
      sceneDescription: args.sceneDescription,
      sceneTokens: args.sceneTokens,
      antiTokens: args.antiTokens,
    });
    return worker();
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, args.imageUrls.length) }, worker),
  );
  return out;
}

/**
 * Multi-shot scoring: score several candidate photos for the same scene and
 * return ONLY the best-scoring one, plus its score.
 *
 * Used for the "blue building across the street" problem — the OSM centroid
 * coord might face the wrong way; by scoring 3-5 nearby Mapillary photos we
 * pick whichever shot actually frames the matching subject.
 *
 * Returns null when no input photo could be scored at all.
 */
export type BestPhotoMatch = {
  imageUrl: string;
  score: VisionScore;
  /** Index into the input `imageUrls` array. */
  sourceIndex: number;
};

export async function scoreBestPhotoMatch(args: {
  imageUrls: ReadonlyArray<string>;
  sceneDescription: string;
  sceneTokens?: ReadonlyArray<string>;
  antiTokens?: ReadonlyArray<string>;
  concurrency?: number;
}): Promise<BestPhotoMatch | null> {
  if (args.imageUrls.length === 0) return null;

  const scores = await scoreImagesParallel({
    imageUrls: args.imageUrls,
    sceneDescription: args.sceneDescription,
    sceneTokens: args.sceneTokens,
    antiTokens: args.antiTokens,
    concurrency: args.concurrency,
  });

  let best: BestPhotoMatch | null = null;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!s) continue;
    if (!best || s.score > best.score.score) {
      best = { imageUrl: args.imageUrls[i]!, score: s, sourceIndex: i };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildVisionPrompt(
  description: string,
  tokens: ReadonlyArray<string>,
  antiTokens: ReadonlyArray<string>,
): string {
  const sections: string[] = [];

  if (tokens.length > 0) {
    sections.push(
      "POSITIVE tokens (the explicit visual checklist — match these first):",
      tokens.map((t) => `  + ${t}`).join("\n"),
      "",
    );
  }

  if (antiTokens.length > 0) {
    sections.push(
      "ANTI-TOKENS (FATAL if visibly present — score must be <= 20):",
      antiTokens.map((t) => `  - ${t}`).join("\n"),
      "",
    );
  }

  sections.push("Scene description (prose):", description, "", "Return the JSON.");
  return sections.join("\n");
}

function pickMediaType(
  contentType: string,
): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const lower = contentType.toLowerCase();
  if (lower.includes("png")) return "image/png";
  if (lower.includes("webp")) return "image/webp";
  if (lower.includes("gif")) return "image/gif";
  return "image/jpeg";
}

function bufferToBase64(bytes: Uint8Array): string {
  // Node 18+ Buffer.from(Uint8Array) works; fall back to manual encoding
  // if for some reason Buffer is unavailable.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
