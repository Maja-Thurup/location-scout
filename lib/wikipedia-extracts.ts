import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// MediaWiki Action API — direct extracts by Wikipedia article title.
//
// Endpoint:
//   https://en.wikipedia.org/w/api.php
//     ?action=query&prop=extracts&exintro&explaintext
//     &titles=A|B|C&format=json
//
// Use this AFTER you already know the enwiki sitelink title for an
// item (i.e. from Wikibase GraphQL `sitelinks` or from the Wikipedia
// geosearch fallback). Skips the geosearch round-trip when the
// upstream Q-id pool already has Wikipedia titles attached.
//
// Cached 7 days per title.
//
// Free, no API key. Polite User-Agent strongly recommended.
// License: CC BY-SA 4.0 — surface attribution alongside any extract
// rendered on a card.
// ---------------------------------------------------------------------------

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const TIMEOUT_MS = 12_000;
/**
 * MediaWiki caps `titles=` at 50 per request when used WITHOUT the
 * apihighlimits right (which we do not have without auth). We chunk
 * accordingly to avoid silent truncation.
 */
const MAX_TITLES_PER_BATCH = 50;

const responseSchema = z.object({
  query: z
    .object({
      pages: z
        .record(
          z.string(),
          z.object({
            pageid: z.number().optional(),
            title: z.string(),
            extract: z.string().optional(),
            missing: z.unknown().optional(),
          }),
        )
        .default({}),
      normalized: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .optional(),
      redirects: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .optional(),
    })
    .default({ pages: {} }),
});

export type WikipediaExtract = {
  title: string;
  extract: string;
};

function buildUrl(titles: ReadonlyArray<string>): URL {
  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", titles.join("|"));
  return url;
}

async function executeBatch(
  titles: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (titles.length === 0) return out;

  let raw: unknown;
  try {
    const res = await fetch(buildUrl(titles), {
      headers: {
        "User-Agent":
          "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("wikipedia extracts HTTP error", { status: res.status });
      return out;
    }
    raw = await res.json();
  } catch (err) {
    logger.warn("wikipedia extracts fetch failed", { err: String(err) });
    return out;
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("wikipedia extracts schema mismatch", {
      issue: parsed.error.issues[0]?.message,
    });
    return out;
  }

  // Build a from→to map so callers can look up by their original
  // sitelink title even after MediaWiki normalises (`%20` → space) or
  // resolves redirects.
  const aliases = new Map<string, string>();
  for (const n of parsed.data.query.normalized ?? []) {
    aliases.set(n.from, n.to);
  }
  for (const r of parsed.data.query.redirects ?? []) {
    aliases.set(r.from, r.to);
  }

  const extractByTitle = new Map<string, string>();
  for (const page of Object.values(parsed.data.query.pages)) {
    if (page.missing !== undefined) continue;
    if (!page.extract) continue;
    extractByTitle.set(page.title, page.extract);
  }

  for (const original of titles) {
    let canonical = original;
    while (aliases.has(canonical)) canonical = aliases.get(canonical)!;
    const extract = extractByTitle.get(canonical) ?? extractByTitle.get(original);
    if (extract) out.set(original, extract);
  }

  return out;
}

/**
 * Fetch lead-section extracts for a list of Wikipedia titles. Returns
 * a map keyed by the INPUT title (original, pre-normalisation) so
 * callers can correlate back to the sitelinks they passed.
 *
 * Cached 7 days per title.
 */
export async function fetchExtractsByTitles(
  titles: ReadonlyArray<string>,
): Promise<Map<string, WikipediaExtract>> {
  const out = new Map<string, WikipediaExtract>();
  const unique = Array.from(
    new Set(titles.map((t) => t.trim()).filter((t) => t.length > 0)),
  );
  if (unique.length === 0) return out;

  const missing: string[] = [];
  await Promise.all(
    unique.map(async (title) => {
      const k = cacheKey("wikipedia:geosearch", {
        kind: "extract-by-title-v1",
        title,
      });
      const cached = await cacheGet<string>(k);
      if (typeof cached === "string" && cached.length > 0) {
        out.set(title, { title, extract: cached });
      } else {
        missing.push(title);
      }
    }),
  );

  if (missing.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += MAX_TITLES_PER_BATCH) {
    batches.push(missing.slice(i, i + MAX_TITLES_PER_BATCH));
  }
  const settled = await Promise.allSettled(batches.map(executeBatch));
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const [title, extract] of r.value) {
      out.set(title, { title, extract });
      const k = cacheKey("wikipedia:geosearch", {
        kind: "extract-by-title-v1",
        title,
      });
      await cacheSet(k, "wikipedia:geosearch", extract, 7);
    }
  }

  return out;
}
