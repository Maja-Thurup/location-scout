import { isBboxSearchableClass } from "@/lib/mapillary/taxonomy";

export type MapillaryClassPlan = {
  bboxClasses: string[];
  imageScanClasses: string[];
  unmatchedTokens: string[];
};

/**
 * scene_token / visual cue → canonical Mapillary `object_value`.
 *
 * Two families:
 *   - Points (bbox-searchable via /map_features): objects, signs,
 *     poles, traffic lights, pavement markings, construction.
 *   - Segmentation (image-scan only via /{id}/detections):
 *     vegetation / mountain / sand / sky / building.
 *
 * The keys are lowercased, space-separated user words. Match is exact
 * (not regex) — Claude or the planner emits the canonical token.
 */
const TOKEN_TO_MAPILLARY: Record<string, string | string[]> = {
  // Furniture / objects
  bench: "object--bench",
  benches: "object--bench",
  "bike rack": "object--bike-rack",
  "bike-rack": "object--bike-rack",
  hydrant: "object--fire-hydrant",
  "fire hydrant": "object--fire-hydrant",
  mailbox: "object--mailbox",
  manhole: "object--manhole",
  "phone booth": "object--phone-booth",
  trash: "object--trash-can",
  "trash can": "object--trash-can",
  bin: "object--trash-can",

  // Signs / billboards / banners (the "big sign" family)
  billboard: "object--sign--advertisement",
  "big sign": "object--sign--advertisement",
  hoarding: "object--sign--advertisement",
  advertisement: "object--sign--advertisement",
  "info sign": "object--sign--information",
  "information board": "object--sign--information",
  "info board": "object--sign--information",
  kiosk: "object--sign--information",
  storefront: "object--sign--store",
  "shop sign": "object--sign--store",
  "store sign": "object--sign--store",
  banner: "object--banner",

  // Poles / supports
  pole: "object--support--pole",
  "lamp post": "object--street-light",
  lamppost: "object--street-light",
  "street light": "object--street-light",
  streetlight: "object--street-light",
  "sign pole": "object--support--pole",
  "utility pole": "object--support--utility-pole",
  "telephone pole": "object--support--utility-pole",

  // Traffic lights
  "traffic light": "object--traffic-light--general-upright",
  "traffic signal": "object--traffic-light--general-upright",
  "stoplight": "object--traffic-light--general-upright",
  "crosswalk light": "object--traffic-light--pedestrians",
  "pedestrian signal": "object--traffic-light--pedestrians",

  // Pavement markings
  arrow: "marking--discrete--arrow--straight",
  "lane arrow": "marking--discrete--arrow--straight",
  crosswalk: "marking--discrete--crosswalk-zebra",
  zebra: "marking--discrete--crosswalk-zebra",
  "stop line": "marking--discrete--stop-line",
  cobblestone: "marking--surface--cobblestone",
  brick: "marking--surface--brick",

  // Construction
  driveway: "construction--flat--driveway",
  sidewalk: "construction--flat--sidewalk",
  "pedestrian area": "construction--flat--pedestrian-area",
  bridge: "construction--structure--bridge",
  barrier: "construction--barrier--temporary",
  cone: "object--traffic-cone",
  "traffic cone": "object--traffic-cone",
  "parking meter": "object--parking-meter",
  cctv: "object--cctv-camera",
  camera: "object--cctv-camera",

  // Segmentation-only (image-scan mode) — these are NOT bbox-searchable.
  park: ["nature--vegetation", "construction--flat--pedestrian-area"],
  parkland: ["nature--vegetation", "construction--flat--pedestrian-area"],
  grass: "nature--vegetation",
  tree: "nature--vegetation",
  trees: "nature--vegetation",
  vegetation: "nature--vegetation",
  greenery: "nature--vegetation",
  wooded: "nature--vegetation",
  forest: "nature--vegetation",
  building: "construction--structure--building",
  buildings: "construction--structure--building",
  facade: "construction--structure--building",
  skyline: "construction--structure--building",
  water: "nature--water",
  lake: "nature--water",
  pond: "nature--water",
  river: "nature--water",
  ocean: "nature--water",
  sea: "nature--water",
  mountain: "nature--mountain",
  mountains: "nature--mountain",
  hill: "nature--mountain",
  alps: "nature--mountain",
  ridge: "nature--mountain",
  sand: "nature--sand",
  beach: "nature--sand",
  sky: "nature--sky",
  snow: "nature--snow",
  terrain: "nature--terrain",
};

/**
 * Tokens that have NO Mapillary class — semantic subjects (statue,
 * monument, animal nouns) are discoverable via OSM/Wikidata, never
 * via /map_features. Listed here so the planner can route them to the
 * subject-discovery path instead of trying to fetch detections.
 */
const NON_MAPILLARY_TOKENS = new Set([
  "horse",
  "dog",
  "cat",
  "lion",
  "eagle",
  "buffalo",
  "bear",
  "tiger",
  "whale",
  "elephant",
  "statue",
  "monument",
  "memorial",
  "sculpture",
  "equestrian",
  "artwork",
  "mural",
  "obelisk",
  "carousel",
  "lighthouse",
  "windmill",
  "watermill",
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
