/// <reference types="google.maps" />
"use client";

import { useEffect, useRef, useState } from "react";
import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

import { clientEnv } from "@/lib/env-client";
import type {
  LocationMapPin,
  LocationMapProps,
  MapType,
} from "@/components/contracts";
import type { Bbox } from "@/lib/bbox";

// ---------------------------------------------------------------------------
// Module-level loader: ensures the Google Maps JS API is loaded exactly once
// per session even if multiple <LocationMap> instances mount.
//
// The v2 loader replaces the old `Loader` class with two standalone fns:
//   setOptions(...)    — configure once
//   importLibrary(...) — fetches a specific JS module on demand
// ---------------------------------------------------------------------------

let configured = false;

type LoadedLibs = {
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
};

let loadPromise: Promise<LoadedLibs> | null = null;

function loadGoogleMaps(): Promise<LoadedLibs> {
  if (loadPromise) return loadPromise;
  if (!clientEnv.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return Promise.reject(
      new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not configured."),
    );
  }
  if (!configured) {
    setOptions({
      key: clientEnv.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
      v: "weekly",
    });
    configured = true;
  }
  loadPromise = (async () => {
    const [maps, marker] = await Promise.all([
      importLibrary("maps") as Promise<google.maps.MapsLibrary>,
      importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
    ]);
    return { maps, marker };
  })();
  return loadPromise;
}

// ---------------------------------------------------------------------------
// LocationMap
// ---------------------------------------------------------------------------

export type LocationMapWithBboxProps = LocationMapProps & {
  /** Optional bbox to fit the viewport to; trumps `center`/`zoom`. */
  bbox?: Bbox;
};

export function LocationMap({
  pins,
  center,
  zoom,
  selectedId,
  mapType,
  onMapTypeChange,
  onPinClick,
  bbox,
  className,
}: LocationMapWithBboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(
    new Map(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initialize the map once.
  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    loadGoogleMaps()
      .then(({ maps }) => {
        if (cancelled || !containerRef.current) return;
        const map = new maps.Map(containerRef.current, {
          center: center ?? { lat: 40.7128, lng: -74.006 },
          zoom: zoom ?? 11,
          mapTypeId: mapType,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          mapId: "location-scout",
        });
        mapRef.current = map;
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to mapType changes from the parent (toggle buttons).
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.setMapTypeId(mapType);
    }
  }, [mapType]);

  // Fit map to bbox when it changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bbox) return;
    const bounds = new google.maps.LatLngBounds(
      { lat: bbox.south, lng: bbox.west },
      { lat: bbox.north, lng: bbox.east },
    );
    map.fitBounds(bounds, 32);
  }, [bbox]);

  // Reconcile markers with `pins`.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const wantIds = new Set(pins.map((p) => p.id));

    // Remove markers no longer in `pins`.
    for (const [id, marker] of markersRef.current.entries()) {
      if (!wantIds.has(id)) {
        marker.map = null;
        markersRef.current.delete(id);
      }
    }

    // Add or update existing markers.
    for (const pin of pins) {
      let marker = markersRef.current.get(pin.id);
      if (!marker) {
        marker = new google.maps.marker.AdvancedMarkerElement({
          map,
          position: { lat: pin.lat, lng: pin.lng },
          title: pin.name,
          content: buildPinElement(pin, pin.id === selectedId),
        });
        marker.addListener("click", () => onPinClick?.(pin.id));
        markersRef.current.set(pin.id, marker);
      } else {
        marker.position = { lat: pin.lat, lng: pin.lng };
        marker.content = buildPinElement(pin, pin.id === selectedId);
      }
    }
  }, [pins, selectedId, onPinClick]);

  if (loadError) {
    return (
      <div
        className={
          (className ?? "") +
          " flex h-full min-h-[320px] items-center justify-center rounded-md border border-dashed border-red-500/30 bg-red-500/5 p-6 text-center text-sm text-red-300"
        }
      >
        Map failed to load: {loadError}
      </div>
    );
  }

  return (
    <div className={(className ?? "") + " relative h-full"}>
      <div ref={containerRef} className="h-full min-h-[320px] w-full overflow-hidden rounded-md" />
      <MapTypeToggle current={mapType} onChange={onMapTypeChange} />
      {pins.length > 0 && (
        <div className="absolute bottom-3 left-3 rounded-md bg-black/70 px-3 py-1 text-xs font-medium tracking-tight text-white backdrop-blur">
          {pins.length} {pins.length === 1 ? "pin" : "pins"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map-type toggle (overlay)
// ---------------------------------------------------------------------------

const MAP_TYPES: Array<{ value: MapType; label: string }> = [
  { value: "roadmap", label: "Map" },
  { value: "satellite", label: "Satellite" },
  { value: "hybrid", label: "Hybrid" },
];

function MapTypeToggle({
  current,
  onChange,
}: {
  current: MapType;
  onChange: (m: MapType) => void;
}) {
  return (
    <div className="absolute top-3 right-3 flex overflow-hidden rounded-md border border-white/10 bg-black/70 backdrop-blur">
      {MAP_TYPES.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={
            "px-3 py-1.5 text-xs font-medium transition " +
            (current === opt.value
              ? "bg-primary text-primary-foreground"
              : "text-white/80 hover:bg-white/10")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pin styling
// ---------------------------------------------------------------------------

function buildPinElement(pin: LocationMapPin, selected: boolean): HTMLElement {
  const el = document.createElement("div");
  el.style.transform = "translateY(-50%)";
  el.style.cursor = "pointer";
  el.innerHTML = `
    <div style="
      width: ${selected ? "16px" : "12px"};
      height: ${selected ? "16px" : "12px"};
      border-radius: 50%;
      background: ${selected ? "oklch(0.696 0.17 162.48)" : "oklch(0.7 0 0)"};
      border: 2px solid ${selected ? "white" : "rgba(255,255,255,0.85)"};
      box-shadow: 0 0 0 1px rgba(0,0,0,0.3), 0 4px 8px rgba(0,0,0,0.4);
      transition: all 0.15s ease;
    "></div>
  `;
  return el;
}
