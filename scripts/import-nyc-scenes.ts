/**
 * Import NYC "Scenes from the City" curated film locations.
 *
 * Source: data.cityofnewyork.us/resource/qb3k-n8mm.json (Socrata SODA)
 * License: Public domain (NYC Open Data)
 *
 * Usage:    npx tsx scripts/import-nyc-scenes.ts
 * Cron:     monthly (dataset rarely updates).
 */

import { config as loadEnv } from "dotenv";

import { bulkUpsertPlaces, deleteBySource, type PlaceRow } from "./import-shared";

loadEnv({ path: ".env.local" });
loadEnv();

const ENDPOINT = "https://data.cityofnewyork.us/resource/qb3k-n8mm.json?$limit=2000";

type SceneRow = {
  title?: string;
  movie?: string;
  year?: string | number;
  director?: string;
  location?: {
    coordinates?: [number, number];
    latitude?: string;
    longitude?: string;
  };
  address?: string;
  notes?: string;
  description?: string;
  scene_number?: string | number;
};

async function main(): Promise<void> {
  console.log(`[nyc-scenes] fetching ${ENDPOINT}…`);
  const res = await fetch(ENDPOINT, {
    headers: { "User-Agent": "LocationScout-import/0.1" },
  });
  if (!res.ok) throw new Error(`NYC Scenes HTTP ${res.status}`);
  const raw = (await res.json()) as SceneRow[];
  console.log(`[nyc-scenes] fetched ${raw.length} rows`);

  const out: PlaceRow[] = [];
  raw.forEach((r, idx) => {
    let coord: { lat: number; lng: number } | null = null;
    if (r.location?.coordinates) {
      const [lng, lat] = r.location.coordinates;
      coord = { lat, lng };
    } else if (r.location?.latitude && r.location?.longitude) {
      const lat = Number(r.location.latitude);
      const lng = Number(r.location.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) coord = { lat, lng };
    }
    if (!coord) return;

    const filmTitle = (r.movie ?? r.title ?? `Scene ${idx + 1}`).trim();
    const sceneTitle = r.title ?? filmTitle;
    const yearNum = r.year != null ? Number(r.year) : null;
    const description = r.description ?? r.notes ?? r.address ?? null;

    const tags: Record<string, string> = {
      "filming:source": "nyc-scenes-from-the-city",
    };
    if (r.address) tags["addr:full"] = r.address;
    if (yearNum && Number.isFinite(yearNum)) tags["filming:year"] = String(yearNum);

    const id = `nyc-scenes:${r.scene_number ?? `${idx}-${filmTitle.slice(0, 16)}`}`;

    out.push({
      id,
      source: "nyc-scenes",
      name: sceneTitle,
      description,
      lat: coord.lat,
      lng: coord.lng,
      tags,
      sourceUrl:
        "https://data.cityofnewyork.us/Business/Filming-Locations-Scenes-from-the-City-/qb3k-n8mm",
      popularityScore: 0.85,
    });
  });

  await deleteBySource("nyc-scenes");
  console.log(`[nyc-scenes] upserting ${out.length} rows…`);
  await bulkUpsertPlaces(out, "nyc-scenes");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("import-nyc-scenes failed:", err);
    process.exit(1);
  });
