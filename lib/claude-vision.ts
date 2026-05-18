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

Given a scene description and a single photo, rate from 0-100 how well the photo matches the scene as a potential filming location.

Consider:
- Building TYPE (warehouse, diner, cathedral, ...) — must match the scene's building type
- Materials and construction (brick, glass, wood, concrete, ...)
- Visual mood and lighting
- Architectural era and style
- Whether the photo actually SHOWS a building or filming-relevant subject (not just a road, sky, parked car, or tree)
- How prominently the matching elements appear in the frame

Scoring rubric:
  90-100  exact match of building type + materials + mood
  70-89   building type matches; some details match
  50-69   building type matches but mood/era is off, or building is partially visible
  30-49   subject loosely related (e.g. street near a building of the right type)
  10-29   wrong building type but adjacent (e.g. asked for warehouse, photo shows nearby store)
   0-9    completely unrelated (street view of empty road, sky, parking lot)

Return ONLY a JSON object: { "score": <integer 0-100>, "reason": "<one sentence>" }
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
 */
export async function scoreImageMatch(args: {
  imageUrl: string;
  sceneDescription: string;
}): Promise<VisionScore | null> {
  const cKey = cacheKey("claude:vision-score", {
    image: args.imageUrl,
    scene: args.sceneDescription.toLowerCase().trim(),
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
                text: `Scene description:\n${args.sceneDescription}\n\nReturn the JSON.`,
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
    });
    return worker();
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, args.imageUrls.length) }, worker),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
