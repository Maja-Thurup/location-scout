import { SceneInputForm } from "@/components/scene-input-form";

export default function NewScoutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">New scout</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Describe a scene in plain English. We&apos;ll extract structured filming requirements
          using Claude. The next milestones layer on map results and saved projects.
        </p>
      </header>

      <SceneInputForm />
    </div>
  );
}
