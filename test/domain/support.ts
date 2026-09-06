// Shared scaffolding for the domain tests.
//
// The synthetic points are built north-south on purpose: along a meridian the
// haversine distance is exactly `dLat * (pi * R / 180)`, so "a fix 200 m from the
// anchor" is an exact statement and a radius-edge assertion is not hand-waving.

import sitesJson from "../../config/sites.json";
import rulesJson from "../../config/rules.json";
import type { Point, Rules, Site } from "../../src/domain/types.ts";

export const SITES: Site[] = sitesJson as Site[];
export const RULES: Rules = rulesJson as Rules;

export const HF = SITES[0]!;
export const HFVILLE = SITES[1]!;

/** Metres per degree of latitude for the earth radius `geo.ts` uses. */
export const M_PER_DEG_LAT = (Math.PI * 6_371_000) / 180;

/** `metres` north of a centre, along the meridian (exact under haversine). */
export const northOf = (c: { lat: number; lon: number }, metres: number): { lat: number; lon: number } => ({
  lat: c.lat + metres / M_PER_DEG_LAT,
  lon: c.lon,
});

/** Epoch seconds for a Bangkok wall-clock instant on a given day. */
export const bkk = (ymd: string, hhmmss: string): number => Date.parse(`${ymd}T${hhmmss}+07:00`) / 1000;

/** A point with sane defaults — tests state only what they are about. */
export function pt(
  t: number,
  at: { lat: number; lon: number },
  extra: { speed?: number; voltage?: number | null } = {},
): Point {
  return { t, lat: at.lat, lon: at.lon, speed: extra.speed ?? 0, voltage: extra.voltage ?? null };
}

/** `count` fixes `stepS` apart, all at the same place — a parked run. */
export function parked(
  t0: number,
  at: { lat: number; lon: number },
  count: number,
  stepS: number,
  extra: { speed?: number; voltage?: number | null } = {},
): Point[] {
  return Array.from({ length: count }, (_, i) => pt(t0 + i * stepS, at, extra));
}

/** A fix `f` of the way from `a` to `b` (linear in degrees — fine over 4 km). */
export const lerp = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  f: number,
): { lat: number; lon: number } => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });

/**
 * One synthetic delivery run, shared by the segment and audit tests: parked at
 * HF, drive, five minutes at nowhere, drive, parked at HF Ville. The day both
 * begins and ends parked, so it has no book-ends.
 *
 * The numbers are PHYSICALLY COHERENT, and §3 rule 1 now needs them to be. HF to
 * HF Ville is 3 920 m, so `f` steps of 0.2 are 784 m and one of those per 60 s
 * is 47 km/h — which is what every moving fix here claims, at a driving voltage.
 * A fix that claims 47 km/h while sitting 200 m from its neighbour is not a
 * truck, and under rule 1 it would read as parked scatter (a settled fix against
 * a settled anchor gets `jitterRadiusM`, whatever the engine is doing) and
 * quietly swallow the stop it was driving towards. The parked runs are at a parked voltage for the same
 * reason: they are the engine-off scatter the rule is about.
 */
export function deliveryDay(t0: number): Point[] {
  const drive = (dt: number, f: number): Point => pt(t0 + dt, lerp(HF, HFVILLE, f), { speed: 47, voltage: 13.8 });
  return [
    ...parked(t0, HF, 11, 60, { voltage: 12.7 }), // 12:00–12:10 at HF
    drive(660, 0.2),
    drive(720, 0.4),
    ...parked(t0 + 780, lerp(HF, HFVILLE, 0.6), 6, 60, { voltage: 12.7 }), // 12:13–12:18 at nowhere
    drive(1140, 0.8),
    ...parked(t0 + 1200, HFVILLE, 11, 60, { voltage: 12.7 }), // 12:20–12:30 at HF Ville
  ];
}

/** The fix a `deliveryDay` is already moving on when a day opens mid-journey. */
export const beforeDeliveryDay = (t0: number): Point =>
  pt(t0 - 60, lerp(HF, HFVILLE, 0.2), { speed: 47, voltage: 13.8 });

/**
 * The 2026-09-06 evening at HF Ville in miniature: the truck stood still for 39
 * minutes while the tracker reported speeds of 5–107 km/h and scattered its
 * fixes up to 570 m from where the truck actually was. Measured on the box that
 * day, over the engine-off fixes: p50 138 m, p90 333 m, p95 496 m, max 571 m.
 *
 * The scatter is arranged as five tight clusters, so the SAME shape read at a
 * driving voltage still segments the way it does today — five stops and four
 * trips — and the difference between the two readings is only the engine state.
 *
 * `volts` is cycled fix by fix: `[12.5, 12.6, 12.7]` is the real parked band,
 * `[13.8]` the same track as if the engine had genuinely been running.
 *
 * `rotate` turns the SAME twenty places over the SAME twenty timestamps so that a
 * different fix leads the evening. Nothing about a parked truck says its first
 * fix lands near the site centre, and the guard must not depend on it: with an
 * anchor-relative bound alone, rotating this list is enough to split the evening
 * into several phantom stops and trips (offsets reach +570 m and -520 m, so two
 * fixes are 1 090 m apart while the bound is 600 m).
 */
export function parkedEvening(
  t0: number,
  centre: { lat: number; lon: number },
  volts: number[],
  rotate = 0,
): Point[] {
  // [seconds after t0, metres north of the centre, the km/h the tracker claims]
  const SCATTER: [number, number, number][] = [
    [0, 0, 7],
    [20, 110, 23], // 20 s apart — the tracker's fast cadence
    [90, -105, 47],
    [200, 115, 5],
    [300, 330, 91],
    [320, 380, 12],
    [480, 300, 107],
    [620, 350, 5],
    [800, -450, 66],
    [880, -520, 31],
    [960, -400, 9],
    [1060, -480, 5],
    [1540, 570, 84], // an eight-minute gap — the slow parked cadence
    [1660, 540, 17],
    [1800, 510, 55],
    [1920, 555, 5],
    [2080, 100, 38],
    [2160, 150, 73],
    [2260, 60, 21],
    [2340, 120, 5],
  ];
  return SCATTER.map(([dt], i) => {
    const [, metres, speed] = SCATTER[(i + rotate) % SCATTER.length]!;
    return pt(t0 + dt!, northOf(centre, metres), { speed, voltage: volts[i % volts.length]! });
  });
}
