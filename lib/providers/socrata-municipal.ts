import { z } from "zod";

import { isBboxOverlapping, type Bbox } from "@/lib/bbox";
import { extractKeywords } from "@/lib/providers/keywords";
import { soqlBbox, soqlQuery, type SocrataDataset } from "@/lib/socrata";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Socrata municipal-datasets provider.
//
// Aggregates a curated set of Socrata-backed open-data datasets that
// cover landmarks, sculptures, public art, historic sites, and named
// scenic places in the major US cities our users actually scout in.
// All datasets share the same SODA query shape so we register one
// provider that fans out per-dataset and unions the results.
//
// Each dataset entry below carries:
//   - the dataset id (8-char "abcd-1234" Socrata ID)
//   - the city's bounding box (so we don't waste a query on a
//     dataset that doesn't physically overlap the user's bbox)
//   - the geometry column name (varies per dataset — `the_geom`,
//     `location_1`, `point`)
//   - a per-dataset row-to-RawCandidate mapper
//
// New cities can be added by appending one DATASETS entry; no other
// changes needed.
// ---------------------------------------------------------------------------

// Generic geometry shape returned by Socrata for Point columns.
const pointGeomSchema = z.object({
  type: z.string().optional(),
  coordinates: z.tuple([z.number(), z.number()]).optional(),
});

const locationGeomSchema = z.object({
  latitude: z.union([z.string(), z.number()]).optional(),
  longitude: z.union([z.string(), z.number()]).optional(),
  human_address: z.string().optional(),
});

function readPoint(
  geom: unknown,
): { lat: number; lng: number } | null {
  if (!geom || typeof geom !== "object") return null;
  const point = pointGeomSchema.safeParse(geom);
  if (point.success && point.data.coordinates) {
    const [lng, lat] = point.data.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const loc = locationGeomSchema.safeParse(geom);
  if (loc.success) {
    const lat = Number(loc.data.latitude);
    const lng = Number(loc.data.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
      return { lat, lng };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-dataset config + row-mapper
// ---------------------------------------------------------------------------

type DatasetEntry = {
  id: string;
  /** Human-friendly label used in `tags["socrata:dataset"]`. */
  label: string;
  domain: string;
  /** Bbox the dataset's data physically covers. */
  bbox: Bbox;
  /** Name of the geometry column. */
  geomColumn: string;
  /** Optional `$where` clause appended to the bbox filter. */
  extraWhere?: string;
  /** Convert one parsed row to a RawCandidate. */
  toCandidate: (row: Record<string, unknown>) => RawCandidate | null;
};

const NYC_BBOX: Bbox = { south: 40.49, west: -74.27, north: 40.92, east: -73.68 };
const SF_BBOX: Bbox = { south: 37.70, west: -122.55, north: 37.84, east: -122.35 };
const CHICAGO_BBOX: Bbox = {
  south: 41.64,
  west: -87.94,
  north: 42.02,
  east: -87.52,
};

const LA_BBOX: Bbox = {
  south: 33.65,
  west: -118.75,
  north: 34.45,
  east: -118.1,
};

/**
 * NYC Public Art / Landmarks dataset (DCLA: Public Art Map).
 * Each row is a sculpture / mural / installation in the five
 * boroughs with location + medium + creator.
 */
const NYC_PUBLIC_ART: DatasetEntry = {
  id: "fhrw-4uyv",
  label: "nyc-public-art",
  domain: "data.cityofnewyork.us",
  bbox: NYC_BBOX,
  geomColumn: "the_geom",
  toCandidate: (row) => {
    const point = readPoint(row.the_geom);
    if (!point) return null;
    const title = String(row.title ?? "");
    const description = String(row.description ?? row.summary ?? "");
    const artist = String(row.artist ?? row.artist_name ?? "");
    const medium = String(row.medium ?? "");
    return {
      externalId: `nyc-public-art:${row.unique_id ?? row.objectid ?? title}`,
      source: "own-db",
      lat: point.lat,
      lng: point.lng,
      name: title || null,
      description: description?.slice(0, 280) || null,
      knownImageUrl: null,
      tags: {
        "socrata:dataset": "nyc-public-art",
        ...(artist ? { "socrata:artist": artist } : {}),
        ...(medium ? { "socrata:medium": medium } : {}),
      },
      associatedFilms: [],
      sourceUrl: `https://data.cityofnewyork.us/d/fhrw-4uyv`,
    };
  },
};

/**
 * NYC LPC Individual Landmarks dataset.
 * Designated NYC historic landmarks with addresses + descriptions.
 */
const NYC_LANDMARKS: DatasetEntry = {
  id: "ts3a-aqkw",
  label: "nyc-individual-landmarks",
  domain: "data.cityofnewyork.us",
  bbox: NYC_BBOX,
  geomColumn: "the_geom",
  toCandidate: (row) => {
    const point = readPoint(row.the_geom);
    if (!point) return null;
    const name = String(row.lpc_name ?? row.lp_name ?? row.name ?? "");
    const addr = String(row.address ?? row.bnp_address ?? "");
    const description = String(row.style_prim ?? row.style ?? "");
    return {
      externalId: `nyc-landmarks:${row.lpc_id ?? row.lp_number ?? name}`,
      source: "own-db",
      lat: point.lat,
      lng: point.lng,
      name: name || null,
      description: addr ? `${addr}${description ? " — " + description : ""}` : null,
      knownImageUrl: null,
      tags: {
        "socrata:dataset": "nyc-individual-landmarks",
        ...(addr ? { "socrata:address": addr } : {}),
        ...(description ? { "socrata:style": description } : {}),
      },
      associatedFilms: [],
      sourceUrl: `https://data.cityofnewyork.us/d/ts3a-aqkw`,
    };
  },
};

/**
 * SF Historic Sites dataset (Article 10 / Article 11 designated).
 */
const SF_HISTORIC_SITES: DatasetEntry = {
  id: "njuh-trk8",
  label: "sf-historic-sites",
  domain: "data.sfgov.org",
  bbox: SF_BBOX,
  geomColumn: "location",
  toCandidate: (row) => {
    const point = readPoint(row.location ?? row.point ?? row.geom);
    if (!point) return null;
    const name = String(row.name ?? row.full_name ?? "");
    const description = String(row.description ?? row.summary ?? "");
    return {
      externalId: `sf-historic:${row.id ?? name}`,
      source: "own-db",
      lat: point.lat,
      lng: point.lng,
      name: name || null,
      description: description?.slice(0, 280) || null,
      knownImageUrl: null,
      tags: { "socrata:dataset": "sf-historic-sites" },
      associatedFilms: [],
      sourceUrl: `https://data.sfgov.org/d/${SF_HISTORIC_SITES.id}`,
    };
  },
};

/**
 * LA Public Arts (City of Los Angeles open data).
 * https://data.lacity.org/City-Infrastructure-Service-Requests/PublicArts/q3kc-wj3g
 */
const LA_PUBLIC_ART: DatasetEntry = {
  id: "q3kc-wj3g",
  label: "la-public-art",
  domain: "data.lacity.org",
  bbox: LA_BBOX,
  geomColumn: "location_1",
  toCandidate: (row) => {
    const point =
      readPoint(row.location_1 ?? row.location ?? row.the_geom ?? row.geom);
    if (!point) return null;
    const title = String(
      row.title ?? row.artwork_title ?? row.name ?? row.project_name ?? "",
    );
    const artist = String(row.artist ?? row.artist_name ?? "");
    const medium = String(row.medium ?? row.artwork_type ?? "");
    const desc = String(row.description ?? row.notes ?? "");
    return {
      externalId: `la-public-art:${row.objectid ?? row.id ?? title}`,
      source: "own-db",
      lat: point.lat,
      lng: point.lng,
      name: title || null,
      description: desc?.slice(0, 280) || null,
      knownImageUrl: null,
      tags: {
        "socrata:dataset": "la-public-art",
        ...(artist ? { "socrata:artist": artist } : {}),
        ...(medium ? { "socrata:medium": medium } : {}),
      },
      associatedFilms: [],
      sourceUrl: `https://data.lacity.org/City-Infrastructure-Service-Requests/PublicArts/q3kc-wj3g`,
    };
  },
};

const CHI_LANDMARKS: DatasetEntry = {
  id: "tdab-kixi",
  label: "chicago-landmarks",
  domain: "data.cityofchicago.org",
  bbox: CHICAGO_BBOX,
  geomColumn: "the_geom",
  toCandidate: (row) => {
    const point = readPoint(row.the_geom ?? row.location);
    if (!point) return null;
    const name = String(row.landmark_name ?? row.name ?? "");
    const description = String(row.description ?? row.address ?? "");
    return {
      externalId: `chicago-landmarks:${row.objectid ?? name}`,
      source: "own-db",
      lat: point.lat,
      lng: point.lng,
      name: name || null,
      description: description?.slice(0, 280) || null,
      knownImageUrl: null,
      tags: { "socrata:dataset": "chicago-landmarks" },
      associatedFilms: [],
      sourceUrl: `https://data.cityofchicago.org/d/tdab-kixi`,
    };
  },
};

const DATASETS: ReadonlyArray<DatasetEntry> = [
  NYC_PUBLIC_ART,
  NYC_LANDMARKS,
  SF_HISTORIC_SITES,
  CHI_LANDMARKS,
  LA_PUBLIC_ART,
];

const rowSchema = z.record(z.string(), z.unknown());

async function searchDataset(
  entry: DatasetEntry,
  bbox: Bbox,
  q: string | null,
): Promise<RawCandidate[]> {
  const rows = await soqlBbox<Record<string, unknown>>({
    dataset: { id: entry.id, domain: entry.domain } as SocrataDataset,
    geomColumn: entry.geomColumn,
    bbox,
    schema: rowSchema,
    extraWhere: entry.extraWhere,
    q: q ?? undefined,
    limit: 200,
  });
  const out: RawCandidate[] = [];
  for (const row of rows) {
    const c = entry.toCandidate(row);
    if (c) out.push(c);
  }
  return out;
}

export const socrataMunicipalProvider: CandidateProvider = {
  name: "own-db",
  debugKey: "socrata-municipal",
  displayName: "Socrata municipal (NYC / SF / Chicago / LA)",
  supportsBbox: (bbox) => DATASETS.some((d) => isBboxOverlapping(d.bbox, bbox)),
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const eligible = DATASETS.filter((d) => isBboxOverlapping(d.bbox, input.bbox));
    if (eligible.length === 0) {
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: null,
        debug: {
          skipReason: "bbox does not overlap any registered municipal dataset",
          request: { datasets: DATASETS.map((d) => d.label) },
        },
      };
    }

    const { joined } = extractKeywords(input.sceneTokens, {
      minLength: 4,
      maxTokens: 3,
    });
    const q = joined.length > 0 ? joined : null;

    const fetches = eligible.map((d) =>
      searchDataset(d, input.bbox, q).catch(() => [] as RawCandidate[]),
    );
    const results = await Promise.all(fetches);
    const out: RawCandidate[] = results.flat();
    return {
      candidates: out,
      elapsedMs: Date.now() - t0,
      error: null,
      debug: {
        request: {
          datasets: eligible.map((d) => ({
            id: d.id,
            label: d.label,
            domain: d.domain,
          })),
          keywordQuery: q,
        },
      },
    };
  },
};

/**
 * Re-export the `soqlQuery` helper bound to a specific dataset for
 * callers that need ad-hoc queries (e.g. one-off enrichment lookups).
 */
export { soqlQuery };
