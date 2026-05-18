export default function NewScoutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">New scout</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The scene-input form lands in M2. For now this page is a placeholder so the route
          works end-to-end.
        </p>
      </header>

      <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          Coming in M2: scene textarea + city selector + Claude analysis.
        </p>
      </div>
    </div>
  );
}
