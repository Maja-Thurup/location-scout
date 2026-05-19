import { z } from "zod";

import { type Bbox, isBboxOverlapping } from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/logger";
import type {
  AssociatedFilm,
  CandidateProvider,
  ProviderInput,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// SF Film Locations — DataSF dataset yitu-d5am.
//
// 3,200+ records of San Francisco filming locations going back to 1915.
// As of December 2024 the dataset includes lat/lng coordinates (older
// snapshots had only an address description). One record per (film, scene)
// pair, so we group by coord to make a single candidate per location and
// attach all the films that shot there.
//
// API: SODA / Socrata public, no auth required.
// License: PDDL (Public Domain).
// ---------------------------------------------------------------------------

const SODA_ENDPOINT = "https://data.sfgov.org/resource/yitu-d5am.json";
const FETCH_LIMIT = 5000;
const FETCH_TIMEOUT_MS = 18_000;

/** Approximate San Francisco bounding box. */
const SF_BBOX: Bbox = {
  south: 37.703,
  west: -122.527,
  north: 37.832,
  east: -122.355,
};

const rowSchema = z
  .object({
    title: z.string().optional(),
    release_year: z.union([z.string(), z.number()]).optional(),
    locations: z.string().optional(),
    fun_facts: z.string().optional(),
    production_company: z.string().optional(),
    distributor: z.string().optional(),
    director: z.string().optional(),
    writer: z.string().optional(),
    actor_1: z.string().optional(),
    actor_2: z.string().optional(),
    actor_3: z.string().optional(),
    analysis_neighborhood: z.string().optional(),
    /** Newer snapshots ship `point` as { type, coordinates: [lng, lat] }. */
    point: z
      .object({
        type: z.string().optional(),
        coordinates: z.tuple([z.number(), z.number()]).optional(),
      })
      .optional(),
    /** Older snapshots provide latitude / longitude as strings. */
    latitude: z.string().optional(),
    longitude: z.string().optional(),
  })
  .passthrough();

type Row = z.infer<typeof rowSchema>;

function rowCoord(r: Row): { lat: number; lng: number } | null {
  if (r.point?.coordinates) {
    const [lng, lat] = r.point.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  if (r.latitude && r.longitude) {
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

function rowYear(r: Row): number | null {
  const v = r.release_year;
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Round coords to ~10m to group multiple film records at the same place.
 * 1e-4 lat ≈ 11 m at the equator and a bit less at SF's latitude.
 */
function clusterKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

async function fetchAllRows(): Promise<Row[]> {
  const cKey = cacheKey("openfilm:dataset", { source: "sf-films-v1" });
  const cached = await cacheGet<Row[]>(cKey);
  if (cached) return cached;

  // Filter at the SODA layer to only rows with non-null coords.
  // `point IS NOT NULL` works in SoQL.
  const url =
    `${SODA_ENDPOINT}` +
    `?$where=point IS NOT NULL` +
    `&$limit=${FETCH_LIMIT}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "LocationScout/0.1 (+https://github.com/Maja-Thurup/location-scout)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`SF Films SODA HTTP ${res.status}`);
  }
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error("SF Films returned non-array body");
  }

  const out: Row[] = [];
  for (const r of raw) {
    const parsed = rowSchema.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }
  await cacheSet(cKey, "openfilm:dataset", out, 7);
  return out;
}

export const sfFilmLocationsProvider: CandidateProvider = {
  name: "sf-film-locations",
  supportsBbox: (bbox) => isBboxOverlapping(bbox, SF_BBOX),
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    let rows: Row[];
    try {
      rows = await fetchAllRows();
    } catch (err) {
      logger.warn("sf-films provider fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [], elapsedMs: Date.now() - t0, error: String(err) };
    }

    // Group by ~10m proximity so one candidate carries all films shot at
    // that exact corner / building.
    const clusters = new Map<
      string,
      {
        lat: number;
        lng: number;
        films: AssociatedFilm[];
        names: Set<string>;
        descriptions: Set<string>;
        neighborhood: string | null;
        location: string | null;
      }
    >();

    for (const r of rows) {
      const c = rowCoord(r);
      if (!c) continue;
      // In-bbox filter against the search.
      if (
        c.lat < input.bbox.south ||
        c.lat > input.bbox.north ||
        c.lng < input.bbox.west ||
        c.lng > input.bbox.east
      ) {
        continue;
      }

      const key = clusterKey(c.lat, c.lng);
      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = {
          lat: c.lat,
          lng: c.lng,
          films: [],
          names: new Set(),
          descriptions: new Set(),
          neighborhood: r.analysis_neighborhood ?? null,
          location: r.locations ?? null,
        };
        clusters.set(key, cluster);
      }

      const title = (r.title ?? "Untitled film").trim();
      cluster.films.push({
        wikidataQid: null,
        title,
        year: rowYear(r),
        imdbId: null,
      });
      if (title) cluster.names.add(title);
      if (r.fun_facts) cluster.descriptions.add(r.fun_facts);
      if (r.locations && !cluster.location) cluster.location = r.locations;
      if (r.analysis_neighborhood && !cluster.neighborhood) {
        cluster.neighborhood = r.analysis_neighborhood;
      }
    }

    const out: RawCandidate[] = [];
    for (const [key, c] of clusters) {
      // Compose a friendly display name: prefer the location string, then
      // the neighborhood, then "X films shot here".
      const sceneTitle =
        c.location ??
        c.neighborhood ??
        `${c.films.length} film${c.films.length === 1 ? "" : "s"} shot here`;

      // Description: join up to two distinct fun-facts; SF Films editors
      // write good 1-line trivia so this is great vision context.
      const descArray = Array.from(c.descriptions).slice(0, 2);
      const description =
        descArray.length > 0 ? descArray.join(" \u2014 ") : null;

      out.push({
        externalId: key,
        source: "sf-film-locations",
        lat: c.lat,
        lng: c.lng,
        name: sceneTitle,
        description,
        knownImageUrl: null,
        tags: {
          "filming:source": "sf-film-locations",
          ...(c.neighborhood
            ? { "addr:neighbourhood": c.neighborhood }
            : {}),
        },
        associatedFilms: c.films,
        sourceUrl:
          "https://data.sfgov.org/Culture-and-Recreation/Film-Locations-in-San-Francisco/yitu-d5am",
      });
    }

    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
