import { z } from "zod";

import { type Bbox, isBboxOverlapping } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type {
  AssociatedFilm,
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// NYC "Scenes from the City" — curated dataset of iconic NYC filming
// locations from the James Sanders book of the same name.
//
// Dataset: qb3k-n8mm on data.cityofnewyork.us
// API: SODA / Socrata public, no auth required for read.
// Records: ~150, with coordinates, film title, year, director.
// License: Public domain (NYC Open Data).
//
// We pull the entire dataset once (it's tiny), cache it for 7 days, and
// filter in-memory by bbox per request — much cheaper than per-request
// SODA queries.
// ---------------------------------------------------------------------------

const SODA_ENDPOINT = "https://data.cityofnewyork.us/resource/qb3k-n8mm.json";
const FETCH_LIMIT = 1000; // dataset is far below this; safety cap
const FETCH_TIMEOUT_MS = 12_000;

/** Approximate NYC bounding box, used by `supportsBbox`. */
const NYC_BBOX: Bbox = {
  south: 40.477,
  west: -74.259,
  north: 40.917,
  east: -73.7,
};

/**
 * Socrata returns Point geometry as either:
 *   - { type: "Point", coordinates: [lng, lat] } (newer)
 *   - { latitude: "40.7", longitude: "-73.9" } legacy fields
 * We accept either to be safe across Socrata API versions.
 */
const rowSchema = z
  .object({
    title: z.string().optional(),
    movie: z.string().optional(),
    year: z.union([z.string(), z.number()]).optional(),
    director: z.string().optional(),
    location: z
      .object({
        coordinates: z.tuple([z.number(), z.number()]).optional(),
        type: z.string().optional(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
      })
      .optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
    description: z.string().optional(),
    /** Some snapshots embed an integer position number used for the book. */
    scene_number: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

type Row = z.infer<typeof rowSchema>;

function rowCoord(r: Row): { lat: number; lng: number } | null {
  if (r.location?.coordinates) {
    const [lng, lat] = r.location.coordinates;
    return { lat, lng };
  }
  if (r.location?.latitude && r.location?.longitude) {
    const lat = Number(r.location.latitude);
    const lng = Number(r.location.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

function rowYear(r: Row): number | null {
  const v = r.year;
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowKey(r: Row, idx: number): string {
  if (r.scene_number != null) return String(r.scene_number);
  // Otherwise compose a stable id from index + title.
  const t = (r.title ?? r.movie ?? "untitled").toLowerCase().replace(/\s+/g, "-");
  return `${idx}:${t}`;
}

async function fetchAllRows(): Promise<Row[]> {
  const cKey = cacheKey("openfilm:dataset", { source: "nyc-scenes-v1" });
  const cached = await cacheGet<Row[]>(cKey);
  if (cached) return cached;

  const url = `${SODA_ENDPOINT}?$limit=${FETCH_LIMIT}`;
  const headers: Record<string, string> = {
    "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
  };
  if (env.SOCRATA_APP_TOKEN) {
    headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`NYC Scenes SODA HTTP ${res.status}`);
  }
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error("NYC Scenes returned non-array body");
  }

  const out: Row[] = [];
  for (const r of raw) {
    const parsed = rowSchema.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }

  await cacheSet(cKey, "openfilm:dataset", out, 7);
  return out;
}

export const nycScenesProvider: CandidateProvider = {
  name: "nyc-scenes-from-the-city",
  /** Only fire when the requested bbox could possibly intersect NYC. */
  supportsBbox: (bbox) => isBboxOverlapping(bbox, NYC_BBOX),
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    let rows: Row[];
    try {
      rows = await fetchAllRows();
    } catch (err) {
      logger.warn("nyc-scenes provider fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], elapsedMs: Date.now() - t0, error: String(err) };
    }

    const out: RawCandidate[] = [];
    rows.forEach((r, idx) => {
      const c = rowCoord(r);
      if (!c) return;
      // In-bbox filter.
      if (
        c.lat < input.bbox.south ||
        c.lat > input.bbox.north ||
        c.lng < input.bbox.west ||
        c.lng > input.bbox.east
      ) {
        return;
      }

      const filmTitle = (r.movie ?? r.title ?? "Untitled scene").trim();
      const year = rowYear(r);
      const film: AssociatedFilm = {
        wikidataQid: null,
        title: filmTitle,
        year,
        imdbId: null,
      };

      const sceneTitle = r.title ?? filmTitle;
      const description =
        r.description ?? r.notes ?? r.address ?? null;

      out.push({
        externalId: rowKey(r, idx),
        source: "nyc-scenes-from-the-city",
        lat: c.lat,
        lng: c.lng,
        name: sceneTitle,
        description,
        knownImageUrl: null,
        tags: {
          "filming:source": "nyc-scenes-from-the-city",
          ...(r.address ? { "addr:full": r.address } : {}),
        },
        associatedFilms: [film],
        sourceUrl: `https://data.cityofnewyork.us/Business/Filming-Locations-Scenes-from-the-City-/qb3k-n8mm`,
      });
    });

    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
