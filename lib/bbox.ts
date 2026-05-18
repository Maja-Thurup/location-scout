/**
 * Bounding-box helpers for converting between (center + radius) and
 * (south, west, north, east) representations.
 *
 * We use the WGS-84 sphere approximation. Good enough at the few-mile
 * scale we care about for film location scouting; certainly tighter
 * than Overpass needs.
 */

export type Bbox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type LatLng = { lat: number; lng: number };

/** Approx miles per degree of latitude (WGS-84, near-constant). */
const MILES_PER_DEG_LAT = 69.0;

/** Convert miles to degrees of longitude at the given latitude. */
function milesToDegLng(miles: number, atLatDeg: number): number {
  const cosLat = Math.cos((atLatDeg * Math.PI) / 180);
  // Avoid divide-by-zero near the poles.
  const safeCos = Math.max(0.001, Math.abs(cosLat));
  return miles / (MILES_PER_DEG_LAT * safeCos);
}

/**
 * Compute a square-ish bbox around a point with the given radius in miles.
 * Useful when the user picks "within 25 miles".
 */
export function bboxFromRadius(center: LatLng, radiusMiles: number): Bbox {
  const dLat = radiusMiles / MILES_PER_DEG_LAT;
  const dLng = milesToDegLng(radiusMiles, center.lat);
  return {
    south: center.lat - dLat,
    west: center.lng - dLng,
    north: center.lat + dLat,
    east: center.lng + dLng,
  };
}

/** Compute the centroid (lat, lng) of a bbox. */
export function bboxCenter(bbox: Bbox): LatLng {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lng: (bbox.west + bbox.east) / 2,
  };
}

/** Render a bbox in Overpass QL "(south,west,north,east)" form. */
export function bboxToOverpass(bbox: Bbox): string {
  return `(${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)})`;
}

/** Reject ridiculous bboxes (e.g. a misparsed string that wraps the globe). */
export function isReasonableBbox(bbox: Bbox): boolean {
  if (bbox.north <= bbox.south) return false;
  if (bbox.east <= bbox.west) return false;
  if (bbox.north - bbox.south > 5) return false; // ~345 miles tall, too big
  if (bbox.east - bbox.west > 5) return false;
  return true;
}

/** Clamp a bbox to a maximum radius around its centroid (defensive). */
export function clampBbox(bbox: Bbox, maxRadiusMiles: number): Bbox {
  if (isReasonableBbox(bbox)) {
    const dLat = bbox.north - bbox.south;
    const dLng = bbox.east - bbox.west;
    const maxDLat = (maxRadiusMiles * 2) / MILES_PER_DEG_LAT;
    const maxDLng = milesToDegLng(maxRadiusMiles * 2, (bbox.south + bbox.north) / 2);
    if (dLat <= maxDLat && dLng <= maxDLng) return bbox;
  }
  return bboxFromRadius(bboxCenter(bbox), maxRadiusMiles);
}

/**
 * Expand a bbox by a multiplier around its centroid. Used for the
 * expanding-ring fallback when an initial search is sparse.
 *
 * `multiplier=2` doubles each dimension (so search area grows ~4x).
 * The result is clamped to `maxRadiusMiles` so a `multiplier=4` request
 * on a 100-mile bbox doesn't try to query the entire continent.
 */
export function expandBbox(
  bbox: Bbox,
  multiplier: number,
  maxRadiusMiles = 100,
): Bbox {
  const center = bboxCenter(bbox);
  const dLat = (bbox.north - bbox.south) / 2;
  const dLng = (bbox.east - bbox.west) / 2;
  const expanded: Bbox = {
    south: center.lat - dLat * multiplier,
    north: center.lat + dLat * multiplier,
    west: center.lng - dLng * multiplier,
    east: center.lng + dLng * multiplier,
  };
  return clampBbox(expanded, maxRadiusMiles);
}

/**
 * Approximate distance between two lat/lng points, in meters.
 * Haversine formula, WGS-84 mean radius.
 */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371008.8; // Earth mean radius (m)
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function metersToMiles(m: number): number {
  return m / 1609.344;
}
