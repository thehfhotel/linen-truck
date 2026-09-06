// linen-truck — points → stops → trips → legs (docs/CONTRACTS.md §3, rules 1-5).
//
// This is the file the whole report rests on, and it is a port of the Python
// prototype that was argued against the real 2026-09-05 track (82 fixes), so the
// shapes below are deliberate rather than convenient:
//
//   * A STOP is a run of consecutive fixes that all stay within `stopRadiusM` of
//     the run's FIRST fix — an anchor, not a rolling centroid. A drifting centroid
//     lets a slow crawl through the sois look like one long stop. The widened
//     radius is for scatter between two SETTLED fixes, so the tight one still
//     binds whenever either the anchor or the candidate is MOVING (engine on and
//     over `movingKmh`); a settled pair gets `jitterRadiusM`, and an engine-off
//     candidate the anchor's site fence too, because a parked tracker scatters its
//     fixes around the SITE (not around the fix that happened to lead the run) and
//     invents speeds to go with them.
//   * The two VIRTUAL stops are book-ends, not parked time. The device only keeps
//     ~a day of history, so a day very often starts and ends mid-move; without
//     book-ends that movement would vanish from the trip list entirely. They are
//     excluded from `timeAtSiteS`, from findings, and from legs.
//   * A LEG is what the owner actually asks about ("did it go HF → HF Ville?"), so
//     it merges consecutive trips through UNKNOWN stops: a truck that stopped for
//     four minutes on the way still made one delivery run, and the unknown stop is
//     reported separately as a finding.

import { engineEvents, engineOnMask } from "./engine.ts";
import { haversineM, siteAt } from "./geo.ts";
import type { Leg, Point, Rules, Site, Stop, StopEngine, Trip } from "./types.ts";

/** A stop plus the point-index range it covers — internal, trips need the indices. */
interface StopRun extends Stop {
  i0: number;
  i1: number;
}

/**
 * Sort by time, drop duplicate timestamps (keep the first), drop null-island fixes.
 *
 * The platform really does repeat a row and really does emit `dbLat=0` while the
 * GPS is cold; both must go before any distance is summed, or a 1 000 km hop to
 * (0, 0) and back lands in the day's kilometres. The zero test runs first so a
 * cold fix can never shadow a good fix that shares its second.
 */
export function cleanPoints(raw: readonly Point[]): Point[] {
  const sorted = [...raw].sort((a, b) => a.t - b.t);
  const out: Point[] = [];
  let lastT: number | null = null;
  for (const p of sorted) {
    if (p.lat === 0 || p.lon === 0) continue;
    if (lastT !== null && p.t === lastT) continue;
    out.push(p);
    lastT = p.t;
  }
  return out;
}

/**
 * The inert engine events a stop carries before it has any: the value the two
 * virtual book-ends keep for good (they are a single fix of a day that opened or
 * closed mid-move, not parked time), and the placeholder a real run holds until
 * the merge is done and its range is final. A fresh object each time — a shared
 * literal would put one `StopEngine` on every book-end of every day.
 */
const noEngineEvents = (): StopEngine => ({ kind: "unknown", offAt: null, onAt: null, offS: 0 });

/** Seconds of `points[i0..i1]` held above `engineOnVolts`, sample-and-hold. */
function engineOnS(points: Point[], i0: number, i1: number, rules: Rules): number {
  let s = 0;
  for (let k = i0; k < i1; k++) {
    const v = points[k]!.voltage;
    if (v !== null && v >= rules.engineOnVolts) s += points[k + 1]!.t - points[k]!.t;
  }
  return s;
}

/**
 * Is this fix the truck actually going somewhere?
 *
 * Both halves are needed. `speed` alone is worthless — a PARKED tracker reports
 * 5–107 km/h (HF Ville, 2026-09-06) — and the engine alone says nothing about
 * movement, because the truck idles while it warms up. MOVING means the charging
 * line is up AND the fix reports more than `movingKmh`; anything else is SETTLED.
 */
const isMoving = (p: Point, engineOn: boolean, rules: Rules): boolean => engineOn && p.speed > rules.movingKmh;

/**
 * May the run anchored at `anchor` still swallow the candidate fix `p`?
 *
 * The widened bound is for scatter BETWEEN TWO SETTLED FIXES, so the tight
 * `stopRadiusM` applies as soon as EITHER end of the comparison is MOVING.
 *
 * Candidate moving: the tight bound exists for exactly one failure — a slow
 * crawl through the sois reading as one long stop — and a fix that reports speed
 * under a live engine is that crawl.
 *
 * Anchor moving: the anchor is not just a bound, it is the STOP. Its lat/lon
 * become the arrival pin and, through `siteAt`, the site label. A run opened on
 * a fix taken at 30 km/h on the approach road would otherwise reach 600 m
 * forwards and swallow the parking place it was driving towards, reporting the
 * arrival a cadence early with the pin out on the road — and a truck parked
 * 540 m from the HF centre (measured, 2026-09-06) could be dragged outside the
 * fence and mislabelled, which is the exact fault this whole change removes. So
 * a moving anchor holds only 120 m: its run dies under `minStopS`, or ends at
 * the first parked fix beyond 120 m, and the parked cluster then anchors on its
 * OWN first fix with the wide bound. A tight run that did last ≥ `minStopS` is
 * merged into the wide one by rule 2 exactly as before.
 *
 * Both settled: a parked truck scatters ~180 m even with the engine running
 * while it warms up (2026-09-05: the restarts at 13:32:44 and 13:34:15 read
 * 0 km/h at 177 m and 120 m from the arrival anchor, and the truck only pulled
 * away at 13:35:15 at 37 km/h). Holding those to 120 m ended the HF Ville stop
 * 11 minutes before the truck left, so a settled pair gets `jitterRadiusM`.
 *
 * With the engine OFF the fix is scatter, and scatter is around the SITE rather
 * than around whichever fix happened to open the run. An anchor-relative bound
 * alone only holds a parked evening together when the first fix lands near the
 * centre: HF Ville's own 2026-09-06 scatter reaches 571 m either side of the
 * centre, so two engine-off fixes can be ~1 140 m apart and a 600 m
 * anchor-relative bound would split the evening into phantom stops and trips.
 * Hence the second, centre-relative arm: a fix inside the SAME site fence as the
 * anchor is the same parked truck, whichever fix leads. The fence is for
 * engine-off scatter only — a settled ENGINE-ON fix is a truck about to move,
 * so it gets the anchor-relative jitter radius and nothing wider.
 *
 * Every arm is a bound and not a licence — the fence is 600 m and
 * `jitterRadiusM` is 600 m — so a km-scale hop (the feed dropping out over a
 * real relocation) lands outside all of them and still ends the run.
 *
 * On a day with NO voltage at all, rule 1 calls every fix engine-on, so MOVING
 * collapses to `speed > movingKmh` and the speed signal alone decides: a pair of
 * fixes that both report no speed takes the jitter radius, where before this
 * rule the tight one applied throughout. That is deliberate: a voltage-less day
 * loses the engine signal, not the speed signal, and a settled fix 300 m from a
 * settled anchor is parked scatter there for the same reason it is here. It
 * widens such a day rather than leaving it byte-identical.
 */
function holdsCandidate(
  anchor: Point,
  anchorSite: Site | null,
  anchorMoving: boolean,
  p: Point,
  engineOn: boolean,
  sites: Site[],
  rules: Rules,
): boolean {
  const d = haversineM(anchor, p);
  if (anchorMoving || isMoving(p, engineOn, rules)) return d <= rules.stopRadiusM;
  if (d <= rules.jitterRadiusM) return true;
  return !engineOn && anchorSite !== null && siteAt(p, sites)?.id === anchorSite.id;
}

/**
 * Rule 1: maximal anchored runs lasting at least `minStopS`.
 *
 * The radius the run is measured against is per-PAIR, not per-run: two SETTLED
 * fixes may sit up to `jitterRadiusM` apart — and an engine-off candidate
 * anywhere inside the anchor's own site fence — because a parked tracker
 * scatters (HF Ville, 2026-09-06: p50 138 m, max 571 m), while a pair with a
 * MOVING fix at either end is held to the tight `stopRadiusM` or the truck
 * really was going somewhere. See `holdsCandidate` for why each arm is shaped
 * the way it is, and why the anchor's own state is half the test.
 */
function findStops(points: Point[], sites: Site[], rules: Rules, engineOn: boolean[]): StopRun[] {
  const stops: StopRun[] = [];
  const n = points.length;
  let i = 0;
  while (i < n) {
    const anchor = points[i]!;
    const anchorSite = siteAt(anchor, sites);
    const anchorMoving = isMoving(anchor, engineOn[i]!, rules);
    let j = i;
    while (
      j + 1 < n &&
      holdsCandidate(anchor, anchorSite, anchorMoving, points[j + 1]!, engineOn[j + 1]!, sites, rules)
    ) {
      j++;
    }
    if (points[j]!.t - anchor.t >= rules.minStopS) {
      stops.push({
        i0: i,
        i1: j,
        arrive: anchor.t,
        depart: points[j]!.t,
        lat: anchor.lat,
        lon: anchor.lon,
        siteId: anchorSite?.id ?? null,
        engineOnS: 0, // filled in after the merge, over the merged range
        engine: noEngineEvents(), // ditto — the ignition events of the merged range
      });
      i = j + 1;
    } else {
      i++;
    }
  }
  return stops;
}

/** The haversine travel along `points[i..j]` — what the truck actually drove. */
function travelM(points: Point[], i: number, j: number): number {
  let m = 0;
  for (let k = i; k < j; k++) m += haversineM(points[k]!, points[k + 1]!);
  return m;
}

/**
 * Rule 2: a yard shuffle is one stop — and ONLY a yard shuffle.
 *
 * Two conditions, both required (§3 rule 2): the hop between the two anchors is
 * under `mergeHopM`, AND the truck's actual travel over the fixes between them is
 * under `mergeHopM` too. The anchor hop alone is not enough: an out-and-back run
 * that turns round somewhere with no far-end stop (nobody was there, the driver
 * never parked for three minutes) comes home to within a few metres of where it
 * left, so on the hop test alone the two parked runs merge, the trip between them
 * disappears and the day reports 0 trips and 0 km for a real journey. The travel
 * test is what tells "shunted across the yard" apart from "drove 4 km and came
 * back".
 */
function mergeStops(stops: StopRun[], points: Point[], rules: Rules): StopRun[] {
  const out: StopRun[] = [];
  for (const s of stops) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.siteId !== null &&
      prev.siteId === s.siteId &&
      haversineM(prev, s) < rules.mergeHopM &&
      travelM(points, prev.i1, s.i0) < rules.mergeHopM
    ) {
      prev.i1 = s.i1;
      prev.depart = s.depart;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/** Rule 3: book-end the day when the track starts or ends mid-move. */
function addVirtualStops(stops: StopRun[], points: Point[], sites: Site[]): StopRun[] {
  const n = points.length;
  const out = [...stops];
  const first = points[0]!;
  if (out.length === 0 || out[0]!.i0 > 0) {
    out.unshift({
      i0: 0,
      i1: 0,
      arrive: first.t,
      depart: first.t,
      lat: first.lat,
      lon: first.lon,
      siteId: siteAt(first, sites)?.id ?? null,
      engineOnS: 0,
      engine: noEngineEvents(),
      virtual: "track-start",
    });
  }
  const last = points[n - 1]!;
  if (out[out.length - 1]!.i1 < n - 1) {
    out.push({
      i0: n - 1,
      i1: n - 1,
      arrive: last.t,
      depart: last.t,
      lat: last.lat,
      lon: last.lon,
      siteId: siteAt(last, sites)?.id ?? null,
      engineOnS: 0,
      engine: noEngineEvents(),
      virtual: "track-end",
    });
  }
  return out;
}

/** Rule 4: everything between one stop's departure fix and the next stop's arrival fix. */
function buildTrips(stops: StopRun[], points: Point[]): Trip[] {
  const trips: Trip[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const path = points.slice(a.i1, b.i0 + 1);
    let m = 0;
    let maxKmh = 0;
    for (let k = 0; k < path.length; k++) {
      if (k + 1 < path.length) m += haversineM(path[k]!, path[k + 1]!);
      if (path[k]!.speed > maxKmh) maxKmh = path[k]!.speed;
    }
    trips.push({
      n: trips.length + 1,
      start: a.depart,
      end: b.arrive,
      from: { lat: a.lat, lon: a.lon, siteId: a.siteId },
      to: { lat: b.lat, lon: b.lon, siteId: b.siteId },
      km: m / 1000,
      maxKmh,
      pointCount: path.length,
      path,
    });
  }
  return trips;
}

/**
 * Rule 5: known site → known site, merging through unknown stops.
 *
 * A virtual book-end ends the search without producing a leg: the truck was
 * already moving when the track began, so where that movement started is simply
 * not known and must not be guessed at as a delivery run.
 */
function buildLegs(stops: StopRun[], trips: Trip[]): Leg[] {
  const legs: Leg[] = [];
  let i = 0;
  while (i < trips.length) {
    const from = stops[i]!;
    if (from.virtual || from.siteId === null) {
      i++;
      continue;
    }
    let j = i;
    let viaUnknownStops = 0;
    // Walk forward through unknown (non-virtual, siteId null) stops.
    while (j < trips.length) {
      const to = stops[j + 1]!;
      if (to.virtual) break;
      if (to.siteId !== null) {
        const members = trips.slice(i, j + 1);
        legs.push({
          tripNs: members.map((t) => t.n),
          fromSiteId: from.siteId,
          toSiteId: to.siteId,
          start: members[0]!.start,
          end: members[members.length - 1]!.end,
          km: members.reduce((s, t) => s + t.km, 0),
          viaUnknownStops,
        });
        break;
      }
      viaUnknownStops++;
      j++;
    }
    i = j + 1;
  }
  return legs;
}

/** The whole segmentation. `points` must already be through `cleanPoints`. */
export function segment(
  points: Point[],
  sites: Site[],
  rules: Rules,
): { stops: Stop[]; trips: Trip[]; legs: Leg[] } {
  if (points.length === 0) return { stops: [], trips: [], legs: [] };
  const engineOn = engineOnMask(points, rules);
  const runs = addVirtualStops(mergeStops(findStops(points, sites, rules, engineOn), points, rules), points, sites);
  for (const r of runs) {
    if (r.virtual) continue;
    r.engineOnS = engineOnS(points, r.i0, r.i1, rules);
    r.engine = engineEvents(points, r.i0, r.i1, rules);
  }
  const trips = buildTrips(runs, points);
  const legs = buildLegs(runs, trips);
  const stops: Stop[] = runs.map(({ i0: _i0, i1: _i1, ...s }) => s);
  return { stops, trips, legs };
}
