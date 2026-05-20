import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type {
  CandidateProvider,
  ProviderInput,
  ProviderName,
  ProviderResult,
  RawCandidate,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Own-DB provider — local Postgres-backed candidate retrieval.
//
// Reads from the `Place` table populated by import scripts (NRHP, NHL,
// UNESCO, NPS, RIDB, NYC Scenes, SF Films, ...). Sub-100ms queries even
// at 200k+ rows thanks to the (lat, lng) compound index.
//
// Always runs first in the provider list because:
//   - It's the fastest source (single Postgres query, no HTTP)
//   - Records are pre-curated with rich metadata (descriptions, images,
//     popularity scores) that fed M4's tag-overlap ranking directly
//   - It's free at scale (no per-search API cost)
//
// Empty / non-imported case: returns 0 rows silently. The other
// providers (Wikidata, Wikipedia, ...) keep working unchanged.
// ---------------------------------------------------------------------------

const QUERY_LIMIT = 500;

/**
 * Map a DB source code to its ProviderName. The DB stores `source` as a
 * loose string; we narrow at read time so RRF weights, dedupe priority,
 * and UI source pills all see the right canonical value.
 */
function mapDbSource(s: string): ProviderName {
  switch (s) {
    case "nrhp":
      return "nrhp";
    case "nhl":
      return "nhl";
    case "nps":
      return "nps-places";
    case "ridb":
      return "ridb-recreation";
    case "unesco":
      return "unesco-heritage";
    case "nyc-scenes":
      return "nyc-scenes-from-the-city";
    case "sf-films":
      return "sf-film-locations";
    default:
      return "own-db"; // unrecognized — show as generic
  }
}

type DbPlace = {
  id: string;
  source: string;
  name: string;
  description: string | null;
  lat: number;
  lng: number;
  tags: unknown;
  imageUrl: string | null;
  sourceUrl: string | null;
  popularityScore: number;
};

function placeToCandidate(p: DbPlace): RawCandidate {
  const mappedSource = mapDbSource(p.source);

  let tags: Record<string, string> = {};
  if (p.tags && typeof p.tags === "object" && !Array.isArray(p.tags)) {
    for (const [k, v] of Object.entries(p.tags as Record<string, unknown>)) {
      if (typeof v === "string") tags[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") tags[k] = String(v);
    }
  }
  // Always carry the underlying source code in tags for debugging.
  tags = { ...tags, "owndb:source": p.source };

  return {
    externalId: p.id,
    source: mappedSource,
    lat: p.lat,
    lng: p.lng,
    name: p.name,
    description: p.description,
    knownImageUrl: p.imageUrl,
    tags,
    associatedFilms: [],
    sourceUrl: p.sourceUrl,
  };
}

export const ownDbProvider: CandidateProvider = {
  name: "own-db",
  supportsBbox: () => true,
  async search(input: ProviderInput): Promise<ProviderResult> {
    const t0 = Date.now();
    const { bbox } = input;

    let rows: DbPlace[];
    try {
      // Plain bbox filter sorted by popularity DESC. The (lat, lng)
      // compound index handles the bbox; the in-memory sort handles
      // popularity. At < 1 second even with 500k rows.
      rows = (await prisma.place.findMany({
        where: {
          lat: { gte: bbox.south, lte: bbox.north },
          lng: { gte: bbox.west, lte: bbox.east },
        },
        orderBy: [{ popularityScore: "desc" }, { name: "asc" }],
        take: QUERY_LIMIT,
      })) as DbPlace[];
    } catch (err) {
      logger.warn("own-db query failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        candidates: [],
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const out: RawCandidate[] = rows.map(placeToCandidate);
    return { candidates: out, elapsedMs: Date.now() - t0, error: null };
  },
};
