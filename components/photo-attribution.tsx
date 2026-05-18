"use client";

import type { PhotoAttribution } from "@/components/contracts";

/**
 * Mandatory attribution overlay for any third-party photo we display.
 *
 * Mapillary photos are CC BY-SA 4.0; the license requires we both name
 * the source ("© Mapillary contributors · CC BY-SA") and link back to
 * the original. Google Place Photos require the attributions Google
 * supplies in `authorAttributions` — we surface them verbatim.
 */
export function PhotoAttributionBadge({
  source,
  text,
  href,
  className,
}: PhotoAttribution & { className?: string }) {
  const sourceLabel = sourceShortName(source);
  const inner = (
    <span className="inline-flex items-center gap-1.5 text-[10px] tracking-tight text-white/80">
      <span className="rounded-sm bg-black/60 px-1 py-0.5 font-medium uppercase">
        {sourceLabel}
      </span>
      <span className="truncate">{text}</span>
    </span>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={
          (className ?? "") +
          " inline-flex max-w-full transition hover:text-white"
        }
        title="Open original photo"
      >
        {inner}
      </a>
    );
  }
  return <span className={className}>{inner}</span>;
}

function sourceShortName(source: PhotoAttribution["source"]): string {
  switch (source) {
    case "mapillary":
      return "Mapillary";
    case "google":
      return "Google";
    case "wikimedia":
      return "Wikimedia";
    case "street_view":
      return "Street View";
    default:
      return "Photo";
  }
}
