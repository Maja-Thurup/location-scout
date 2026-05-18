import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import { reverseGeocode, shortLabel } from "@/lib/geocode";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const POST = withAuth(async (req) => {
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
        issues: parsed.error.issues.map((i) => i.message),
      },
      { status: 400 },
    );
  }

  const result = await reverseGeocode(parsed.data.lat, parsed.data.lng);
  if (!result) {
    logger.info("reverse-geocode no result", parsed.data);
    return NextResponse.json(
      { error: "no_result" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    label: shortLabel(result),
    fullLabel: result.label,
    lat: result.lat,
    lng: result.lng,
    country: result.country,
    bbox: result.bbox,
  });
});
