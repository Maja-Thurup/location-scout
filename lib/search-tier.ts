import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Search-tier policy. Two tiers:
//
//   FREE  — default for every search. Sub-second, sub-cent cost.
//           Pipeline: own-DB + Wikidata SPARQL + Wikipedia + NPS/RIDB/UNESCO
//           providers, RRF + IDF tag-overlap ranking, NO vision scoring,
//           NO Google Places searchText, NO Mapillary multi-shot. Skipped
//           candidates render with the curated thumbnail (Wikimedia /
//           NPS / UNESCO image) when available, OR the Mapillary closest
//           panorama as a free fallback.
//
//   DEEP  — explicit opt-in via "Run Deep Search" button. ~10-15s, ~$0.10
//           per search. Adds Google Places searchText as parallel
//           provider, Mapillary multi-shot, Claude Vision multi-shot
//           scoring with anti-tokens. Best-quality output.
//
// Quotas:
//   Free tier user  → 5 deep searches per calendar month, then paywalled.
//   Pro tier user   → unlimited deep searches ($9/mo via Stripe — Stripe
//                     wiring deferred to a separate commit).
// ---------------------------------------------------------------------------

export type SearchTier = "free" | "deep";

export const FREE_DEEP_CREDITS_PER_MONTH = 5;

export type DeepCreditCheck =
  | { ok: true; remaining: number; tier: "free" | "pro" }
  | {
      ok: false;
      reason: "no_credits";
      remaining: 0;
      tier: "free";
      resetAt: Date;
    };

/** First day of the next calendar month, used for the user's "resets at" copy. */
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Returns whether the user can run a deep search right now. For "pro"
 * subscribers, always ok; for "free", ok if at least one credit remains.
 */
export async function checkDeepCredit(userId: string): Promise<DeepCreditCheck> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      deepSearchCreditsRemaining: true,
      subscriptionTier: true,
    },
  });
  if (!user) {
    return { ok: false, reason: "no_credits", remaining: 0, tier: "free", resetAt: firstOfNextMonth() };
  }
  if (user.subscriptionTier === "pro") {
    return { ok: true, remaining: -1, tier: "pro" };
  }
  if (user.deepSearchCreditsRemaining > 0) {
    return {
      ok: true,
      remaining: user.deepSearchCreditsRemaining,
      tier: "free",
    };
  }
  return {
    ok: false,
    reason: "no_credits",
    remaining: 0,
    tier: "free",
    resetAt: firstOfNextMonth(),
  };
}

/**
 * Decrement a free-tier user's deep credits by 1. Pro users are no-op.
 * Idempotent in the sense that you should call this AFTER you've verified
 * the user has credits via checkDeepCredit; the decrement clamps at 0.
 */
export async function consumeDeepCredit(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionTier: true, deepSearchCreditsRemaining: true },
  });
  if (!user || user.subscriptionTier === "pro") return;
  if (user.deepSearchCreditsRemaining <= 0) return;
  await prisma.user.update({
    where: { id: userId },
    data: {
      deepSearchCreditsRemaining: { decrement: 1 },
    },
  });
}

/**
 * Reset all free-tier users' credits to FREE_DEEP_CREDITS_PER_MONTH. Run
 * by a Vercel cron at 00:01 UTC on the 1st of each month. Pro users are
 * untouched.
 */
export async function resetMonthlyCredits(): Promise<{ updated: number }> {
  const result = await prisma.user.updateMany({
    where: { subscriptionTier: "free" },
    data: {
      deepSearchCreditsRemaining: FREE_DEEP_CREDITS_PER_MONTH,
      lastCreditResetAt: new Date(),
    },
  });
  return { updated: result.count };
}
