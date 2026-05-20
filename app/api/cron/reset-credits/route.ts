import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { resetMonthlyCredits } from "@/lib/search-tier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Monthly cron: reset every free-tier user's Deep Search credit balance to
// the per-month allowance. Triggered by Vercel Cron (see vercel.json).
//
// Auth: Vercel Cron requests carry an `Authorization: Bearer <CRON_SECRET>`
// header. We verify it matches process.env.CRON_SECRET before acting.
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await resetMonthlyCredits();
    logger.info("cron reset-credits ok", { updated: result.updated });
    return NextResponse.json({ ok: true, updated: result.updated });
  } catch (err) {
    logger.error("cron reset-credits failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "reset_failed", message: String(err) },
      { status: 500 },
    );
  }
}
