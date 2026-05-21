"use client";

import { useState } from "react";

import type {
  LocationCardPhoto,
  LocationCardProps,
  LocationSource,
  SurfacedFilm,
} from "@/components/contracts";
import { PhotoAttributionBadge } from "@/components/photo-attribution";

// ---------------------------------------------------------------------------
// Result card v4 — mobile-first, photos-and-context
//
//   ┌───────────────────────┐
//   │      [Photos]  Map    │  <- tab bar
//   │                       │
//   │      photo carousel   │  <- 4:5 aspect, swipeable
//   │      (or OSM iframe   │
//   │       on Map tab)     │
//   │                       │
//   │  ‹  •••              ›│
//   ├───────────────────────┤
//   │ NAME (or coords)      │
//   │ source pills · open ↗ │
//   │ description / summary │
//   │                       │
//   │ 🎬 Films strip        │
//   │ [ Open in Google Maps]│
//   └───────────────────────┘
//
// Photos tab: every available photo (curated + Mapillary alternates +
//   Google Place photos) in an arrow-navigated carousel. Single source
//   of truth — no separate "more views" dropdown to discover.
//
// Map tab: free OpenStreetMap iframe with a marker at the candidate's
//   coords. No Google Maps JS, no API key, no cost. One-click "Open in
//   Google Maps" link below for the full Street View experience.
//
// Aspect 4:5 (1080×1350, "Instagram Portrait") — taller than 16:9 so
//   it reads well on phones, less aggressive crop than 9:16.
//
// Removed in v4: Apple Maps + Waze + Directions buttons (clutter),
//   embedded Google Street View modal (paid, unreliable), photo
//   `source` badge in the corner (the carousel exposes provenance via
//   the attribution overlay instead).
// ---------------------------------------------------------------------------

export type LocationCardExtraProps = {
  visionScore?: number | null;
  visionReason?: string | null;
};

export function LocationCard(props: LocationCardProps & LocationCardExtraProps) {
  const {
    id,
    name,
    lat,
    lng,
    photos,
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

  const [activeTab, setActiveTab] = useState<"photos" | "map">("photos");
  const [photoIdx, setPhotoIdx] = useState(0);
  const [descExpanded, setDescExpanded] = useState(false);

  const safePhotoIdx = Math.min(photoIdx, Math.max(0, photos.length - 1));
  const currentPhoto = photos[safePhotoIdx] ?? null;
  const headingLine = headingFor(name, lat, lng);

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
      {/* Tab bar */}
      <div
        className="flex items-center gap-1 border-b border-white/10 px-2 pt-2"
        onClick={(e) => e.stopPropagation()}
      >
        <TabButton
          active={activeTab === "photos"}
          onClick={() => setActiveTab("photos")}
        >
          Photos {photos.length > 0 ? `(${photos.length})` : ""}
        </TabButton>
        <TabButton active={activeTab === "map"} onClick={() => setActiveTab("map")}>
          Map
        </TabButton>
      </div>

      {/* Tab body — fixed 4:5 aspect for mobile-friendly layout */}
      <div className="relative aspect-[4/5] bg-black/40">
        {activeTab === "photos" ? (
          <PhotosTab
            photo={currentPhoto}
            photoIdx={safePhotoIdx}
            photoCount={photos.length}
            onPrev={() =>
              setPhotoIdx((i) => (i - 1 + photos.length) % photos.length)
            }
            onNext={() => setPhotoIdx((i) => (i + 1) % photos.length)}
            onPick={setPhotoIdx}
            visionScore={visionScore}
            visionReason={visionReason}
            drivingDistance={drivingDistance}
          />
        ) : (
          <MapTab lat={lat} lng={lng} name={headingLine.label} />
        )}
      </div>

      {/* Info block */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <header className="space-y-1.5">
          <h3 className="text-base leading-tight font-semibold">
            {headingLine.kind === "name" ? (
              headingLine.label
            ) : (
              <span className="font-mono text-sm text-muted-foreground">
                {headingLine.label}
              </span>
            )}
          </h3>
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
        </header>

        {description && (
          <Summary
            description={description}
            expanded={descExpanded}
            onToggle={() => setDescExpanded((v) => !v)}
          />
        )}

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

        {films && films.length > 0 && <FilmsStrip films={films} />}

        <a
          href={deepLinks.googleMaps}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-auto inline-flex items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:border-emerald-400 hover:bg-emerald-500/20"
        >
          Open in Google Maps ↗
        </a>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Photos tab
// ---------------------------------------------------------------------------

function PhotosTab(props: {
  photo: LocationCardPhoto | null;
  photoIdx: number;
  photoCount: number;
  onPrev: () => void;
  onNext: () => void;
  onPick: (idx: number) => void;
  visionScore?: number | null;
  visionReason?: string | null;
  drivingDistance?: LocationCardProps["drivingDistance"];
}) {
  const {
    photo,
    photoIdx,
    photoCount,
    onPrev,
    onNext,
    onPick,
    visionScore,
    visionReason,
    drivingDistance,
  } = props;

  if (!photo) return <NoPhotoPlaceholder />;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />

      {/* Top-left: vision-score + photo-source badges */}
      <div className="absolute top-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
        <span className="rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase backdrop-blur">
          {sourceLabel(photo.source)}
        </span>
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

      {/* Bottom-left: attribution */}
      {photo.attributionText && (
        <div className="absolute bottom-2 left-2 max-w-[80%]">
          <PhotoAttributionBadge
            source={photo.source}
            text={photo.attributionText}
            href={photo.attributionHref ?? undefined}
          />
        </div>
      )}

      {/* Bottom-right: capture date + driving distance */}
      <div className="absolute right-2 bottom-2 flex flex-col items-end gap-1">
        {photo.capturedAt && (
          <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80 backdrop-blur">
            {formatPhotoDate(photo.capturedAt)}
          </span>
        )}
        {drivingDistance && (
          <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
            {formatDriving(drivingDistance.meters, drivingDistance.seconds)}
          </span>
        )}
      </div>

      {/* Carousel arrows + indicators */}
      {photoCount > 1 && (
        <>
          <CarouselButton side="left" onClick={onPrev} />
          <CarouselButton side="right" onClick={onNext} />
          <div className="absolute right-0 bottom-0 left-0 flex justify-center gap-1 pb-2">
            {Array.from({ length: photoCount }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Photo ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(i);
                }}
                className={
                  "h-1.5 rounded-full transition " +
                  (i === photoIdx
                    ? "w-4 bg-white"
                    : "w-1.5 bg-white/40 hover:bg-white/70")
                }
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function CarouselButton({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/60 px-2 py-1 text-white opacity-70 backdrop-blur transition hover:bg-black/80 hover:opacity-100 " +
        (side === "left" ? "left-2" : "right-2")
      }
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Map tab — free OpenStreetMap iframe
// ---------------------------------------------------------------------------

function MapTab({ lat, lng, name }: { lat: number; lng: number; name: string }) {
  // OSM's export/embed.html is a free, no-API-key way to drop a map
  // tile with a marker into an iframe. Bbox is ~600m around the coord
  // so the marker is centered at a useful zoom.
  const delta = 0.003;
  const bbox = [lng - delta, lat - delta, lng + delta, lat + delta]
    .map((n) => n.toFixed(5))
    .join(",");
  const src =
    `https://www.openstreetmap.org/export/embed.html` +
    `?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lng.toFixed(5)}`;

  return (
    <>
      <iframe
        src={src}
        title={`Map showing ${name}`}
        className="h-full w-full"
        loading="lazy"
        // Transparency lets the dark card surface show through during
        // tile load, which looks cleaner than a flash of OSM's white.
        style={{ border: 0, background: "transparent" }}
      />
      {/* Bottom-right: coords pill */}
      <div className="pointer-events-none absolute right-2 bottom-2">
        <span className="rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white/80 backdrop-blur">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab + summary helpers
// ---------------------------------------------------------------------------

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        "rounded-t-md px-3 py-1.5 text-xs font-medium tracking-wide uppercase transition " +
        (props.active
          ? "bg-white/10 text-foreground"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {props.children}
    </button>
  );
}

function Summary({
  description,
  expanded,
  onToggle,
}: {
  description: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Clamp long descriptions — UNESCO entries can run to 500+ chars and
  // dominate the card. Show the first ~280 chars, expand on click.
  const NEEDS_CLAMP_AT = 280;
  const needsClamp = description.length > NEEDS_CLAMP_AT;

  if (!needsClamp) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <p
        className={
          "text-xs leading-relaxed text-muted-foreground " +
          (expanded ? "" : "line-clamp-3")
        }
      >
        {description}
      </p>
      <button
        type="button"
        onClick={onToggle}
        className="mt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase underline-offset-4 hover:text-foreground hover:underline"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heading: name when available, lat/lng fallback otherwise
// ---------------------------------------------------------------------------

type HeadingLine =
  | { kind: "name"; label: string }
  | { kind: "coords"; label: string };

function headingFor(name: string, lat: number, lng: number): HeadingLine {
  const trimmed = (name ?? "").trim();
  // Names like "Building (OSM)" or "Tourism=artwork (OSM)" are derived
  // fallbacks from the upstream `deriveName` helper — they look like
  // labels but carry zero useful info to a scout. Treat them as "no
  // name" and show coords instead.
  const isFallbackName =
    !trimmed || /\(OSM\)$/i.test(trimmed) || /^Building$/i.test(trimmed);
  if (isFallbackName) {
    return { kind: "coords", label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
  return { kind: "name", label: trimmed };
}

// ---------------------------------------------------------------------------
// Tiny helpers
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

function sourceLabel(source: LocationCardPhoto["source"]): string {
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
// Source pills (kept verbatim from v3)
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
    case "nps-places":
      return "NPS";
    case "ridb-recreation":
      return "Recreation.gov";
    case "unesco-heritage":
      return "UNESCO";
    case "own-db":
      return "Own DB";
    case "nrhp":
      return "NRHP";
    case "nhl":
      return "NHL";
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
    case "nps-places":
      return "bg-emerald-500/15 text-emerald-200 border border-emerald-500/20";
    case "ridb-recreation":
      return "bg-teal-500/15 text-teal-200 border border-teal-500/20";
    case "unesco-heritage":
      return "bg-amber-500/15 text-amber-200 border border-amber-500/20";
    case "nrhp":
      return "bg-orange-500/15 text-orange-200 border border-orange-500/20";
    case "nhl":
      return "bg-yellow-500/15 text-yellow-200 border border-yellow-500/20";
    case "own-db":
      return "bg-indigo-500/15 text-indigo-200 border border-indigo-500/20";
    case "osm":
    default:
      return "bg-white/5 text-muted-foreground border border-white/10";
  }
}

// ---------------------------------------------------------------------------
// Films strip (kept verbatim from v3)
// ---------------------------------------------------------------------------

function FilmsStrip({ films }: { films: ReadonlyArray<SurfacedFilm> }) {
  const surfaced = films.slice(0, 3);
  const overflow = films.length - surfaced.length;

  return (
    <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        🎬 Films shot here
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
