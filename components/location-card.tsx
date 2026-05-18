"use client";

import { useState } from "react";

import type { LocationCardProps } from "@/components/contracts";
import { PhotoAttributionBadge } from "@/components/photo-attribution";
import { StreetViewModal } from "@/components/street-view-modal";

// ---------------------------------------------------------------------------
// Result card v2
//
// Top-left tab toggle: vision-matched thumbnail ↔ "Open Street View"
//   - When a photo URL exists, the default view is the matched thumbnail
//     with its source badge ("Google" / "Mapillary" / "Street View").
//   - Clicking the "Street View" tab opens the interactive panorama modal
//     (google.maps.StreetViewPanorama) when imagery is available.
//
// Identifier strip: monospaced lat/lng is the primary, address (when known)
// is a secondary line. Filmmakers paste coords; addresses are nice-to-have.
// ---------------------------------------------------------------------------

export type LocationCardExtraProps = {
  /** 0-100 from Claude Vision; null when scoring failed or wasn't run. */
  visionScore?: number | null;
  /** Optional one-line rationale Claude returned with the score. */
  visionReason?: string | null;
};

export function LocationCard(props: LocationCardProps & LocationCardExtraProps) {
  const {
    id,
    name,
    address,
    lat,
    lng,
    rating,
    photoUrl,
    photoSource,
    photoCapturedAt,
    photoAttribution,
    hasInteractiveStreetView,
    drivingDistance,
    deepLinks,
    badges,
    isSelected,
    onSelect,
    visionScore,
    visionReason,
  } = props;

  const [panoOpen, setPanoOpen] = useState(false);

  return (
    <>
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
          {photoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={photoUrl}
              alt={name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <NoPhotoPlaceholder />
          )}

          {/* Top-left: source badge for the matched photo + "Street View" toggle. */}
          <div className="absolute top-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
            {photoUrl && (
              <span className="rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase backdrop-blur">
                {sourceLabel(photoSource)}
              </span>
            )}
            {hasInteractiveStreetView && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPanoOpen(true);
                }}
                className="rounded-md border border-white/20 bg-black/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase backdrop-blur transition hover:bg-white/10"
              >
                Open Street View
              </button>
            )}
            {visionScore != null && (
              <span
                title={visionReason ?? undefined}
                className={
                  "rounded-md px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase backdrop-blur " +
                  visionBadgeClass(visionScore)
                }
              >
                Match {visionScore}
              </span>
            )}
          </div>

          {/* Bottom-left: photo attribution overlay (CC BY-SA + Google reqs). */}
          {photoAttribution && (
            <div className="absolute bottom-2 left-2 max-w-[80%]">
              <PhotoAttributionBadge {...photoAttribution} />
            </div>
          )}

          {/* Bottom-right: capture date + driving distance pill. */}
          <div className="absolute right-2 bottom-2 flex flex-col items-end gap-1">
            {photoCapturedAt && (
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
          {/* Coordinates first, address below. */}
          <div className="space-y-1">
            <p className="font-mono text-xs leading-tight text-foreground">
              {lat.toFixed(5)}, {lng.toFixed(5)}
            </p>
            {address && (
              <p className="text-xs leading-snug text-muted-foreground">{address}</p>
            )}
          </div>

          <header className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold leading-snug">{name}</h3>
            {rating != null && (
              <span className="shrink-0 text-xs text-muted-foreground">
                ★ {rating.toFixed(1)}
              </span>
            )}
          </header>

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

          <SendToRow deepLinks={deepLinks} />
        </div>
      </article>

      <StreetViewModal
        open={panoOpen}
        lat={lat}
        lng={lng}
        title={name}
        onClose={() => setPanoOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Send-to row
// ---------------------------------------------------------------------------

function SendToRow({ deepLinks }: { deepLinks: LocationCardProps["deepLinks"] }) {
  return (
    <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
      <SendToButton href={deepLinks.googleMaps} label="Google Maps" />
      <SendToButton href={deepLinks.directions} label="Directions" />
      <SendToButton href={deepLinks.appleMaps} label="Apple Maps" />
      <SendToButton href={deepLinks.waze} label="Waze" />
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
// Helpers
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
    case "google":
      return "Google";
    case "street_view":
      return "Street View";
    case "mapillary":
      return "Mapillary";
    case "wikimedia":
      return "Wikimedia";
    default:
      return "Photo";
  }
}

function formatPhotoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso; // pass-through "YYYY-MM" form Street View sometimes returns
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

function visionBadgeClass(score: number): string {
  if (score >= 70) return "bg-emerald-500/80 text-black";
  if (score >= 40) return "bg-amber-500/80 text-black";
  return "bg-red-500/70 text-white";
}
