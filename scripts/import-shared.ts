/**
 * Shared bulk-import helpers used by the per-source scripts in this folder.
 *
 * Run with:  npx tsx scripts/import-<source>.ts
 *
 * Each per-source script implements one async function that returns
 * `Iterable<PlaceRow>` and hands it to `bulkUpsertPlaces`.
 *
 * (c) 2026 Igor Kirko. All rights reserved.
 */

import { prisma } from "@/lib/prisma";

export type PlaceRow = {
  id: string;
  source: string;
  name: string;
  description?: string | null;
  lat: number;
  lng: number;
  tags: Record<string, unknown>;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  popularityScore?: number;
};

/**
 * Insert/update a batch of Place rows. Uses Prisma `upsert` per record
 * because SQLite-style `ON CONFLICT DO UPDATE` requires `Prisma.$transaction`
 * + raw SQL when batched. Per-record upsert is slightly slower (50–100 rows
 * per second) but acceptable for the one-time-then-monthly imports we run.
 *
 * Supabase free-tier connection limit is 60. We process at concurrency 8
 * to stay well under it.
 */
export async function bulkUpsertPlaces(
  rows: ReadonlyArray<PlaceRow>,
  sourceLabel: string,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const concurrency = 8;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < rows.length) {
      const i = idx++;
      const row = rows[i]!;
      // Skip clearly bad rows.
      if (
        !Number.isFinite(row.lat) ||
        !Number.isFinite(row.lng) ||
        Math.abs(row.lat) > 90 ||
        Math.abs(row.lng) > 180 ||
        (row.lat === 0 && row.lng === 0) ||
        !row.name ||
        row.name.trim().length === 0
      ) {
        skipped++;
        continue;
      }

      const data = {
        source: row.source,
        name: row.name.trim(),
        description: row.description ?? null,
        lat: row.lat,
        lng: row.lng,
        tags: row.tags as never,
        imageUrl: row.imageUrl ?? null,
        sourceUrl: row.sourceUrl ?? null,
        popularityScore: row.popularityScore ?? 0,
      };

      try {
        const existing = await prisma.place.findUnique({ where: { id: row.id } });
        if (existing) {
          await prisma.place.update({ where: { id: row.id }, data });
          updated++;
        } else {
          await prisma.place.create({ data: { id: row.id, ...data } });
          inserted++;
        }
      } catch (err) {
        console.error(
          `[${sourceLabel}] upsert failed for ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
        skipped++;
      }

      if ((inserted + updated) % 250 === 0) {
        process.stdout.write(
          `\r[${sourceLabel}] progress: ${inserted + updated} / ${rows.length}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, worker),
  );
  console.log(
    `\n[${sourceLabel}] done — inserted ${inserted}, updated ${updated}, skipped ${skipped}`,
  );

  return { inserted, updated, skipped };
}

/**
 * Delete all rows in `Place` matching `source`. Used at the start of each
 * import script so a stale row doesn't linger after the source removes it.
 */
export async function deleteBySource(source: string): Promise<number> {
  const result = await prisma.place.deleteMany({ where: { source } });
  console.log(`[${source}] cleared ${result.count} stale rows`);
  return result.count;
}
