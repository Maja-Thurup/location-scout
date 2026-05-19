import { z } from "zod";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// The Movie Database (TMDb) v4 client — used as an ENRICHER only.
//
// TMDb has no filming-location data of its own, but it has authoritative
// metadata for almost every film/TV title (poster, release year, popularity,
// IMDb id, ...). We use it to attach posters + cleaner titles to films we
// already discovered via Wikidata P915 (or other filming-location sources).
//
// Auth: v4 read-access bearer token, optional. When absent (e.g. in CI
// without the secret), every call returns null and the UI degrades to
// "title + year only".
//
// Free tier: 60K requests/day. We cache aggressively (30 days per movie
// id, 30 days per Wikidata Q-id resolve).
// ---------------------------------------------------------------------------

const BASE = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 10_000;
const POSTER_BASE = "https://image.tmdb.org/t/p/w342";

export type TmdbMovie = {
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  popularity: number | null;
  voteAverage: number | null;
  imdbId: string | null;
  /** TMDb canonical title page URL for "Open in TMDb" links. */
  tmdbUrl: string;
};

const findResultSchema = z.object({
  movie_results: z
    .array(
      z.object({
        id: z.number(),
        title: z.string().optional(),
        original_title: z.string().optional(),
        release_date: z.string().optional(),
        poster_path: z.string().nullable().optional(),
        popularity: z.number().optional(),
        vote_average: z.number().optional(),
      }),
    )
    .default([]),
  tv_results: z
    .array(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        original_name: z.string().optional(),
        first_air_date: z.string().optional(),
        poster_path: z.string().nullable().optional(),
        popularity: z.number().optional(),
        vote_average: z.number().optional(),
      }),
    )
    .default([]),
});

const movieDetailSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  original_title: z.string().optional(),
  release_date: z.string().optional(),
  poster_path: z.string().nullable().optional(),
  popularity: z.number().optional(),
  vote_average: z.number().optional(),
  imdb_id: z.string().nullable().optional(),
});

function yearFromIso(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function authHeader(): { Authorization: string } | null {
  const token = env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function tmdbFetch<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const auth = authHeader();
  if (!auth) {
    logger.warn("TMDb client: no read-access token configured");
    return null;
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { ...auth, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("TMDb HTTP non-ok", { path, status: res.status });
      return null;
    }
    const json = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      logger.warn("TMDb schema mismatch", {
        path,
        issue: parsed.error.issues[0]?.message,
      });
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn("TMDb fetch threw", {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve a Wikidata film Q-id to a TMDb movie record (poster, year, ...).
 * Tries movies first, then TV. Returns null when TMDb doesn't index the work.
 *
 * Cached 30 days per (Q-id) — TMDb posters are stable.
 */
export async function findMovieByWikidata(
  wikidataQid: string,
): Promise<TmdbMovie | null> {
  const cKey = cacheKey("tmdb:movie", { source: "wikidata", id: wikidataQid });
  const cached = await cacheGet<TmdbMovie | null>(cKey);
  if (cached !== null) return cached;

  const data = await tmdbFetch(
    `/find/${encodeURIComponent(wikidataQid)}?external_source=wikidata_id`,
    findResultSchema,
  );
  if (!data) return null;

  const movie = data.movie_results[0];
  const tv = data.tv_results[0];

  let result: TmdbMovie | null = null;
  if (movie) {
    const title = movie.title ?? movie.original_title ?? "Untitled";
    result = {
      tmdbId: movie.id,
      title,
      year: yearFromIso(movie.release_date),
      posterUrl: movie.poster_path ? `${POSTER_BASE}${movie.poster_path}` : null,
      popularity: movie.popularity ?? null,
      voteAverage: movie.vote_average ?? null,
      imdbId: null, // requires another /movie/{id}/external_ids fetch — skip for cost
      tmdbUrl: `https://www.themoviedb.org/movie/${movie.id}`,
    };
  } else if (tv) {
    const title = tv.name ?? tv.original_name ?? "Untitled series";
    result = {
      tmdbId: tv.id,
      title,
      year: yearFromIso(tv.first_air_date),
      posterUrl: tv.poster_path ? `${POSTER_BASE}${tv.poster_path}` : null,
      popularity: tv.popularity ?? null,
      voteAverage: tv.vote_average ?? null,
      imdbId: null,
      tmdbUrl: `https://www.themoviedb.org/tv/${tv.id}`,
    };
  }

  // Cache positive AND negative results (null) — both stable.
  await cacheSet(cKey, "tmdb:movie", result, 30);
  return result;
}

/**
 * Resolve an IMDb id (tt-prefixed) to a TMDb movie record. Used when the
 * source supplied an IMDb id but no Wikidata Q-id (e.g. Wikidata P345
 * without a P915-side Q-id).
 */
export async function findMovieByImdb(imdbId: string): Promise<TmdbMovie | null> {
  const cKey = cacheKey("tmdb:movie", { source: "imdb", id: imdbId });
  const cached = await cacheGet<TmdbMovie | null>(cKey);
  if (cached !== null) return cached;

  const data = await tmdbFetch(
    `/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`,
    findResultSchema,
  );
  if (!data) return null;

  const movie = data.movie_results[0];
  const tv = data.tv_results[0];
  let result: TmdbMovie | null = null;
  if (movie) {
    result = {
      tmdbId: movie.id,
      title: movie.title ?? movie.original_title ?? "Untitled",
      year: yearFromIso(movie.release_date),
      posterUrl: movie.poster_path ? `${POSTER_BASE}${movie.poster_path}` : null,
      popularity: movie.popularity ?? null,
      voteAverage: movie.vote_average ?? null,
      imdbId,
      tmdbUrl: `https://www.themoviedb.org/movie/${movie.id}`,
    };
  } else if (tv) {
    result = {
      tmdbId: tv.id,
      title: tv.name ?? tv.original_name ?? "Untitled series",
      year: yearFromIso(tv.first_air_date),
      posterUrl: tv.poster_path ? `${POSTER_BASE}${tv.poster_path}` : null,
      popularity: tv.popularity ?? null,
      voteAverage: tv.vote_average ?? null,
      imdbId,
      tmdbUrl: `https://www.themoviedb.org/tv/${tv.id}`,
    };
  }
  await cacheSet(cKey, "tmdb:movie", result, 30);
  return result;
}

/**
 * Fall-back search by title + year for sources that have neither a
 * Wikidata Q-id nor an IMDb id (e.g. NYC Scenes from the City).
 */
export async function searchMovieByTitle(
  title: string,
  year?: number | null,
): Promise<TmdbMovie | null> {
  const cKey = cacheKey("tmdb:movie", {
    source: "title",
    title: title.toLowerCase().trim(),
    year: year ?? null,
  });
  const cached = await cacheGet<TmdbMovie | null>(cKey);
  if (cached !== null) return cached;

  const params = new URLSearchParams();
  params.set("query", title);
  if (year != null) params.set("year", String(year));
  params.set("include_adult", "false");

  const schema = z.object({
    results: z
      .array(
        z.object({
          id: z.number(),
          title: z.string().optional(),
          release_date: z.string().optional(),
          poster_path: z.string().nullable().optional(),
          popularity: z.number().optional(),
          vote_average: z.number().optional(),
        }),
      )
      .default([]),
  });

  const data = await tmdbFetch(`/search/movie?${params}`, schema);
  if (!data) return null;

  // Pick the most-popular result so quirky scene-name collisions don't
  // crowd out the actual movie.
  const top = [...data.results].sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  )[0];

  let result: TmdbMovie | null = null;
  if (top) {
    result = {
      tmdbId: top.id,
      title: top.title ?? "Untitled",
      year: yearFromIso(top.release_date),
      posterUrl: top.poster_path ? `${POSTER_BASE}${top.poster_path}` : null,
      popularity: top.popularity ?? null,
      voteAverage: top.vote_average ?? null,
      imdbId: null,
      tmdbUrl: `https://www.themoviedb.org/movie/${top.id}`,
    };
  }
  await cacheSet(cKey, "tmdb:movie", result, 30);
  return result;
}

void movieDetailSchema; // reserved for future per-movie detail enrichment
