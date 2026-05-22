import { describe, expect, it } from "vitest";

import {
  buildSourceDebugEntry,
  resolveSourceStatus,
  sanitizeDebugRequest,
  SOURCE_DEBUG_CANDIDATE_CAP,
  truncateCandidates,
} from "@/lib/source-debug";
import type { RawCandidate } from "@/lib/providers/types";

function mockCandidate(id: string): RawCandidate {
  return {
    externalId: id,
    source: "own-db",
    lat: 40.7,
    lng: -74.0,
    tags: { tourism: "artwork" },
    name: `Place ${id}`,
    description: null,
    knownImageUrl: null,
    associatedFilms: [],
    sourceUrl: null,
  };
}

describe("resolveSourceStatus", () => {
  it("maps skipped, error, cached, empty, ok", () => {
    expect(
      resolveSourceStatus({ skipped: true, error: null, fromCache: false, count: 0 }),
    ).toBe("skipped");
    expect(
      resolveSourceStatus({ skipped: false, error: "boom", fromCache: false, count: 0 }),
    ).toBe("error");
    expect(
      resolveSourceStatus({ skipped: false, error: null, fromCache: true, count: 3 }),
    ).toBe("cached");
    expect(
      resolveSourceStatus({ skipped: false, error: null, fromCache: false, count: 0 }),
    ).toBe("empty");
    expect(
      resolveSourceStatus({ skipped: false, error: null, fromCache: false, count: 2 }),
    ).toBe("ok");
  });
});

describe("truncateCandidates", () => {
  it("passes through when under cap", () => {
    const list = [mockCandidate("a"), mockCandidate("b")];
    const { candidates, truncated } = truncateCandidates(list, 50);
    expect(candidates).toHaveLength(2);
    expect(truncated).toBeUndefined();
  });

  it("truncates at cap with metadata", () => {
    const list = Array.from({ length: SOURCE_DEBUG_CANDIDATE_CAP + 10 }, (_, i) =>
      mockCandidate(String(i)),
    );
    const { candidates, truncated } = truncateCandidates(list);
    expect(candidates).toHaveLength(SOURCE_DEBUG_CANDIDATE_CAP);
    expect(truncated).toEqual({
      shown: SOURCE_DEBUG_CANDIDATE_CAP,
      total: SOURCE_DEBUG_CANDIDATE_CAP + 10,
    });
  });
});

describe("sanitizeDebugRequest", () => {
  it("redacts secret-like keys", () => {
    const out = sanitizeDebugRequest({
      bbox: { south: 1 },
      api_key: "secret-value",
      nested: { token: "abc" },
    });
    expect(out.api_key).toBe("[redacted]");
    expect(out.nested).toEqual({ token: "[redacted]" });
    expect(out.bbox).toEqual({ south: 1 });
  });
});

describe("buildSourceDebugEntry", () => {
  it("sets skip status from skipReason", () => {
    const entry = buildSourceDebugEntry({
      sourceKey: "nps-places",
      displayName: "NPS",
      ms: 0,
      error: null,
      skipReason: "NPS_API_KEY not set",
      request: { states: ["NY"] },
      candidates: [],
    });
    expect(entry.status).toBe("skipped");
    expect(entry.skipReason).toBe("NPS_API_KEY not set");
  });
});
