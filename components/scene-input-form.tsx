"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import posthog from "posthog-js";

import type { SceneInputProps } from "@/components/contracts";

// ---------------------------------------------------------------------------
// Form schema (client-side validation; mirrors the server's stricter check).
// ---------------------------------------------------------------------------

const formSchema = z.object({
  sceneText: z
    .string()
    .min(10, "At least 10 characters please.")
    .max(20_000, "Keep it under 20,000 characters."),
  city: z
    .string()
    .max(120, "City is too long.")
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
});

type FormValues = z.input<typeof formSchema>;

// ---------------------------------------------------------------------------
// Server response shape (mirror of /api/parse-scene).
// ---------------------------------------------------------------------------

type ParseSceneResponse = {
  analysis: {
    osm_tags: Record<string, string>;
    google_query: string;
    google_types: string[];
    city: string;
    visual: string;
    mood: string | null;
    time_of_day: string | null;
    interior_exterior: "interior" | "exterior" | "both" | null;
  };
  cached: boolean;
  attempts: number;
  rateLimit: { used: number; limit: number; remaining: number; resetAt: string };
};

type ApiError = { error: string; message?: string };

async function parseSceneRequest(
  input: { sceneText: string; city?: string },
): Promise<ParseSceneResponse> {
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

// ---------------------------------------------------------------------------
// Sample prompts (also exercises caching on second click of the same one).
// ---------------------------------------------------------------------------

const SAMPLES: ReadonlyArray<{ label: string; sceneText: string; city?: string }> = [
  {
    label: "Abandoned Brooklyn warehouse",
    sceneText:
      "Late-night fight scene inside an abandoned brick warehouse with broken windows and exposed steel beams. Single overhead practical light, puddles on the floor.",
    city: "Brooklyn, NY",
  },
  {
    label: "Diner conversation, NYC",
    sceneText:
      "Two characters in a corner booth of a 24-hour diner. Neon glow from outside, chrome stools at the counter, formica tabletops. Late-night conversation.",
    city: "New York, NY",
  },
  {
    label: "Atlanta back-porch dusk",
    sceneText:
      "Quiet conversation on the back porch of a small bungalow. Wooden porch swing, peeling white paint, dense overgrown yard, fireflies, golden-hour sky.",
    city: "Atlanta, GA",
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SceneInputForm(_props: Partial<SceneInputProps> = {}) {
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { sceneText: "", city: "" },
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
    mutation.mutate({
      sceneText: values.sceneText.trim(),
      city: values.city?.trim() ? values.city.trim() : undefined,
    });
  });

  function loadSample(sample: (typeof SAMPLES)[number]) {
    setValue("sceneText", sample.sceneText, { shouldValidate: true });
    setValue("city", sample.city ?? "", { shouldValidate: true });
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

        <div className="space-y-2">
          <label htmlFor="city" className="text-sm font-medium">
            City <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            id="city"
            type="text"
            placeholder="Brooklyn, NY"
            className="w-full rounded-md border border-white/10 bg-card px-3 py-2 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
            {...register("city")}
          />
          {errors.city && <p className="text-xs text-red-400">{errors.city.message}</p>}
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

      {mutation.data && <AnalysisResultPanel result={mutation.data} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result preview (placeholder — replaced by real result UI in M3/M4).
// ---------------------------------------------------------------------------

function AnalysisResultPanel({ result }: { result: ParseSceneResponse }) {
  const { analysis, cached, attempts, rateLimit } = result;

  return (
    <section className="space-y-4 rounded-lg border border-white/10 bg-card p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Claude analysis</h2>
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
        <span className="text-xs text-muted-foreground">
          {rateLimit.used} / {rateLimit.limit} scenes today · resets{" "}
          {new Date(rateLimit.resetAt).toLocaleTimeString()}
        </span>
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
