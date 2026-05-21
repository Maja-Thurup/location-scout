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
  /**
   * Driving directions in Google Maps. Optional in v4: the card now
   * surfaces only Google Maps to keep the action area clean. Kept on
   * the type for tests and future use.
   */
  directions?: string;
  /** Apple Maps deep link. Optional in v4 — see directions. */
  appleMaps?: string;
  /** Waze deep link. Optional in v4 — see directions. */
  waze?: string;
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

/**
 * One photo carried on the LocationCard prop. Mirrors the SelectedPhoto
 * shape from the API (URL + provenance + attribution + optional vision
 * score) but is cloned here so the contract stays pure-frontend.
 */
export type LocationCardPhoto = {
  url: string;
  source: PhotoSource;
  capturedAt: string | null;
  attributionText: string;
  attributionHref: string | null;
  visionScore: number | null;
  visionReason: string | null;
  /**
   * Optional Mapillary panorama flag. When true the renderer can show
   * the photo with a 360°-style frame and (eventually) wire it into
   * the embedded MapillaryJS viewer for swipeable views.
   */
  isPanorama?: boolean;
  /**
   * Mapillary `quality_score` (0..1) when the source is Mapillary.
   * Used to pick the visually-strongest photo as the primary thumbnail
   * even when a more recent capture exists.
   */
  qualityScore?: number | null;
  /**
   * Compass heading the camera was pointing in degrees (0=N, 90=E,
   * 180=S, 270=W). When present, the carousel can display a small
   * compass needle so the scout knows what direction the photo faces.
   */
  compassAngle?: number | null;
};

/**
 * Card-ready facts pulled from Wikidata for landmark-y candidates.
 * Mirrors the WikidataFacts type in lib/providers/types.ts but is
 * defined here so the components contract stays pure-frontend.
 */
export type LocationFacts = {
  /** Year built / inception (4-digit string, e.g. "1885"). */
  inception?: string;
  /** Sculptor / artist names. */
  creators?: ReadonlyArray<string>;
  /** Architect names. */
  architects?: ReadonlyArray<string>;
  /** Materials, e.g. "bronze", "marble". */
  materials?: ReadonlyArray<string>;
  /** Genre, e.g. "neoclassical", "Art Deco". */
  genres?: ReadonlyArray<string>;
  /** Subjects depicted, e.g. "horse", "George Washington". */
  depicts?: ReadonlyArray<string>;
  /** Named after, e.g. "Theodore Roosevelt". */
  namedAfter?: ReadonlyArray<string>;
  /** Parent place, e.g. "Central Park". */
  partOf?: ReadonlyArray<string>;
  /** Wikimedia Commons category (gallery slug). */
  commonsCategory?: string;
};

export type LocationCardProps = {
  id: string;
  /**
   * Display name. Falsy/empty means "no name available" — the card
   * shows lat/lng coordinates instead (filmmaker-friendly fallback for
   * unnamed OSM features).
   */
  name: string;
  /** Postal address — present for back-compat but no longer rendered. */
  address?: string;
  lat: number;
  lng: number;
  rating?: number;

  /**
   * Every photo we have for this location, ordered most-curated first.
   * Powers the "Photos" carousel above the info section. The first
   * entry is the primary thumbnail.
   */
  photos: ReadonlyArray<LocationCardPhoto>;

  /** Driving distance + time from the user's crew base, if set. */
  drivingDistance?: DrivingDistance;

  /**
   * Deep-link bundle. Only `googleMaps` is rendered as a button in v4
   * (apple/waze/directions removed for visual clarity); the other
   * fields stay on the type for tests + future use.
   */
  deepLinks: DeepLinks;

  /** Optional badges, e.g. "abandoned", "3 stories", "brick". */
  badges?: ReadonlyArray<string>;

  /** Per-location notes (free-tier feature). */
  notes?: string;

  /** Providers that surfaced this location (for source pills). */
  sources?: ReadonlyArray<LocationSource>;
  /** Wikidata description / NYC fun-fact / Wikipedia summary, when present. */
  description?: string;
  /** "Open in source" link (Wikipedia article, NYC dataset row, ...). */
  sourceUrl?: string;
  /** Films known to have been shot here. Up to 3 surfaced in the strip. */
  films?: ReadonlyArray<SurfacedFilm>;

  /**
   * Optional Wikidata facts (year built, sculptor, material, genre,
   * named-after, Commons gallery). Rendered as a compact fact list
   * below the description when any are present.
   */
  facts?: LocationFacts;

  isSaved?: boolean;
  isSelected?: boolean;

  onSelect?: (id: string) => void;
  onSave?: (id: string) => void;
  onUnsave?: (id: string) => void;
  onNotesChange?: (id: string, notes: string) => void;
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
