/**
 * Mapillary detection `object_value` strings from:
 * https://www.mapillary.com/developer/api-documentation/detections
 *
 * `bboxSearchable`: can use GET /map_features?bbox=&object_values=
 * When false, use image-first pipeline (/images bbox → /{id}/detections).
 */

export type MapillaryTaxonEntry = {
  value: string;
  bboxSearchable: boolean;
};

/** Curated subset used for scene-token matching (full table has 120+ rows). */
export const MAPILLARY_TAXONOMY: ReadonlyArray<MapillaryTaxonEntry> = [
  { value: "object--bench", bboxSearchable: true },
  { value: "object--bike-rack", bboxSearchable: true },
  { value: "object--fire-hydrant", bboxSearchable: true },
  { value: "object--mailbox", bboxSearchable: true },
  { value: "object--manhole", bboxSearchable: true },
  { value: "object--phone-booth", bboxSearchable: true },
  { value: "object--street-light", bboxSearchable: true },
  { value: "object--trash-can", bboxSearchable: true },
  { value: "object--traffic-cone", bboxSearchable: true },
  { value: "object--parking-meter", bboxSearchable: true },
  { value: "object--catch-basin", bboxSearchable: true },
  { value: "marking--surface--cobblestone", bboxSearchable: true },
  { value: "construction--flat--crosswalk-plain", bboxSearchable: true },
  { value: "construction--flat--pedestrian-area", bboxSearchable: true },
  { value: "construction--flat--sidewalk", bboxSearchable: true },
  { value: "construction--structure--building", bboxSearchable: false },
  { value: "construction--structure--bridge", bboxSearchable: true },
  { value: "nature--vegetation", bboxSearchable: false },
  { value: "nature--water", bboxSearchable: false },
  { value: "nature--mountain", bboxSearchable: false },
  { value: "nature--sand", bboxSearchable: false },
  { value: "nature--sky", bboxSearchable: false },
];

const TAXON_BY_VALUE = new Map(
  MAPILLARY_TAXONOMY.map((e) => [e.value, e] as const),
);

export function isBboxSearchableClass(value: string): boolean {
  return TAXON_BY_VALUE.get(value)?.bboxSearchable ?? true;
}

export function allTaxonValues(): string[] {
  return MAPILLARY_TAXONOMY.map((e) => e.value);
}
