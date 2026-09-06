// linen-truck — was the engine running? (docs/CONTRACTS.md §3, rule 1).
//
// The tracker is wired to the truck's electrics, so the charging line is the
// only honest movement signal it has. `nSpeed` is not: a PARKED tracker reports
// 5–107 km/h and scatters its fixes hundreds of metres (HF Ville, 2026-09-06,
// 16:00–21:00 — the truck never moved and the day page still showed 20 trips,
// 19.8 km and 17 outside-hours findings). Voltage tells the two apart cleanly:
// real driving reads 13.4–14.0 V from the FIRST fix after a start and stays
// there, parked sits at 12.4–12.9 V.
//
// Two deliberate shapes:
//
//   * The hold is SYMMETRIC. Under load the line dips for a single fix
//     (2026-09-05 13:40:45 = 12.2 V at 40 km/h, with 13.8 V neighbours 90 s
//     either side); a causal hold would call that an engine stop. This domain
//     is an offline batch over a finished day, so looking forwards is free.
//   * A day with NO voltage anywhere is entirely ENGINE-ON. Voltage is present
//     on essentially every fix today (null on 1 of 198 on 2026-09-05, 0 of 235
//     on 2026-09-06), but a future point source without it must leave the report
//     exactly as it is now rather than silently declaring the truck parked all
//     day: null is unknown, never "off".

import type { Point, Rules } from "./types.ts";

/**
 * One flag per point, in the same order: true where the engine was running.
 *
 * A fix is ENGINE-ON iff some fix of the same day carries a voltage at or above
 * `engineOnVolts` within ±`engineHoldS` seconds of it — so a null-voltage fix
 * inherits the state of its neighbours rather than answering for itself.
 */
export function engineOnMask(points: readonly Point[], rules: Rules): boolean[] {
  const hot: number[] = [];
  let anyVoltage = false;
  for (const p of points) {
    if (p.voltage === null) continue;
    anyVoltage = true;
    if (p.voltage >= rules.engineOnVolts) hot.push(p.t);
  }
  if (!anyVoltage) return points.map(() => true);
  // `points` is normally already sorted (cleanPoints), but this helper is
  // exported on its own, so the hold window may not assume it.
  hot.sort((a, b) => a - b);

  const hold = rules.engineHoldS;
  return points.map((p) => {
    // The first hot fix at or after `p.t - hold`; on iff it is also within reach.
    let lo = 0;
    let hi = hot.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hot[mid]! < p.t - hold) lo = mid + 1;
      else hi = mid;
    }
    return lo < hot.length && hot[lo]! <= p.t + hold;
  });
}
