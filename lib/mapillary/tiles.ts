import type { Bbox } from "@/lib/bbox";

/** Mapillary bbox queries must be < 0.01 degrees square (API v4). */
export const MAPILLARY_MAX_BBOX_AREA_DEG2 = 0.009;

/**
 * Above this total bbox area, tiled `/map_features` search is skipped.
 * City/metro boxes (e.g. all of LA) need dozens of tiles × seconds each
 * and routinely exceed Vercel's function timeout → HTTP 504.
 */
export const MAPILLARY_SKIP_TILED_SEARCH_AREA_DEG2 = 0.02;

export function bboxAreaDeg2(bbox: Bbox): number {
  return (bbox.east - bbox.west) * (bbox.north - bbox.south);
}

export function shouldSkipTiledMapillarySearch(bbox: Bbox): boolean {
  return bboxAreaDeg2(bbox) > MAPILLARY_SKIP_TILED_SEARCH_AREA_DEG2;
}

export type MapillaryTile = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export function tileAreaDeg2(tile: MapillaryTile): number {
  return (tile.east - tile.west) * (tile.north - tile.south);
}

/**
 * Split a bbox into sub-boxes each under `maxAreaDeg2`, capped at `maxTiles`.
 * Uses a simple grid — sufficient for Mapillary API tiling (see FAQ).
 */
export function splitBboxIntoTiles(
  bbox: Bbox,
  maxAreaDeg2 = MAPILLARY_MAX_BBOX_AREA_DEG2,
  maxTiles = 40,
): MapillaryTile[] {
  const width = bbox.east - bbox.west;
  const height = bbox.north - bbox.south;
  const totalArea = width * height;
  if (totalArea <= 0) return [];

  if (totalArea <= maxAreaDeg2) {
    return [
      {
        west: bbox.west,
        south: bbox.south,
        east: bbox.east,
        north: bbox.north,
      },
    ];
  }

  const nCells = Math.ceil(totalArea / maxAreaDeg2);
  const aspect = width / height;
  const cols = Math.max(1, Math.ceil(Math.sqrt(nCells * aspect)));
  const rows = Math.max(1, Math.ceil(nCells / cols));
  const stepLng = width / cols;
  const stepLat = height / rows;

  const tiles: MapillaryTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (tiles.length >= maxTiles) return tiles;
      const west = bbox.west + col * stepLng;
      const east = col === cols - 1 ? bbox.east : west + stepLng;
      const south = bbox.south + row * stepLat;
      const north = row === rows - 1 ? bbox.north : south + stepLat;
      if ((east - west) * (north - south) <= maxAreaDeg2 + 1e-9) {
        tiles.push({ west, south, east, north });
      }
    }
  }
  return tiles.length > 0 ? tiles : [{ west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north }];
}

export function tileToBboxStr(tile: MapillaryTile): string {
  return `${tile.west},${tile.south},${tile.east},${tile.north}`;
}
