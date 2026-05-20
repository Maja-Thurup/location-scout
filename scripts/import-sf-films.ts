/**
 * Import SF Film Locations dataset.
 *
 * Source: data.sfgov.org/resource/yitu-d5am.json (Socrata SODA)
 * License: PDDL Public Domain
 *
 * Usage:    npx tsx scripts/import-sf-films.ts
 * Cron:     monthly.
 */

import { config as loadEnv } from "dotenv";

import { bulkUpsertPlaces, deleteBySource, type PlaceRow } from "./import-shared";

loadEnv({ path: ".env.local" });
loadEnv();

const ENDPOINT =
  "https://data.sfgov.org/resource/yitu-d5am.json?$where=point IS NOT NULL&$limit=10000";

type SfRow = {
  title?: string;
  release_year?: string | number;
  locations?: string;
  fun_facts?: string;
  director?: string;
  point?: { coordinates?: [number, number] };
  latitude?: string;
  longitude?: string;
  analysis_neighborhood?: string;
};

function clusterKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

async function main(): Promise<void> {
  console.log(`[sf-films] fetching ${ENDPOINT}…`);
  const res = await fetch(ENDPOINT, {
    headers: { "User-Agent": "LocationScout-import/0.1" },
  });
  if (!res.ok) throw new Error(`SF Films HTTP ${res.status}`);
  const raw = (await res.json()) as SfRow[];
  console.log(`[sf-films] fetched ${raw.length} rows`);

  // Group by ~10m proximity so one Place row carries all films at that
  // exact corner / building. Otherwise we'd insert dozens of duplicate
  // rows at popular SF film blocks.
  const clusters = new Map<
    string,
    {
      lat: number;
      lng: number;
      locationDesc: string | null;
      neighborhood: string | null;
      filmTitles: Set<string>;
      funFacts: Set<string>;
    }
  >();

  for (const r of raw) {
    let lat: number | null = null;
    let lng: number | null = null;
    if (r.point?.coordinates) {
      [lng, lat] = r.point.coordinates;
    } else if (r.latitude && r.longitude) {
      lat = Number(r.latitude);
      lng = Number(r.longitude);
    }
    if (!Number.isFinite(lat ?? NaN) || !Number.isFinite(lng ?? NaN)) continue;

    const key = clusterKey(lat!, lng!);
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        lat: lat!,
        lng: lng!,
        locationDesc: r.locations ?? null,
        neighborhood: r.analysis_neighborhood ?? null,
        filmTitles: new Set(),
        funFacts: new Set(),
      };
      clusters.set(key, cluster);
    }
    if (r.title) cluster.filmTitles.add(r.title.trim());
    if (r.fun_facts) cluster.funFacts.add(r.fun_facts.trim());
  }

  const out: PlaceRow[] = [];
  for (const [key, c] of clusters) {
    const filmCount = c.filmTitles.size;
    const sceneTitle =
      c.locationDesc ??
      c.neighborhood ??
      `${filmCount} film${filmCount === 1 ? "" : "s"} shot here`;
    const description =
      Array.from(c.funFacts).slice(0, 2).join(" \u2014 ") || null;

    const tags: Record<string, string> = {
      "filming:source": "sf-film-locations",
      "filming:count": String(filmCount),
    };
    if (c.neighborhood) tags["addr:neighbourhood"] = c.neighborhood;

    out.push({
      id: `sf-films:${key}`,
      source: "sf-films",
      name: sceneTitle,
      description,
      lat: c.lat,
      lng: c.lng,
      tags,
      sourceUrl:
        "https://data.sfgov.org/Culture-and-Recreation/Film-Locations-in-San-Francisco/yitu-d5am",
      // Higher popularity for clusters with more films shot there.
      popularityScore: Math.min(1, 0.5 + 0.05 * filmCount),
    });
  }

  await deleteBySource("sf-films");
  console.log(`[sf-films] upserting ${out.length} clusters…`);
  await bulkUpsertPlaces(out, "sf-films");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("import-sf-films failed:", err);
    process.exit(1);
  });
