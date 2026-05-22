/**
 * Derive a human-readable description from OSM element tags.
 * Overpass returns tags only — there is no top-level description field.
 *
 * Source keys are organised by signal:
 *   - prose keys (`description`, `note`, `memorial:text`, `inscription`):
 *     the longest hit becomes the description.
 *   - subject / type / era keys: appended to the prose so the
 *     ranking-blob match can also see them. Generic for ANY prompt —
 *     the same pull-through covers "horse statue", "MLK memorial",
 *     "art deco diner", "Roman amphitheater". No subject hardcoding.
 */

const PROSE_KEYS = [
  "description",
  "description:en",
  "note",
  "note:en",
  "memorial:text",
  "memorial:text:en",
  "inscription",
  "inscription:en",
  "artist_name",
] as const;

/**
 * Subject / type / era / name family.
 *
 * These are present on hundreds of thousands of OSM features regardless
 * of subject:
 *   - artwork_subject / subject — free-text subject (animal, person,
 *     event, abstract concept). taginfo lists 30k+ features.
 *   - artwork_type — statue / mural / installation / bust / relief.
 *   - statue — equestrian / bust / figure / relief.
 *   - memorial — statue / plaque / cross / monument / obelisk / stone.
 *   - historic:civilization — roman / greek / aztec / etc.
 *   - building:architecture — art_deco / brutalist / gothic / etc.
 *   - start_date / end_date — formatted "since YYYY" / "to YYYY".
 *   - alt_name / loc_name / was:name / official_name — alternate /
 *     historical / local / multi-language names. Crucial for foreign
 *     candidates where the official name is e.g. Cyrillic but the
 *     alt_name is in English.
 *
 * Why this lives in the description blob: the ranking step
 * (lib/providers/tag-overlap.ts) reads `description` straight into its
 * candidate text. Surfacing these keys here makes them visible to the
 * tag-overlap matcher without changing scoring logic.
 */
const SUBJECT_KEYS = [
  "subject",
  "subject:en",
  "artwork_subject",
  "artwork_type",
  "statue",
  "memorial",
  "historic:civilization",
  "building:architecture",
] as const;

const NAME_KEYS = [
  "alt_name",
  "alt_name:en",
  "loc_name",
  "was:name",
  "old_name",
  "official_name",
] as const;

function formatStartDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^[+-]?(\d{3,4})/);
  return m ? `since ${m[1]}` : null;
}

function formatEndDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^[+-]?(\d{3,4})/);
  return m ? `to ${m[1]}` : null;
}

export function deriveOsmDescription(
  tags: Record<string, string>,
): string | null {
  const parts: string[] = [];

  let prose: string | null = null;
  for (const key of PROSE_KEYS) {
    const v = tags[key]?.trim();
    if (v && (!prose || v.length > prose.length)) prose = v;
  }
  if (prose) parts.push(prose);

  for (const key of SUBJECT_KEYS) {
    const v = tags[key]?.trim();
    if (!v) continue;
    parts.push(`${key}=${v}`);
  }

  for (const key of NAME_KEYS) {
    const v = tags[key]?.trim();
    if (!v) continue;
    parts.push(v);
  }

  const since = formatStartDate(tags.start_date);
  if (since) parts.push(since);
  const ended = formatEndDate(tags.end_date);
  if (ended) parts.push(ended);

  if (parts.length === 0) {
    const wiki = tags.wikipedia ?? tags["wikipedia:en"];
    if (wiki?.trim()) {
      const article = wiki.includes(":") ? wiki.split(":").slice(1).join(":") : wiki;
      return `Wikipedia: ${article.trim()}`;
    }
    return null;
  }

  const wiki = tags.wikipedia ?? tags["wikipedia:en"];
  if (wiki?.trim()) {
    const article = wiki.includes(":") ? wiki.split(":").slice(1).join(":") : wiki;
    parts.push(`Wikipedia: ${article.trim()}`);
  }

  return parts.join(" \u2022 ");
}

export function extractOsmWikidataQid(tags: Record<string, string>): string | null {
  const raw = tags.wikidata ?? tags["wikidata:qid"];
  if (!raw) return null;
  const qid = raw.trim().toUpperCase();
  return /^Q\d+$/.test(qid) ? qid : null;
}

/**
 * Subject Q-id explicitly tagged on the feature (`subject:wikidata=Q…`).
 * Returned separate from the main `wikidata=Q…` so callers can use it as
 * a scoring boost without overwriting the feature's own Q-id.
 */
export function extractOsmSubjectWikidataQid(
  tags: Record<string, string>,
): string | null {
  const raw = tags["subject:wikidata"];
  if (!raw) return null;
  const qid = raw.trim().toUpperCase();
  return /^Q\d+$/.test(qid) ? qid : null;
}
