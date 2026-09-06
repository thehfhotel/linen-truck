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
//
// `engineEvents` below asks a DIFFERENT question of the same volts and therefore
// reads them differently — see its own comment.

import type { Point, Rules, StopEngine } from "./types.ts";

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

/**
 * The ignition events inside ONE stop: `points[i0..i1]`, the stop's own range.
 *
 * Deliberately RAW voltage, not `engineOnMask`. The mask holds a fix ON across a
 * dip because it answers "was the truck under power while it moved", and a hold
 * that survives 300 s would swallow exactly the event this function exists to
 * report: the driver switching off for a minute at a place he should not be
 * stopped at. Here each fix answers for itself — at or above `engineOnVolts` is
 * ON, under it is OFF — and only a NULL fix borrows anything, carrying the
 * previous fix's state forward (null is unknown, never "off", the same rule the
 * mask keeps). A fix with no state yet — a leading null stretch, before the stop
 * has seen any voltage at all — answers for nothing: it is neither on nor off,
 * and the seconds it spans count towards neither.
 *
 * `kind` is therefore `unknown` only for a range with NO voltage anywhere,
 * `running` when every reading is on, and `parked` as soon as one reading is
 * off — an owner who asked to "differentiate between traffic and stops" is asking
 * whether the engine was ever switched off here, not for a threshold.
 *
 * `offAt` is the first fix reading off (the arrival fix itself when the truck
 * came in already switched off) and `onAt` the first ON reading after the LAST
 * off-run, so an engine that cycled twice reports the restart the truck actually
 * left on; `onAt` stays null while the engine was still off at the stop's last
 * fix. `offS` is sample-and-hold exactly like `engineOnS` in `segment.ts`: each
 * gap counts to the state of the EARLIER of its two fixes, so the final fix's
 * state adds nothing.
 */
export function engineEvents(
  points: readonly Point[],
  i0: number,
  i1: number,
  rules: Rules,
): StopEngine {
  const inert: StopEngine = { kind: "unknown", offAt: null, onAt: null, offS: 0 };
  const from = Math.max(i0, 0);
  const to = Math.min(i1, points.length - 1);
  if (to < from) return inert;

  let state: boolean | null = null; // null = no reading yet, so no state to hold
  let sawVoltage = false;
  let offAt: number | null = null;
  let lastOff = -1;
  let offS = 0;

  for (let k = from; k <= to; k++) {
    const p = points[k]!;
    if (p.voltage !== null) {
      sawVoltage = true;
      state = p.voltage >= rules.engineOnVolts;
    }
    if (state === false) {
      if (offAt === null) offAt = p.t;
      lastOff = k;
      if (k < to) offS += points[k + 1]!.t - p.t;
    }
  }

  if (!sawVoltage) return inert;
  if (lastOff < 0) return { kind: "running", offAt: null, onAt: null, offS: 0 };
  return { kind: "parked", offAt, onAt: lastOff < to ? points[lastOff + 1]!.t : null, offS };
}
