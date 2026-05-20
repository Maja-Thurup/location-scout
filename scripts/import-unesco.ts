/**
 * Import UNESCO World Heritage Sites into the local Place table.
 *
 * Source: data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/exports/json
 * License: open (UNESCO publishes the dataset with no usage restrictions).
 *
 * Usage:
 *   npx tsx scripts/import-unesco.ts
 *
 * Cron: monthly (UNESCO's list grows by a few dozen sites per year).
 *
 * (c) 2026 Igor Kirko. All rights reserved.
 */

import { config as loadEnv } from "dotenv";

import { bulkUpsertPlaces, deleteBySource, type PlaceRow } from "./import-shared";

loadEnv({ path: ".env.local" });
loadEnv(); // fall back to .env

const UNESCO_BASE =
  "https://data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/records";
const PAGE_LIMIT = 100; // Opendatasoft v2.1 hard cap

type UnescoSite = {
  id_no?: string | number;
  uuid?: string;
  name_en?: string;
  short_description_en?: string;
  description_en?: string;
  category?: string;
  date_inscribed?: string | number;
  states_names?: string[];
  iso_codes?: string;
  region?: string;
  coordinates?: { lon?: number; lat?: number };
  main_image_url?: string;
  main_image_caption_en?: string;
};

async function fetchAll(): Promise<UnescoSite[]> {
  console.log(`[unesco] paging through ${UNESCO_BASE}…`);
  const all: UnescoSite[] = [];
  let offset = 0;
  while (true) {
    const url = `${UNESCO_BASE}?limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "LocationScout-import/0.1" },
    });
    if (!res.ok) throw new Error(`UNESCO HTTP ${res.status} (offset=${offset})`);
    const raw = (await res.json()) as {
      total_count?: number;
      results?: UnescoSite[];
    };
    const results = raw.results ?? [];
    if (results.length === 0) break;
    all.push(...results);
    process.stdout.write(`\r[unesco] fetched ${all.length} so far`);
    if (results.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  console.log(`\n[unesco] total fetched: ${all.length}`);
  return all;
}

function siteCoord(s: UnescoSite): { lat: number; lng: number } | null {
  if (s.coordinates?.lat != null && s.coordinates?.lon != null) {
    return { lat: s.coordinates.lat, lng: s.coordinates.lon };
  }
  return null;
}

async function main(): Promise<void> {
  const sites = await fetchAll();
  console.log(`[unesco] fetched ${sites.length} sites`);

  const rows: PlaceRow[] = [];
  for (const s of sites) {
    const coord = siteCoord(s);
    if (!coord) continue;
    const id = `unesco:${s.id_no ?? s.uuid ?? `${s.name_en}-${coord.lat}`}`;
    const description =
      s.short_description_en ??
      (s.description_en
        ? s.description_en.slice(0, 320).replace(/\s+/g, " ")
        : null);
    const tags: Record<string, string> = { "unesco:world_heritage": "yes" };
    if (s.category) tags["unesco:category"] = s.category;
    if (s.date_inscribed) tags["unesco:inscribed"] = String(s.date_inscribed);
    if (s.states_names && s.states_names.length > 0) {
      tags["unesco:state_party"] = s.states_names.join(", ");
    }
    if (s.iso_codes) tags["unesco:iso"] = s.iso_codes;
    if (s.region) tags["unesco:region"] = s.region;

    rows.push({
      id,
      source: "unesco",
      name: s.name_en ?? "Unnamed UNESCO site",
      description,
      lat: coord.lat,
      lng: coord.lng,
      tags,
      // UNESCO image URLs redirect to the actual asset; the URL is fine
      // to embed in <img> directly (302 follow).
      imageUrl: s.main_image_url ?? null,
      sourceUrl: `https://whc.unesco.org/en/list/${s.id_no ?? ""}`,
      // Every UNESCO entry is globally significant — top popularity score.
      popularityScore: 1.0,
    });
  }

  console.log(`[unesco] geocoded ${rows.length} rows; deleting stale entries…`);
  await deleteBySource("unesco");
  console.log(`[unesco] upserting ${rows.length} rows…`);
  await bulkUpsertPlaces(rows, "unesco");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("import-unesco failed:", err);
    process.exit(1);
  });
