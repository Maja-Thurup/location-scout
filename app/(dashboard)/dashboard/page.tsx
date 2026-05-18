import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";

import { requireDbUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const [user, { dbUserId }] = await Promise.all([currentUser(), requireDbUser()]);
  const greeting = user?.firstName ? `Welcome back, ${user.firstName}.` : "Welcome back.";

  const recentSearches = await prisma.searchHistory.findMany({
    where: { userId: dbUserId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      sceneText: true,
      city: true,
      radiusMiles: true,
      cached: true,
      createdAt: true,
      analysis: true,
    },
  });

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{greeting}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Start a new scout, or pick up an existing project.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <Link
          href="/dashboard/new"
          className="group rounded-lg border border-white/10 bg-card p-6 transition hover:border-primary/40"
        >
          <p className="font-mono text-xs tracking-wide text-primary uppercase">
            Start new search
          </p>
          <h2 className="mt-2 text-xl font-semibold">Describe a scene</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Type a scene description or paste a script excerpt. We&apos;ll extract the filming
            requirements and surface real-world matches.
          </p>
          <p className="mt-4 text-xs text-muted-foreground transition group-hover:text-foreground">
            New search &rarr;
          </p>
        </Link>

        <Link
          href="/settings"
          className="group rounded-lg border border-white/10 bg-card p-6 transition hover:border-primary/40"
        >
          <p className="font-mono text-xs tracking-wide text-primary uppercase">Crew base</p>
          <h2 className="mt-2 text-xl font-semibold">Set your starting point</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Tell us where your crew works from and we&apos;ll show driving distance + time on
            every result.
          </p>
          <p className="mt-4 text-xs text-muted-foreground transition group-hover:text-foreground">
            Open settings &rarr;
          </p>
        </Link>
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Recent searches</h2>
          {recentSearches.length > 0 && (
            <span className="text-xs text-muted-foreground">
              Last {recentSearches.length} of yours
            </span>
          )}
        </div>

        {recentSearches.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No searches yet. Run your first scene through the analyzer and it&apos;ll show up
              here automatically.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10">
            {recentSearches.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/dashboard/new?historyId=${s.id}`}
                  className="block px-5 py-4 transition hover:bg-white/5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {s.city ?? extractCityFromAnalysis(s.analysis) ?? "Unspecified location"}
                        </span>
                        {s.radiusMiles != null && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            within {s.radiusMiles} mi
                          </span>
                        )}
                        {s.cached && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                            cached
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-sm text-muted-foreground">
                        {s.sceneText.slice(0, 140)}
                        {s.sceneText.length > 140 ? "…" : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelative(s.createdAt)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Your projects</h2>
        <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            Saved projects land in M5 — explicit save with a custom name and per-location notes.
          </p>
        </div>
      </section>
    </div>
  );
}

function extractCityFromAnalysis(analysis: unknown): string | null {
  if (typeof analysis !== "object" || analysis === null) return null;
  const obj = analysis as Record<string, unknown>;
  return typeof obj.city === "string" ? obj.city : null;
}

function formatRelative(date: Date): string {
  const ms = Date.now() - date.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString();
}
