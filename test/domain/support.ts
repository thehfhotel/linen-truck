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
