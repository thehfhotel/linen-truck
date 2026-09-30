// §3 rule 10 — GPS gaps inside trips. Map only: every number of rules 1-9 must be
// exactly what it was before `tripGaps` existed, which the summary/segment tests
// keep proving against the same fixture; this file pins the new rule itself.

import { describe, expect, it } from "bun:test";
import { tripGaps } from "../../src/domain/gaps.ts";
import { haversineM } from "../../src/domain/geo.ts";
import { cleanPoints } from "../../src/domain/segment.ts";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Point, Trip } from "../../src/domain/types.ts";
import { HF, HFVILLE, RULES, SITES, bkk, lerp, parked, pt } from "./support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);

/** A trip wrapping a hand-made path; only `n` and `path` matter to `tripGaps`. */
const tripOf = (n: number, path: Point[]): Trip => ({
  n,
  start: path[0]!.t,
  end: path[path.length - 1]!.t,
  from: { ...HF, siteId: null },
  to: { ...HFVILLE, siteId: null },
  km: 0,
  maxKmh: 0,
  pointCount: path.length,
  path,
});

/** Fixes at the given second offsets, `f` of the way from HF to HF Ville each. */
const runAt = (t0: number, steps: [number, number][]): Point[] =>
  steps.map(([dt, f]) => pt(t0 + dt, lerp(HF, HFVILLE, f), { speed: 47, voltage: 13.8 }));

describe("the rule's threshold", () => {
  const T0 = bkk("2026-09-24", "14:00:00");

  it("should ship gapS = 300 in config/rules.json", () => {
    expect(RULES.gapS).toBe(300);
  });

  it("should NOT call exactly gapS seconds a gap, and SHOULD call one second more a gap", () => {
    const exactly = tripOf(1, runAt(T0, [[0, 0.1], [300, 0.2], [360, 0.3]]));
    expect(tripGaps([exactly], RULES)).toEqual([]);

    const over = tripOf(1, runAt(T0, [[0, 0.1], [301, 0.2], [361, 0.3]]));
    const gaps = tripGaps([over], RULES);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({
      tripN: 1,
      from: T0,
      to: T0 + 301,
      s: 301,
      m: haversineM(over.path[0]!, over.path[1]!),
    });
  });

  it("should read the threshold from the rules it is given", () => {
    const trip = tripOf(1, runAt(T0, [[0, 0.1], [120, 0.2]]));
    expect(tripGaps([trip], RULES)).toEqual([]);
    expect(tripGaps([trip], { ...RULES, gapS: 119 })).toHaveLength(1);
    expect(tripGaps([trip], { ...RULES, gapS: 120 })).toEqual([]);
  });

  it("should list gaps in trip order, then time order, tagged with the trip's n", () => {
    const a = tripOf(1, runAt(T0, [[0, 0.1], [400, 0.2], [460, 0.3], [900, 0.4]]));
    const b = tripOf(2, runAt(T0 + 5000, [[0, 0.5], [700, 0.6]]));
    const gaps = tripGaps([a, b], RULES);
    expect(gaps.map((g) => [g.tripN, g.from - T0, g.s])).toEqual([
      [1, 0, 400],
      [1, 460, 440],
      [2, 5000, 700],
    ]);
  });

  it("should give nothing for a trip of fewer than two fixes, or for no trips", () => {
    expect(tripGaps([], RULES)).toEqual([]);
    expect(tripGaps([tripOf(1, runAt(T0, [[0, 0.1]]))], RULES)).toEqual([]);
  });
});

describe("a day shaped like 2026-09-24 trip 2", () => {
  // 60 s cadence, one 656 s hole in the middle of the drive, the fix after it the
  // arrival fix of the next stop: the tracker delivered nothing while the truck
  // drove most of the way to HF Ville. Real: 14:32:29 → 14:43:25, ~4 km.
  const T0 = bkk("2026-09-24", "14:00:00");
  const HOLE_FROM = T0 + 420;
  const HOLE_TO = HOLE_FROM + 656;
  const day: Point[] = [
    ...parked(T0, HF, 6, 60, { voltage: 12.7 }), // 14:00–14:05 at HF
    pt(T0 + 360, lerp(HF, HFVILLE, 0.05), { speed: 47, voltage: 13.8 }),
    pt(HOLE_FROM, lerp(HF, HFVILLE, 0.1), { speed: 47, voltage: 13.8 }),
    ...parked(HOLE_TO, HFVILLE, 6, 60, { voltage: 12.7 }), // arrival fix, then parked
  ];
  const summary = summarizeDay("2026-09-24", day, SITES, RULES);

  it("should find exactly one gap: the 656 s hole, and the straight line across it", () => {
    expect(summary.tripCount).toBe(1);
    expect(summary.gaps).toHaveLength(1);
    const g = summary.gaps[0]!;
    expect(g).toEqual({
      tripN: 1,
      from: HOLE_FROM,
      to: HOLE_TO,
      s: 656,
      m: haversineM(lerp(HF, HFVILLE, 0.1), HFVILLE),
    });
    expect(g.m).toBeGreaterThan(3400);
    expect(g.m).toBeLessThan(3600);
  });

  it("should change no other number: the trip still counts the straight-line leg in its km", () => {
    const trip = summary.trips[0]!;
    // Both ends of the hole are consecutive fixes of the trip's own path…
    const i = trip.path.findIndex((p) => p.t === HOLE_FROM);
    expect(trip.path[i + 1]!.t).toBe(HOLE_TO);
    // …so the km is the plain haversine sum of that path, gap included.
    let m = 0;
    for (let k = 0; k + 1 < trip.path.length; k++) m += haversineM(trip.path[k]!, trip.path[k + 1]!);
    expect(trip.km).toBeCloseTo(m / 1000, 9);
    expect(trip.km * 1000).toBeGreaterThan(summary.gaps[0]!.m);
    expect(summary.stops.map((s) => s.siteId)).toEqual(["hf", "hfville"]);
  });

  it("should turn the rule off by raising gapS above the hole, leaving everything else identical", () => {
    const off = summarizeDay("2026-09-24", day, SITES, { ...RULES, gapS: 656 });
    expect(off.gaps).toEqual([]);
    const { gaps: _a, ...withGaps } = summary;
    const { gaps: _b, ...without } = off;
    expect(without).toEqual(withGaps);
  });
});

describe("silence inside a stop is not a gap", () => {
  it("should ignore a parked truck reporting every 8 minutes, and still catch a hole in the drive", () => {
    const T0 = bkk("2026-09-24", "12:00:00");
    const sparse = parked(T0, HF, 5, 480, { voltage: 12.7 }); // 12:00–12:32, all inside one stop
    const summary = summarizeDay("2026-09-24", sparse, SITES, RULES);
    expect(summary.stops.some((s) => s.siteId === "hf")).toBe(true);
    expect(summary.tripCount).toBe(0);
    expect(summary.gaps).toEqual([]);

    // The same sparse cadence either side of a drive whose own cadence is 60 s: the
    // trip runs from the stop's last fix to the next stop's first, so the 480 s hops
    // BETWEEN parked fixes stay outside it.
    const day: Point[] = [
      ...sparse,
      pt(T0 + 1980, lerp(HF, HFVILLE, 0.2), { speed: 47, voltage: 13.8 }),
      pt(T0 + 2040, lerp(HF, HFVILLE, 0.4), { speed: 47, voltage: 13.8 }),
      pt(T0 + 2100, lerp(HF, HFVILLE, 0.6), { speed: 47, voltage: 13.8 }),
      pt(T0 + 2160, lerp(HF, HFVILLE, 0.8), { speed: 47, voltage: 13.8 }),
      ...parked(T0 + 2220, HFVILLE, 5, 480, { voltage: 12.7 }),
    ];
    const withDrive = summarizeDay("2026-09-24", day, SITES, RULES);
    expect(withDrive.tripCount).toBe(1);
    expect(withDrive.gaps).toEqual([]);
  });
});

describe("the 2026-09-05 fixture", () => {
  const YMD = "2026-09-05";
  const summary = summarizeDay(YMD, POINTS, SITES, RULES);

  it("should have NO gap at 300 s: the tracker never went silent while the truck was driving", () => {
    // Derived by the code AND checked by hand against the raw nTime column: the
    // longest silence inside any of its four trips is 271 s (14:22:15 → 14:26:46,
    // trip 4), and trip 1's is 270 s (12:11:44 → 12:16:14) — both under 300.
    expect(summary.gaps).toEqual([]);
  });

  it("should see the two near-misses when the rule is tightened, and nothing from the stops", () => {
    const tight = summarizeDay(YMD, POINTS, SITES, { ...RULES, gapS: 200 });
    expect(tight.gaps.map((g) => [g.tripN, g.s])).toEqual([
      [1, 270],
      [4, 271],
    ]);
    // The parked hops of 480-511 s (12:28 → 12:36, 13:07 → 13:15, 14:54 → 15:02 …)
    // are far above every threshold here and still never appear: they sit inside stops.
    const ts = cleanPoints(POINTS).map((p) => p.t);
    const longest = Math.max(...ts.slice(1).map((t, i) => t - ts[i]!));
    expect(longest).toBeGreaterThan(500);
    expect(tight.gaps.every((g) => g.s < 300)).toBe(true);
  });
});
