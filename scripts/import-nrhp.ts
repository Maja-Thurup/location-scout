/**
 * Import the National Register of Historic Places (NRHP) dataset.
 *
 * Source: NPS ArcGIS REST FeatureServer (the `nrhp_locations` MapServer
 * has a Points layer at index 0). Fetches all Points (~95k) in pages of
 * 1000.
 *
 * License: U.S. government work, public domain.
 *
 * Usage:    npx tsx scripts/import-nrhp.ts
 * Cron:     quarterly (the federal listing changes ~50 entries/month).
 *
 * Notes:
 *   - The GIS feed is intentionally minimal — just CR_ID, resource name,
 *     listing date, and coords. Architectural style / year built /
 *     materials live in the NRIS database, NOT this feed.
 *   - We tag NHL records via a separate import-nhl.ts pass (the NHL
 *     subset has a `Listing_Status = "NHL"` field on a sibling layer).
 */

import { config as loadEnv } from "dotenv";

import { bulkUpsertPlaces, deleteBySource, type PlaceRow } from "./import-shared";

loadEnv({ path: ".env.local" });
loadEnv();

const NRHP_LAYER =
  "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0/query";

const PAGE_SIZE = 1000;

type ArcGisFeature = {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
};

async function fetchPage(offset: number): Promise<ArcGisFeature[]> {
  const url = new URL(NRHP_LAYER);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326"); // WGS84 lat/lng
  url.searchParams.set("f", "json");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));

  const res = await fetch(url, {
    headers: { "User-Agent": "LocationScout-import/0.1" },
  });
  if (!res.ok) throw new Error(`NRHP page offset=${offset}: HTTP ${res.status}`);
  const json = (await res.json()) as { features?: ArcGisFeature[] };
  return json.features ?? [];
}

function attr(f: ArcGisFeature, key: string): string | null {
  const v = f.attributes[key];
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

async function main(): Promise<void> {
  let offset = 0;
  const all: ArcGisFeature[] = [];
  while (true) {
    const page = await fetchPage(offset);
    if (page.length === 0) break;
    all.push(...page);
    process.stdout.write(`\r[nrhp] fetched ${all.length} so far (offset ${offset})`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  console.log(`\n[nrhp] total fetched: ${all.length}`);

  const rows: PlaceRow[] = [];
  for (const f of all) {
    const x = f.geometry?.x;
    const y = f.geometry?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const refnum =
      attr(f, "REFNUM") ??
      attr(f, "ID") ??
      attr(f, "OBJECTID") ??
      attr(f, "CR_ID") ??
      `${x},${y}`;
    const name =
      attr(f, "RESNAME") ??
      attr(f, "ResourceName") ??
      attr(f, "FullName") ??
      "NRHP Property";

    const tags: Record<string, string> = {
      "nrhp:listed": "yes",
    };
    const certDate = attr(f, "CertDate");
    if (certDate) tags["nrhp:cert_date"] = certDate;
    const state = attr(f, "STATE") ?? attr(f, "State");
    if (state) tags["addr:state"] = state;

    rows.push({
      id: `nrhp:${refnum}`,
      source: "nrhp",
      name,
      description: null, // NRHP GIS feed has no descriptions
      lat: y as number,
      lng: x as number,
      tags,
      sourceUrl: `https://npgallery.nps.gov/AssetDetail/NRIS/${refnum}`,
      // Listed = vetted, but no NHL-level curation.
      popularityScore: 0.6,
    });
  }

  await deleteBySource("nrhp");
  console.log(`[nrhp] upserting ${rows.length} rows…`);
  await bulkUpsertPlaces(rows, "nrhp");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("import-nrhp failed:", err);
    process.exit(1);
  });
