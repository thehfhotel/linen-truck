// linen-truck — distances and geofences (docs/CONTRACTS.md §3).
//
// One earth radius (6 371 000 m) and one formula for the whole app: every
// kilometre the owner sees — trip km, leg km, the detour ratio — is a sum of
// `haversineM` over consecutive fixes, so a different radius here would move
// every number on the page at once.

import type { Site } from "./types.ts";

const EARTH_R_M = 6_371_000;

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle metres between two fixes. */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const dp = rad(b.lat - a.lat);
  const dl = rad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The nearest site whose own `radiusM` contains the fix, or null.
 *
 * Per site radius, not a global one: HF and HF Ville are 4 km apart today, but
 * the geofences are allowed to overlap (§2 is owner-tuned), and when they do the
 * NEAREST centre wins — never the first in the file.
 */
export function siteAt(p: { lat: number; lon: number }, sites: Site[]): Site | null {
  let best: Site | null = null;
  let bestD = Infinity;
  for (const s of sites) {
    const d = haversineM(p, s);
    if (d <= s.radiusM && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** The Google Maps link every unknown stop and map-less table cell carries (§9). */
export function mapUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
}
