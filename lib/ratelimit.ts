import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Free-tier per-user, per-day quotas.
 *
 * Cache hits do NOT count against the quota — only fresh API calls (a
 * cache miss that triggered a real upstream request) increment the
 * counter. The caller decides when to call `incrementUsage`.
 */
export type RateLimitedAction =
  | "parse_scene"
  | "search_locations"
  | "vision_score";

const DEFAULT_LIMITS: Record<RateLimitedAction, number> = {
  parse_scene: 5,
  search_locations: 5,
  vision_score: 0, // Phase 2 only.
};

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  limit: number;
  used: number;
  resetAt: Date;
};

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nextUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/**
 * Read-only check of remaining quota. Does not mutate the counter.
 *
 * Use this BEFORE doing the expensive work, to short-circuit with 429.
 */
export async function checkRateLimit(
  userId: string,
  action: RateLimitedAction,
): Promise<RateLimitResult> {
  const limit = DEFAULT_LIMITS[action];
  const day = todayKey();
  const resetAt = nextUtcMidnight();

  try {
    const row = await prisma.usageLog.findUnique({
      where: { userId_action_day: { userId, action, day } },
      select: { count: true },
    });
    const used = row?.count ?? 0;
    return {
      ok: used < limit,
      remaining: Math.max(0, limit - used),
      limit,
      used,
      resetAt,
    };
  } catch (err) {
    // If the DB is unreachable, fail open (allow the request) but log it.
    // Better to occasionally over-serve than to lock everyone out.
    logger.warn("ratelimit.check failed (failing open)", {
      userId,
      action,
      err: String(err),
    });
    return { ok: true, remaining: limit, limit, used: 0, resetAt };
  }
}

/**
 * Atomically increment the usage counter for `(userId, action, today)`.
 *
 * Call this AFTER a successful upstream API call. Cache hits should
 * NOT call this.
 */
export async function incrementUsage(
  userId: string,
  action: RateLimitedAction,
): Promise<RateLimitResult> {
  const limit = DEFAULT_LIMITS[action];
  const day = todayKey();
  const resetAt = nextUtcMidnight();

  try {
    const row = await prisma.usageLog.upsert({
      where: { userId_action_day: { userId, action, day } },
      create: { userId, action, day, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    return {
      ok: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      limit,
      used: row.count,
      resetAt,
    };
  } catch (err) {
    logger.error("ratelimit.increment failed", {
      userId,
      action,
      err: String(err),
    });
    // Don't fail the request just because we couldn't track it.
    return { ok: true, remaining: limit, limit, used: 0, resetAt };
  }
}
