import { DeveloperModeSetting } from "@/components/developer-mode-setting";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Preferences that affect search and results debugging.
        </p>
      </header>

      <DeveloperModeSetting />

      <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          Coming in M5: crew base address, default search radius, account.
        </p>
      </div>
    </div>
  );
}
