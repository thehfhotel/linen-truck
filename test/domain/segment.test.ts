import { describe, expect, it } from "bun:test";
import { cleanPoints, segment } from "../../src/domain/segment.ts";
import type { Point } from "../../src/domain/types.ts";
import { HF, HFVILLE, RULES, SITES, bkk, lerp, northOf, parked, pt } from "./support.ts";

const T0 = bkk("2026-09-05", "12:00:00");

describe("cleanPoints", () => {
  it("should sort by time, keep the first of duplicate timestamps, and drop null-island fixes", () => {
    const raw: Point[] = [
      pt(T0 + 60, HF, { speed: 2 }),
      pt(T0, HF, { speed: 1 }),
      pt(T0 + 60, HF, { speed: 99 }), // duplicate second — the later row loses
      { t: T0 + 120, lat: 0, lon: 99.3, speed: 3, voltage: null },
      { t: T0 + 180, lat: 9.1, lon: 0, speed: 4, voltage: null },
      pt(T0 + 240, HF, { speed: 5 }),
    ];
    const out = cleanPoints(raw);
    expect(out.map((p) => p.t)).toEqual([T0, T0 + 60, T0 + 240]);
    expect(out[1]!.speed).toBe(2);
  });

  it("should not mutate its input", () => {
    const raw = [pt(T0 + 60, HF), pt(T0, HF)];
    cleanPoints(raw);
    expect(raw.map((p) => p.t)).toEqual([T0 + 60, T0]);
  });

  it("should survive an empty day", () => {
    expect(cleanPoints([])).toEqual([]);
    expect(segment([], SITES, RULES)).toEqual({ stops: [], trips: [], legs: [] });
  });
});

describe("segment — stop detection", () => {
  it("should need the run to last at least minStopS", () => {
    const short = parked(T0, HF, 3, 60); // 0..120 s
    expect(segment(short, SITES, RULES).stops.filter((s) => !s.virtual)).toHaveLength(0);
    const exact = parked(T0, HF, 4, 60); // 0..180 s — the boundary counts
    const stops = segment(exact, SITES, RULES).stops;
    expect(stops).toHaveLength(1);
    expect(stops[0]!.virtual).toBeUndefined();
    expect(stops[0]!.depart - stops[0]!.arrive).toBe(180);
    expect(stops[0]!.siteId).toBe("hf");
  });

  it("should anchor the run on its FIRST fix, so a slow crawl is not one long stop", () => {
    // Each fix is 100 m past the last (inside stopRadiusM of its predecessor) but
    // walks 900 m away from the anchor, so no stop may be reported.
    const crawl = Array.from({ length: 10 }, (_, i) => pt(T0 + i * 60, northOf(HF, i * 100), { speed: 6 }));
    expect(segment(crawl, SITES, RULES).stops.every((s) => s.virtual)).toBe(true);
  });

  it("should count engine-on seconds by sample-and-hold above engineOnVolts", () => {
    const run = [
      pt(T0, HF, { voltage: 13.8 }),
      pt(T0 + 60, HF, { voltage: 13.2 }), // the threshold itself is "on"
      pt(T0 + 120, HF, { voltage: 12.6 }),
      pt(T0 + 180, HF, { voltage: null }), // missing voltage is never "on"
      pt(T0 + 240, HF, { voltage: 12.6 }),
    ];
    expect(segment(run, SITES, RULES).stops[0]!.engineOnS).toBe(120);
  });
});

describe("segment — merging yard shuffles", () => {
  const centre = { lat: HFVILLE.lat, lon: HFVILLE.lon };

  it("should merge two stops at the same site when the hop is under mergeHopM", () => {
    const points = [...parked(T0, centre, 6, 60), ...parked(T0 + 420, northOf(centre, 200), 6, 60)];
    const { stops, trips } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.siteId).toBe("hfville");
    expect(stops[0]!.arrive).toBe(T0);
    expect(stops[0]!.depart).toBe(T0 + 420 + 300);
    expect(stops[0]!.lat).toBeCloseTo(centre.lat, 9); // the FIRST anchor is kept
    expect(trips).toHaveLength(0);
  });

  it("should not merge across a hop of mergeHopM or more", () => {
    const points = [
      ...parked(T0, northOf(centre, -200), 6, 60),
      ...parked(T0 + 420, northOf(centre, 200), 6, 60),
    ];
    const { stops, trips } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.siteId)).toEqual(["hfville", "hfville"]);
    expect(trips).toHaveLength(1);
  });

  it("should NOT merge an out-and-back run home again, even though the anchors coincide", () => {
    // §3 rule 2: the truck leaves HF Ville, drives ~2 km towards HF, finds nobody
    // to stop for, turns round and parks where it started. The two anchors are the
    // same point (hop 0 m), so the hop test alone would swallow the whole journey
    // and report 0 trips; the travel between the runs is ~3.1 km, so it must not.
    const out = [0.1, 0.2, 0.3, 0.4].map((f, i) => pt(T0 + 300 + (i + 1) * 60, lerp(HFVILLE, HF, f), { speed: 50 }));
    const back = [0.3, 0.2, 0.1].map((f, i) => pt(T0 + 300 + (i + 5) * 60, lerp(HFVILLE, HF, f), { speed: 50 }));
    const points = [
      ...parked(T0, centre, 6, 60), // 12:00–12:05
      ...out,
      ...back,
      ...parked(T0 + 780, centre, 6, 60), // back home 12:13–12:18
    ];

    const { stops, trips } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.siteId)).toEqual(["hfville", "hfville"]);
    expect(stops.every((s) => s.virtual === undefined)).toBe(true);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.km).toBeGreaterThan(3);
    expect(trips[0]!.km).toBeCloseTo(3.14, 1); // 0.8 × the 3.92 km straight line
  });

  it("should never merge unknown stops, however close", () => {
    const nowhere = lerp(HF, HFVILLE, 0.5);
    const points = [...parked(T0, nowhere, 6, 60), ...parked(T0 + 420, northOf(nowhere, 200), 6, 60)];
    const { stops } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.siteId)).toEqual([null, null]);
  });
});

// One synthetic delivery run: parked at HF, drive, four minutes at nowhere, drive,
// parked at HF Ville. The day both begins and ends parked, so it has no book-ends.
function deliveryDay(): Point[] {
  return [
    ...parked(T0, HF, 11, 60, { voltage: 12.7 }), // 12:00–12:10
    pt(T0 + 660, lerp(HF, HFVILLE, 0.25), { speed: 40 }),
    pt(T0 + 720, lerp(HF, HFVILLE, 0.45), { speed: 62 }),
    ...parked(T0 + 780, lerp(HF, HFVILLE, 0.5), 6, 60, { speed: 0 }), // 12:13–12:18
    pt(T0 + 1140, lerp(HF, HFVILLE, 0.75), { speed: 55 }),
    ...parked(T0 + 1200, HFVILLE, 11, 60), // 12:20–12:30
  ];
}

describe("segment — trips and legs", () => {
  it("should build a trip between each pair of stops", () => {
    const { stops, trips } = segment(deliveryDay(), SITES, RULES);
    expect(stops.map((s) => s.siteId)).toEqual(["hf", null, "hfville"]);
    expect(stops.every((s) => s.virtual === undefined)).toBe(true);
    expect(trips.map((t) => t.n)).toEqual([1, 2]);
    expect(trips[0]!.start).toBe(stops[0]!.depart);
    expect(trips[0]!.end).toBe(stops[1]!.arrive);
    expect(trips[0]!.from.siteId).toBe("hf");
    expect(trips[0]!.to.siteId).toBeNull();
    expect(trips[0]!.maxKmh).toBe(62);
    // Departure fix + two moving fixes + arrival fix.
    expect(trips[0]!.pointCount).toBe(4);
    expect(trips[0]!.path).toHaveLength(4);
    expect(trips[0]!.km).toBeCloseTo(1.96, 1);
    expect(trips[1]!.km + trips[0]!.km).toBeCloseTo(3.92, 1);
  });

  it("should merge the two trips into one hf → hfville leg through the unknown stop", () => {
    const { legs } = segment(deliveryDay(), SITES, RULES);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.tripNs).toEqual([1, 2]);
    expect(legs[0]!.fromSiteId).toBe("hf");
    expect(legs[0]!.toSiteId).toBe("hfville");
    expect(legs[0]!.viaUnknownStops).toBe(1);
    expect(legs[0]!.start).toBe(T0 + 600);
    expect(legs[0]!.end).toBe(T0 + 1200);
    expect(legs[0]!.km).toBeCloseTo(3.92, 1);
  });
});

describe("segment — virtual book-ends", () => {
  it("should open with track-start when the day begins mid-move", () => {
    const points = [pt(T0 - 300, lerp(HF, HFVILLE, 0.05), { speed: 44 }), ...deliveryDay()];
    const { stops, trips, legs } = segment(points, SITES, RULES);
    expect(stops[0]!.virtual).toBe("track-start");
    expect(stops[0]!.arrive).toBe(T0 - 300);
    expect(stops[0]!.depart).toBe(T0 - 300);
    expect(trips).toHaveLength(3);
    // Trip 1 starts nowhere in particular, so it is not a delivery leg.
    expect(legs).toHaveLength(1);
    expect(legs[0]!.tripNs).toEqual([2, 3]);
  });

  it("should close with track-end when the day is still moving", () => {
    const points = [...deliveryDay(), pt(T0 + 2100, lerp(HF, HFVILLE, 0.6), { speed: 51 })];
    const { stops, trips, legs } = segment(points, SITES, RULES);
    expect(stops[stops.length - 1]!.virtual).toBe("track-end");
    expect(trips).toHaveLength(3);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.tripNs).toEqual([1, 2]);
  });

  it("should book-end both sides of a day that never stops", () => {
    const points = Array.from({ length: 6 }, (_, i) =>
      pt(T0 + i * 120, lerp(HF, HFVILLE, i / 6), { speed: 50 }),
    );
    const { stops, trips, legs } = segment(points, SITES, RULES);
    expect(stops.map((s) => s.virtual)).toEqual(["track-start", "track-end"]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.pointCount).toBe(6);
    expect(legs).toHaveLength(0);
  });

  it("should not book-end a day that is parked from first fix to last", () => {
    const { stops } = segment(parked(T0, HF, 11, 60), SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.virtual).toBeUndefined();
  });
});
