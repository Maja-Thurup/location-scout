import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Footer } from "@/components/footer";

// Every page under (dashboard) requires an authenticated user, so these
// routes must be rendered per-request, never prerendered at build time.
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-white/5 bg-background/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="font-mono text-sm tracking-tight">
              <span className="text-primary">LocationScout</span>
            </Link>
            <div className="flex gap-6 text-sm text-muted-foreground">
              <Link href="/dashboard" className="transition hover:text-foreground">
                Dashboard
              </Link>
              <Link href="/dashboard/new" className="transition hover:text-foreground">
                New search
              </Link>
              <Link href="/settings" className="transition hover:text-foreground">
                Settings
              </Link>
            </div>
          </div>
          <UserButton />
        </nav>
      </header>

      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-6 py-10">{children}</div>
      </main>

      <Footer />
    </div>
  );
}
