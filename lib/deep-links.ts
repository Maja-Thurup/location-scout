/**
 * Deep-link URL builders for handing a location off to other map / nav apps.
 *
 * All free; no API needed. URLs follow each platform's documented "universal
 * link" convention so they open the native app on mobile and the web app
 * on desktop.
 */

export type DeepLinks = {
  /** Open the location in Google Maps (web or native). */
  googleMaps: string;
  /** Get driving directions in Google Maps. */
  directions: string;
  /** Open in Apple Maps — iOS native, Apple's website on other platforms. */
  appleMaps: string;
  /** Open and start navigating to the location in Waze. */
  waze: string;
};

export type DeepLinkInput = {
  lat: number;
  lng: number;
  /** Optional human label shown by Apple Maps and as Google's `q=` text. */
  label?: string;
  /** Optional Google Place ID. When present, Google Maps shows the rich card. */
  googlePlaceId?: string;
};

function fixed(n: number): string {
  return n.toFixed(6);
}

export function buildDeepLinks(input: DeepLinkInput): DeepLinks {
  const ll = `${fixed(input.lat)},${fixed(input.lng)}`;

  // Google Maps
  // Reference: https://developers.google.com/maps/documentation/urls/get-started
  //
  // CRITICAL: when there's no Google Place ID, we MUST query by coordinates,
  // not by label. Querying by label does a text search on Google's whole
  // index, which means generic OSM labels ("Warehouse (OSM)") all resolve
  // to the same useless top result. Coords always open at the right pin.
  const googleParams = new URLSearchParams({ api: "1" });
  if (input.googlePlaceId) {
    // We have a real place — show its rich card. Label is just for display.
    googleParams.set("query", input.label ?? ll);
    googleParams.set("query_place_id", input.googlePlaceId);
  } else {
    // No place ID — use coords as the query so Google opens at the actual pin.
    googleParams.set("query", ll);
  }
  const googleMaps = `https://www.google.com/maps/search/?${googleParams.toString()}`;

  const directionsParams = new URLSearchParams({
    api: "1",
    destination: ll,
  });
  if (input.googlePlaceId) {
    directionsParams.set("destination_place_id", input.googlePlaceId);
  }
  const directions = `https://www.google.com/maps/dir/?${directionsParams.toString()}`;

  // Apple Maps
  // Reference: https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html
  // ll= centers the map at the coords; q= is the label to display on the pin.
  // When no useful label is available, fall back to coords so the pin renders
  // with a meaningful tooltip rather than the empty string.
  const appleParams = new URLSearchParams({
    ll,
    q: input.label ?? ll,
  });
  const appleMaps = `https://maps.apple.com/?${appleParams.toString()}`;

  // Waze
  // Reference: https://developers.google.com/waze/deeplinks
  const wazeParams = new URLSearchParams({
    ll,
    navigate: "yes",
  });
  const waze = `https://waze.com/ul?${wazeParams.toString()}`;

  return { googleMaps, directions, appleMaps, waze };
}

// ---------------------------------------------------------------------------
// Lightweight UA detection for surfacing the most relevant CTA on mobile.
// We never *block* options; we just pick a default to highlight.
// ---------------------------------------------------------------------------

export type PreferredApp = "googleMaps" | "appleMaps" | "waze";

export function preferredAppForUserAgent(
  ua: string | undefined,
): PreferredApp {
  if (!ua) return "googleMaps";
  const lower = ua.toLowerCase();
  if (/iphone|ipad|ipod/.test(lower)) return "appleMaps";
  if (/android/.test(lower)) {
    // Android users overwhelmingly have Google Maps installed, but film
    // crews driving to set frequently use Waze for traffic. Default to
    // Google but Waze is one click away in the dropdown.
    return "googleMaps";
  }
  return "googleMaps";
}
