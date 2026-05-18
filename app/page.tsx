import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Footer } from "@/components/footer";

const FOUR_SOURCES = [
  {
    name: "Claude",
    role: "Scene parsing",
    detail: "Turns natural-language scene descriptions into structured filming requirements.",
  },
  {
    name: "OpenStreetMap",
    role: "Visual pre-filter (free)",
    detail:
      "Filters by physical attributes Google can't search on: stories, material, era, condition.",
  },
  {
    name: "Mapillary + Google",
    role: "Photos & Street View",
    detail:
      "2B+ free crowdsourced street photos, with Google Photos as fallback and Street View embedded.",
  },
  {
    name: "Google Places",
    role: "Real-world enrichment",
    detail: "Names, addresses, ratings, business info, and driving directions for every result.",
  },
] as const;

export default async function HomePage() {
  const { userId } = await auth();
  const isSignedIn = Boolean(userId);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-white/5">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link href="/" className="font-mono text-sm tracking-tight">
            <span className="text-primary">LocationScout</span>
            <span className="text-muted-foreground"> · v0.1</span>
          </Link>
          <div className="flex items-center gap-6 text-sm">
            <Link
              href="https://github.com/Maja-Thurup/location-scout"
              className="text-muted-foreground transition hover:text-foreground"
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
            </Link>
            {isSignedIn ? (
              <Link
                href="/dashboard"
                className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition hover:opacity-90"
              >
                Open dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="text-muted-foreground transition hover:text-foreground"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition hover:opacity-90"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-6 py-24 md:py-32">
          <div className="max-w-3xl">
            <p className="mb-4 inline-block rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              AI-powered location scouting
            </p>
            <h1 className="text-balance text-5xl font-semibold tracking-tight md:text-6xl">
              Describe a scene.
              <br />
              <span className="text-primary">Find where to shoot it.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
              LocationScout reads your scene description, extracts the filming requirements with
              Claude, then searches OpenStreetMap, Mapillary, and Google Maps to surface real
              places that match — with photos, Street View, and driving distance from your crew
              base.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
              {isSignedIn ? (
                <Link
                  href="/dashboard"
                  className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  Open dashboard
                </Link>
              ) : (
                <>
                  <Link
                    href="/sign-up"
                    className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                  >
                    Start scouting — free
                  </Link>
                  <Link
                    href="/sign-in"
                    className="rounded-md border border-white/10 px-5 py-3 text-sm font-medium transition hover:border-white/20"
                  >
                    I already have an account
                  </Link>
                </>
              )}
            </div>
            <p className="mt-6 text-xs text-muted-foreground">
              Free tier: 5 scene analyses per day, 3 saved projects. No credit card required.
            </p>
          </div>
        </section>

        <section className="border-t border-white/5">
          <div className="mx-auto max-w-6xl px-6 py-24">
            <div className="mb-12 max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-tight">
                Four data sources, one pipeline.
              </h2>
              <p className="mt-3 text-muted-foreground">
                Most scouting tools rely on Google alone. We layer in OpenStreetMap and Mapillary
                so you can search by visual attributes Google can&apos;t see — and pay for
                photos only when free sources don&apos;t have them.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {FOUR_SOURCES.map((source) => (
                <div
                  key={source.name}
                  className="rounded-lg border border-white/5 bg-card p-6 transition hover:border-white/10"
                >
                  <p className="font-mono text-xs tracking-wide text-primary uppercase">
                    {source.role}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold">{source.name}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{source.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-white/5">
          <div className="mx-auto max-w-6xl px-6 py-24">
            <div className="grid gap-12 md:grid-cols-2">
              <div>
                <h2 className="text-3xl font-semibold tracking-tight">
                  Built for video production.
                </h2>
                <p className="mt-3 text-muted-foreground">
                  Filmmakers, music-video directors, ad agencies, and YouTube creators use scene
                  language. We translate it into search queries that real-world map data can
                  answer.
                </p>
              </div>
              <ul className="space-y-4 text-sm">
                {[
                  "Search by visual attributes: stories, material, color, era, condition",
                  "Embedded Street View and Mapillary photos for walking the location",
                  "Driving distance and time from your crew base on every result",
                  "One-tap directions to Google Maps, Apple Maps, or Waze",
                  "Save projects, add per-location notes, share with collaborators",
                  "Upload a script — we detect every INT./EXT. scene automatically",
                ].map((feature) => (
                  <li key={feature} className="flex gap-3">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
