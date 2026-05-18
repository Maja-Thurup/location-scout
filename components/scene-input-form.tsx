"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import posthog from "posthog-js";

import type { SceneAnalysis } from "@/lib/claude";

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
// Server response shape (mirror of /api/parse-scene).
// ---------------------------------------------------------------------------

type ParseSceneResponse = {
  analysis: SceneAnalysis;
  cached: boolean;
  attempts: number;
  rateLimit: { used: number; limit: number; remaining: number; resetAt: string };
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
// Sample prompts (also exercises caching on second click of the same one).
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

export function SceneInputForm({
  initialSceneText = "",
  initialLocation = "",
  initialRadius = "any",
  initialAnalysis = null,
}: SceneInputFormProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [geoStatus, setGeoStatus] = useState<"idle" | "locating" | "error">("idle");
  const [geoError, setGeoError] = useState<string | null>(null);

  // If we hydrated with a previous analysis, surface it as the initial
  // result panel state. Once the user runs a fresh search the mutation's
  // own data takes over.
  const [initialResult] = useState<ParseSceneResponse | null>(() =>
    initialAnalysis
      ? {
          analysis: initialAnalysis,
          cached: true,
          attempts: 1,
          rateLimit: {
            used: 0,
            limit: 5,
            remaining: 5,
            resetAt: new Date(
              new Date().setUTCHours(24, 0, 0, 0),
            ).toISOString(),
          },
        }
      : null,
  );

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
      radius: typeof initialRadius === "number" ? (String(initialRadius) as FormValues["radius"]) : "any",
    },
  });

  const mutation = useMutation({
    mutationFn: parseSceneRequest,
    onMutate: () => setServerError(null),
    onSuccess: (data) => {
      posthog.capture("scene_parsed", {
        cached: data.cached,
        attempts: data.attempts,
        city: data.analysis.city,
        rateLimitRemaining: data.rateLimit.remaining,
      });
    },
    onError: (err: Error) => {
      setServerError(err.message);
      posthog.capture("scene_parse_failed", { error: err.message });
    },
  });

  const sceneText = watch("sceneText");
  const charCount = sceneText?.length ?? 0;

  const onSubmit = handleSubmit((values) => {
    const location = values.location?.trim();
    const radiusMiles = values.radius === "any" ? null : Number(values.radius);
    mutation.mutate({
      sceneText: values.sceneText.trim(),
      location: location || undefined,
      radiusMiles,
    });
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
            disabled={mutation.isPending}
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation.isPending ? "Analyzing…" : "Analyze scene"}
          </button>

          <span className="text-xs text-muted-foreground">
            Try a sample:
          </span>
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

        {serverError && (
          <p className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
            {serverError}
          </p>
        )}
      </form>

      {(mutation.data ?? initialResult) && (
        <AnalysisResultPanel
          result={mutation.data ?? (initialResult as ParseSceneResponse)}
          isLoadedFromHistory={!mutation.data && initialResult !== null}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result preview (placeholder — replaced by real result UI in M3/M4).
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
    <section className="space-y-4 rounded-lg border border-white/10 bg-card p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Claude analysis</h2>
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
            {rateLimit.used} / {rateLimit.limit} scenes today · resets{" "}
            {new Date(rateLimit.resetAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <Field label="City" value={analysis.city} />
        <Field label="Visual" value={analysis.visual} />
        <Field label="Mood" value={analysis.mood ?? "—"} />
        <Field label="Time of day" value={analysis.time_of_day ?? "—"} />
        <Field label="Interior / exterior" value={analysis.interior_exterior ?? "—"} />
        <Field label="Google query" value={analysis.google_query} />
      </dl>

      <div className="space-y-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          OSM tags (will drive the Overpass query in M3)
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

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Raw JSON</summary>
        <pre className="mt-2 overflow-auto rounded-md bg-black/40 p-3 font-mono text-xs">
          {JSON.stringify(analysis, null, 2)}
        </pre>
      </details>
    </section>
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
