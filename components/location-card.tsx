"use client";

import { useState } from "react";

import type {
  LocationCardProps,
  LocationSource,
  SurfacedFilm,
} from "@/components/contracts";
import { PhotoAttributionBadge } from "@/components/photo-attribution";
import { StreetViewModal } from "@/components/street-view-modal";

// ---------------------------------------------------------------------------
// Result card v3 — minimalist
//
// Filmmakers don't care about business names, ratings, or addresses on
// the scout card. They care about WHAT IT LOOKS LIKE and HOW TO GET
// THERE. So the card is now:
//
//   [ photo ]
//   [ tag pills + distance pill + Match score pill ]
//   [ Open Street View | Google Maps | Directions | Apple Maps | Waze ]
//
// Coordinates are encoded into the deep links but no longer rendered as
// visible text. Name (kept on the prop for contract stability) is used
// only for accessibility (alt text + Street View modal title).
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
    // Intentionally received and ignored — kept on the contract so designed
    // components can opt back in if they want to surface them later.
    address: _address,
    rating: _rating,
    lat,
    lng,
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
    sources,
    description,
    sourceUrl,
    films,
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

          {/* Top-left: source badge + Open Street View button + match badge */}
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

          {/* Bottom-left: photo attribution overlay */}
          {photoAttribution && (
            <div className="absolute bottom-2 left-2 max-w-[80%]">
              <PhotoAttributionBadge {...photoAttribution} />
            </div>
          )}

          {/* Bottom-right: capture date + driving distance pill */}
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

        <div className="flex flex-1 flex-col gap-3 p-4">
          {/* Source pills (Wikidata, Wikipedia, NYC Scenes, OSM, ...) */}
          {sources && sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {sources.map((s) => (
                <span
                  key={s}
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide " +
                    sourcePillClass(s)
                  }
                >
                  {sourcePillLabel(s)}
                </span>
              ))}
              {sourceUrl && (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-[10px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  open ↗
                </a>
              )}
            </div>
          )}

          {/* Provider description (Wikidata schema:description, NYC fun-fact, ...) */}
          {description && (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}

          {/* Tag pills */}
          <div className="flex flex-wrap gap-1">
            {badges && badges.length > 0 ? (
              badges.map((b, i) => (
                <span
                  key={i}
                  className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {b}
                </span>
              ))
            ) : (
              <span className="text-[10px] text-muted-foreground">no tags</span>
            )}
          </div>

          {/* Famous films shot here (TMDb-enriched poster strip) */}
          {films && films.length > 0 && <FilmsStrip films={films} />}

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
  if (Number.isNaN(d.getTime())) return iso;
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

// ---------------------------------------------------------------------------
// Source pills — visual identity per provider
// ---------------------------------------------------------------------------

function sourcePillLabel(source: LocationSource): string {
  switch (source) {
    case "osm":
      return "OSM";
    case "wikidata-landmark":
      return "Wikidata";
    case "wikidata-filming-location":
      return "Wikidata · P915";
    case "wikipedia-geosearch":
      return "Wikipedia";
    case "nyc-scenes-from-the-city":
      return "NYC Scenes";
    case "sf-film-locations":
      return "SF Films";
  }
}

function sourcePillClass(source: LocationSource): string {
  switch (source) {
    case "nyc-scenes-from-the-city":
    case "sf-film-locations":
      return "bg-rose-500/15 text-rose-200 border border-rose-500/20";
    case "wikidata-filming-location":
      return "bg-violet-500/15 text-violet-200 border border-violet-500/20";
    case "wikidata-landmark":
      return "bg-blue-500/15 text-blue-200 border border-blue-500/20";
    case "wikipedia-geosearch":
      return "bg-sky-500/15 text-sky-200 border border-sky-500/20";
    case "osm":
    default:
      return "bg-white/5 text-muted-foreground border border-white/10";
  }
}

// ---------------------------------------------------------------------------
// "Famous films shot here" poster strip
// ---------------------------------------------------------------------------

function FilmsStrip({ films }: { films: ReadonlyArray<SurfacedFilm> }) {
  // Up to 3 posters in the strip; the rest get a "+N more" pill.
  const surfaced = films.slice(0, 3);
  const overflow = films.length - surfaced.length;

  return (
    <div
      className="space-y-1"
      // Click on a poster shouldn't bubble to the card-select handler.
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        🎬 Famous films shot here
      </p>
      <div className="flex gap-2">
        {surfaced.map((f, i) => (
          <FilmPoster key={f.tmdbId ?? `${i}:${f.title}`} film={f} />
        ))}
        {overflow > 0 && (
          <div className="flex h-[78px] w-[52px] items-center justify-center rounded border border-white/10 bg-white/5 text-[10px] text-muted-foreground">
            +{overflow}
          </div>
        )}
      </div>
    </div>
  );
}

function FilmPoster({ film }: { film: SurfacedFilm }) {
  const tooltipParts = [film.title, film.year ? `(${film.year})` : null].filter(
    Boolean,
  );
  const tooltip = tooltipParts.join(" ");

  const inner = film.posterUrl ? (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={film.posterUrl}
      alt={tooltip}
      loading="lazy"
      className="h-[78px] w-[52px] rounded border border-white/10 object-cover"
    />
  ) : (
    <div className="flex h-[78px] w-[52px] flex-col items-center justify-center rounded border border-white/10 bg-white/5 px-1 text-center">
      <span className="line-clamp-2 text-[9px] leading-tight text-muted-foreground">
        {film.title}
      </span>
      {film.year && (
        <span className="mt-0.5 font-mono text-[9px] text-muted-foreground">
          {film.year}
        </span>
      )}
    </div>
  );

  if (film.tmdbUrl) {
    return (
      <a
        href={film.tmdbUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={tooltip}
        className="transition hover:opacity-80"
      >
        {inner}
      </a>
    );
  }
  return (
    <span title={tooltip} className="block">
      {inner}
    </span>
  );
}
