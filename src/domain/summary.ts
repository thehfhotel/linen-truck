// linen-truck — one Bangkok day, end to end (docs/CONTRACTS.md §3, rules 7-8).
//
// `summarizeDay` is the only entry point the server needs: hand it every point it
// has and the checked-in config, and it clips to the Bangkok day, cleans, segments
// and audits. Numbers come out UNROUNDED (15.710809… km, ratio 1.5034…); rounding
// is a presentation decision and belongs to the report layer in §9.

import { audit } from "./audit.ts";
import { bangkokDayWindow } from "./clock.ts";
import { cleanPoints, segment } from "./segment.ts";
import type { DaySummary, Leg, Point, Rules, Site, Stop, Trip } from "./types.ts";

/** Rule 7: parked seconds per known site. Virtual book-ends are not parked time. */
function timeAtSite(stops: Stop[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stops) {
    if (s.virtual || s.siteId === null) continue;
    out[s.siteId] = (out[s.siteId] ?? 0) + (s.depart - s.arrive);
  }
  return out;
}

/**
 * Rule 7: `min(#legs A→B, #legs B→A)` over the first two configured sites — HF and
 * HF Ville (§2). The minimum is what makes it a ROUND trip: three runs out and one
 * back is one round trip and three deliveries, not three round trips. Symmetric,
 * so the order of `config/sites.json` cannot change the answer.
 */
function countRoundTrips(legs: Leg[], sites: Site[]): number {
  const a = sites[0]?.id;
  const b = sites[1]?.id;
  if (a === undefined || b === undefined) return 0;
  let ab = 0;
  let ba = 0;
  for (const leg of legs) {
    if (leg.fromSiteId === a && leg.toSiteId === b) ab++;
    if (leg.fromSiteId === b && leg.toSiteId === a) ba++;
  }
  return Math.min(ab, ba);
}

/**
 * Rule 7: when the truck first moved. This is the first trip's start, which is by
 * construction the first stop's departure — the fixture's 12:11 (§9), where the
 * day opens mid-move at a virtual book-end and there is no earlier real departure
 * to report. Null on a day with no trip at all.
 */
const firstDepartureOf = (trips: Trip[]): number | null => trips[0]?.start ?? null;

/** Rule 7: the last time the truck actually settled somewhere; book-ends excluded. */
function lastArrivalOf(stops: Stop[]): number | null {
  for (let i = stops.length - 1; i >= 0; i--) {
    const s = stops[i]!;
    if (!s.virtual) return s.arrive;
  }
  return null;
}

/** Rule 8: the Bangkok `[00:00, 24:00)` of `ymd`; anything outside is another day. */
export function summarizeDay(ymd: string, points: Point[], sites: Site[], rules: Rules): DaySummary {
  const { startS, endS } = bangkokDayWindow(ymd);
  const day = cleanPoints(points).filter((p) => p.t >= startS && p.t < endS);
  const seg = segment(day, sites, rules);
  const findings = audit(ymd, seg, day, sites, rules);
  return {
    ymd,
    pointCount: day.length,
    firstPointAt: day[0]?.t ?? null,
    lastPointAt: day[day.length - 1]?.t ?? null,
    km: seg.trips.reduce((s, t) => s + t.km, 0),
    tripCount: seg.trips.length,
    roundTrips: countRoundTrips(seg.legs, sites),
    firstDeparture: firstDepartureOf(seg.trips),
    lastArrival: lastArrivalOf(seg.stops),
    timeAtSiteS: timeAtSite(seg.stops),
    stops: seg.stops,
    trips: seg.trips,
    legs: seg.legs,
    findings,
  };
}
