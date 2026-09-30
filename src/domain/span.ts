// linen-truck — stop spans (docs/CONTRACTS.md §3, "Stop spans").
//
// A day report only sees one Bangkok day's points, so a stop that crosses
// midnight is CLIPPED: on 2026-09-30 the first row read `00:02 → 13:08` for a
// truck that had really parked at HF Ville on the 29th at 14:34, and the last row
// read `→ 19:00` while the truck was still there. The report's own numbers
// (`arrive`, `depart`, `minutes`, `timeAtSite`) are deliberately left as the day
// counts them; a span is the SEPARATE, true answer to "when did this stop really
// begin and end?", found by looking into the neighbouring days.
//
// Pure, like the rest of this directory: no IO, no clock. The caller hands in the
// day's points, a wider window of points around it, and the day's own stops.

import { segment } from "./segment.ts";
import type { Point, Rules, Site, Stop } from "./types.ts";

/** How far either side of the day the caller loads points for `windowPoints`. */
export const SPAN_WINDOW_DAYS = 7;

/** One stop's real extent, in epoch seconds. */
export interface StopSpan {
  /** Real arrival. */
  arriveAt: number;
  /**
   * True when the window's first fix already lies inside this stop: the real
   * arrival is at or before `arriveAt`, and the data cannot say by how much.
   */
  arriveOpen: boolean;
  /**
   * Real departure; null = no departure in the data (the window's last fix lies
   * inside this stop — the truck is still there, or the data simply ends).
   */
  departAt: number | null;
  engineOffAt: number | null;
  engineOnAt: number | null;
  /**
   * The last fix inside the stop — what the whole stop's duration is measured to.
   * `departAt` says when the truck LEFT; this says when it was last SEEN there,
   * so a stop with no departure (`departAt` null) still has a length: arrival to
   * the latest fix.
   */
  lastFixAt: number;
  /** Seconds of engine-on over the whole stop (`Stop.engineOnS` of the stop the span describes). */
  engineOnS: number;
}

const defaultSpan = (s: Stop): StopSpan => ({
  arriveAt: s.arrive,
  arriveOpen: false,
  departAt: s.depart,
  engineOffAt: s.engine.offAt,
  engineOnAt: s.engine.onAt,
  lastFixAt: s.depart,
  engineOnS: s.engineOnS,
});

/**
 * The real extent of each of the day's stops; same length and order as `dayStops`.
 *
 * `dayPoints` and `windowPoints` are already through `cleanPoints`, and the window
 * includes the day.
 *
 * WHY ONLY TWO STOPS MAY EXTEND. A stop can only be clipped where the day's data
 * is cut, and the day is cut at exactly two places: its first fix and its last
 * fix. So the only stops whose ends could be wrong are the one that begins on the
 * day's first fix (the FIRST-BOUNDARY stop) and the one that ends on the day's
 * last fix (the LAST-BOUNDARY stop); they may be the same stop, as on a day spent
 * entirely parked. Every other row keeps exactly what the day computed. The
 * window is segmented afresh and a wider segmentation can disagree with the day's
 * about the middle of the day (a different greedy anchor, a different engine
 * hold), and a mid-day row must never change because of the window the report
 * happened to load. Virtual book-ends are not parked time and never extend.
 */
export function stopSpans(
  dayPoints: Point[],
  windowPoints: Point[],
  dayStops: Stop[],
  sites: Site[],
  rules: Rules,
): StopSpan[] {
  const spans = dayStops.map(defaultSpan);
  if (dayPoints.length === 0 || windowPoints.length === 0) return spans;

  const firstFix = dayPoints[0]!.t;
  const lastFix = dayPoints[dayPoints.length - 1]!.t;
  const firstIdx = dayStops.findIndex((s) => !s.virtual && s.arrive === firstFix);
  const lastIdx = dayStops.findIndex((s) => !s.virtual && s.depart === lastFix);
  if (firstIdx < 0 && lastIdx < 0) return spans;

  const windowStops = segment(windowPoints, sites, rules).stops.filter((s) => !s.virtual);
  /** The window's stop that holds the fix at `t`, if the window has one. */
  const holding = (t: number): Stop | undefined => windowStops.find((w) => w.arrive <= t && t <= w.depart);

  const windowStart = windowPoints[0]!.t;
  const windowEnd = windowPoints[windowPoints.length - 1]!.t;

  if (firstIdx >= 0) {
    const w = holding(firstFix);
    if (w) {
      const span = spans[firstIdx]!;
      span.arriveAt = w.arrive;
      span.arriveOpen = w.arrive === windowStart;
      span.engineOffAt = w.engine.offAt;
      span.engineOnS = w.engineOnS;
    }
  }
  if (lastIdx >= 0) {
    const w = holding(lastFix);
    if (w) {
      const span = spans[lastIdx]!;
      span.departAt = w.depart === windowEnd ? null : w.depart;
      span.engineOnAt = w.engine.onAt;
      span.lastFixAt = w.depart;
      // Overwrites the first boundary's value when one stop is both: the two
      // window stops agree unless a segmentation quirk splits them, and then the
      // one holding the departing end is the better witness of the whole stop.
      span.engineOnS = w.engineOnS;
    }
  }
  return spans;
}
