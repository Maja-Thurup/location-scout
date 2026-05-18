import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-white/5 bg-background/50">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1 text-sm">
          <p className="font-mono tracking-tight">
            <span className="text-primary">LocationScout</span>
          </p>
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} Igor Kirko. All rights reserved.{" "}
            <Link
              href="https://github.com/Maja-Thurup/location-scout/blob/main/LICENSE"
              className="underline-offset-4 hover:underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              Proprietary license
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <Link
            href="https://github.com/Maja-Thurup/location-scout"
            className="hover:text-foreground"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </Link>
          <span aria-hidden>·</span>
          <Link
            href="https://github.com/Maja-Thurup/location-scout/blob/main/NOTICE.md"
            className="hover:text-foreground"
            rel="noopener noreferrer"
            target="_blank"
          >
            Notice
          </Link>
          <span aria-hidden>·</span>
          <span>Built with Next.js, Claude, OSM, Mapillary, Google Maps</span>
        </div>
      </div>
    </footer>
  );
}
