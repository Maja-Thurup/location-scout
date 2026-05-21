import type { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Socrata Open Data API (SODA) client.
//
// Used by every Socrata-backed open-data portal: data.cityofnewyork.us,
// data.sfgov.org, data.cityofchicago.org, data.dc.gov, data.lacity.org,
// data.austintexas.gov, data.cityofboston.gov, ... — all share the same
// /resource/{dataset_id}.json endpoint and SoQL query language.
//
// Auth modes:
//   1. Anonymous (heavily rate-limited; many queries 403 without a token)
//   2. App Token via ?$$app_token=XXX or X-App-Token: header
//   3. Basic Auth with KeyId / KeySecret pair (lifts per-token rate limits
//      and unlocks private datasets)
//
// We prefer Basic Auth when both env vars are set; fall back to App Token
// when only the token is set; warn when neither is set (the query will
// usually still work for trivial requests).
//
// Docs:
//   - SoQL queries: https://dev.socrata.com/docs/queries/
//   - Endpoints:    https://dev.socrata.com/docs/endpoints.html
// ---------------------------------------------------------------------------

const SOCRATA_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)";

/**
 * Build the Authorization header pair for Socrata. Returns the empty
 * record when no auth env is set — the caller should rely on the
 * `?$$app_token=` query-string fallback in that case.
 */
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (env.SOCRATA_APP_TOKEN) {
    headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;
  }
  if (env.SOCRATA_APP_TOKEN && env.SOCRATA_APP_TOKEN_SECRET) {
    // Basic auth scheme — Socrata accepts the App Token as the
    // username and the Secret as the password.
    const cred = Buffer.from(
      `${env.SOCRATA_APP_TOKEN}:${env.SOCRATA_APP_TOKEN_SECRET}`,
    ).toString("base64");
    headers.Authorization = `Basic ${cred}`;
  }
  return headers;
}

export type SocrataDataset = {
  /** Hostname, e.g. "data.cityofnewyork.us" (no protocol). */
  domain: string;
  /** Dataset id, e.g. "yitu-d5am". */
  id: string;
};

export type SoqlOptions = {
  /** SoQL `$where` clause, e.g. "year > 2020 AND title='Pulp Fiction'". */
  where?: string;
  /** SoQL `$select` clause, e.g. "title, locations, release_year". */
  select?: string;
  /** SoQL `$order` clause. */
  order?: string;
  /** SoQL `$limit` clause. Default 200, hard cap 50_000. */
  limit?: number;
  /** SoQL `$offset` clause. */
  offset?: number;
  /** Free-text `$q` clause — runs over every text column. */
  q?: string;
};

/**
 * Run a SoQL query against a Socrata dataset and return parsed JSON.
 * Cached 14 days. Returns the empty array on auth or HTTP errors so
 * the caller can degrade gracefully.
 */
export async function soqlQuery<T>(
  dataset: SocrataDataset,
  schema: z.ZodType<T>,
  opts: SoqlOptions = {},
): Promise<T[]> {
  const cKey = cacheKey("socrata", { dataset, opts });
  const cached = await cacheGet<T[]>(cKey);
  if (cached) return cached;

  const url = new URL(`https://${dataset.domain}/resource/${dataset.id}.json`);
  if (opts.where) url.searchParams.set("$where", opts.where);
  if (opts.select) url.searchParams.set("$select", opts.select);
  if (opts.order) url.searchParams.set("$order", opts.order);
  if (opts.q) url.searchParams.set("$q", opts.q);
  url.searchParams.set("$limit", String(Math.min(opts.limit ?? 200, 50_000)));
  if (opts.offset) url.searchParams.set("$offset", String(opts.offset));
  // Public-API query-string fallback — works even when the bearer
  // header gets stripped by intermediate proxies.
  if (env.SOCRATA_APP_TOKEN) {
    url.searchParams.set("$$app_token", env.SOCRATA_APP_TOKEN);
  }

  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(),
      signal: AbortSignal.timeout(SOCRATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("socrata HTTP error", {
        status: res.status,
        domain: dataset.domain,
        dataset: dataset.id,
      });
      // Cache short-lived on error so we don't hammer.
      await cacheSet(cKey, "socrata", [], 1);
      return [];
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) {
      await cacheSet(cKey, "socrata", [], 1);
      return [];
    }
    const out: T[] = [];
    for (const row of raw) {
      const parsed = schema.safeParse(row);
      if (parsed.success) out.push(parsed.data);
    }
    await cacheSet(cKey, "socrata", out, 14);
    return out;
  } catch (err) {
    logger.warn("socrata fetch failed", {
      err: String(err),
      domain: dataset.domain,
      dataset: dataset.id,
    });
    return [];
  }
}

/**
 * Helper for the common "fetch all rows whose Point column lies in a
 * bbox" query. Most Socrata municipal datasets have at least one
 * geometry column (Location, Point, geom, ...) — pass its name and
 * we'll build the SoQL `within_box(...)` clause for you.
 *
 * Result rows include the geometry column verbatim — caller is
 * responsible for normalising it into lat/lng.
 */
export async function soqlBbox<T>(input: {
  dataset: SocrataDataset;
  geomColumn: string;
  bbox: { south: number; west: number; north: number; east: number };
  schema: z.ZodType<T>;
  extraWhere?: string;
  q?: string;
  limit?: number;
}): Promise<T[]> {
  // SoQL within_box: within_box(geom, north_lat, west_lng, south_lat, east_lng)
  const within = `within_box(${input.geomColumn}, ${input.bbox.north}, ${input.bbox.west}, ${input.bbox.south}, ${input.bbox.east})`;
  const where = input.extraWhere ? `${within} AND (${input.extraWhere})` : within;
  return soqlQuery(input.dataset, input.schema, {
    where,
    q: input.q,
    limit: input.limit ?? 500,
  });
}
