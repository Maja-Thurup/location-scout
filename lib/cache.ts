import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Cache namespaces. Keep this list explicit so we can audit how the cache
 * is used across the codebase. Adding a new one is a one-line change.
 */
export type CacheNamespace =
  | "claude:parse-scene"
  | "claude:vision-score"
  | "geocode"
  | "overpass"
  | "google:place-details"
  | "google:place-photo"
  | "mapillary:image"
  | "routes:distance";

export type TTLDays = 1 | 7 | 14 | 30 | 90 | 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hash an arbitrary input into a stable cache key.
 *
 * We use SHA-256 hex (64 chars) so no value of any size collides with
 * typical UUIDs / cuids in other primary keys.
 */
export function cacheKey(namespace: CacheNamespace, input: unknown): string {
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  const hash = createHash("sha256").update(serialized).digest("hex");
  return `${namespace}:${hash}`;
}

/**
 * Look up a cached value. Returns `null` on miss or when the entry is
 * expired (we don't proactively delete expired rows here; a periodic job
 * or Postgres TTL extension can sweep them later).
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const row = await prisma.cache.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return row.value as T;
  } catch (err) {
    logger.warn("cache.get failed", { key, err: String(err) });
    return null;
  }
}

/**
 * Store a value in the cache with a TTL in days.
 *
 * Errors are swallowed (logged) so a cache write failure never crashes a
 * request. Cache is an optimization, not a source of truth.
 */
export async function cacheSet<T>(
  key: string,
  namespace: CacheNamespace,
  value: T,
  ttlDays: TTLDays,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlDays * DAY_MS);
  try {
    await prisma.cache.upsert({
      where: { key },
      create: { key, namespace, value: value as never, expiresAt },
      update: { value: value as never, expiresAt, namespace },
    });
  } catch (err) {
    logger.warn("cache.set failed", { key, err: String(err) });
  }
}

/**
 * Convenience wrapper: try cache, fall back to fetcher, write on miss.
 *
 * Returns the value plus a boolean indicating whether it was a cache hit
 * (useful for callers that want to skip a rate-limit increment on hit).
 */
export async function cacheOrFetch<T>(args: {
  key: string;
  namespace: CacheNamespace;
  ttlDays: TTLDays;
  fetcher: () => Promise<T>;
}): Promise<{ value: T; hit: boolean }> {
  const cached = await cacheGet<T>(args.key);
  if (cached !== null) {
    return { value: cached, hit: true };
  }
  const value = await args.fetcher();
  await cacheSet(args.key, args.namespace, value, args.ttlDays);
  return { value, hit: false };
}
