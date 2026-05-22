import { isBboxSearchableClass } from "@/lib/mapillary/taxonomy";

export type MapillaryClassPlan = {
  bboxClasses: string[];
  imageScanClasses: string[];
  unmatchedTokens: string[];
};

/** scene_token / visual cue → canonical Mapillary object_value. */
const TOKEN_TO_MAPILLARY: Record<string, string | string[]> = {
  bench: "object--bench",
  benches: "object--bench",
  "bike rack": "object--bike-rack",
  "bike-rack": "object--bike-rack",
  hydrant: "object--fire-hydrant",
  "fire hydrant": "object--fire-hydrant",
  mailbox: "object--mailbox",
  manhole: "object--manhole",
  "phone booth": "object--phone-booth",
  cobblestone: "marking--surface--cobblestone",
  brick: "marking--surface--cobblestone",
  crosswalk: "construction--flat--crosswalk-plain",
  sidewalk: "construction--flat--sidewalk",
  park: ["nature--vegetation", "construction--flat--pedestrian-area"],
  parkland: ["nature--vegetation", "construction--flat--pedestrian-area"],
  grass: "nature--vegetation",
  tree: "nature--vegetation",
  trees: "nature--vegetation",
  vegetation: "nature--vegetation",
  greenery: "nature--vegetation",
  building: "construction--structure--building",
  buildings: "construction--structure--building",
  facade: "construction--structure--building",
  bridge: "construction--structure--bridge",
  water: "nature--water",
  lake: "nature--water",
  pond: "nature--water",
  mountain: "nature--mountain",
  hill: "nature--mountain",
  streetlight: "object--street-light",
  "street light": "object--street-light",
  lamppost: "object--street-light",
  trash: "object--trash-can",
  "trash can": "object--trash-can",
};

/** Tokens with no Mapillary class — use OSM/Wikidata instead. */
const NON_MAPILLARY_TOKENS = new Set([
  "horse",
  "statue",
  "monument",
  "memorial",
  "sculpture",
  "equestrian",
  "artwork",
  "mural",
]);

function normalizeToken(t: string): string {
  return t.trim().toLowerCase();
}

function addClass(set: Set<string>, value: string): void {
  if (value && !NON_MAPILLARY_TOKENS.has(value)) set.add(value);
}

/**
 * Resolve scene inputs to Mapillary detection classes for dual pipeline.
 */
export function mapSceneToMapillary(input: {
  sceneTokens: ReadonlyArray<string>;
  mapillaryClasses?: ReadonlyArray<string>;
  locationKind?: string | null;
}): MapillaryClassPlan {
  const resolved = new Set<string>();
  const unmatched: string[] = [];

  for (const raw of input.mapillaryClasses ?? []) {
    const v = raw.trim();
    if (v) addClass(resolved, v);
  }

  for (const raw of input.sceneTokens) {
    const norm = normalizeToken(raw);
    if (!norm || norm.length < 3) continue;
    if (NON_MAPILLARY_TOKENS.has(norm)) {
      unmatched.push(norm);
      continue;
    }
    const mapped = TOKEN_TO_MAPILLARY[norm];
    if (mapped) {
      const list = Array.isArray(mapped) ? mapped : [mapped];
      for (const v of list) addClass(resolved, v);
    }
  }

  if (input.locationKind === "waterfront") {
    addClass(resolved, "nature--water");
  }

  const bboxClasses: string[] = [];
  const imageScanClasses: string[] = [];
  for (const v of resolved) {
    if (isBboxSearchableClass(v)) bboxClasses.push(v);
    else imageScanClasses.push(v);
  }

  return {
    bboxClasses: [...new Set(bboxClasses)],
    imageScanClasses: [...new Set(imageScanClasses)],
    unmatchedTokens: [...new Set(unmatched)],
  };
}
