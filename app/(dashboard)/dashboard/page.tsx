import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";

export default async function DashboardPage() {
  const user = await currentUser();
  const greeting = user?.firstName ? `Welcome back, ${user.firstName}.` : "Welcome back.";

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
        <h2 className="mb-4 text-lg font-semibold">Your projects</h2>
        <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            You don&apos;t have any saved projects yet. Start a new search and we&apos;ll save
            it here.
          </p>
        </div>
      </section>
    </div>
  );
}
