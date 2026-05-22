import { z } from "zod";

import type { SceneAnalysis } from "@/lib/claude";
import { mapSceneToMapillary } from "@/lib/mapillary/scene-to-classes";
import type { ProviderName } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Retrieval plan — produced at parse-scene, executed deterministically at
// search + enrich. Model-agnostic (Claude today; swappable later).
// ---------------------------------------------------------------------------

export const primarySubjectTypeSchema = z.enum([
  "named_entity",
  "osm_feature",
  "street_object",
  "landscape",
  "interior",
  "generic",
]);

export const conceptRoleSchema = z.enum([
  "primary",
  "setting",
  "background",
  "street_object",
]);

export const mapillaryModeSchema = z.enum([
  "none",
  "point_images",
  "bbox_objects",
  "image_scan",
]);

export const enrichStrategySchema = z.enum([
  "default",
  "subject_then_mapillary_then_background",
  "landscape_image_scan",
]);

export const conceptSchema = z.object({
  id: z.string().min(1),
  terms: z.array(z.string()).default([]),
  role: conceptRoleSchema,
  weight: z.number().min(0).max(3).default(1),
  verify_in: z.enum(["mapillary_photo", "none"]).optional().default("none"),
});

/**
 * Per-source query hints emitted by the planner. Each provider reads
 * the slice it cares about; unknown fields are ignored. Generic for any
 * prompt — the hints are FILLED FROM THE PROMPT PARSE, not hardcoded.
 *
 * Examples:
 *   - osm.extra_arms: extra Overpass alternatives keyed on
 *     subject-family keys (artwork_subject, statue, memorial, …) with
 *     values pulled from the user's prompt nouns. The OSM provider
 *     unions them with the regular `osm_tags_alternatives`.
 *   - wikidata.depicts_qids: Q-ids the planner already resolved (via
 *     SUBJECT_QIDS dictionary or wbsearchentities). The Wikidata
 *     provider runs an extra P180-depicts query for them.
 *   - wikidata.classes_qids: instance-of Q-ids ("statue" → Q860861)
 *     the planner resolved from the prompt's form noun.
 *   - wikipedia.run_only_when_no_qids: when true, the Wikipedia
 *     provider self-skips if the Q-id pool from OSM/Wikidata is
 *     non-empty. Avoids redundant work.
 *   - mapillary.points_classes: bbox-searchable Points classes the
 *     planner picked (already covered by mapillary.classes; mirrored
 *     here for symmetry).
 */
export const queryHintsSchema = z
  .object({
    extra_arms: z.array(z.record(z.string(), z.string())).optional(),
    description_keys: z.array(z.string()).optional(),
    depicts_qids: z.array(z.string()).optional(),
    classes_qids: z.array(z.string()).optional(),
    run_only_when_no_qids: z.boolean().optional(),
    points_classes: z.array(z.string()).optional(),
  })
  .partial();

export const sourceToggleSchema = z.object({
  enabled: z.boolean().default(true),
  priority: z.number().min(0).max(2).default(1),
  reason: z.string().optional(),
  query_hints: queryHintsSchema.optional(),
});

export const retrievalPlanSchema = z.object({
  primary_subject: z
    .object({
      type: primarySubjectTypeSchema,
      label: z.string().default(""),
      osm_focus: z.boolean().default(true),
      wikidata_focus: z.boolean().default(true),
    })
    .optional(),
  enrich_strategy: enrichStrategySchema.default("default"),
  concepts: z.array(conceptSchema).default([]),
  dependencies: z
    .array(
      z.object({
        kind: z.enum(["in_setting", "requires"]),
        primary: z.string(),
        secondary: z.string(),
      }),
    )
    .default([]),
  sources: z.record(z.string(), sourceToggleSchema).default({}),
  mapillary: z
    .object({
      mode: mapillaryModeSchema.default("none"),
      classes: z.array(z.string()).default([]),
      image_scan_required_classes: z.array(z.string()).default([]),
      min_classes_for_filter: z.number().int().min(1).max(6).default(2),
      use_for: z
        .array(z.enum(["attach_photos", "background_verify", "find_subject"]))
        .default(["attach_photos"]),
      rationale: z.string().optional(),
    })
    .default({
      mode: "none",
      classes: [],
      image_scan_required_classes: [],
      min_classes_for_filter: 2,
      use_for: ["attach_photos"],
    }),
  ranking: z
    .object({
      use_concept_weights: z.boolean().default(true),
      tier_mapillary_with_background_first: z.boolean().default(false),
      min_primary_overlap: z.number().min(0).default(0.5),
    })
    .default({
      use_concept_weights: true,
      tier_mapillary_with_background_first: false,
      min_primary_overlap: 0.5,
    }),
});

export type RetrievalPlan = z.infer<typeof retrievalPlanSchema>;
export type MapillaryMode = z.infer<typeof mapillaryModeSchema>;
export type EnrichStrategy = z.infer<typeof enrichStrategySchema>;
export type QueryHints = z.infer<typeof queryHintsSchema>;

const CONTENT_PROVIDER_NAMES: ReadonlyArray<ProviderName> = [
  "own-db",
  "wikidata-landmark",
  "wikipedia-geosearch",
  "nps-places",
  "ridb-recreation",
];

/** Mapillary detection classes used to verify background concepts in photos. */
export const BACKGROUND_TERM_TO_DETECTION: Readonly<Record<string, string>> = {
  tree: "nature--vegetation",
  trees: "nature--vegetation",
  vegetation: "nature--vegetation",
  grass: "nature--vegetation",
  wooded: "nature--vegetation",
  forest: "nature--vegetation",
  building: "construction--structure--building",
  buildings: "construction--structure--building",
  facade: "construction--structure--building",
  skyline: "construction--structure--building",
};

const SUBJECT_HINT_RE =
  /\b(statue|sculpture|monument|memorial|artwork|equestrian|lighthouse|windmill|fountain|obelisk|mural)\b/i;
const BACKGROUND_HINT_RE =
  /\b(trees?|buildings?|behind|background|backdrop|skyline|facade)\b/i;
const STREET_OBJECT_HINT_RE =
  /\b(bench|hydrant|bike\s*rack|cobblestone|phone\s*booth|mailbox|crosswalk)\b/i;
const LANDSCAPE_HINT_RE = /\b(mountain|road|highway|alps|vista|scenic\s*drive)\b/i;

export function parseRetrievalPlan(raw: unknown): RetrievalPlan | null {
  const r = retrievalPlanSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Deterministic fallback when Claude omits `retrieval_plan` (stale cache).
 */
export function deriveRetrievalPlan(analysis: SceneAnalysis): RetrievalPlan {
  const tokens = analysis.scene_tokens ?? [];
  const tokenBlob = tokens.join(" ").toLowerCase();
  const mly = mapSceneToMapillary({
    sceneTokens: tokens,
    mapillaryClasses: analysis.mapillary_classes ?? [],
    locationKind: analysis.location_kind,
  });

  const hasSubject = SUBJECT_HINT_RE.test(tokenBlob);
  const hasBackground = BACKGROUND_HINT_RE.test(tokenBlob);
  const hasStreetObject = STREET_OBJECT_HINT_RE.test(tokenBlob);
  const hasLandscape = LANDSCAPE_HINT_RE.test(tokenBlob);

  let enrichStrategy: EnrichStrategy = "default";
  let mapillaryMode: MapillaryMode = mly.bboxClasses.length > 0 ? "bbox_objects" : "none";

  if (hasLandscape && mly.imageScanClasses.length >= 1) {
    enrichStrategy = "landscape_image_scan";
    mapillaryMode = "image_scan";
  } else if (hasSubject) {
    enrichStrategy = hasBackground
      ? "subject_then_mapillary_then_background"
      : "default";
    mapillaryMode = "point_images";
  } else if (hasStreetObject && mly.bboxClasses.length > 0) {
    mapillaryMode = "bbox_objects";
  }

  const concepts: z.infer<typeof conceptSchema>[] = [];
  if (hasSubject) {
    concepts.push({
      id: "subject",
      terms: tokens.filter((t) => SUBJECT_HINT_RE.test(t) || t.length > 4),
      role: "primary",
      weight: 1,
      verify_in: "none",
    });
  }
  if (hasBackground) {
    const bgTerms = tokens.filter((t) => BACKGROUND_HINT_RE.test(t));
    if (bgTerms.length > 0) {
      concepts.push({
        id: "background",
        terms: bgTerms,
        role: "background",
        weight: 0.4,
        verify_in: "mapillary_photo",
      });
    }
  }

  // Deterministic fallback: synthesize subject-family arms from the
  // existing osm_tags_alternatives. Anything Claude already emitted on
  // the subject-family keys (artwork_subject / statue / memorial /
  // historic:civilization / building:architecture) bubbles up as
  // OSM extra_arms so the executor reads it from the plan rather
  // than re-walking the alternatives. Generic for any prompt.
  const subjectFamilyKeys = new Set([
    "artwork_subject",
    "artwork_type",
    "statue",
    "memorial",
    "subject",
    "historic:civilization",
    "building:architecture",
  ]);
  const osmExtraArms: Array<Record<string, string>> = [];
  for (const alt of analysis.osm_tags_alternatives ?? []) {
    for (const key of Object.keys(alt)) {
      if (subjectFamilyKeys.has(key)) {
        osmExtraArms.push(alt);
        break;
      }
    }
  }

  const sources: Record<string, z.infer<typeof sourceToggleSchema>> = {};
  for (const p of CONTENT_PROVIDER_NAMES) {
    let enabled = true;
    let priority = 1;
    if (p === "nps-places" && hasSubject && analysis.location_kind === "urban") {
      enabled = false;
      priority = 0;
    }
    if (p === "ridb-recreation" && !hasLandscape && analysis.location_kind !== "wilderness") {
      enabled = false;
      priority = 0;
    }
    const entry: z.infer<typeof sourceToggleSchema> = { enabled, priority };
    if (p === "wikipedia-geosearch") {
      // Cheap default: gate Wikipedia on Q-id pool emptiness. The
      // sitelinks pipeline (lib/wikipedia-extracts) handles the
      // descriptions for items we already have via Wikidata.
      entry.query_hints = { run_only_when_no_qids: true };
    }
    sources[p] = entry;
  }
  // OSM hints — emit only when we found subject-family arms.
  if (osmExtraArms.length > 0) {
    sources["osm"] = {
      enabled: true,
      priority: 1,
      query_hints: { extra_arms: osmExtraArms },
    };
  }

  return {
    primary_subject: hasSubject
      ? {
          type: "named_entity",
          label: tokens.find((t) => SUBJECT_HINT_RE.test(t)) ?? "subject",
          osm_focus: true,
          wikidata_focus: true,
        }
      : undefined,
    enrich_strategy: enrichStrategy,
    concepts,
    dependencies: [],
    sources,
    mapillary: {
      mode: mapillaryMode,
      classes:
        mapillaryMode === "bbox_objects"
          ? mly.bboxClasses
          : mapillaryMode === "image_scan"
            ? mly.imageScanClasses
            : [],
      image_scan_required_classes:
        mapillaryMode === "image_scan" ? mly.imageScanClasses : [],
      min_classes_for_filter: 2,
      use_for:
        enrichStrategy === "subject_then_mapillary_then_background"
          ? ["attach_photos", "background_verify"]
          : ["attach_photos"],
      rationale: "derived-fallback",
    },
    ranking: {
      use_concept_weights: true,
      tier_mapillary_with_background_first:
        enrichStrategy === "subject_then_mapillary_then_background",
      min_primary_overlap: 0.5,
    },
  };
}

export function resolveRetrievalPlan(analysis: SceneAnalysis): RetrievalPlan {
  const parsed = analysis.retrieval_plan
    ? parseRetrievalPlan(analysis.retrieval_plan)
    : null;
  if (parsed) return parsed;
  return deriveRetrievalPlan(analysis);
}

export function isProviderEnabled(plan: RetrievalPlan, name: ProviderName): boolean {
  const entry = plan.sources[name];
  if (!entry) return true;
  return entry.enabled !== false;
}

export function shouldRunMapillaryBboxSearch(plan: RetrievalPlan): boolean {
  if (plan.mapillary.mode !== "bbox_objects") return false;
  if (plan.mapillary.use_for.includes("find_subject")) return true;
  return plan.mapillary.classes.length > 0;
}

export function shouldSkipEnrichBboxDetectionFilter(plan: RetrievalPlan): boolean {
  return (
    plan.enrich_strategy === "subject_then_mapillary_then_background" ||
    plan.mapillary.mode === "point_images" ||
    plan.mapillary.mode === "none"
  );
}

export function shouldUseEnrichDetectionFilter(plan: RetrievalPlan): boolean {
  if (shouldSkipEnrichBboxDetectionFilter(plan)) return false;
  if (plan.mapillary.mode !== "bbox_objects") return false;
  const min = plan.mapillary.min_classes_for_filter ?? 2;
  return plan.mapillary.classes.length >= min;
}

/** Per-token weight multiplier for tag-overlap (primary=1, setting/background lower). */
export function buildConceptTokenWeights(plan: RetrievalPlan): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const c of plan.concepts) {
    const roleMul =
      c.role === "primary" ? 1 : c.role === "setting" ? 0.25 : c.role === "background" ? 0.4 : 0.7;
    const w = c.weight * roleMul;
    for (const term of c.terms) {
      const key = term.toLowerCase().trim();
      if (key.length < 2) continue;
      map.set(key, Math.max(map.get(key) ?? 0, w));
    }
  }
  return map;
}

export function backgroundDetectionClasses(plan: RetrievalPlan): string[] {
  const out = new Set<string>();
  for (const c of plan.concepts) {
    if (c.role !== "background" || c.verify_in !== "mapillary_photo") continue;
    for (const term of c.terms) {
      const norm = term.toLowerCase().trim();
      const det = BACKGROUND_TERM_TO_DETECTION[norm];
      if (det) out.add(det);
    }
  }
  if (out.size === 0) {
    for (const term of Object.keys(BACKGROUND_TERM_TO_DETECTION)) {
      if (plan.concepts.some((c) => c.terms.some((t) => t.toLowerCase().includes(term)))) {
        out.add(BACKGROUND_TERM_TO_DETECTION[term]!);
      }
    }
  }
  return [...out];
}

export function resolveMapillaryClassesFromPlan(plan: RetrievalPlan): {
  bboxClasses: string[];
  imageScanClasses: string[];
} {
  if (plan.mapillary.mode === "bbox_objects") {
    return { bboxClasses: plan.mapillary.classes, imageScanClasses: [] };
  }
  if (plan.mapillary.mode === "image_scan") {
    return {
      bboxClasses: [],
      imageScanClasses: plan.mapillary.image_scan_required_classes,
    };
  }
  return { bboxClasses: [], imageScanClasses: [] };
}

export type EnrichRankTier = 1 | 2 | 3 | 4;

export function computeEnrichRankTier(input: {
  mapillaryAttached: boolean;
  backgroundMatchCount: number;
  backgroundRequested: boolean;
  tagHitCount: number;
  hasCuratedImage: boolean;
}): EnrichRankTier {
  const {
    mapillaryAttached,
    backgroundMatchCount,
    backgroundRequested,
    tagHitCount,
    hasCuratedImage,
  } = input;

  if (mapillaryAttached && backgroundRequested && backgroundMatchCount > 0) return 1;
  if (mapillaryAttached) return 2;
  if (tagHitCount >= 2 || hasCuratedImage) return 3;
  return 4;
}

export function compareEnrichTiers(
  a: {
    tier: EnrichRankTier;
    tagHitCount: number;
    visionScore: number;
    distanceMeters: number;
  },
  b: {
    tier: EnrichRankTier;
    tagHitCount: number;
    visionScore: number;
    distanceMeters: number;
  },
): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tagHitCount !== b.tagHitCount) return b.tagHitCount - a.tagHitCount;
  if (a.visionScore !== b.visionScore) return b.visionScore - a.visionScore;
  return a.distanceMeters - b.distanceMeters;
}

// ---------------------------------------------------------------------------
// Per-source query-hint readers
// ---------------------------------------------------------------------------

export function getProviderQueryHints(
  plan: RetrievalPlan | null | undefined,
  name: ProviderName,
): QueryHints | null {
  if (!plan) return null;
  const entry = plan.sources[name];
  return entry?.query_hints ?? null;
}

/**
 * OSM Overpass extra subject-family arms. Pulled from the planner's
 * hints OR derived from `osm_tags_alternatives` already present (i.e.
 * arms whose keys are in the subject-family list).
 */
export function getOsmExtraArms(
  plan: RetrievalPlan | null | undefined,
): Array<Record<string, string>> {
  const hints = getProviderQueryHints(plan, "osm");
  return hints?.extra_arms ?? [];
}

/**
 * Wikidata Q-id list for the depicts (P180) query. Set when the
 * planner resolved a subject noun to a Q-id (via the dictionary or
 * wbsearchentities). Empty when the prompt names no concrete subject.
 */
export function getWikidataDepictsQids(
  plan: RetrievalPlan | null | undefined,
): string[] {
  const hints = getProviderQueryHints(plan, "wikidata-landmark");
  return (hints?.depicts_qids ?? []).filter((q) => /^Q\d+$/.test(q));
}

export function getWikidataClassesQids(
  plan: RetrievalPlan | null | undefined,
): string[] {
  const hints = getProviderQueryHints(plan, "wikidata-landmark");
  return (hints?.classes_qids ?? []).filter((q) => /^Q\d+$/.test(q));
}

/**
 * When true, the Wikipedia geosearch / fulltext provider should
 * SELF-SKIP if the Q-id pool from upstream sources is non-empty.
 * Default: true when the planner's `wikipedia-geosearch` source has
 * `run_only_when_no_qids: true` set.
 */
export function shouldGateWikipediaOnQids(
  plan: RetrievalPlan | null | undefined,
): boolean {
  const hints = getProviderQueryHints(plan, "wikipedia-geosearch");
  return hints?.run_only_when_no_qids === true;
}
