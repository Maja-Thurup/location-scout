/**
 * Mapillary `object_value` strings.
 *
 * Two taxonomies live here:
 *
 * 1. MAPILLARY_TAXONOMY — Points (general infrastructure / objects /
 *    markings). All entries are queryable via:
 *      GET /map_features?bbox=&object_values=…
 *    bboxSearchable: true on every row. Pulled from the Mapillary
 *    Points reference: https://www.mapillary.com/developer/api-documentation/points
 *
 * 2. MAPILLARY_SEGMENTATION — pixel-segmentation classes. These are
 *    NOT queryable via /map_features (Mapillary only stores them as
 *    per-image detections). Use them only via:
 *      GET /{image_id}/detections
 *    bboxSearchable: false on every row. The image-scan pipeline
 *    pulls images first, then checks each image's detections for the
 *    required segmentation classes.
 *
 * Why split? Mixing the two confuses the planner — querying
 * `nature--vegetation` against /map_features returns garbage; querying
 * `object--bench` per-image is wasted work. The retrieval plan picks
 * mode `bbox_objects` for Points and `image_scan` for segmentation.
 */

export type MapillaryTaxonEntry = {
  value: string;
  bboxSearchable: boolean;
};

/**
 * Mapillary Points — full list (one row per /map_features object_value
 * accepted by the API). Generic for any prompt; keep this list as the
 * single source of truth so Claude's prompt allowed-list and the
 * scene-to-classes mapper agree.
 */
export const MAPILLARY_TAXONOMY: ReadonlyArray<MapillaryTaxonEntry> = [
  // Street-level objects (general)
  { value: "object--bench", bboxSearchable: true },
  { value: "object--bike-rack", bboxSearchable: true },
  { value: "object--billboard", bboxSearchable: true },
  { value: "object--catch-basin", bboxSearchable: true },
  { value: "object--cctv-camera", bboxSearchable: true },
  { value: "object--fire-hydrant", bboxSearchable: true },
  { value: "object--junction-box", bboxSearchable: true },
  { value: "object--mailbox", bboxSearchable: true },
  { value: "object--manhole", bboxSearchable: true },
  { value: "object--parking-meter", bboxSearchable: true },
  { value: "object--phone-booth", bboxSearchable: true },
  { value: "object--street-light", bboxSearchable: true },
  { value: "object--trash-can", bboxSearchable: true },
  { value: "object--traffic-cone", bboxSearchable: true },
  { value: "object--water-valve", bboxSearchable: true },
  { value: "object--banner", bboxSearchable: true },
  // Signs (non-traffic — the "billboard / shop sign / info board" family)
  { value: "object--sign--advertisement", bboxSearchable: true },
  { value: "object--sign--information", bboxSearchable: true },
  { value: "object--sign--store", bboxSearchable: true },
  // Supports — pole shots
  { value: "object--support--pole", bboxSearchable: true },
  { value: "object--support--utility-pole", bboxSearchable: true },
  { value: "object--support--traffic-sign-frame", bboxSearchable: true },
  // Traffic lights (six canonical orientations)
  { value: "object--traffic-light--general-upright", bboxSearchable: true },
  { value: "object--traffic-light--general-horizontal", bboxSearchable: true },
  { value: "object--traffic-light--general-single", bboxSearchable: true },
  { value: "object--traffic-light--pedestrians", bboxSearchable: true },
  { value: "object--traffic-light--cyclists", bboxSearchable: true },
  { value: "object--traffic-light--other", bboxSearchable: true },
  // Pavement markings
  { value: "marking--surface--cobblestone", bboxSearchable: true },
  { value: "marking--surface--brick", bboxSearchable: true },
  { value: "marking--discrete--arrow--straight", bboxSearchable: true },
  { value: "marking--discrete--arrow--left", bboxSearchable: true },
  { value: "marking--discrete--arrow--right", bboxSearchable: true },
  { value: "marking--discrete--arrow--split-left-or-straight", bboxSearchable: true },
  { value: "marking--discrete--arrow--split-right-or-straight", bboxSearchable: true },
  { value: "marking--discrete--arrow--other", bboxSearchable: true },
  { value: "marking--discrete--crosswalk-zebra", bboxSearchable: true },
  { value: "marking--discrete--stop-line", bboxSearchable: true },
  { value: "marking--discrete--symbol--bicycle", bboxSearchable: true },
  { value: "marking--discrete--symbol--other", bboxSearchable: true },
  { value: "marking--discrete--text", bboxSearchable: true },
  { value: "marking--discrete--give-way-row", bboxSearchable: true },
  { value: "marking--discrete--give-way-single", bboxSearchable: true },
  // Construction (driveway / barriers / sidewalk / pedestrian area)
  { value: "construction--barrier--temporary", bboxSearchable: true },
  { value: "construction--flat--crosswalk-plain", bboxSearchable: true },
  { value: "construction--flat--driveway", bboxSearchable: true },
  { value: "construction--flat--pedestrian-area", bboxSearchable: true },
  { value: "construction--flat--sidewalk", bboxSearchable: true },
  { value: "construction--structure--bridge", bboxSearchable: true },
];

/**
 * Pixel-segmentation classes — for the per-image detections endpoint
 * only. NEVER queryable via /map_features (the API silently returns
 * empty for these). Used by the `image_scan` retrieval-plan mode and
 * by the per-photo background-verify step in enrich.
 */
export const MAPILLARY_SEGMENTATION: ReadonlyArray<MapillaryTaxonEntry> = [
  { value: "construction--structure--building", bboxSearchable: false },
  { value: "nature--mountain", bboxSearchable: false },
  { value: "nature--sand", bboxSearchable: false },
  { value: "nature--sky", bboxSearchable: false },
  { value: "nature--snow", bboxSearchable: false },
  { value: "nature--terrain", bboxSearchable: false },
  { value: "nature--vegetation", bboxSearchable: false },
  { value: "nature--water", bboxSearchable: false },
];

const TAXON_BY_VALUE = new Map<string, MapillaryTaxonEntry>();
for (const e of MAPILLARY_TAXONOMY) TAXON_BY_VALUE.set(e.value, e);
for (const e of MAPILLARY_SEGMENTATION) TAXON_BY_VALUE.set(e.value, e);

export function isBboxSearchableClass(value: string): boolean {
  const entry = TAXON_BY_VALUE.get(value);
  if (entry) return entry.bboxSearchable;
  // Unknown class — treat as bbox-searchable so callers can still
  // experiment with new object_values pulled from Claude.
  return true;
}

export function allTaxonValues(): string[] {
  return [
    ...MAPILLARY_TAXONOMY.map((e) => e.value),
    ...MAPILLARY_SEGMENTATION.map((e) => e.value),
  ];
}

/** Bbox-searchable values only (Points). */
export function bboxSearchableTaxonValues(): string[] {
  return MAPILLARY_TAXONOMY.map((e) => e.value);
}

/** Segmentation-only values (image-scan mode). */
export function segmentationTaxonValues(): string[] {
  return MAPILLARY_SEGMENTATION.map((e) => e.value);
}
