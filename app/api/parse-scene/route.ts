import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { analyzeScene, type SceneAnalysis } from "@/lib/claude";
import { logger } from "@/lib/logger";
import { checkRateLimit, incrementUsage } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  sceneText: z.string().min(10, "Scene description is too short").max(20_000),
  city: z.string().min(2).max(120).optional(),
});

type ParseSceneResponse = {
  analysis: SceneAnalysis;
  cached: boolean;
  attempts: number;
  rateLimit: {
    used: number;
    limit: number;
    remaining: number;
    resetAt: string;
  };
};

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
  const { sceneText, city } = parsed.data;

  // 2) Cache lookup (cache hits do NOT consume the rate-limit quota).
  const key = cacheKey("claude:parse-scene", { sceneText, city: city ?? "" });
  const cached = await cacheGet<{ analysis: SceneAnalysis; attempts: number }>(key);

  if (cached) {
    const rl = await checkRateLimit(req.dbUserId, "parse_scene");
    logger.info("parse-scene cache hit", {
      userId: req.dbUserId,
      ms: Date.now() - t0,
      city,
    });
    const response: ParseSceneResponse = {
      analysis: cached.analysis,
      cached: true,
      attempts: cached.attempts,
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
    analysisResult = await analyzeScene({ sceneText, city });
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
    rateLimit: {
      used: post.used,
      limit: post.limit,
      remaining: post.remaining,
      resetAt: post.resetAt.toISOString(),
    },
  };
  return NextResponse.json(response, { status: 200 });
});
