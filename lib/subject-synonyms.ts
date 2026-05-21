// ---------------------------------------------------------------------------
// Subject synonym table — runtime expansion of user prompt nouns.
//
// Two layers:
//
//   1. HAND_CURATED below: a small, hand-tuned dictionary covering the
//      subjects film scouts commonly search for (horse, dog, lighthouse,
//      windmill, ...). Always available, no external dependency.
//
//   2. data/taginfo-dict.json: an OSM-grounded dictionary built offline
//      by `npm run build-taginfo-dict`. Picks up real synonyms from the
//      `artwork_subject`, `tourism`, `historic`, etc. keys. Loaded
//      lazily on first use; falls back gracefully when the file is
//      missing (e.g. fresh checkout).
//
// Usage from `app/api/search-osm/route.ts`:
//
//   const expanded = expandSubjectKeywords(["horse", "statue"]);
//   // expanded = ["horse", "equestrian", "stallion", "horseback", ...]
//
// The expansion is what powers the subject-name boost AND the subject-
// required filter without a Claude round-trip.
// ---------------------------------------------------------------------------

/**
 * Hand-curated subject synonyms. Each entry maps a single normalised
 * noun (the "subject") to its canonical synonym list. Entries are
 * deliberately scoped to subjects film scouts ask for — animal
 * subjects, structure types, civic subjects.
 *
 * We INCLUDE the subject itself in its synonym list so callers can
 * use the value directly without an extra union.
 */
const HAND_CURATED: Record<string, string[]> = {
  // Animals — frequent equestrian/lion/eagle statue subjects.
  horse: ["horse", "equestrian", "horseback", "stallion", "rider", "cavalry", "jockey"],
  dog: ["dog", "canine", "hound", "puppy"],
  cat: ["cat", "feline", "kitten"],
  lion: ["lion", "lioness", "leonine"],
  eagle: ["eagle", "raptor"],
  buffalo: ["buffalo", "bison"],
  bear: ["bear", "grizzly"],
  tiger: ["tiger", "tigress"],
  whale: ["whale", "cetacean", "leviathan"],
  elephant: ["elephant", "tusker"],
  cow: ["cow", "cattle", "bull", "bovine", "ox"],
  sheep: ["sheep", "lamb", "ram"],
  // Structure types — rarely-used words that strongly signal the subject.
  lighthouse: ["lighthouse", "beacon"],
  windmill: ["windmill", "mill"],
  watermill: ["watermill"],
  obelisk: ["obelisk", "monolith"],
  carousel: ["carousel", "merry-go-round"],
  pagoda: ["pagoda"],
  amphitheater: ["amphitheater", "amphitheatre", "arena"],
  bandstand: ["bandstand", "gazebo"],
  gazebo: ["gazebo", "bandstand", "pavilion"],
  pavilion: ["pavilion", "gazebo"],
  fountain: ["fountain", "spring"],
  pier: ["pier", "wharf", "jetty"],
  arch: ["arch", "archway", "gateway"],
  bridge: ["bridge", "viaduct"],
  tower: ["tower", "spire", "minaret"],
  church: ["church", "chapel", "cathedral", "basilica"],
  chapel: ["chapel", "church"],
  cathedral: ["cathedral", "church", "basilica"],
  mausoleum: ["mausoleum", "tomb", "crypt"],
  tomb: ["tomb", "mausoleum", "crypt", "sepulchre"],
  // Civic / political subjects.
  soldier: ["soldier", "warrior", "infantryman", "trooper"],
  president: ["president"],
  general: ["general"],
  king: ["king", "monarch"],
  queen: ["queen", "monarch"],
  // Industrial / decay.
  warehouse: ["warehouse", "depot", "storehouse"],
  factory: ["factory", "mill", "plant"],
  silo: ["silo"],
  smokestack: ["smokestack", "chimney"],
  // Outdoor.
  cliff: ["cliff", "bluff", "escarpment"],
  cave: ["cave", "cavern", "grotto"],
  waterfall: ["waterfall", "cascade", "cataract"],
  glacier: ["glacier"],
};

let dictCache: ReadonlyMap<string, string[]> | null = null;
let dictLoadAttempted = false;

/**
 * Load the offline taginfo dictionary lazily. Synchronous to keep the
 * runtime API simple; relies on Node's `require` cache so the
 * `data/taginfo-dict.json` blob loads once per process.
 *
 * Intentionally returns an empty Map when the file is missing — the
 * hand-curated table is enough to function. The build step generates
 * a richer dictionary with `npm run build-taginfo-dict`.
 */
function loadTaginfoDict(): ReadonlyMap<string, string[]> {
  if (dictCache) return dictCache;
  if (dictLoadAttempted) return dictCache ?? new Map();
  dictLoadAttempted = true;
  try {
    // Synchronous require — the file is small (<1 MB) and we'd block
    // on the first request anyway. Wrapped in eval to avoid bundlers
    // trying to inline-import a JSON file that might not exist on
    // first checkout.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../data/taginfo-dict.json") as {
      cards?: Array<{
        key: string;
        values?: Array<{ value: string }>;
        combinations?: Array<{ otherKey: string }>;
      }>;
    };
    const built = new Map<string, string[]>();
    for (const card of mod.cards ?? []) {
      const values = (card.values ?? []).map((v) => v.value).filter(Boolean);
      // Index each VALUE → its sibling values + the key itself.
      // e.g. for `historic={memorial,monument,castle,church,...}`:
      //   memorial → [memorial, monument, castle, church, ..., historic]
      // The expansion is generous; downstream filters drop noise.
      for (const v of values) {
        const norm = v.toLowerCase();
        if (norm.length < 3) continue;
        const siblings = values
          .filter((s) => s !== v)
          .slice(0, 6)
          .map((s) => s.toLowerCase());
        const existing = built.get(norm) ?? [];
        for (const s of [norm, ...siblings, card.key.toLowerCase()]) {
          if (!existing.includes(s)) existing.push(s);
        }
        built.set(norm, existing.slice(0, 8));
      }
    }
    dictCache = built;
    return built;
  } catch {
    // No dictionary file — that's fine, fall back to HAND_CURATED.
    return new Map();
  }
}

/**
 * Expand a list of user-supplied tokens with their known synonyms.
 * Drops anything that isn't a useful subject (we keep generic tokens
 * like "park" and "statue" out of the expansion — those don't
 * discriminate places).
 *
 * Returns a deduped, lowercased array of expanded synonyms.
 */
export function expandSubjectKeywords(
  tokens: ReadonlyArray<string>,
  opts: { maxExpansionsPerToken?: number } = {},
): string[] {
  const max = opts.maxExpansionsPerToken ?? 6;
  const dict = loadTaginfoDict();
  const out: string[] = [];
  const seen = new Set<string>();

  function pushExpansion(value: string): void {
    const norm = value.trim().toLowerCase();
    if (!norm || norm.length < 3) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  }

  for (const token of tokens) {
    const norm = token.trim().toLowerCase();
    if (!norm) continue;
    pushExpansion(norm);
    const handCurated = HAND_CURATED[norm];
    if (handCurated) {
      for (const s of handCurated.slice(0, max)) pushExpansion(s);
    }
    const taginfo = dict.get(norm);
    if (taginfo) {
      for (const s of taginfo.slice(0, max)) pushExpansion(s);
    }
  }
  return out;
}

/**
 * Look up the synonym set for a single subject token without expanding
 * other tokens. Returns null when the token isn't in either dictionary.
 * Used by tag-overlap to recognise that a candidate's text containing
 * "equestrian" is a hit for the user's "horse" subject.
 */
export function synonymsFor(token: string): ReadonlyArray<string> | null {
  const norm = token.trim().toLowerCase();
  const handCurated = HAND_CURATED[norm];
  if (handCurated) return handCurated;
  const dict = loadTaginfoDict();
  const taginfo = dict.get(norm);
  return taginfo ?? null;
}

/**
 * Validate an OSM tag (key or key=value) against the popular-keys
 * list from taginfo. Returns true when the tag is widely-used enough
 * to expect Overpass results from. Used by the search route to drop
 * Claude's ill-formed alternatives before hitting Overpass — saves
 * round-trips and avoids zero-result alternatives polluting RRF.
 *
 * When the dictionary file is missing we return true (don't filter)
 * so behaviour matches the pre-taginfo era.
 */
export function isPopularOsmKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../data/taginfo-dict.json") as {
      popularKeys?: Array<{ key: string; count: number }>;
    };
    const popular = mod.popularKeys ?? [];
    if (popular.length === 0) return true;
    return popular.some((k) => k.key === key && k.count > 100);
  } catch {
    return true;
  }
}
