import type { ProviderDebugMeta, RawCandidate } from "@/lib/providers/types";

export type { ProviderDebugMeta };

// ---------------------------------------------------------------------------
// Developer-mode source inspector — per-retriever request/response payloads.
// ---------------------------------------------------------------------------

export const SOURCE_DEBUG_CANDIDATE_CAP = 50;

export type SourceDebugStatus = "ok" | "empty" | "skipped" | "error" | "cached";

/** Enrich-phase payload (photos, vision, REST lookups). */
export type EnrichSourcePayload = {
  byCandidateId?: Record<
    string,
    {
      mapillaryImages?: unknown[];
      mapillaryDetections?: unknown[];
      googleNearby?: unknown[];
      streetViewProbes?: unknown[];
      wikidataRest?: unknown;
      vision?: { imageUrl: string; score: number | null; reason: string | null } | null;
      filmsAttached?: unknown[];
    }
  >;
  summary?: Record<string, unknown>;
};

export type SourceDebugEntry = {
  sourceKey: string;
  displayName: string;
  status: SourceDebugStatus;
  ms: number;
  error: string | null;
  skipReason: string | null;
  fromCache: boolean;
  request: Record<string, unknown>;
  candidates: RawCandidate[];
  enrich?: EnrichSourcePayload;
  truncated?: { shown: number; total: number };
  notes?: string | null;
};

export function truncateCandidates(
  candidates: ReadonlyArray<RawCandidate>,
  cap: number = SOURCE_DEBUG_CANDIDATE_CAP,
): { candidates: RawCandidate[]; truncated?: { shown: number; total: number } } {
  if (candidates.length <= cap) {
    return { candidates: [...candidates] };
  }
  return {
    candidates: candidates.slice(0, cap),
    truncated: { shown: cap, total: candidates.length },
  };
}

export function resolveSourceStatus(args: {
  skipped: boolean;
  error: string | null;
  fromCache: boolean;
  count: number;
}): SourceDebugStatus {
  if (args.skipped) return "skipped";
  if (args.error) return "error";
  if (args.fromCache && args.count > 0) return "cached";
  if (args.count === 0) return "empty";
  return "ok";
}

export function buildSourceDebugEntry(args: {
  sourceKey: string;
  displayName: string;
  ms: number;
  error: string | null;
  skipReason?: string | null;
  skipped?: boolean;
  fromCache?: boolean;
  request?: Record<string, unknown>;
  candidates?: ReadonlyArray<RawCandidate>;
  enrich?: EnrichSourcePayload;
  notes?: string | null;
}): SourceDebugEntry {
  const skipped = args.skipped ?? Boolean(args.skipReason);
  const all = args.candidates ?? [];
  const { candidates, truncated } = truncateCandidates(all);
  const status = resolveSourceStatus({
    skipped,
    error: args.error,
    fromCache: args.fromCache ?? false,
    count: all.length,
  });

  return {
    sourceKey: args.sourceKey,
    displayName: args.displayName,
    status,
    ms: args.ms,
    error: args.error,
    skipReason: args.skipReason ?? null,
    fromCache: args.fromCache ?? false,
    request: sanitizeDebugRequest(args.request ?? {}),
    candidates,
    enrich: args.enrich,
    truncated,
    notes: args.notes ?? null,
  };
}

/** Strip accidental secret keys from debug request objects. */
export function sanitizeDebugRequest(
  req: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const secretPattern = /key|token|secret|password|apikey|api_key/i;
  for (const [k, v] of Object.entries(req)) {
    if (secretPattern.test(k)) {
      out[k] = v ? "[redacted]" : v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeDebugRequest(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function providerStatsFromSourceDebug(
  entries: ReadonlyArray<SourceDebugEntry>,
): Record<string, { count: number; ms: number; error: string | null }> {
  const out: Record<string, { count: number; ms: number; error: string | null }> = {};
  for (const e of entries) {
    out[e.sourceKey] = {
      count: e.truncated?.total ?? e.candidates.length,
      ms: e.ms,
      error: e.error,
    };
  }
  return out;
}
