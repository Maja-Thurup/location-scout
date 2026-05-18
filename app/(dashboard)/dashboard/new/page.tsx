import Link from "next/link";

import { requireDbUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sceneAnalysisSchema } from "@/lib/claude";
import { SceneInputForm } from "@/components/scene-input-form";

type SearchParams = Promise<{ historyId?: string }>;

export default async function NewScoutPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const historyEntry = params.historyId
    ? await loadHistoryForUser(params.historyId)
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">New scout</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Describe a scene in plain English. We&apos;ll extract structured filming requirements
          using Claude. The next milestones layer on map results and saved projects.
        </p>
      </header>

      {historyEntry && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm">
          <span className="text-emerald-300">
            Loaded from your history
            {historyEntry.location ? ` · ${historyEntry.location}` : ""}
            {historyEntry.radiusMiles ? ` · within ${historyEntry.radiusMiles} mi` : ""}.
          </span>
          <Link
            href="/dashboard/new"
            className="text-xs text-emerald-300/80 underline-offset-4 transition hover:text-emerald-200 hover:underline"
          >
            Start fresh
          </Link>
        </div>
      )}

      <SceneInputForm
        initialSceneText={historyEntry?.sceneText ?? ""}
        initialLocation={historyEntry?.location ?? ""}
        initialRadius={
          historyEntry?.radiusMiles == null
            ? "any"
            : (historyEntry.radiusMiles as 5 | 10 | 25 | 50 | 100)
        }
        initialAnalysis={historyEntry?.analysis ?? null}
      />
    </div>
  );
}

async function loadHistoryForUser(historyId: string) {
  const { dbUserId } = await requireDbUser();
  const row = await prisma.searchHistory.findFirst({
    where: { id: historyId, userId: dbUserId },
    select: {
      sceneText: true,
      city: true,
      radiusMiles: true,
      analysis: true,
    },
  });
  if (!row) return null;

  // Validate the stored analysis still matches the current schema. If it
  // doesn't (e.g. the schema changed since this row was written), drop it.
  const parsed = sceneAnalysisSchema.safeParse(row.analysis);
  return {
    sceneText: row.sceneText,
    location: row.city, // column name is `city` for migration continuity; semantically a location string
    radiusMiles: row.radiusMiles,
    analysis: parsed.success ? parsed.data : null,
  };
}
