// linen-truck — GPS gaps inside trips (docs/CONTRACTS.md §3, rule 10).
//
// The tracker sometimes goes quiet while the truck keeps driving (2026-09-24
// trip 2: no fix from 14:32:29 to 14:43:25 across ~4 km). The two fixes either
// side of the hole are still joined by the trip's polyline and still counted in
// its km, so on the map the hole reads as a GPS "jump". This finds those holes so
// the map can draw them as what they are: a straight line, not the route driven.
//
// MAP ONLY. Nothing here feeds km, trips, stops, legs, findings or any table —
// `tripGaps` reads the trips segmentation already produced and changes none of
// its numbers.

import { haversineM } from "./geo.ts";
import type { Rules, Trip } from "./types.ts";

/** One silent stretch inside a trip: the two fixes either side of it. */
export interface Gap {
  /** `Trip.n` the gap sits in. */
  tripN: number;
  /** Epoch seconds of the last fix before the silence. */
  from: number;
  /** Epoch seconds of the first fix after it. */
  to: number;
  /** `to - from`, seconds. */
  s: number;
  /** Great-circle metres between the two fixes — the straight line the map draws. */
  m: number;
}

/**
 * Every pair of CONSECUTIVE fixes in a trip's path more than `rules.gapS` apart.
 * Strictly more: exactly `gapS` is not a gap. Trip order, then time order.
 *
 * Only trips are looked at, so a parked truck reporting sparsely inside a stop
 * never yields a gap — silence is only worth drawing while the truck is between
 * two places.
 */
export function tripGaps(trips: Trip[], rules: Rules): Gap[] {
  const out: Gap[] = [];
  for (const trip of trips) {
    for (let i = 1; i < trip.path.length; i++) {
      const a = trip.path[i - 1]!;
      const b = trip.path[i]!;
      if (b.t - a.t > rules.gapS) out.push({ tripN: trip.n, from: a.t, to: b.t, s: b.t - a.t, m: haversineM(a, b) });
    }
  }
  return out;
}
