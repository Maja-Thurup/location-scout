/// <reference types="google.maps" />
"use client";

import { useEffect, useRef, useState } from "react";
import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

import { clientEnv } from "@/lib/env-client";

// ---------------------------------------------------------------------------
// Interactive Street View modal.
//
// Embeds google.maps.StreetViewPanorama inside a centered overlay. Lets the
// user drag to rotate, scroll to zoom, switch to adjacent panoramas — the
// full Street View experience inline, without leaving the app.
// ---------------------------------------------------------------------------

let configured = false;
let loadPromise: Promise<google.maps.StreetViewLibrary> | null = null;

function loadStreetView(): Promise<google.maps.StreetViewLibrary> {
  if (loadPromise) return loadPromise;
  if (!clientEnv.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return Promise.reject(
      new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not configured."),
    );
  }
  if (!configured) {
    setOptions({ key: clientEnv.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, v: "weekly" });
    configured = true;
  }
  loadPromise = importLibrary("streetView") as Promise<google.maps.StreetViewLibrary>;
  return loadPromise;
}

export type StreetViewModalProps = {
  open: boolean;
  lat: number;
  lng: number;
  /** Optional title for the dialog header. */
  title?: string;
  onClose: () => void;
};

export function StreetViewModal({
  open,
  lat,
  lng,
  title,
  onClose,
}: StreetViewModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panoRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build a fresh panorama every time the modal OPENS, against whatever
  // the current container DOM node is. The previous implementation reused
  // a cached panorama, but when the modal is closed React unmounts the
  // container; on reopen the cached panorama still pointed at a detached
  // DOM node — net effect was a black screen on every reopen.
  useEffect(() => {
    if (!open) {
      // Tear down any prior panorama so the next open builds a fresh one.
      panoRef.current = null;
      return;
    }
    let cancelled = false;

    loadStreetView()
      .then(async (lib) => {
        if (cancelled || !containerRef.current) return;
        setError(null);

        // Resolve an OUTDOOR-only panorama at this coord BEFORE building
        // the panorama. Without this, Google's interactive viewer can
        // pick a user-contributed INDOOR panorama (e.g. inside a deli on
        // the ground floor of the Woolworth Building) which lands the
        // user inside a shop instead of looking at the building.
        const svc = new lib.StreetViewService();
        let panoId: string | null = null;
        try {
          const result = await svc.getPanorama({
            location: { lat, lng },
            radius: 75,
            // OUTDOOR limits to Google's official street-level imagery
            // (excludes user-contributed indoor "look inside" panoramas).
            source: lib.StreetViewSource.OUTDOOR,
            preference: lib.StreetViewPreference.NEAREST,
          });
          panoId = result.data.location?.pano ?? null;
        } catch {
          // No outdoor pano available within 75m — surface the friendly
          // empty state rather than falling back to indoor imagery.
          if (!cancelled) {
            setError("Street View imagery isn't available at this exact spot.");
          }
          return;
        }

        if (cancelled || !containerRef.current) return;

        const sv = new lib.StreetViewPanorama(containerRef.current, {
          // Use the explicit pano id we resolved with OUTDOOR source.
          // Setting `position` would re-trigger Google's default picker
          // and could re-introduce indoor panoramas.
          pano: panoId ?? undefined,
          position: panoId ? undefined : { lat, lng },
          pov: { heading: 0, pitch: 0 },
          zoom: 1,
          motionTracking: false,
          motionTrackingControl: false,
          fullscreenControl: true,
          addressControl: false,
          showRoadLabels: false,
        });
        sv.addListener("status_changed", () => {
          const status = sv.getStatus();
          if (status !== "OK") {
            setError("Street View imagery isn't available at this exact spot.");
          }
        });
        panoRef.current = sv;
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      // Hide the panorama on unmount so DOM cleanup doesn't leak listeners.
      if (panoRef.current) {
        panoRef.current.setVisible(false);
        panoRef.current = null;
      }
    };
  }, [open, lat, lng]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-white/10 bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">{title ?? "Street View"}</h3>
            <p className="font-mono text-[10px] text-muted-foreground">
              {lat.toFixed(5)}, {lng.toFixed(5)} · drag to look around · scroll to zoom
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 rounded-md border border-white/10 px-3 py-1 text-xs text-muted-foreground transition hover:border-white/20 hover:text-foreground"
          >
            Close (Esc)
          </button>
        </header>

        <div className="relative flex-1">
          <div ref={containerRef} className="absolute inset-0" />
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <p className="max-w-md text-sm text-amber-300">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
