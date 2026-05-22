"use client";

import { useDeveloperMode } from "@/lib/use-developer-mode";

export function DeveloperModeSetting() {
  const { developerMode, setDeveloperMode, hydrated } = useDeveloperMode();

  if (!hydrated) {
    return (
      <div className="rounded-lg border border-white/10 bg-card p-6">
        <p className="text-sm text-muted-foreground">Loading preferences…</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Developer mode</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            On the results page, show a per-source inspector with request payloads and
            normalized candidate rows for every retriever (including sources with zero
            hits or skipped API keys).
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="sr-only">Developer mode</span>
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-white/20"
            checked={developerMode}
            onChange={(e) => setDeveloperMode(e.target.checked)}
          />
          <span className="text-sm tabular-nums">{developerMode ? "On" : "Off"}</span>
        </label>
      </div>
    </div>
  );
}
