import { describe, expect, it } from "bun:test";
import { cleanPoints, segment } from "../../src/domain/segment.ts";
import type { Point } from "../../src/domain/types.ts";
import {
  HF,
  HFVILLE,
  RULES,
  SITES,
  beforeDeliveryDay,
  bkk,
  deliveryDay,
  lerp,
  northOf,
  parked,
  parkedEvening,
  pt,
} from "./support.ts";

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

  /**
   * Parked, a shuffle of `metres` north caught by ONE fix in motion, parked again.
   *
   * The fix in motion is what makes the two runs two runs: §3 rule 1 holds a pair
   * to the tight `stopRadiusM` only when one of its ends is MOVING, so without it
   * the second cluster is settled scatter inside `jitterRadiusM` of a settled
   * first anchor and rule 2 is never reached. `metres` per 60 s is the speed
   * the moving fix reports, so the shuffle is a shuffle and not a claim.
   */
  const shuffle = (from: { lat: number; lon: number }, metres: number): Point[] => [
    ...parked(T0, from, 6, 60, { voltage: 12.7 }), // T0 … T0+300
    pt(T0 + 360, northOf(from, metres), { speed: Math.round((metres / 60) * 3.6), voltage: 13.8 }),
    ...parked(T0 + 420, northOf(from, metres), 6, 60, { voltage: 12.7 }), // T0+420 … T0+720
  ];

  it("should merge two stops at the same site when the hop is under mergeHopM", () => {
    const { stops, trips } = segment(shuffle(centre, 200), SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.siteId).toBe("hfville");
    expect(stops[0]!.arrive).toBe(T0);
    expect(stops[0]!.depart).toBe(T0 + 420 + 300);
    expect(stops[0]!.lat).toBeCloseTo(centre.lat, 9); // the FIRST anchor is kept
    expect(trips).toHaveLength(0);
  });

  it("should not merge across a hop of mergeHopM or more", () => {
    const { stops, trips } = segment(shuffle(northOf(centre, -200), 400), SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.siteId)).toEqual(["hfville", "hfville"]);
    expect(trips).toHaveLength(1);
  });

  it("should NOT merge an out-and-back run home again, even though the anchors coincide", () => {
    // §3 rule 2: the truck leaves HF Ville, drives ~1.6 km towards HF, finds nobody
    // to stop for, turns round and parks where it started. The two anchors are the
    // same point (hop 0 m), so the hop test alone would swallow the whole journey
    // and report 0 trips; the travel between the runs is ~3.1 km, so it must not.
    //
    // The `f` steps are 0.2 of the 3 920 m to HF — 784 m per 60 s, which is the
    // 47 km/h each moving fix reports. It also keeps the last homeward fix outside
    // `jitterRadiusM` of home, so the truck is still driving when it is driving:
    // at a 0.1 step it would be 392 m out, and §3 rule 1 would read the arrival
    // fix as scatter and anchor the homecoming on a fix doing 47 km/h.
    const out = [0.2, 0.4].map((f, i) => pt(T0 + 360 + i * 60, lerp(HFVILLE, HF, f), { speed: 47, voltage: 13.8 }));
    const back = [pt(T0 + 480, lerp(HFVILLE, HF, 0.2), { speed: 47, voltage: 13.8 })];
    const points = [
      ...parked(T0, centre, 6, 60, { voltage: 12.7 }), // 12:00–12:05
      ...out,
      ...back,
      ...parked(T0 + 540, centre, 6, 60, { voltage: 12.7 }), // back home 12:09–12:14
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
    // The same 200 m shuffle as the first test — close enough to merge on both
    // halves of rule 2 — but at no known site, where the rule does not apply.
    const { stops } = segment(shuffle(lerp(HF, HFVILLE, 0.5), 200), SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.siteId)).toEqual([null, null]);
  });
});

describe("segment — trips and legs", () => {
  it("should build a trip between each pair of stops", () => {
    const { stops, trips } = segment(deliveryDay(T0), SITES, RULES);
    expect(stops.map((s) => s.siteId)).toEqual(["hf", null, "hfville"]);
    expect(stops.every((s) => s.virtual === undefined)).toBe(true);
    expect(trips.map((t) => t.n)).toEqual([1, 2]);
    expect(trips[0]!.start).toBe(stops[0]!.depart);
    expect(trips[0]!.end).toBe(stops[1]!.arrive);
    expect(trips[0]!.from.siteId).toBe("hf");
    expect(trips[0]!.to.siteId).toBeNull();
    expect(trips[0]!.maxKmh).toBe(47);
    // Departure fix + two moving fixes + arrival fix.
    expect(trips[0]!.pointCount).toBe(4);
    expect(trips[0]!.path).toHaveLength(4);
    expect(trips[0]!.km).toBeCloseTo(2.35, 1); // 0.6 × the 3.92 km straight line
    expect(trips[1]!.km + trips[0]!.km).toBeCloseTo(3.92, 1);
  });

  it("should merge the two trips into one hf → hfville leg through the unknown stop", () => {
    const { legs } = segment(deliveryDay(T0), SITES, RULES);
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
    const points = [beforeDeliveryDay(T0), ...deliveryDay(T0)];
    const { stops, trips, legs } = segment(points, SITES, RULES);
    expect(stops[0]!.virtual).toBe("track-start");
    expect(stops[0]!.arrive).toBe(T0 - 60);
    expect(stops[0]!.depart).toBe(T0 - 60);
    expect(trips).toHaveLength(3);
    // Trip 1 starts nowhere in particular, so it is not a delivery leg.
    expect(legs).toHaveLength(1);
    expect(legs[0]!.tripNs).toEqual([2, 3]);
  });

  it("should close with track-end when the day is still moving", () => {
    const points = [...deliveryDay(T0), pt(T0 + 1860, lerp(HF, HFVILLE, 0.8), { speed: 47, voltage: 13.8 })];
    const { stops, trips, legs } = segment(points, SITES, RULES);
    expect(stops[stops.length - 1]!.virtual).toBe("track-end");
    expect(trips).toHaveLength(3);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.tripNs).toEqual([1, 2]);
  });

  it("should book-end both sides of a day that never stops", () => {
    // 653 m every 120 s — the fixes claim the 20 km/h they are actually doing.
    const points = Array.from({ length: 6 }, (_, i) =>
      pt(T0 + i * 120, lerp(HF, HFVILLE, i / 6), { speed: 20 }),
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

// The 2026-09-06 evening: the truck never left HF Ville (voltage never reached
// engineOnVolts) yet the day page showed 20 "trips" and 19.8 km, because a
// parked tracker reports both bogus speeds and fixes hundreds of metres from
// where the truck stands. §3 rule 1 answers that with an anchored radius that
// widens to `jitterRadiusM` while the engine is off.
describe("segment — the engine-off jitter guard (§3 rule 1)", () => {
  const EVENING = bkk("2026-09-06", "16:05:00");
  const centre = { lat: HFVILLE.lat, lon: HFVILLE.lon };

  it("should read a whole parked evening as ONE stop and no trip at all", () => {
    const { stops, trips } = segment(parkedEvening(EVENING, centre, [12.5, 12.6, 12.7]), SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.virtual).toBeUndefined();
    expect(stops[0]!.siteId).toBe("hfville");
    expect(stops[0]!.arrive).toBe(EVENING);
    expect(stops[0]!.depart).toBe(EVENING + 2340); // 39 minutes, first fix to last
    expect(trips).toHaveLength(0);
  });

  it("should read it as ONE stop whichever fix happens to lead the run", () => {
    // The anchor is not special. The same twenty places over the same twenty
    // timestamps, rotated so a different fix opens the run, used to leave the
    // anchor 300-500 m off centre and split the evening into up to five stops,
    // four trips and 2.3 km that nobody drove — because the bound was measured
    // from the anchor while the scatter is measured from the centre (offsets
    // reach +570 m and -520 m, so two fixes are 1 090 m apart). §3 rule 1 also
    // holds a fix that shares the anchor's site fence, so the lead fix stops
    // mattering.
    for (const rotate of [4, 8, 12, 16]) {
      const { stops, trips } = segment(parkedEvening(EVENING, centre, [12.5, 12.6, 12.7], rotate), SITES, RULES);
      expect({ rotate, stops: stops.length, trips: trips.length }).toEqual({ rotate, stops: 1, trips: 0 });
      expect(stops[0]!.siteId).toBe("hfville");
      expect(stops[0]!.depart - stops[0]!.arrive).toBe(2340);
    }
  });

  it("should leave the SAME track alone when the voltage says the engine was running", () => {
    // Nothing about the jitter guard applies at 13.8 V: the tight-radius rule
    // still splits this into the five stops and four trips it reports today.
    const { stops, trips } = segment(parkedEvening(EVENING, centre, [13.8]), SITES, RULES);
    expect(stops).toHaveLength(5);
    expect(stops.every((s) => s.virtual === undefined)).toBe(true);
    expect(trips).toHaveLength(4);
  });

  it("should still end the run at a jump beyond jitterRadiusM — a bound, not a licence", () => {
    // 650 m from the anchor, engine off. Jitter is bounded at ~600 m; this is the
    // truck somewhere else, so it is a second stop even though nothing moved.
    const points = [
      ...parked(EVENING, centre, 5, 60, { voltage: 12.6, speed: 41 }),
      ...parked(EVENING + 360, northOf(centre, 650), 5, 60, { voltage: 12.6, speed: 41 }),
    ];
    const { stops } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops[0]!.depart).toBe(EVENING + 240);
    expect(stops[1]!.arrive).toBe(EVENING + 360);
  });

  it("should NOT swallow a km-scale relocation that happened during a feed gap", () => {
    // The vendor's feed drops out for hours and comes back with the truck 3.4 km
    // away, both sides engine-off (07:34 at HF Ville → 14:10 at HF on 2026-09-06).
    // Jitter is metres; a relocation is kilometres, and it owes the owner a trip.
    const far = lerp(HFVILLE, HF, 3400 / 3919.86);
    const points = [
      ...parked(EVENING, centre, 5, 60, { voltage: 12.7 }),
      ...parked(EVENING + 24000, far, 5, 60, { voltage: 12.7 }),
    ];
    const { stops, trips, legs } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.siteId)).toEqual(["hfville", "hf"]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.km).toBeCloseTo(3.4, 1);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ fromSiteId: "hfville", toSiteId: "hf" });
  });
});

// The warm-up half of the same rule. On 2026-09-05 the engine restarts at
// 13:32:44 (13.9 V) and 13:34:15 (13.8 V) with the truck still standing — speed
// 0, 177 m and 120 m from the arrival anchor — and the truck only pulls away at
// 13:35:15 at 37 km/h. While every ENGINE-ON fix was held to `stopRadiusM` those
// two closed the HF Ville stop at 13:24:14, eleven minutes before the truck left.
describe("segment — a settled fix is scatter whatever the engine is doing (§3 rule 1)", () => {
  const centre = { lat: HFVILLE.lat, lon: HFVILLE.lon };
  const arrival = parked(T0, centre, 6, 60, { voltage: 12.7 }); // T0 … T0+300, engine off
  const warmUpAt = northOf(centre, 180); // beyond stopRadiusM, well inside jitterRadiusM

  it("should keep an engine-on WARM-UP fix 180 m out inside the stop", () => {
    const points = [...arrival, pt(T0 + 360, warmUpAt, { speed: 0, voltage: 13.9 })];
    const { stops } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.virtual).toBeUndefined();
    expect(stops[0]!.depart).toBe(T0 + 360); // the truck has not left yet
  });

  it("should end the stop at the SAME fix once it reports movement", () => {
    const points = [...arrival, pt(T0 + 360, warmUpAt, { speed: 37, voltage: 13.9 })];
    const real = segment(points, SITES, RULES).stops.filter((s) => !s.virtual);
    expect(real).toHaveLength(1);
    expect(real[0]!.depart).toBe(T0 + 300); // 37 km/h at 180 m is the truck leaving
  });
});

// The other half: the widened bound is for scatter between two SETTLED fixes, so
// a MOVING ANCHOR is held to `stopRadiusM` too. The anchor is not just a bound —
// it IS the stop, supplying the arrival time, the map pin and (through `siteAt`)
// the site label — so a run opened on an approach fix must not reach 600 m
// forwards and swallow the parking place the truck was driving towards.
describe("segment — a moving anchor holds only stopRadiusM (§3 rule 1)", () => {
  const centre = { lat: HFVILLE.lat, lon: HFVILLE.lon };

  it("should anchor an arrival on the first PARKED fix, not on the approach", () => {
    // Closing at 30 km/h (500 m per 60 s), so the last fix before the truck parks
    // is 500 m short of the centre — inside `jitterRadiusM` of the parking place.
    const points = [
      pt(T0, northOf(centre, 1000), { speed: 30, voltage: 13.8 }),
      pt(T0 + 60, northOf(centre, 500), { speed: 30, voltage: 13.8 }),
      ...parked(T0 + 120, centre, 11, 60, { voltage: 12.7 }), // 10 minutes parked
    ];
    const real = segment(points, SITES, RULES).stops.filter((s) => !s.virtual);
    expect(real).toHaveLength(1);
    expect(real[0]!.arrive).toBe(T0 + 120); // not T0+60, which is still doing 30 km/h
    expect(real[0]!.lat).toBeCloseTo(centre.lat, 9); // the pin is the yard, not the road
    expect(real[0]!.lon).toBeCloseTo(centre.lon, 9);
  });

  it("should not let an approach fix drag a parked stop outside its site fence", () => {
    // On 2026-09-06 the truck parked engine-off in a tight cluster 540–552 m from
    // the HF centre — inside the 600 m fence, and the reason the fence is 600 m.
    // Anchored 500 m further out on the approach it would be 1 040 m from the
    // centre, outside the fence, and the day would report an unknown stop.
    const yard = northOf(HF, 540);
    const points = [
      pt(T0, northOf(HF, 1540), { speed: 30, voltage: 13.8 }),
      pt(T0 + 60, northOf(HF, 1040), { speed: 30, voltage: 13.8 }),
      ...parked(T0 + 120, yard, 11, 60, { voltage: 12.7 }),
    ];
    const real = segment(points, SITES, RULES).stops.filter((s) => !s.virtual);
    expect(real).toHaveLength(1);
    expect(real[0]!.siteId).toBe("hf");
    expect(real[0]!.lat).toBeCloseTo(yard.lat, 9);
  });
});

// Every stop carries the ignition events of its own point range (§3 rule 1,
// "engine events"): the owner asked to tell a truck waiting at a red light-ish
// halt from a truck whose driver switched off and walked away, and the answer is
// per-stop, not per-day.
describe("segment — every stop carries its engine events (§3 rule 1)", () => {
  const centre = { lat: HFVILLE.lat, lon: HFVILLE.lon };

  it("should fill offAt, onAt and offS from the stop's own fixes", () => {
    const points = [
      pt(T0, centre, { voltage: 13.8 }), // arrives with the engine running
      pt(T0 + 60, centre, { voltage: 12.7 }), // switched off
      pt(T0 + 120, centre, { voltage: 12.7 }),
      pt(T0 + 180, centre, { voltage: 13.9 }), // restarted
      pt(T0 + 240, centre, { voltage: 13.9 }),
    ];
    const { stops } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.engine).toEqual({ kind: "parked", offAt: T0 + 60, onAt: T0 + 180, offS: 120 });
    expect(stops[0]!.engineOnS).toBe(120); // unchanged, and a different question
  });

  it("should call a stop the truck idled through RUNNING, with no off time", () => {
    const idling = parked(T0, centre, 6, 60, { voltage: 13.8 });
    const { stops } = segment(idling, SITES, RULES);
    expect(stops[0]!.engine).toEqual({ kind: "running", offAt: null, onAt: null, offS: 0 });
  });

  it("should give a day with no voltage at all an unknown engine, never parked", () => {
    const { stops } = segment(parked(T0, centre, 6, 60), SITES, RULES);
    expect(stops[0]!.engine).toEqual({ kind: "unknown", offAt: null, onAt: null, offS: 0 });
  });

  it("should give the virtual book-ends an unknown engine — they are not parked time", () => {
    const points = Array.from({ length: 6 }, (_, i) =>
      pt(T0 + i * 120, lerp(HF, HFVILLE, i / 6), { speed: 20, voltage: 13.8 }),
    );
    const { stops } = segment(points, SITES, RULES);
    expect(stops.map((s) => s.virtual)).toEqual(["track-start", "track-end"]);
    for (const s of stops) expect(s.engine).toEqual({ kind: "unknown", offAt: null, onAt: null, offS: 0 });
  });

  it("should read the MERGED range, so a yard shuffle's restart is inside the stop", () => {
    // The same 200 m shuffle rule 2 merges: parked engine-off, one fix in motion
    // at 13.8 V, parked engine-off again. The events must span both runs — a
    // range covering only the first would report 300 s off, not 660. `onAt` is
    // still null: the shuffle's restart is not the last off-run's end, because
    // the driver switched off again on arrival and never came back.
    const points = [
      ...parked(T0, centre, 6, 60, { voltage: 12.7 }),
      pt(T0 + 360, northOf(centre, 200), { speed: 12, voltage: 13.8 }),
      ...parked(T0 + 420, northOf(centre, 200), 6, 60, { voltage: 12.7 }),
    ];
    const { stops } = segment(points, SITES, RULES);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.engine).toEqual({ kind: "parked", offAt: T0, onAt: null, offS: 660 });
  });
});
