"use client";

import { useState } from "react";

import type { LocationCardProps } from "@/components/contracts";
import { PhotoAttributionBadge } from "@/components/photo-attribution";

/**
 * The result card. Implements `LocationCardProps` from contracts.ts so a
 * future redesign can drop in a different visual treatment without
 * touching the data plumbing.
 */
export function LocationCard({
  id,
  name,
  address,
  rating,
  photoUrl,
  photoSource,
  photoCapturedAt,
  photoAttribution,
  streetViewThumbUrl,
  hasInteractiveStreetView,
  drivingDistance,
  deepLinks,
  badges,
  isSelected,
  onSelect,
}: LocationCardProps) {
  const [view, setView] = useState<"primary" | "street_view">("primary");

  const showStreetView = view === "street_view" && streetViewThumbUrl;
  const displayUrl = showStreetView
    ? streetViewThumbUrl
    : photoUrl ?? streetViewThumbUrl ?? null;

  return (
    <article
      onClick={() => onSelect?.(id)}
      className={
        "group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card transition " +
        (isSelected
          ? "border-primary shadow-[0_0_0_1px_oklch(0.696_0.17_162.48)]"
          : "border-white/10 hover:border-white/20")
      }
    >
      <div className="relative aspect-video bg-black/40">
        {displayUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={displayUrl}
            alt={name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <NoPhotoPlaceholder />
        )}

        {/* Top-left: photo source toggle (only when both options exist). */}
        {photoUrl && streetViewThumbUrl && (
          <div className="absolute top-2 left-2 flex overflow-hidden rounded-md border border-white/10 bg-black/70 text-[10px] backdrop-blur">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setView("primary");
              }}
              className={
                "px-2 py-0.5 transition " +
                (view === "primary" ? "bg-primary text-primary-foreground" : "text-white/80 hover:bg-white/10")
              }
            >
              {sourceLabel(photoSource)}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setView("street_view");
              }}
              className={
                "px-2 py-0.5 transition " +
                (view === "street_view"
                  ? "bg-primary text-primary-foreground"
                  : "text-white/80 hover:bg-white/10")
              }
            >
              Street View
            </button>
          </div>
        )}

        {/* Bottom-left: photo attribution overlay (CC BY-SA + Google reqs). */}
        {showStreetView ? (
          <div className="absolute bottom-2 left-2 max-w-[80%]">
            <PhotoAttributionBadge source="street_view" text="© Google" />
          </div>
        ) : photoAttribution ? (
          <div className="absolute bottom-2 left-2 max-w-[80%]">
            <PhotoAttributionBadge {...photoAttribution} />
          </div>
        ) : null}

        {/* Bottom-right: photo capture date + distance pill. */}
        <div className="absolute right-2 bottom-2 flex flex-col items-end gap-1">
          {!showStreetView && photoCapturedAt && (
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80 backdrop-blur">
              {formatPhotoDate(photoCapturedAt)}
            </span>
          )}
          {drivingDistance && (
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              {formatDriving(drivingDistance.meters, drivingDistance.seconds)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <header className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug">{name}</h3>
          {rating != null && (
            <span className="shrink-0 text-xs text-muted-foreground">
              ★ {rating.toFixed(1)}
            </span>
          )}
        </header>

        {address && <p className="text-xs text-muted-foreground">{address}</p>}

        {badges && badges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {badges.map((b, i) => (
              <span
                key={i}
                className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {b}
              </span>
            ))}
          </div>
        )}

        <SendToDropdown deepLinks={deepLinks} hasStreetView={hasInteractiveStreetView} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Send-to dropdown (compact: shown as a row of buttons on the card itself).
// ---------------------------------------------------------------------------

function SendToDropdown({
  deepLinks,
  hasStreetView,
}: {
  deepLinks: LocationCardProps["deepLinks"];
  hasStreetView: boolean;
}) {
  return (
    <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
      <SendToButton href={deepLinks.googleMaps} label="Google Maps" />
      <SendToButton href={deepLinks.directions} label="Directions" />
      <SendToButton href={deepLinks.appleMaps} label="Apple Maps" />
      <SendToButton href={deepLinks.waze} label="Waze" />
      {hasStreetView && (
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          Street View available
        </span>
      )}
    </div>
  );
}

function SendToButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-white/20 hover:text-foreground"
    >
      {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function NoPhotoPlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-base">
          📍
        </div>
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
          No photo found
        </p>
      </div>
    </div>
  );
}

function sourceLabel(source: LocationCardProps["photoSource"]): string {
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

function formatPhotoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // The Street View metadata API returns "YYYY-MM" sometimes — pass through.
    return iso;
  }
  const year = d.getFullYear();
  const month = d.toLocaleString(undefined, { month: "short" });
  return `${month} ${year}`;
}

function formatDriving(meters: number, seconds: number): string {
  const miles = meters / 1609.344;
  const minutes = Math.round(seconds / 60);
  const distance = miles < 1 ? `${(miles * 5280).toFixed(0)} ft` : `${miles.toFixed(1)} mi`;
  return `${distance} · ${minutes} min`;
}
