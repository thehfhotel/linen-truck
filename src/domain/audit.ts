// linen-truck — the three things worth telling the owner (docs/CONTRACTS.md §3, rule 6).
//
// A finding is an EXCEPTION, never a summary: the day page shows this list first,
// so anything that fires on a normal delivery day would train the owner to ignore
// the section. Hence the three thresholds — a stop must be long enough to be a
// choice (`unknownStopMinS`), a leg must be a quarter longer than the known route
// (`detourRatio`), and movement must be real movement (`movingKmh`).

import { engineOnMask } from "./engine.ts";
import { haversineM } from "./geo.ts";
import { bangkokMinuteOfDay, parseHhMm } from "./clock.ts";
import type { Finding, Point, Rules, Site, Stop } from "./types.ts";
import type { segment } from "./segment.ts";

/** Two moving fixes further apart than this are two separate runs, not one (§3.6). */
const RUN_SPLIT_S = 600;

/** `["hfville","hf"]` → `"hf|hfville"` — the `referenceKm` key shape (§2). */
export const legKey = (a: string, b: string): string => [a, b].sort().join("|");

/** Is a Bangkok minute-of-day inside the half-open working window? */
function insideSchedule(minute: number, startM: number, endM: number): boolean {
  // A window that wraps midnight (start > end) is still meaningful, so support it
  // rather than silently reporting a whole night shift as outside hours.
  return startM <= endM ? minute >= startM && minute < endM : minute >= startM || minute < endM;
}

/** Rule 6a: a real stop, long enough to be a decision, at no known site. */
function unknownStops(stops: Stop[], rules: Rules): Finding[] {
  const out: Finding[] = [];
  for (const s of stops) {
    if (s.virtual || s.siteId !== null) continue;
    const durationS = s.depart - s.arrive;
    if (durationS < rules.unknownStopMinS) continue;
    out.push({ kind: "unknown-stop", arrive: s.arrive, depart: s.depart, lat: s.lat, lon: s.lon, durationS });
  }
  return out;
}

/** Rule 6b: a leg longer than the known route between the same two sites. */
function detours(legs: ReturnType<typeof segment>["legs"], rules: Rules): Finding[] {
  const out: Finding[] = [];
  for (const leg of legs) {
    const referenceKm = rules.referenceKm[legKey(leg.fromSiteId, leg.toSiteId)];
    if (referenceKm === undefined || referenceKm <= 0) continue;
    const ratio = leg.km / referenceKm;
    if (ratio > rules.detourRatio) out.push({ kind: "detour", leg, referenceKm, ratio });
  }
  return out;
}

/**
 * Rule 6c: maximal runs of moving fixes whose Bangkok wall-clock is outside the
 * schedule. Only fixes that are BOTH moving and outside hours join a run, and a
 * gap over `RUN_SPLIT_S` starts a new one — otherwise a truck parked overnight
 * between two evening errands would be reported as one seven-hour excursion.
 *
 * MOVING means `speed > movingKmh` AND the engine on. A parked tracker reports
 * speeds it never drove (HF Ville, 2026-09-06 16:00–21:00: 5–107 km/h at 12.4–
 * 12.7 V, and 17 outside-hours findings for a truck that stood still all
 * evening), so a speed on its own is not evidence that anybody drove anywhere.
 *
 * The accepted cost (§3 rule 6, "KNOWN BLIND SPOT"): this is the only
 * unauthorised-use detector and it now rests entirely on the charging line, so a
 * tracker on its internal battery — a failed charging line, or a feed pulled on
 * purpose — reads 12.x V all day, every fix is engine-off, and nothing is
 * reported here even though the day still shows trips and kilometres. A
 * displacement compensator was considered and rejected: parked scatter spans up
 * to ~1 140 m, so any bound tight enough to catch a short night errand fires on a
 * parked evening again. A day with kilometres but no fix ever at `engineOnVolts`
 * is a tracker fault to chase, not a quiet day.
 */
function outsideHours(points: Point[], rules: Rules, engineOn: boolean[]): Finding[] {
  const startM = parseHhMm(rules.schedule.start);
  const endM = parseHhMm(rules.schedule.end);
  const out: Finding[] = [];
  let run: Point[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    let m = 0;
    for (let k = 0; k + 1 < run.length; k++) m += haversineM(run[k]!, run[k + 1]!);
    out.push({ kind: "outside-hours", start: run[0]!.t, end: run[run.length - 1]!.t, km: m / 1000 });
    run = [];
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.speed <= rules.movingKmh || !engineOn[i]!) continue;
    if (insideSchedule(bangkokMinuteOfDay(p.t), startM, endM)) continue;
    if (run.length > 0 && p.t - run[run.length - 1]!.t > RUN_SPLIT_S) flush();
    run.push(p);
  }
  flush();
  return out;
}

/**
 * All findings for one day, grouped by kind (unknown stops, detours, outside
 * hours) and chronological within a kind — the order the day page renders them.
 * `ymd` and `sites` are part of the locked signature (§3) and are not needed by
 * the current rules: the segmentation has already resolved every site id.
 */
export function audit(
  ymd: string,
  seg: ReturnType<typeof segment>,
  points: Point[],
  sites: Site[],
  rules: Rules,
): Finding[] {
  void ymd;
  void sites;
  const engineOn = engineOnMask(points, rules);
  return [...unknownStops(seg.stops, rules), ...detours(seg.legs, rules), ...outsideHours(points, rules, engineOn)];
}
