import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth";
import {
  type Bbox,
  bboxFromRadius,
  bboxCenter,
  clampBbox,
  distanceMeters,
  isReasonableBbox,
} from "@/lib/bbox";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { forwardGeocode } from "@/lib/geocode";
import { type GooglePlace, searchText } from "@/lib/google-places";
import { logger } from "@/lib/logger";
import { findDetectionsInBbox } from "@/lib/mapillary";
import {
  type MatchMode,
  type OsmCandidate,
  searchOsm,
  searchOsmRich,
} from "@/lib/overpass";
import { mergeCandidates } from "@/lib/providers/dedupe";
import { runProviders } from "@/lib/providers/registry";
import { rrfRank } from "@/lib/providers/rrf";
import {
  MIN_USEFUL_OVERLAP_SCORE,
  combinedRank,
  isHighConfidence,
  tagOverlapScore,
  type TagOverlapScore,
} from "@/lib/providers/tag-overlap";
import type {
  AssociatedFilm,
  MergedCandidate,
  ProviderName,
  RawCandidate,
} from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Bumped from default (10s on Vercel Hobby, 15s on Pro) so the rich-tag
 * parallel-alternatives pipeline plus the new candidate providers
 * (Wikidata SPARQL, Wikipedia geosearch, NYC/SF datasets) all have
 * headroom on big-city bboxes.
 */
export const maxDuration = 60;

const ALLOWED_RADII = [5, 10, 25, 50, 100] as const;

const requestSchema = z.object({
  /**
   * Single OSM tag-set. Backwards-compat path; if `osmTagsAlternatives` is
   * non-empty, this is ignored for OSM retrieval. Always required so callers
   * can fall back when the LLM didn't emit alternatives.
   */
  osmTags: z
    .record(z.string(), z.string())
    .refine((obj) => Object.keys(obj).length > 0, "osmTags must have at least one entry"),

  /** Multiple alternative tag-sets to UNION at the OSM layer. */
  osmTagsAlternatives: z
    .array(z.record(z.string(), z.string()))
    .optional()
    .default([]),

  /** Optional Google Places "type" filter for the B2 text-search fallback. */
  googleTypes: z.array(z.string()).optional(),

  /** Optional Claude-derived text query for the B2 fallback. */
  googleQuery: z.string().min(1).max(200).optional(),

  /** Optional Mapillary `object_value` classes specified by Claude. */
  mapillaryClasses: z.array(z.string()).optional(),

  /**
   * Phase 2a: pass through to providers so they can tailor their queries
   * (e.g. Wikidata could filter by location_kind in the future).
   */
  sceneTokens: z.array(z.string()).optional().default([]),
  locationKind: z
    .enum([
      "urban",
      "suburban",
      "rural",
      "industrial",
      "wilderness",
      "waterfront",
      "mixed",
    ])
    .nullable()
    .optional()
    .default(null),

  /**
   * M5: which tier this search runs at. "free" (default) skips Google
   * Places searchText. "deep" enables it as a parallel provider and is
   * gated on the user's deep-search credit balance.
   */
  searchTier: z.enum(["free", "deep"]).optional().default("free"),

  /** Free-text location string to geocode. */
  location: z.string().min(2).max(160).optional(),

  /** Optional radius around the geocoded location, in miles. */
  radiusMiles: z
    .number()
    .int()
    .refine((v) => (ALLOWED_RADII as readonly number[]).includes(v))
    .nullable()
    .optional(),

  /** Pre-computed bbox. */
  bbox: z
    .object({
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    })
    .optional(),
});

/**
 * Candidate sent to the client. Extends the OSM-shape with provider
 * metadata so the enrichment pipeline + UI can show richer cards
 * (descriptions, curated images, films attached, source pills).
 */
type RankedCandidate = {
  // OSM-style core
  id: string;
  type: "node" | "way" | "relation";
  osmId: number;
  lat: number;
  lng: number;
  tags: Record<string, string>;
  name: string | null;
  // Provider extension
  sources: ReadonlyArray<ProviderName>;
  primarySource: ProviderName;
  description: string | null;
  knownImageUrl: string | null;
  associatedFilms: ReadonlyArray<AssociatedFilm>;
  sourceUrl: string | null;
  // Search-time
  distanceMeters: number;
  // M4: ranking signals
  /** Reciprocal Rank Fusion score across contributing retrievers. */
  rrfScore: number;
  /** IDF-weighted tag overlap with scene_tokens. */
  tagOverlapScore: number;
  /** Distinctive tokens that matched (for UI badge). */
  matchedTokens: ReadonlyArray<string>;
};

export type ExtendedMatchMode = MatchMode | "google_text_fallback";

type SearchOsmResponse = {
  bbox: Bbox;
  requestedBbox: Bbox;
  center: { lat: number; lng: number };
  candidates: RankedCandidate[];
  cached: boolean;
  bboxSource: "geocoded_city" | "geocoded_radius" | "supplied";
  matchMode: ExtendedMatchMode;
  primaryTag: { key: string; value: string } | null;
  expansionMultiplier: 1 | 2 | 4;
  mirror: string | null;
  alternativesTried: number;
  alternativesSucceeded: number;
  /** Per-provider stats, surfaced for debugging + the analysis panel UI. */
  providerStats: Record<ProviderName, { count: number; ms: number; error: string | null }>;
  /**
   * True when tag-overlap is strong enough that vision scoring is
   * unnecessary. Free tier (M5) skips vision when this is set; deep
   * tier still runs vision for tie-breaking but expects fewer score
   * disagreements.
   */
  highConfidence: boolean;
};

type CachedSearchValue = {
  candidates: RankedCandidate[];
  effectiveBbox: Bbox;
  matchMode: ExtendedMatchMode;
  primaryTag: { key: string; value: string } | null;
  expansionMultiplier: 1 | 2 | 4;
  alternativesTried: number;
  alternativesSucceeded: number;
  providerStats: Record<ProviderName, { count: number; ms: number; error: string | null }>;
  highConfidence: boolean;
};

// ---------------------------------------------------------------------------
// B1 helper: detect "abandonment / decay" cues that should make us include
// CLOSED_PERMANENTLY businesses when we hit Google Places.
// ---------------------------------------------------------------------------

const ABANDONED_OSM_KEYS = new Set(["abandoned", "ruins", "disused"]);
const ABANDONED_VALUE_RE =
  /\b(abandoned|disused|ruined|ruins|derelict|boarded[- ]up|decayed|deserted|forgotten|crumbling)\b/i;

export function sceneImpliesAbandonment(args: {
  osmTags: Record<string, string>;
  googleQuery?: string;
}): boolean {
  for (const [k, v] of Object.entries(args.osmTags)) {
    if (ABANDONED_OSM_KEYS.has(k) && v && v !== "no") return true;
    if (ABANDONED_VALUE_RE.test(v)) return true;
  }
  if (args.googleQuery && ABANDONED_VALUE_RE.test(args.googleQuery)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Conversion: OSM candidate -> RawCandidate so it can flow through the
// provider-merge step alongside Wikidata/Wikipedia/NYC/SF results.
// ---------------------------------------------------------------------------

function osmCandidateToRaw(c: OsmCandidate): RawCandidate {
  return {
    externalId: c.id,
    source: "osm",
    lat: c.lat,
    lng: c.lng,
    name: c.name,
    description: null,
    knownImageUrl: null,
    tags: c.tags,
    associatedFilms: [],
    sourceUrl: `https://www.openstreetmap.org/${c.type}/${c.osmId}`,
  };
}

function googlePlaceToRaw(p: GooglePlace): RawCandidate {
  return {
    externalId: p.id,
    source: "osm", // treat Google fallback as OSM-class for the merge step
    lat: p.lat,
    lng: p.lng,
    name: p.displayName ?? null,
    description: p.editorialSummary ?? null,
    knownImageUrl: null,
    tags: {
      "google:place_id": p.id,
      "google:primary_type": p.primaryType ?? "",
      ...(p.businessStatus ? { "google:business_status": p.businessStatus } : {}),
    },
    associatedFilms: [],
    sourceUrl: p.googleMapsUri ?? null,
  };
}

const MAX_BBOX_RADIUS_MILES = 100;
const MAX_OUTPUT_CANDIDATES = 50;

/** OSM "type" used downstream for ID composition. Provider candidates use "node". */
function inferTypeFromId(id: string): "node" | "way" | "relation" {
  if (id.startsWith("way/")) return "way";
  if (id.startsWith("relation/")) return "relation";
  return "node";
}

/** OSM-internal numeric id, when applicable; 0 for non-OSM provider sources. */
function inferOsmId(externalIds: Record<string, string | undefined>): number {
  const osmExt = externalIds.osm;
  if (!osmExt) return 0;
  const m = /^(?:node|way|relation)\/(\d+)$/.exec(osmExt);
  return m ? Number(m[1]) : 0;
}

/**
 * Concatenate a candidate's name + description + tag values into one
 * lowercased text blob for substring matching.
 */
function candidateBlob(c: MergedCandidate): string {
  const parts: string[] = [];
  if (c.name) parts.push(c.name);
  if (c.description) parts.push(c.description);
  for (const v of Object.values(c.tags)) {
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  return parts.join(" \u2022 ").toLowerCase();
}

/**
 * Tokens that are too generic to be a "subject" we'd require in a
 * candidate. The user might write them but they don't carve out a
 * specific thing — every memorial mentions "park"/"statue"/"monument"
 * incidentally.
 */
const NON_SUBJECT_TOKENS = new Set([
  "park",
  "statue",
  "sculpture",
  "monument",
  "memorial",
  "artwork",
  "building",
  "house",
  "tree",
  "trees",
  "grass",
  "sky",
  "background",
  "outdoor",
  "exterior",
  "interior",
  "the",
  "a",
  "an",
  "of",
  "in",
  "with",
  "and",
  "or",
  "old",
  "new",
  "big",
  "small",
  "large",
  "tiny",
]);

/**
 * Collect the literal subject keywords used by the subject-required
 * filter. Pulls them from two places:
 *   1. The pipe-separated `name` regex Claude emitted (e.g.
 *      "horse|equestrian|cavalry|jockey|rider"). These are the
 *      authoritative subject synonyms.
 *   2. As a fallback (when there's no name regex), any single-word
 *      scene_token that isn't in the generic-noun blacklist. Short
 *      words and category nouns are dropped.
 */
function collectSubjectKeywords(
  subjectNameRegex: string | null,
  sceneTokens: ReadonlyArray<string>,
): string[] {
  const out = new Set<string>();
  if (subjectNameRegex && subjectNameRegex.trim().length > 0) {
    for (const part of subjectNameRegex.split("|")) {
      const norm = part.trim().toLowerCase();
      if (norm.length >= 3 && !NON_SUBJECT_TOKENS.has(norm)) {
        out.add(norm);
      }
    }
  }
  if (out.size === 0) {
    for (const t of sceneTokens) {
      const norm = t.trim().toLowerCase();
      if (
        norm.length >= 4 &&
        !norm.includes(" ") &&
        !NON_SUBJECT_TOKENS.has(norm)
      ) {
        out.add(norm);
      }
    }
  }
  return Array.from(out);
}

/**
 * Build a regex that matches any of `keywords` as a word-substring in
 * a lowercased blob. Returns null when there are no usable keywords —
 * the caller should skip the filter in that case.
 */
function buildSubjectMatcher(keywords: ReadonlyArray<string>): RegExp | null {
  const escaped = keywords.map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  if (escaped.length === 0) return null;
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

export const POST = withAuth(async (req) => {
  const t0 = Date.now();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const {
    osmTags,
    osmTagsAlternatives,
    googleTypes,
    googleQuery,
    mapillaryClasses,
    sceneTokens,
    locationKind,
    searchTier,
    location,
    radiusMiles,
    bbox: suppliedBbox,
  } = parsed.data;

  const effectiveAlternatives: ReadonlyArray<Record<string, string>> =
    osmTagsAlternatives.length > 0 ? osmTagsAlternatives : [osmTags];

  // 1) Resolve bbox.
  let bbox: Bbox;
  let bboxSource: SearchOsmResponse["bboxSource"];
  if (suppliedBbox) {
    if (!isReasonableBbox(suppliedBbox)) {
      return NextResponse.json(
        { error: "invalid_bbox", message: "Supplied bbox is too large or malformed." },
        { status: 400 },
      );
    }
    bbox = suppliedBbox;
    bboxSource = "supplied";
  } else {
    if (!location) {
      return NextResponse.json(
        { error: "invalid_request", message: "Either `location` or `bbox` is required." },
        { status: 400 },
      );
    }
    const geocoded = await forwardGeocode(location);
    if (!geocoded) {
      return NextResponse.json(
        { error: "geocode_failed", message: `Could not find "${location}" on the map.` },
        { status: 422 },
      );
    }
    if (radiusMiles != null) {
      bbox = clampBbox(
        bboxFromRadius({ lat: geocoded.lat, lng: geocoded.lng }, radiusMiles),
        MAX_BBOX_RADIUS_MILES,
      );
      bboxSource = "geocoded_radius";
    } else if (geocoded.bbox) {
      bbox = clampBbox(geocoded.bbox, MAX_BBOX_RADIUS_MILES);
      bboxSource = "geocoded_city";
    } else {
      bbox = bboxFromRadius({ lat: geocoded.lat, lng: geocoded.lng }, 25);
      bboxSource = "geocoded_radius";
    }
  }

  // 2) Cache lookup.
  // Schema constant captures the SHAPE + RANKING ALGORITHM. Bump it
  // whenever the cached candidate ordering or the cached fields change
  // — old entries miss cleanly and trigger a fresh fetch + re-rank.
  // History: v4-providers (post-providers refactor) → v5-rrf-tag-overlap
  // (M4 ranking with RRF + tag-overlap + macro-region filter + films-as-
  // post-add).
  // The key includes scene_tokens / location_kind because M4's ranking
  // depends on them; the same OSM-tag query with different scene tokens
  // produces a different ordering and must miss.
  const key = cacheKey("overpass:v3", {
    schema: "v9-subject-required-filter",
    bbox,
    osmTags,
    osmTagsAlternatives: effectiveAlternatives,
    mapillaryClasses: mapillaryClasses ? [...mapillaryClasses].sort() : null,
    sceneTokens: [...sceneTokens].sort(),
    locationKind: locationKind ?? null,
    // M5: free vs deep produces different candidate pools (Google
    // Places searchText only runs in deep). Cache them separately.
    searchTier,
  });
  const cached = await cacheGet<CachedSearchValue>(key);
  if (cached?.candidates) {
    logger.info("search-osm cache hit", {
      userId: req.dbUserId,
      ms: Date.now() - t0,
      candidateCount: cached.candidates.length,
      matchMode: cached.matchMode,
    });
    const effective = cached.effectiveBbox ?? bbox;
    const response: SearchOsmResponse = {
      bbox: effective,
      requestedBbox: bbox,
      center: bboxCenter(effective),
      candidates: cached.candidates,
      cached: true,
      bboxSource,
      matchMode: cached.matchMode,
      primaryTag: cached.primaryTag,
      expansionMultiplier: cached.expansionMultiplier ?? 1,
      mirror: null,
      alternativesTried: cached.alternativesTried ?? 1,
      alternativesSucceeded: cached.alternativesSucceeded ?? cached.alternativesTried ?? 1,
      providerStats:
        cached.providerStats ??
        ({} as Record<ProviderName, { count: number; ms: number; error: string | null }>),
      highConfidence: cached.highConfidence ?? false,
    };
    return NextResponse.json(response, { status: 200 });
  }

  // 3) PARALLEL: run OSM and the provider registry.
  //    OSM has its own tier-relaxation logic; providers each cache for
  //    7 days so re-runs are nearly free.
  const osmPromise = (async () => {
    return effectiveAlternatives.length > 1
      ? await searchOsmRich({
          bbox,
          osmTagsAlternatives: effectiveAlternatives,
        })
      : await searchOsm({ bbox, osmTags: effectiveAlternatives[0]! });
  })();
  const providersPromise = runProviders({
    bbox,
    sceneTokens,
    locationKind,
    osmTagsAlternatives: effectiveAlternatives,
  });

  // 3b) DEEP TIER ONLY: parallel Google Places searchText. This is the
  // entity-name index — for prompts like "horse statue in a park" or
  // "diner conversation" Google's place index returns named matches
  // (Sherman Monument, Joan of Arc Statue, ...) instantly. We pay
  // ~$0.02 per searchText call and gate this behind the "deep" tier
  // so free-tier searches stay near-zero cost.
  const googleTextPromise: Promise<GooglePlace[]> =
    searchTier === "deep" && googleQuery && googleQuery.trim().length >= 2
      ? searchText({
          textQuery: googleQuery,
          bbox,
          includedType: googleTypes?.[0],
          includeClosedPermanently: false,
          maxResultCount: 20,
        }).catch((err) => {
          logger.warn("deep-tier Google searchText threw (non-fatal)", {
            err: err instanceof Error ? err.message : String(err),
          });
          return [];
        })
      : Promise.resolve([] as GooglePlace[]);

  let osmResult;
  try {
    [osmResult] = await Promise.all([osmPromise]);
  } catch (err) {
    logger.error("search-osm overpass failed", {
      userId: req.dbUserId,
      err: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      {
        error: "overpass_failed",
        message: "Couldn't reach the OpenStreetMap query service. Try again in a moment.",
      },
      { status: 502 },
    );
  }
  // Providers must NEVER throw; if they do, runProviders catches and
  // returns an error stat. We await separately so an OSM throw doesn't
  // cancel them (and vice versa).
  const providerResult = await providersPromise;
  const googleTextResults = await googleTextPromise;

  let effectiveBbox = osmResult.effectiveBbox;
  const osmCandidates = osmResult.candidates;
  let finalMatchMode: ExtendedMatchMode = osmResult.matchMode;
  let finalExpansion: 1 | 2 | 4 = osmResult.expansionMultiplier;
  let finalPrimaryTag = osmResult.primaryTag;

  // 3.5) Mapillary detections — additional OSM-flavored candidates from
  // street-level object detections (benches, hydrants, etc.).
  const mapillaryCandidates: OsmCandidate[] = [];
  if (mapillaryClasses && mapillaryClasses.length > 0) {
    const bboxStr = `${effectiveBbox.west},${effectiveBbox.south},${effectiveBbox.east},${effectiveBbox.north}`;
    try {
      const detections = await findDetectionsInBbox({
        bboxStr,
        classes: mapillaryClasses,
        limit: 80,
      });
      for (const d of detections) {
        mapillaryCandidates.push({
          id: `mapillary/${d.id}`,
          type: "node",
          osmId: 0,
          lat: d.lat,
          lng: d.lng,
          tags: { [`mapillary:${d.objectClass}`]: "yes" },
          name: null,
        });
      }
      if (detections.length > 0) {
        logger.info("search-osm Mapillary detections merged", {
          count: detections.length,
        });
      }
    } catch (err) {
      logger.warn("search-osm Mapillary detections threw (non-fatal)", {
        err: String(err),
      });
    }
  }

  // 4) Build the unified raw-candidate pool: OSM + Mapillary + providers
  //    + (deep tier only) Google Places searchText.
  const rawCandidates: RawCandidate[] = [
    ...osmCandidates.map(osmCandidateToRaw),
    ...mapillaryCandidates.map(osmCandidateToRaw),
    ...providerResult.candidates,
    ...googleTextResults.map(googlePlaceToRaw),
  ];
  if (googleTextResults.length > 0) {
    logger.info("search-osm deep-tier Google searchText contributed", {
      count: googleTextResults.length,
    });
  }

  // 4.5) B2 — Google Places text-search fallback. Triggered when EVERY
  // source came back empty (OSM + providers + Mapillary).
  if (
    rawCandidates.length === 0 &&
    googleQuery &&
    googleQuery.trim().length >= 2
  ) {
    logger.info("search-osm all sources empty, attempting Google Places text fallback", {
      userId: req.dbUserId,
      googleQuery,
    });

    const includeClosed = sceneImpliesAbandonment({ osmTags, googleQuery });
    const places = await searchText({
      textQuery: googleQuery,
      bbox: effectiveBbox,
      includedType: googleTypes?.[0],
      includeClosedPermanently: includeClosed,
      maxResultCount: 15,
    });

    if (places.length > 0) {
      rawCandidates.push(...places.map(googlePlaceToRaw));
      finalMatchMode = "google_text_fallback";
      finalExpansion = osmResult.expansionMultiplier;
      finalPrimaryTag = null;
      logger.info("search-osm Google Places fallback hit", {
        count: places.length,
      });
    }
  }

  // 5) Merge by 50m proximity, preferring richer sources. Per-source
  // ranks (used by RRF) are tracked in mergeCandidates.
  const merged = mergeCandidates(rawCandidates);

  // 5.5) Drop low-signal OSM-only candidates.
  // OSM has tons of un-named polygons (`tourism=attraction` for an empty
  // park lawn, `building=yes` for a generic shed, ...). When OSM is the
  // ONLY source for a candidate AND there's no `name` tag AND no
  // structural keyword the user actually asked about (abandoned/ruins/
  // material/forest/...), drop it. Cards without curated metadata are
  // close to useless to filmmakers.
  const STRUCTURAL_KEEP_TAGS = new Set([
    "abandoned",
    "ruins",
    "disused",
    "building:material",
    "building:colour",
    "natural",
    "leisure",
    "historic",
    "memorial",
    "tourism",
  ]);
  const filteredMerged = merged.filter((c) => {
    if (c.sources.length > 1 || c.primarySource !== "osm") return true;
    if (c.name && c.name.trim().length > 0) return true;
    for (const k of Object.keys(c.tags)) {
      if (STRUCTURAL_KEEP_TAGS.has(k)) return true;
    }
    return false;
  });
  const droppedOsmNoise = merged.length - filteredMerged.length;

  // 5.7) Score each candidate with RRF (across retrievers) AND IDF-
  // weighted tag overlap (against the user's prompt-derived scene_tokens).
  // The combined rank is what drives the final ordering — pure proximity-
  // sort produced terrible results because it surfaced un-named OSM
  // polygons close to the bbox center over actual landmarks across town.
  //
  // For prompts where Claude emitted a name-keyword alternative
  // ({ "name": "horse|equestrian|cavalry|..." }), pull that regex out
  // and use it as a STRONG name-match multiplier in tag-overlap. This
  // is the "horse statue ranks above Statue of Liberty even when
  // Liberty has higher RRF" rule — Liberty's NAME doesn't contain a
  // horse-synonym so it doesn't get the boost.
  const subjectNameRegex =
    effectiveAlternatives.find((alt) => "name" in alt)?.name ?? null;
  const rrfRanked = rrfRank(filteredMerged, locationKind);
  const overlapByCandidate = new Map<string, TagOverlapScore>();
  for (const c of rrfRanked) {
    const overlap = tagOverlapScore(c, sceneTokens, { subjectNameRegex });
    overlapByCandidate.set(c.id, overlap);
  }

  // 5.8) Optional hard filter: when the user supplied 4+ distinctive
  // scene tokens AND we have at least 6 candidates with at least
  // *meaningful* IDF-weighted overlap (>=0.5, i.e. one common-token
  // match like "park" or "monument"), drop candidates with negligible
  // overlap (<0.5). This is the "horse statue removes NYU and the
  // Woolworth Building from the pool" rule.
  const distinctiveTokenCount = sceneTokens.filter((t) => t.length > 2).length;
  const withOverlapCount = Array.from(overlapByCandidate.values()).filter(
    (o) => o.score >= MIN_USEFUL_OVERLAP_SCORE,
  ).length;
  const applyHardFilter = distinctiveTokenCount >= 4 && withOverlapCount >= 6;
  const afterTagFilter = applyHardFilter
    ? rrfRanked.filter(
        (c) =>
          (overlapByCandidate.get(c.id)?.score ?? 0) >= MIN_USEFUL_OVERLAP_SCORE,
      )
    : rrfRanked;
  const droppedZeroOverlap = rrfRanked.length - afterTagFilter.length;

  // 5.9) SUBJECT-REQUIRED HARD FILTER. This is the "Statue of Liberty
  // is not a horse statue" rule.
  //
  // When the user's prompt has a clear SUBJECT noun (Claude emitted a
  // "name" alternative in osm_tags_alternatives, or scene_tokens
  // contains a high-IDF subject word like "horse"/"lighthouse"), every
  // surviving candidate MUST physically reference that subject — the
  // candidate's name OR description OR tag values must contain the
  // subject noun OR one of its synonyms from the regex.
  //
  // Without this filter:
  //   - UNESCO Statue of Liberty (text: "Made in Paris by Bartholdi...")
  //     passes because it matches "statue" via tag-overlap
  //   - JQA Ward standing-Washington (text: "bronze statue on Wall St")
  //     passes for the same reason
  //
  // With this filter, both drop because their text contains zero
  // horse-synonym tokens.
  const subjectKeywords = collectSubjectKeywords(
    subjectNameRegex,
    sceneTokens,
  );
  const subjectMatcher = buildSubjectMatcher(subjectKeywords);
  const subjectFiltered = subjectMatcher
    ? afterTagFilter.filter((c) => {
        const blob = candidateBlob(c).toLowerCase();
        return subjectMatcher.test(blob);
      })
    : afterTagFilter;
  // Don't apply the filter if it would empty the pool — prefer 12
  // marginal results to zero results.
  const finalAfterSubject =
    subjectMatcher && subjectFiltered.length >= 3
      ? subjectFiltered
      : afterTagFilter;
  const droppedNoSubject = afterTagFilter.length - finalAfterSubject.length;

  // 6) Convert to RankedCandidate[], rank by combined RRF + tag-overlap
  // score (descending), then break ties by distance from search center.
  const center = bboxCenter(effectiveBbox);
  const ranked: RankedCandidate[] = finalAfterSubject
    .map((m) => {
      const overlap = overlapByCandidate.get(m.id) ?? {
        matched: [],
        score: 0,
      };
      return {
        id: m.id,
        type:
          m.primarySource === "osm" ? inferTypeFromId(m.externalIds.osm ?? "") : "node",
        osmId: inferOsmId(m.externalIds),
        lat: m.lat,
        lng: m.lng,
        tags: m.tags,
        name: m.name,
        sources: m.sources,
        primarySource: m.primarySource,
        description: m.description,
        knownImageUrl: m.knownImageUrl,
        associatedFilms: m.associatedFilms,
        sourceUrl: m.sourceUrl,
        distanceMeters: distanceMeters(center, { lat: m.lat, lng: m.lng }),
        rrfScore: m.rrfScore,
        tagOverlapScore: overlap.score,
        matchedTokens: overlap.matched,
      };
    })
    .sort((a, b) => {
      const aCombined = combinedRank(a.rrfScore, {
        matched: a.matchedTokens,
        score: a.tagOverlapScore,
      });
      const bCombined = combinedRank(b.rrfScore, {
        matched: b.matchedTokens,
        score: b.tagOverlapScore,
      });
      if (bCombined !== aCombined) return bCombined - aCombined;
      return a.distanceMeters - b.distanceMeters;
    })
    .slice(0, MAX_OUTPUT_CANDIDATES);

  // 6.5) Decide whether vision scoring is necessary at enrichment time.
  // Strong tag overlap on enough candidates means vision is unlikely to
  // change the ranking, so the enrichment route can skip it (free tier
  // automatically; deep tier as a latency optimization).
  const topOverlap =
    ranked.length > 0
      ? overlapByCandidate.get(ranked[0]!.id) ?? null
      : null;
  const highConfidence = isHighConfidence({
    topOverlap,
    poolOverlaps: Array.from(overlapByCandidate.values()),
    sceneTokens,
  });

  if (droppedOsmNoise > 0 || droppedZeroOverlap > 0 || droppedNoSubject > 0) {
    logger.info("search-osm filter stats", {
      droppedOsmNoise,
      droppedZeroOverlap,
      droppedNoSubject,
      applyHardFilter,
      subjectKeywords,
      finalCount: ranked.length,
    });
  }

  // 7) Cache.
  const alternativesTried =
    "alternativesTried" in osmResult
      ? (osmResult as { alternativesTried: number }).alternativesTried
      : 1;
  const alternativesSucceeded =
    "alternativesSucceeded" in osmResult
      ? (osmResult as { alternativesSucceeded: number }).alternativesSucceeded
      : 1;

  const toCache: CachedSearchValue = {
    candidates: ranked,
    effectiveBbox,
    matchMode: finalMatchMode,
    primaryTag: finalPrimaryTag,
    expansionMultiplier: finalExpansion,
    alternativesTried,
    alternativesSucceeded,
    providerStats: providerResult.perProvider,
    highConfidence,
  };
  await cacheSet(key, "overpass:v3", toCache, 14);

  logger.info("search-osm success", {
    userId: req.dbUserId,
    ms: Date.now() - t0,
    osmCount: osmCandidates.length,
    mapillaryCount: mapillaryCandidates.length,
    providerCount: providerResult.candidates.length,
    rawTotal: rawCandidates.length,
    rendered: ranked.length,
    matchMode: finalMatchMode,
    perProvider: providerResult.perProvider,
  });

  const response: SearchOsmResponse = {
    bbox: effectiveBbox,
    requestedBbox: bbox,
    center,
    candidates: ranked,
    cached: false,
    bboxSource,
    matchMode: finalMatchMode,
    primaryTag: finalPrimaryTag,
    expansionMultiplier: finalExpansion,
    mirror: osmResult.mirror,
    alternativesTried,
    alternativesSucceeded,
    providerStats: providerResult.perProvider,
    highConfidence,
  };
  return NextResponse.json(response, { status: 200 });
});
