import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { analyzeScene, sceneAnalysisSchema, type SceneAnalysis } from "@/lib/claude";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, incrementUsage } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Allowed radii. `null` (or absent) means "use the location's natural area"
// (we'll fall back to the geocoded bbox in M3).
const ALLOWED_RADII = [5, 10, 25, 50, 100] as const;

const requestSchema = z.object({
  sceneText: z.string().min(10, "Scene description is too short").max(20_000),
  /** Free-text location: city, "neighborhood, state", or street address. */
  location: z.string().min(2).max(160).optional(),
  /** Search radius in miles, or null/absent to use the location's bbox. */
  radiusMiles: z
    .number()
    .int()
    .refine((v) => (ALLOWED_RADII as readonly number[]).includes(v), {
      message: `radiusMiles must be one of ${ALLOWED_RADII.join(", ")}`,
    })
    .nullable()
    .optional(),
});

type ParseSceneResponse = {
  analysis: SceneAnalysis;
  cached: boolean;
  attempts: number;
  echo: {
    location: string | null;
    radiusMiles: number | null;
  };
  rateLimit: {
    used: number;
    limit: number;
    remaining: number;
    resetAt: string;
  };
};

async function recordHistory(args: {
  userId: string;
  sceneText: string;
  location?: string;
  radiusMiles?: number | null;
  analysis: SceneAnalysis;
  fromCache: boolean;
}): Promise<void> {
  try {
    await prisma.searchHistory.create({
      data: {
        userId: args.userId,
        sceneText: args.sceneText,
        city: args.location ?? null,
        radiusMiles: args.radiusMiles ?? null,
        analysis: args.analysis as never,
        cached: args.fromCache,
      },
    });
  } catch (err) {
    logger.warn("history.write failed", {
      userId: args.userId,
      err: String(err),
    });
  }
}

export const POST = withAuth(async (req) => {
  const t0 = Date.now();

  // 1) Validate input.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const { sceneText, location, radiusMiles } = parsed.data;

  // 2) Cache lookup (cache hits do NOT consume the rate-limit quota).
  // Radius is part of the cache key so radius changes get a fresh analysis;
  // for now Claude doesn't use it, but future versions may.
  const key = cacheKey("claude:parse-scene", {
    sceneText,
    location: location ?? "",
    radiusMiles: radiusMiles ?? null,
  });
  const cached = await cacheGet<{ analysis: SceneAnalysis; attempts: number }>(key);

  if (cached) {
    // Defensively re-validate cached entries through the current schema so
    // newly-added optional fields (e.g. osm_tags_alternatives, scene_tokens,
    // location_kind) get their default values populated when reading old
    // cache entries written before those fields existed.
    const reparsed = sceneAnalysisSchema.safeParse(cached.analysis);
    const analysis: SceneAnalysis = reparsed.success ? reparsed.data : cached.analysis;

    const rl = await checkRateLimit(req.dbUserId, "parse_scene");
    await recordHistory({
      userId: req.dbUserId,
      sceneText,
      location,
      radiusMiles,
      analysis,
      fromCache: true,
    });
    logger.info("parse-scene cache hit", {
      userId: req.dbUserId,
      ms: Date.now() - t0,
      location,
      radiusMiles,
      reparsed: reparsed.success,
    });
    const response: ParseSceneResponse = {
      analysis,
      cached: true,
      attempts: cached.attempts,
      echo: { location: location ?? null, radiusMiles: radiusMiles ?? null },
      rateLimit: {
        used: rl.used,
        limit: rl.limit,
        remaining: rl.remaining,
        resetAt: rl.resetAt.toISOString(),
      },
    };
    return NextResponse.json(response, { status: 200 });
  }

  // 3) Cache miss → enforce rate limit before spending API tokens.
  const rl = await checkRateLimit(req.dbUserId, "parse_scene");
  if (!rl.ok) {
    logger.info("parse-scene rate limited", {
      userId: req.dbUserId,
      used: rl.used,
      limit: rl.limit,
    });
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Free tier limit reached (${rl.limit} scenes per day). Resets at ${rl.resetAt.toISOString()}.`,
        rateLimit: {
          used: rl.used,
          limit: rl.limit,
          remaining: rl.remaining,
          resetAt: rl.resetAt.toISOString(),
        },
      },
      { status: 429 },
    );
  }

  // 4) Call Claude.
  let analysisResult;
  try {
    analysisResult = await analyzeScene({ sceneText, location });
  } catch (err) {
    logger.error("parse-scene Claude call failed", {
      userId: req.dbUserId,
      err: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      {
        error: "upstream_failed",
        message: "Couldn't analyze the scene. Try again in a moment.",
      },
      { status: 502 },
    );
  }

  // 5) Cache the successful response (30-day TTL).
  await cacheSet(
    key,
    "claude:parse-scene",
    { analysis: analysisResult.analysis, attempts: analysisResult.attempts },
    30,
  );

  // 6) Charge the user (cache miss only).
  const post = await incrementUsage(req.dbUserId, "parse_scene");

  // 7) Record this search in the user's history.
  await recordHistory({
    userId: req.dbUserId,
    sceneText,
    location,
    radiusMiles,
    analysis: analysisResult.analysis,
    fromCache: false,
  });

  logger.info("parse-scene success", {
    userId: req.dbUserId,
    attempts: analysisResult.attempts,
    used: post.used,
    ms: Date.now() - t0,
  });

  const response: ParseSceneResponse = {
    analysis: analysisResult.analysis,
    cached: false,
    attempts: analysisResult.attempts,
    echo: { location: location ?? null, radiusMiles: radiusMiles ?? null },
    rateLimit: {
      used: post.used,
      limit: post.limit,
      remaining: post.remaining,
      resetAt: post.resetAt.toISOString(),
    },
  };
  return NextResponse.json(response, { status: 200 });
});
