/**
 * Derive a human-readable description from OSM element tags.
 * Overpass returns tags only — there is no top-level description field.
 */

const DESCRIPTION_TAG_KEYS = [
  "description",
  "description:en",
  "note",
  "note:en",
  "memorial:text",
  "inscription",
  "inscription:en",
  "artist_name",
  "artist:wikidata",
] as const;

export function deriveOsmDescription(
  tags: Record<string, string>,
): string | null {
  for (const key of DESCRIPTION_TAG_KEYS) {
    const v = tags[key]?.trim();
    if (v) return v;
  }
  const wiki = tags.wikipedia ?? tags["wikipedia:en"];
  if (wiki?.trim()) {
    const article = wiki.includes(":") ? wiki.split(":").slice(1).join(":") : wiki;
    return `Wikipedia: ${article.trim()}`;
  }
  return null;
}

export function extractOsmWikidataQid(tags: Record<string, string>): string | null {
  const raw = tags.wikidata ?? tags["wikidata:qid"];
  if (!raw) return null;
  const qid = raw.trim().toUpperCase();
  return /^Q\d+$/.test(qid) ? qid : null;
}
