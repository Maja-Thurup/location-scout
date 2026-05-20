/**
 * Component contracts — the swap-in source of truth.
 *
 * Every component listed here has its prop signature locked. You design and
 * deliver new versions of these components against these types and we drop
 * them in 1:1.
 *
 * Rules:
 *   - Adding a new optional field is a non-breaking change (always allowed).
 *   - Renaming, removing, or making a field required is a breaking change
 *     and must be coordinated.
 *
 * (c) 2026 Igor Kirko. All rights reserved.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type LatLng = { lat: number; lng: number };

export type MapType = "roadmap" | "satellite" | "hybrid" | "terrain";

export type PhotoSource = "mapillary" | "google" | "wikimedia" | "street_view";

export type DeepLinks = {
  /** Open in Google Maps for viewing the location. */
  googleMaps: string;
  /** Get driving directions in Google Maps. */
  directions: string;
  /** Open in Apple Maps (iOS). */
  appleMaps: string;
  /** Open and start navigation in Waze. */
  waze: string;
};

export type DrivingDistance = {
  meters: number;
  seconds: number;
  /** Display label for the origin, e.g. "from Brooklyn studio". */
  fromLabel: string;
};

export type PhotoAttribution = {
  source: PhotoSource;
  /** Human-readable line, e.g. "© Mapillary contributors, CC BY-SA". */
  text: string;
  /** Optional link to the source page (clickable for ShareAlike compliance). */
  href?: string;
};

// ---------------------------------------------------------------------------
// SceneInput — used in M2
// ---------------------------------------------------------------------------

export type SceneInputProps = {
  initialSceneText?: string;
  initialCity?: string;
  isAnalyzing?: boolean;
  onAnalyze: (input: { sceneText: string; city: string }) => void;
};

// ---------------------------------------------------------------------------
// LocationCard — used in M4 onwards
// ---------------------------------------------------------------------------

/**
 * Films attached to a location by Phase 2a's filming-location providers
 * (Wikidata P915, NYC Scenes from the City, SF Films), enriched with
 * TMDb posters when available.
 */
export type SurfacedFilm = {
  title: string;
  year: number | null;
  /** TMDb poster URL (w342) when TMDb has the film, else null. */
  posterUrl: string | null;
  tmdbUrl: string | null;
  tmdbId: number | null;
  wikidataQid: string | null;
};

/** Provider that produced the candidate (used for source pills in UI). */
export type LocationSource =
  | "osm"
  | "wikidata-landmark"
  | "wikidata-filming-location"
  | "wikipedia-geosearch"
  | "nyc-scenes-from-the-city"
  | "sf-film-locations"
  | "nps-places"
  | "ridb-recreation"
  | "unesco-heritage"
  | "own-db"
  | "nrhp"
  | "nhl";

export type LocationCardProps = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;

  /** Primary photo URL (Mapillary preferred, Google fallback). */
  photoUrl?: string;
  photoSource: PhotoSource | null;
  photoCapturedAt?: string;
  photoAttribution?: PhotoAttribution;

  /** Static Street View thumbnail URL, if imagery exists at this coord. */
  streetViewThumbUrl?: string;
  /** Whether `google.maps.StreetViewPanorama` will succeed at this coord. */
  hasInteractiveStreetView: boolean;

  /** Driving distance + time from the user's crew base, if set. */
  drivingDistance?: DrivingDistance;

  /** Pre-built deep-link URLs to other map apps. */
  deepLinks: DeepLinks;

  /** Optional badges, e.g. "abandoned", "3 stories", "brick". */
  badges?: ReadonlyArray<string>;

  /** Per-location notes (free-tier feature). */
  notes?: string;

  // ---- Phase 2a additions ----
  /** Providers that surfaced this location (for source pills). */
  sources?: ReadonlyArray<LocationSource>;
  /** Wikidata description / NYC fun-fact / Wikipedia summary, when present. */
  description?: string;
  /** "Open in source" link (Wikipedia article, NYC dataset row, ...). */
  sourceUrl?: string;
  /** Films known to have been shot here. Up to 3 surfaced in the strip. */
  films?: ReadonlyArray<SurfacedFilm>;

  isSaved?: boolean;
  isSelected?: boolean;

  onSelect?: (id: string) => void;
  onSave?: (id: string) => void;
  onUnsave?: (id: string) => void;
  onNotesChange?: (id: string, notes: string) => void;
  onOpenStreetView?: (id: string) => void;
};

// ---------------------------------------------------------------------------
// LocationMap — used in M3 onwards
// ---------------------------------------------------------------------------

export type LocationMapPin = {
  id: string;
  lat: number;
  lng: number;
  name: string;
  /** Optional category for color-coding (e.g. "result", "rental", "cafe"). */
  category?: string;
};

export type LocationMapProps = {
  pins: ReadonlyArray<LocationMapPin>;
  center?: LatLng;
  zoom?: number;
  selectedId?: string;
  mapType: MapType;
  onMapTypeChange: (type: MapType) => void;
  onPinClick?: (id: string) => void;
  className?: string;
};

// ---------------------------------------------------------------------------
// PhotoAttribution — required UI for Mapillary CC BY-SA compliance
// ---------------------------------------------------------------------------

export type PhotoAttributionProps = PhotoAttribution & {
  className?: string;
};

// ---------------------------------------------------------------------------
// SendToDropdown — used in M4 (the "Open in..." button)
// ---------------------------------------------------------------------------

export type SendToDropdownProps = {
  deepLinks: DeepLinks;
  /** If known, surface Apple Maps first on iOS, Waze on Android. */
  preferredApp?: "googleMaps" | "appleMaps" | "waze";
  className?: string;
};

// ---------------------------------------------------------------------------
// ProjectCard — used in M5
// ---------------------------------------------------------------------------

export type ProjectCardProps = {
  id: string;
  title: string;
  city: string;
  locationCount: number;
  thumbnailUrl?: string;
  createdAt: string;
  updatedAt: string;

  onOpen?: (id: string) => void;
  onDelete?: (id: string) => void;
};

// ---------------------------------------------------------------------------
// CrewBaseInput — used in M5
// ---------------------------------------------------------------------------

export type CrewBaseInputProps = {
  initialAddress?: string;
  isSaving?: boolean;
  onSave: (address: string) => void;
  onClear?: () => void;
};

// ---------------------------------------------------------------------------
// ScriptUpload — used in M6
// ---------------------------------------------------------------------------

export type DetectedScene = {
  index: number;
  heading: string; // e.g. "INT. WAREHOUSE - NIGHT"
  excerpt: string; // first ~200 chars of the scene
  startOffset: number;
  endOffset: number;
};

export type ScriptUploadProps = {
  isUploading?: boolean;
  onUpload: (file: File) => void;
  onPasteText?: (text: string) => void;
  detectedScenes?: ReadonlyArray<DetectedScene>;
  onSelectScene?: (scene: DetectedScene) => void;
};
