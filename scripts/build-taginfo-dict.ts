/**
 * Offline taginfo dictionary builder.
 *
 * Pulls a curated set of OSM key/values from taginfo and writes them
 * to `data/taginfo-dict.json`. The runtime imports that JSON to:
 *   - expand the user's subject keyword for retrieval (e.g. "horse"
 *     → ["horse", "equestrian", "stallion", "horseback", "rider"])
 *   - validate Claude's `osm_tags_alternatives` against real-world
 *     OSM key counts (drop tags with <100 uses globally)
 *   - seed the IDF weight table with descriptions from the OSM wiki
 *
 * Run manually whenever the dictionary needs refreshing:
 *   npm run build-taginfo-dict
 *
 * Free + no API key. Polite and rate-limited via the taginfo client.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  fetchAllKeys,
  fetchKeyCombinations,
  fetchKeyValues,
  fetchKeyDescription,
} from "../lib/taginfo";

/**
 * Keys whose VALUES we want as synonym candidates. These are the OSM
 * "category" keys whose value-space is the actual list of place
 * types / subjects / activities our users describe.
 *
 * Picked by hand based on which categories matter for film scouting:
 *   - tourism, historic, leisure, amenity: place types
 *   - artwork_subject, artwork_type: sculpture-specific subject space
 *   - building, building:use: structural categories
 *   - natural, water, waterway: outdoor categories
 *   - sport: activity-typed places
 *   - animal: livestock / wildlife (rare but useful for "horse barn")
 *   - landuse: land-use categories
 */
const SUBJECT_KEYS = [
  "tourism",
  "historic",
  "leisure",
  "amenity",
  "artwork_subject",
  "artwork_type",
  "building",
  "building:use",
  "natural",
  "water",
  "waterway",
  "sport",
  "animal",
  "landuse",
  "shop",
  "man_made",
  "memorial",
];

/**
 * For each subject key, also pull `key/combinations` to discover
 * neighbouring keys that often appear together. The neighbour list
 * is what powers "what other keys could match this prompt?" — e.g.
 * `tourism` co-occurs with `wikidata`, `name`, `artwork_type`,
 * `artwork_subject` (the subject-of-a-statue field).
 */
async function buildKeyCard(key: string) {
  const [values, combinations, description] = await Promise.all([
    fetchKeyValues({ key, limit: 100 }),
    fetchKeyCombinations({ key, limit: 30 }),
    fetchKeyDescription(key),
  ]);
  return {
    key,
    description: description ?? null,
    /** Top-100 values, count desc. */
    values: (values ?? []).map((v) => ({
      value: v.value,
      count: v.count,
      fraction: v.fraction,
      description: v.description ?? null,
    })),
    /** Top-30 co-occurring keys. */
    combinations: (combinations ?? []).map((c) => ({
      otherKey: c.other_key,
      count: c.together_count,
      fraction: c.from_fraction ?? 0,
    })),
  };
}

async function main() {
  console.log(`[taginfo-dict] building dictionary for ${SUBJECT_KEYS.length} keys...`);
  const start = Date.now();

  // Top 1000 most-used keys. Used by the Claude validator (drop
  // alternatives that aren't in this set — they'll never hit Overpass).
  const allKeys = await fetchAllKeys({ page: 1, perPage: 1000 });
  const popularKeys = (allKeys ?? []).map((k) => ({
    key: k.key,
    count: k.count_all,
  }));

  // Subject-key cards (values + combinations + descriptions).
  const cards: Awaited<ReturnType<typeof buildKeyCard>>[] = [];
  for (const key of SUBJECT_KEYS) {
    process.stdout.write(`[taginfo-dict] ${key}... `);
    try {
      const card = await buildKeyCard(key);
      cards.push(card);
      console.log(`${card.values.length} values, ${card.combinations.length} combos`);
    } catch (err) {
      console.warn(
        `[taginfo-dict] ${key} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const dict = {
    builtAt: new Date().toISOString(),
    source: "https://taginfo.openstreetmap.org/api/4",
    popularKeys,
    cards,
  };

  const outPath = path.join(process.cwd(), "data", "taginfo-dict.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(dict, null, 2), "utf8");

  const ms = Date.now() - start;
  console.log(
    `[taginfo-dict] wrote ${outPath} (${cards.length} cards, ${popularKeys.length} popular keys, ${ms}ms)`,
  );
}

main().catch((err) => {
  console.error("[taginfo-dict] fatal:", err);
  process.exit(1);
});
