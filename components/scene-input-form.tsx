"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import posthog from "posthog-js";

import type { Bbox } from "@/lib/bbox";
import type { SceneAnalysis } from "@/lib/claude";
import type { OsmCandidate } from "@/lib/overpass";
import type {
  DeepLinks,
  PhotoAttribution,
  PhotoSource,
} from "@/components/contracts";
import { LocationCard } from "@/components/location-card";

// ---------------------------------------------------------------------------
// Form schema (client-side validation; mirrors the server's stricter check).
// ---------------------------------------------------------------------------

const RADIUS_OPTIONS = [
  { value: 5, label: "5 miles" },
  { value: 10, label: "10 miles" },
  { value: 25, label: "25 miles" },
  { value: 50, label: "50 miles" },
  { value: 100, label: "100 miles" },
] as const;

type RadiusValue = (typeof RADIUS_OPTIONS)[number]["value"] | "any";

const formSchema = z.object({
  sceneText: z
    .string()
    .min(10, "At least 10 characters please.")
    .max(20_000, "Keep it under 20,000 characters."),
  location: z
    .string()
    .max(160, "Location is too long.")
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  radius: z.enum(["any", "5", "10", "25", "50", "100"]).default("any"),
});

type FormValues = z.input<typeof formSchema>;

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

type ParseSceneResponse = {
  analysis: SceneAnalysis;
  cached: boolean;
  attempts: number;
  echo?: { location: string | null; radiusMiles: number | null };
  rateLimit: { used: number; limit: number; remaining: number; resetAt: string };
};

type RankedCandidate = OsmCandidate & { distanceMeters: number };

type SearchOsmResponse = {
  bbox: Bbox;
  requestedBbox: Bbox;
  center: { lat: number; lng: number };
  candidates: RankedCandidate[];
  cached: boolean;
  bboxSource: "geocoded_city" | "geocoded_radius" | "supplied";
  matchMode:
    | "strict"
    | "primary_only"
    | "primary_only_expanded"
    | "best_effort"
    | "google_text_fallback";
  primaryTag: { key: string; value: string } | null;
  expansionMultiplier: 1 | 2 | 4;
  mirror: string | null;
  alternativesTried: number;
  alternativesSucceeded: number;
};

type SelectedPhoto = {
  url: string;
  source: PhotoSource;
  capturedAt: string | null;
  attributionText: string;
  attributionHref: string | null;
  visionScore: number | null;
  visionReason: string | null;
};

type EnrichedLocation = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  distanceMeters: number | null;
  primaryType: string | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: string | null;
  editorialSummary: string | null;
  googleMapsUri: string | null;
  websiteUri: string | null;
  photo: SelectedPhoto | null;
  alternatePhotos: ReadonlyArray<SelectedPhoto>;
  streetView: {
    available: boolean;
    capturedAt: string | null;
    thumbUrl: string | null;
    copyright: string | null;
  };
  deepLinks: DeepLinks;
  badges: ReadonlyArray<{ key: string; value: string }>;
  enrichmentSparse: boolean;
};

type EnrichResponse = {
  locations: EnrichedLocation[];
  visionScoringApplied: boolean;
  pipelineStats: {
    inputCandidates: number;
    afterDedupe: number;
    afterColorFilter: number;
    afterDetectionFilter: number;
    afterVisionFilter: number;
    finalRendered: number;
    targetColor: string | null;
    mapillaryDetectionsFound: number;
  };
};

type ApiError = { error: string; message?: string };

async function parseSceneRequest(input: {
  sceneText: string;
  location?: string;
  radiusMiles: number | null;
}): Promise<ParseSceneResponse> {
  const res = await fetch("/api/parse-scene", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(err?.message ?? err?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ParseSceneResponse;
}

async function searchOsmRequest(input: {
  osmTags: Record<string, string>;
  osmTagsAlternatives?: ReadonlyArray<Record<string, string>>;
  googleTypes?: string[];
  googleQuery?: string;
  mapillaryClasses?: string[];
  location?: string;
  radiusMiles: number | null;
}): Promise<SearchOsmResponse> {
  const res = await fetch("/api/search-osm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(err?.message ?? err?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as SearchOsmResponse;
}

async function enrichLocationsRequest(input: {
  candidates: ReadonlyArray<{
    id: string;
    type: "node" | "way" | "relation";
    lat: number;
    lng: number;
    tags: Record<string, string>;
    name?: string | null;
  }>;
  searchCenter?: { lat: number; lng: number };
  searchBbox?: { south: number; west: number; north: number; east: number };
  includeClosed?: boolean;
  sceneDescription: string;
  sceneTokens?: ReadonlyArray<string>;
  visionScoreLimit?: number;
  minVisionScore?: number;
  mapillaryClasses?: ReadonlyArray<string>;
}): Promise<EnrichResponse> {
  const res = await fetch("/api/enrich-locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(err?.message ?? err?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as EnrichResponse;
}

type ReverseGeocodeResponse = {
  label: string;
  fullLabel: string;
  lat: number;
  lng: number;
};

async function reverseGeocodeRequest(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResponse> {
  const res = await fetch("/api/reverse-geocode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lat, lng }),
  });
  if (!res.ok) {
    throw new Error(`Couldn't resolve your location (HTTP ${res.status}).`);
  }
  return (await res.json()) as ReverseGeocodeResponse;
}

function browserGeolocate(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Your browser doesn't support geolocation."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 60_000,
      timeout: 10_000,
    });
  });
}

// ---------------------------------------------------------------------------
// Sample prompts
// ---------------------------------------------------------------------------

const SAMPLES: ReadonlyArray<{
  label: string;
  sceneText: string;
  location?: string;
  radius?: RadiusValue;
}> = [
  {
    label: "Abandoned Brooklyn warehouse",
    sceneText:
      "Late-night fight scene inside an abandoned brick warehouse with broken windows and exposed steel beams. Single overhead practical light, puddles on the floor.",
    location: "Brooklyn, NY",
    radius: 25,
  },
  {
    label: "Diner conversation, NYC",
    sceneText:
      "Two characters in a corner booth of a 24-hour diner. Neon glow from outside, chrome stools at the counter, formica tabletops. Late-night conversation.",
    location: "New York, NY",
    radius: 10,
  },
  {
    label: "Atlanta back-porch dusk",
    sceneText:
      "Quiet conversation on the back porch of a small bungalow. Wooden porch swing, peeling white paint, dense overgrown yard, fireflies, golden-hour sky.",
    location: "Atlanta, GA",
    radius: 50,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type SceneInputFormProps = {
  /** Optional starting scene text (e.g. when loading from search history). */
  initialSceneText?: string;
  /** Optional starting location (free text: city, area, or address). */
  initialLocation?: string;
  /** Optional starting radius in miles, or "any" for the city's natural bbox. */
  initialRadius?: RadiusValue;
  /** Optional pre-existing analysis to render below the form on first paint. */
  initialAnalysis?: SceneAnalysis | null;
};

type Stage =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "searching-osm" }
  | { kind: "enriching" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const MAX_ENRICH_CANDIDATES = 15;

export function SceneInputForm({
  initialSceneText = "",
  initialLocation = "",
  initialRadius = "any",
  initialAnalysis = null,
}: SceneInputFormProps) {
  const [geoStatus, setGeoStatus] = useState<"idle" | "locating" | "error">("idle");
  const [geoError, setGeoError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const [parseResult, setParseResult] = useState<ParseSceneResponse | null>(
    initialAnalysis
      ? {
          analysis: initialAnalysis,
          cached: true,
          attempts: 1,
          rateLimit: {
            used: 0,
            limit: 5,
            remaining: 5,
            resetAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
          },
        }
      : null,
  );
  const [osmResult, setOsmResult] = useState<SearchOsmResponse | null>(null);
  const [enrichResult, setEnrichResult] = useState<EnrichResponse | null>(null);
  const isFromHistory = initialAnalysis !== null && parseResult?.analysis === initialAnalysis;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sceneText: initialSceneText,
      location: initialLocation,
      radius:
        typeof initialRadius === "number"
          ? (String(initialRadius) as FormValues["radius"])
          : "any",
    },
  });

  const parseMutation = useMutation({ mutationFn: parseSceneRequest });
  const osmMutation = useMutation({ mutationFn: searchOsmRequest });
  const enrichMutation = useMutation({ mutationFn: enrichLocationsRequest });

  // If we hydrated from history with prior analysis, auto-fire OSM + enrich
  // so the user immediately sees the same map and result cards.
  useEffect(() => {
    if (!isFromHistory || !initialAnalysis) return;
    if (osmResult || osmMutation.isPending) return;
    const radiusMiles =
      typeof initialRadius === "number" ? (initialRadius as number) : null;
    void runOsmAndEnrich({
      analysis: initialAnalysis,
      location: initialLocation || undefined,
      radiusMiles,
      sceneText: initialSceneText,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sceneText = watch("sceneText");
  const charCount = sceneText?.length ?? 0;

  async function runOsmAndEnrich(args: {
    analysis: SceneAnalysis;
    location?: string;
    radiusMiles: number | null;
    sceneText: string;
  }): Promise<void> {
    const { analysis, location, radiusMiles, sceneText } = args;

    setStage({ kind: "searching-osm" });
    setEnrichResult(null);
    // Defensive defaults: cached entries from before Path A may not have
    // these fields. Rich alternatives are sent through when present;
    // otherwise the server falls back to single `osm_tags`.
    const osmTagsAlternatives =
      analysis.osm_tags_alternatives && analysis.osm_tags_alternatives.length > 0
        ? analysis.osm_tags_alternatives
        : undefined;
    const sceneTokens = analysis.scene_tokens ?? [];
    let osm: SearchOsmResponse;
    try {
      osm = await osmMutation.mutateAsync({
        osmTags: analysis.osm_tags,
        osmTagsAlternatives,
        googleTypes: analysis.google_types,
        googleQuery: analysis.google_query,
        mapillaryClasses: analysis.mapillary_classes,
        location,
        radiusMiles,
      });
      setOsmResult(osm);
      posthog.capture("osm_search_completed", {
        cached: osm.cached,
        candidateCount: osm.candidates.length,
        bboxSource: osm.bboxSource,
        matchMode: osm.matchMode,
        mirror: osm.mirror,
        alternativesTried: osm.alternativesTried,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "OSM search failed.";
      setStage({ kind: "error", message });
      posthog.capture("osm_search_failed", { error: message });
      return;
    }

    if (osm.candidates.length === 0) {
      setStage({ kind: "ready" });
      return;
    }

    setStage({ kind: "enriching" });
    const includeClosed = sceneImpliesAbandonment(analysis);
    // Combine the user's raw scene text with Claude's distilled visual
    // descriptor — the more signal we hand the vision scorer, the better
    // it can pick the matching photo.
    const sceneDescription = [sceneText.trim(), analysis.visual]
      .filter(Boolean)
      .join("\n\n");
    try {
      const enriched = await enrichMutation.mutateAsync({
        candidates: osm.candidates.slice(0, MAX_ENRICH_CANDIDATES).map((c) => ({
          id: c.id,
          type: c.type,
          lat: c.lat,
          lng: c.lng,
          tags: c.tags,
          name: c.name,
        })),
        searchCenter: osm.center,
        searchBbox: osm.bbox,
        includeClosed,
        sceneDescription,
        sceneTokens,
        visionScoreLimit: 10,
        minVisionScore: 30,
        mapillaryClasses: analysis.mapillary_classes ?? [],
      });
      setEnrichResult(enriched);
      setStage({ kind: "ready" });
      posthog.capture("enrich_completed", {
        candidateCount: enriched.locations.length,
        sparseCount: enriched.locations.filter((l) => l.enrichmentSparse).length,
        visionScoringApplied: enriched.visionScoringApplied,
        includeClosed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Enrichment failed.";
      setStage({ kind: "error", message });
      posthog.capture("enrich_failed", { error: message });
    }
  }

  function sceneImpliesAbandonment(analysis: SceneAnalysis): boolean {
    const ABANDONED_RE = /\b(abandoned|disused|ruined|ruins|derelict|boarded[- ]up|decayed|deserted|crumbling)\b/i;
    if (
      analysis.osm_tags.abandoned ||
      analysis.osm_tags.ruins ||
      analysis.osm_tags.disused
    ) {
      return true;
    }
    return (
      ABANDONED_RE.test(analysis.visual ?? "") ||
      ABANDONED_RE.test(analysis.google_query ?? "")
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    const location = values.location?.trim() || undefined;
    const radiusMiles = values.radius === "any" ? null : Number(values.radius);

    setOsmResult(null);
    setEnrichResult(null);
    setStage({ kind: "analyzing" });

    try {
      const parsed = await parseMutation.mutateAsync({
        sceneText: values.sceneText.trim(),
        location,
        radiusMiles,
      });
      setParseResult(parsed);
      posthog.capture("scene_parsed", {
        cached: parsed.cached,
        attempts: parsed.attempts,
        city: parsed.analysis.city,
        rateLimitRemaining: parsed.rateLimit.remaining,
      });

      // Chain straight into OSM + enrichment.
      await runOsmAndEnrich({
        analysis: parsed.analysis,
        location,
        radiusMiles,
        sceneText: values.sceneText.trim(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setStage({ kind: "error", message });
      posthog.capture("scene_parse_failed", { error: message });
    }
  });

  function loadSample(sample: (typeof SAMPLES)[number]) {
    setValue("sceneText", sample.sceneText, { shouldValidate: true });
    setValue("location", sample.location ?? "", { shouldValidate: true });
    if (sample.radius !== undefined) {
      setValue(
        "radius",
        sample.radius === "any" ? "any" : (String(sample.radius) as FormValues["radius"]),
        { shouldValidate: true },
      );
    }
  }

  async function handleUseMyLocation() {
    setGeoStatus("locating");
    setGeoError(null);
    try {
      const pos = await browserGeolocate();
      const result = await reverseGeocodeRequest(pos.coords.latitude, pos.coords.longitude);
      setValue("location", result.label, { shouldValidate: true });
      setGeoStatus("idle");
      posthog.capture("geolocation_used", { label: result.label });
    } catch (err) {
      const message =
        err instanceof GeolocationPositionError
          ? geolocationErrorMessage(err)
          : err instanceof Error
            ? err.message
            : "Couldn't fetch your location.";
      setGeoError(message);
      setGeoStatus("error");
      posthog.capture("geolocation_failed", { error: message });
    }
  }

  const isBusy =
    stage.kind === "analyzing" ||
    stage.kind === "searching-osm" ||
    stage.kind === "enriching";
  const buttonLabel =
    stage.kind === "analyzing"
      ? "Analyzing scene…"
      : stage.kind === "searching-osm"
        ? "Searching OpenStreetMap…"
        : stage.kind === "enriching"
          ? "Enriching with photos…"
          : "Find locations";

  return (
    <div className="space-y-8">
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="sceneText" className="text-sm font-medium">
              Scene description
            </label>
            <span className="text-xs text-muted-foreground">{charCount} / 20,000</span>
          </div>
          <textarea
            id="sceneText"
            rows={8}
            placeholder="A run-down brick warehouse, broken windows, weeds creeping through the parking lot..."
            className="w-full resize-y rounded-md border border-white/10 bg-card px-3 py-2 text-sm leading-relaxed shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
            {...register("sceneText")}
          />
          {errors.sceneText && (
            <p className="text-xs text-red-400">{errors.sceneText.message}</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="location" className="text-sm font-medium">
                Location <span className="text-muted-foreground">(optional)</span>
              </label>
              <button
                type="button"
                onClick={handleUseMyLocation}
                disabled={geoStatus === "locating"}
                className="text-xs text-primary transition hover:text-primary/80 disabled:opacity-50"
              >
                {geoStatus === "locating" ? "Locating…" : "Use my location"}
              </button>
            </div>
            <input
              id="location"
              type="text"
              placeholder="City, state, neighborhood, or address (e.g. Brooklyn, NY)"
              autoComplete="off"
              className="w-full rounded-md border border-white/10 bg-card px-3 py-2 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
              {...register("location")}
            />
            {errors.location && (
              <p className="text-xs text-red-400">{errors.location.message}</p>
            )}
            {geoError && <p className="text-xs text-amber-400">{geoError}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="radius" className="text-sm font-medium">
              Within
            </label>
            <select
              id="radius"
              className="w-full rounded-md border border-white/10 bg-card px-3 py-2 text-sm shadow-sm outline-none transition focus:border-primary/50 focus:ring-1 focus:ring-primary/30 sm:w-40"
              {...register("radius")}
            >
              <option value="any">The city/area</option>
              {RADIUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={isBusy}
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {buttonLabel}
          </button>

          <span className="text-xs text-muted-foreground">Try a sample:</span>
          {SAMPLES.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => loadSample(s)}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-white/20 hover:text-foreground"
            >
              {s.label}
            </button>
          ))}
        </div>

        {stage.kind === "error" && (
          <p className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
            {stage.message}
          </p>
        )}
      </form>

      {osmResult && (
        <SearchSummaryPanel
          osm={osmResult}
          analysis={parseResult?.analysis ?? null}
          isSearching={stage.kind === "searching-osm"}
        />
      )}

      {(enrichResult ?? (stage.kind === "enriching" && osmResult)) && (
        <ResultCardsPanel
          enriched={enrichResult}
          isEnriching={stage.kind === "enriching"}
        />
      )}

      {parseResult && (
        <AnalysisResultPanel
          result={parseResult}
          isLoadedFromHistory={isFromHistory && stage.kind !== "ready"}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search summary — replaces the embedded map. Shows match-mode badge,
// candidate count, and a "View all on Google Maps" CTA.
// ---------------------------------------------------------------------------

function SearchSummaryPanel({
  osm,
  analysis,
  isSearching,
}: {
  osm: SearchOsmResponse;
  analysis: SceneAnalysis | null;
  isSearching: boolean;
}) {
  // Build a "View all on Google Maps" URL using Claude's google_query (when
  // available) so users can browse the same conceptual search on Google's
  // own map. Fallback to the bbox center coordinates.
  const fallbackQuery =
    analysis?.google_query ??
    `${osm.center.lat.toFixed(5)},${osm.center.lng.toFixed(5)}`;
  const viewAllHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackQuery)}`;

  return (
    <section className="space-y-3 rounded-lg border border-white/10 bg-card p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Search</h2>
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs font-medium " +
              (osm.cached
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-blue-500/15 text-blue-300")
            }
          >
            {osm.cached ? "cached" : "live"}
          </span>
          {osm.matchMode !== "strict" && (
            <span
              title={matchModeTooltip(osm.matchMode)}
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300"
            >
              {matchModeLabel(osm.matchMode, osm.expansionMultiplier)}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {osm.candidates.length} candidate
            {osm.candidates.length === 1 ? "" : "s"}
            {osm.alternativesTried > 1 && (
              <>
                {" · "}
                <span className="font-medium text-emerald-300">
                  {osm.alternativesSucceeded < osm.alternativesTried
                    ? `${osm.alternativesSucceeded}/${osm.alternativesTried}`
                    : osm.alternativesTried}{" "}
                  tag-set
                  {osm.alternativesTried === 1 ? "" : "s"} unioned
                </span>
              </>
            )}
            {" · "}
            bbox: {osm.bboxSource.replace("_", " ")}
          </span>
          {isSearching && (
            <span className="text-xs text-muted-foreground">Querying OpenStreetMap…</span>
          )}
        </div>
        <a
          href={viewAllHref}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
        >
          View all on Google Maps ↗
        </a>
      </header>

      {osm.matchMode !== "strict" && <RelaxationExplainer osm={osm} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cards grid (M4 result UI)
// ---------------------------------------------------------------------------

function ResultCardsPanel({
  enriched,
  isEnriching,
}: {
  enriched: EnrichResponse | null;
  isEnriching: boolean;
}) {
  if (!enriched && !isEnriching) return null;

  return (
    <section className="space-y-4 rounded-lg border border-white/10 bg-card p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Result cards</h2>
        {enriched && (
          <span className="text-xs text-muted-foreground">
            {enriched.locations.length} of {enriched.pipelineStats.inputCandidates} candidates kept
          </span>
        )}
      </header>

      {enriched && (
        <PipelineStatsStrip stats={enriched.pipelineStats} visionApplied={enriched.visionScoringApplied} />
      )}

      {isEnriching && !enriched && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex animate-pulse flex-col gap-2 rounded-lg border border-white/10 bg-black/30 p-4"
            >
              <div className="aspect-video rounded-md bg-white/5" />
              <div className="h-3 w-3/4 rounded bg-white/5" />
              <div className="h-3 w-1/2 rounded bg-white/5" />
            </div>
          ))}
        </div>
      )}

      {enriched && enriched.locations.length === 0 && (
        <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
          No enriched results — every candidate failed to match a Google Place.
        </p>
      )}

      {enriched && enriched.locations.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {enriched.locations.map((loc) => (
            <LocationCard
              key={loc.id}
              id={loc.id}
              name={loc.name}
              address={loc.address}
              lat={loc.lat}
              lng={loc.lng}
              rating={loc.rating ?? undefined}
              photoUrl={loc.photo?.url}
              photoSource={loc.photo?.source ?? null}
              photoCapturedAt={loc.photo?.capturedAt ?? undefined}
              photoAttribution={
                loc.photo
                  ? ({
                      source: loc.photo.source,
                      text: loc.photo.attributionText,
                      href: loc.photo.attributionHref ?? undefined,
                    } satisfies PhotoAttribution)
                  : undefined
              }
              streetViewThumbUrl={loc.streetView.thumbUrl ?? undefined}
              hasInteractiveStreetView={loc.streetView.available}
              deepLinks={loc.deepLinks}
              badges={loc.badges.map((b) => `${b.key}=${b.value}`)}
              visionScore={loc.photo?.visionScore ?? undefined}
              visionReason={loc.photo?.visionReason ?? undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Match-mode badge + explainer
// ---------------------------------------------------------------------------

function matchModeLabel(
  mode: SearchOsmResponse["matchMode"],
  expansionMultiplier: 1 | 2 | 4,
): string {
  if (mode === "primary_only_expanded") return `expanded ${expansionMultiplier}×`;
  if (mode === "primary_only") return "loose match";
  if (mode === "best_effort") return "best effort";
  if (mode === "google_text_fallback") return "Google Places";
  return "strict";
}

function matchModeTooltip(mode: SearchOsmResponse["matchMode"]): string {
  switch (mode) {
    case "primary_only":
      return "Strict match (all tags) was sparse, so we relaxed to the primary classifier tag.";
    case "primary_only_expanded":
      return "Same primary tag, but the search bbox was expanded outward to find enough nearby candidates.";
    case "best_effort":
      return "Every tier returned below the result threshold. Showing the most populous attempt.";
    case "google_text_fallback":
      return "OpenStreetMap had no matches even after expansion. Results come from Google Places text search instead.";
    default:
      return "All requested tags matched at least 5 features in the original bbox.";
  }
}

function RelaxationExplainer({ osm }: { osm: SearchOsmResponse }) {
  const tagSpan = osm.primaryTag ? (
    <span className="font-mono">
      {osm.primaryTag.key}={osm.primaryTag.value}
    </span>
  ) : null;

  if (osm.matchMode === "primary_only") {
    return (
      <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
        Strict match for all OSM tags was sparse. Showing results that match {tagSpan}{" "}
        alone. Other tags (e.g. material, abandonment) are sparsely populated in
        OpenStreetMap and would have left this map empty.
      </p>
    );
  }
  if (osm.matchMode === "primary_only_expanded") {
    return (
      <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
        Not enough matches inside your requested area, so we expanded the search bbox by{" "}
        <span className="font-mono">{osm.expansionMultiplier}×</span> on the primary tag{" "}
        {tagSpan}. Results are sorted by distance from your search center.
      </p>
    );
  }
  if (osm.matchMode === "best_effort") {
    return (
      <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
        Every relaxation tier returned below the result threshold. Showing the most
        populous attempt {tagSpan ? <>(matched on {tagSpan})</> : null} so you have
        somewhere to start. Try a different scene or a wider radius for stronger matches.
      </p>
    );
  }
  if (osm.matchMode === "google_text_fallback") {
    return (
      <p className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-200">
        OpenStreetMap had no matches in this area even after expanding the bbox, so we
        fell back to Google Places text search. Results may include businesses by name
        rather than physical attributes.
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Analysis (Claude output) panel
// ---------------------------------------------------------------------------

function AnalysisResultPanel({
  result,
  isLoadedFromHistory,
}: {
  result: ParseSceneResponse;
  isLoadedFromHistory?: boolean;
}) {
  const { analysis, cached, attempts, rateLimit } = result;

  return (
    <details className="rounded-lg border border-white/10 bg-card">
      <summary className="cursor-pointer select-none px-6 py-4 text-sm font-medium">
        <span className="text-foreground">Claude analysis (scene parse)</span>
        <span className="ml-3 inline-flex items-center gap-2">
          {isLoadedFromHistory ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
              from history
            </span>
          ) : (
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs font-medium " +
                (cached
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-blue-500/15 text-blue-300")
              }
            >
              {cached ? "cached" : `live · ${attempts} attempt${attempts === 1 ? "" : "s"}`}
            </span>
          )}
          {!isLoadedFromHistory && (
            <span className="text-xs text-muted-foreground">
              {rateLimit.used} / {rateLimit.limit} today
            </span>
          )}
        </span>
      </summary>

      <div className="space-y-4 border-t border-white/5 px-6 py-5">
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <Field label="City" value={analysis.city} />
          <Field label="Visual" value={analysis.visual} />
          <Field
            label="Setting"
            value={analysis.location_kind ?? "—"}
          />
          <Field label="Mood" value={analysis.mood ?? "—"} />
          <Field label="Time of day" value={analysis.time_of_day ?? "—"} />
          <Field label="Interior / exterior" value={analysis.interior_exterior ?? "—"} />
        </dl>

        {/* Scene tokens drive vision scoring + future embedding retrieval. */}
        {(analysis.scene_tokens?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Scene tokens ({analysis.scene_tokens.length} — drove vision scoring)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {analysis.scene_tokens.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 font-mono text-xs text-emerald-200"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* OSM tag alternatives: each one is a standalone Overpass filter. */}
        {(analysis.osm_tags_alternatives?.length ?? 0) > 1 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              OSM tag alternatives ({analysis.osm_tags_alternatives.length} — UNION drove Overpass)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {analysis.osm_tags_alternatives.map((alt, i) => (
                <span
                  key={i}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs"
                >
                  {Object.entries(alt)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" ")}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              OSM tags (drove the Overpass query)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(analysis.osm_tags).map(([k, v]) => (
                <span
                  key={k}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs"
                >
                  {k}={v}
                </span>
              ))}
            </div>
          </div>
        )}

        {analysis.google_types.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Google Places types
            </p>
            <div className="flex flex-wrap gap-1.5">
              {analysis.google_types.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {(analysis.mapillary_classes?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Mapillary detection classes ({analysis.mapillary_classes.length})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {analysis.mapillary_classes.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        <Field label="Google Maps query (for the link)" value={analysis.google_query} />

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Raw JSON</summary>
          <pre className="mt-2 overflow-auto rounded-md bg-black/40 p-3 font-mono text-xs">
            {JSON.stringify(analysis, null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Permission denied. Allow location access in your browser to use this.";
    case err.POSITION_UNAVAILABLE:
      return "Couldn't determine your position right now. Try again in a moment.";
    case err.TIMEOUT:
      return "Location request timed out. Try again.";
    default:
      return "Couldn't fetch your location.";
  }
}

// ---------------------------------------------------------------------------
// Pipeline stats — shows the user how their candidate pool got narrowed
// ---------------------------------------------------------------------------

function PipelineStatsStrip({
  stats,
  visionApplied,
}: {
  stats: EnrichResponse["pipelineStats"];
  visionApplied: boolean;
}) {
  const steps: ReadonlyArray<{ label: string; value: number; visible: boolean }> = [
    { label: "input", value: stats.inputCandidates, visible: true },
    { label: "deduped", value: stats.afterDedupe, visible: stats.afterDedupe < stats.inputCandidates },
    {
      label: stats.targetColor ? `${stats.targetColor} match` : "color",
      value: stats.afterColorFilter,
      visible: stats.targetColor != null && stats.afterColorFilter < stats.afterDedupe,
    },
    {
      label: "objects",
      value: stats.afterDetectionFilter,
      visible: stats.mapillaryDetectionsFound > 0 && stats.afterDetectionFilter < stats.afterColorFilter,
    },
    {
      label: visionApplied ? "vision ≥30" : "no vision",
      value: stats.afterVisionFilter,
      visible: visionApplied,
    },
    { label: "rendered", value: stats.finalRendered, visible: true },
  ].filter((s) => s.visible);

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium tracking-wide text-foreground/70 uppercase">Pipeline</span>
      {steps.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>→</span>}
          <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono">
            {s.label}: <span className="text-foreground">{s.value}</span>
          </span>
        </span>
      ))}
    </div>
  );
}
