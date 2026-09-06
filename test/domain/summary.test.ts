// The regression that matters: the archived 2026-09-05 track, end to end.
//
// Every number below is from docs/CONTRACTS.md §3 ("Expected on the fixture") and
// was first produced by the Python prototype the owner reviewed. If a change to the
// segmentation moves one of them, that is a decision, not a detail.

import { describe, expect, it } from "bun:test";
import { haversineM } from "../../src/domain/geo.ts";
import { cleanPoints } from "../../src/domain/segment.ts";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Finding, Point } from "../../src/domain/types.ts";
import { HFVILLE, RULES, SITES, bkk, pt } from "./support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

const YMD = "2026-09-05";
const at = (hhmmss: string): number => bkk(YMD, hhmmss);

const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);
const DAY = summarizeDay(YMD, POINTS, SITES, RULES);
const of = <K extends Finding["kind"]>(kind: K): Extract<Finding, { kind: K }>[] =>
  DAY.findings.filter((f): f is Extract<Finding, { kind: K }> => f.kind === kind);

describe("the 2026-09-05 fixture — points", () => {
  it("should read every archived row and clean 84 down to 82", () => {
    expect(RAW).toHaveLength(84);
    expect(POINTS).toHaveLength(84);
    expect(cleanPoints(POINTS)).toHaveLength(82);
    expect(DAY.pointCount).toBe(82);
    expect(DAY.firstPointAt).toBe(at("12:11:14"));
    expect(DAY.lastPointAt).toBe(at("15:11:16"));
  });

  it("should clip to the Bangkok day, not the UTC one", () => {
    const strays = [
      pt(at("00:00:00") - 1, SITES[0]!), // 23:59:59 on 09-04 Bangkok
      pt(bkk("2026-09-06", "00:00:00"), SITES[0]!), // already 09-06
    ];
    expect(summarizeDay(YMD, [...POINTS, ...strays], SITES, RULES).pointCount).toBe(82);
    expect(summarizeDay("2026-09-04", POINTS, SITES, RULES).pointCount).toBe(0);
    expect(summarizeDay("2026-09-04", POINTS, SITES, RULES).findings).toEqual([]);
  });
});

describe("the 2026-09-05 fixture — stops and trips", () => {
  it("should find the day's five stops, opening on a track-start book-end", () => {
    expect(DAY.stops).toHaveLength(5);
    // Every real stop of this day is at a known site: the 14:18 one is 368 m from
    // the HF Ville centre, inside the 600 m fence (§2).
    expect(DAY.stops.map((s) => s.siteId)).toEqual([null, "hfville", "hf", "hfville", "hfville"]);
    expect(DAY.stops[0]!.virtual).toBe("track-start");
    expect(DAY.stops.slice(1).every((s) => s.virtual === undefined)).toBe(true);
    expect(DAY.stops[1]!.arrive).toBe(at("12:24:15"));
    // The run is anchored on the 12:24:15 arrival fix and every fix that is not
    // both engine-on and moving rides inside `jitterRadiusM` of it. That covers
    // the two engine RESTARTS before departure (13:32:44 at 13.9 V and 13:34:15 at
    // 13.8 V, both speed 0, both 120–180 m from the anchor — a warm-up scatters
    // like any other parked truck), so the stop ends where the truck actually
    // left: 13:35:15, the first fix reporting movement, is more than
    // `stopRadiusM` from the anchor and starts the trip.
    expect(DAY.stops[1]!.depart).toBe(at("13:34:15"));
    expect(DAY.stops[2]!.depart - DAY.stops[2]!.arrive).toBe(1080); // 18 min at HF
    expect(haversineM(DAY.stops[3]!, HFVILLE)).toBeCloseTo(368.4, 0);
    expect(haversineM(DAY.stops[3]!, DAY.stops[4]!)).toBeGreaterThanOrEqual(RULES.mergeHopM); // so they stay two stops
    expect(DAY.stops[4]!.depart).toBe(at("15:11:16")); // still parked at HF Ville at the last fix
  });

  it("should find four trips totalling 15.4 km", () => {
    expect(DAY.tripCount).toBe(4);
    expect(DAY.km).toBeCloseTo(15.35, 2);
    expect(DAY.trips.map((t) => t.n)).toEqual([1, 2, 3, 4]);
    expect(DAY.trips.map((t) => t.from.siteId)).toEqual([null, "hfville", "hf", "hfville"]);
    expect(DAY.trips.map((t) => t.to.siteId)).toEqual(["hfville", "hf", "hfville", "hfville"]);
    expect(DAY.trips[0]!.start).toBe(at("12:11:14"));
    expect(DAY.trips[0]!.end).toBe(at("12:24:15"));
    expect(DAY.trips[0]!.km).toBeCloseTo(3.5, 1);
    expect(DAY.trips[0]!.maxKmh).toBe(44);
    expect(DAY.trips[0]!.pointCount).toBe(14);
    expect(DAY.trips[0]!.path).toHaveLength(14);
    expect(DAY.trips[1]!.km).toBeCloseTo(4.76, 2); // short of the 4.9 km reference
    expect(DAY.trips[1]!.maxKmh).toBe(81);
  });
});

describe("the 2026-09-05 fixture — legs and the day's headline numbers", () => {
  it("should form three legs, and none for the unlabelled trip 1", () => {
    // Every stop of the day is now at a known site, so no leg walks through an
    // unknown one, and the 0.4 km hop between the two HF Ville stops is a leg of
    // its own — known site → known site, §3 rule 5, with no referenceKm to judge.
    expect(DAY.legs).toHaveLength(3);
    expect(DAY.legs[0]).toMatchObject({ tripNs: [2], fromSiteId: "hfville", toSiteId: "hf", viaUnknownStops: 0 });
    expect(DAY.legs[0]!.km).toBeCloseTo(4.76, 2);
    expect(DAY.legs[1]).toMatchObject({ tripNs: [3], fromSiteId: "hf", toSiteId: "hfville", viaUnknownStops: 0 });
    expect(DAY.legs[1]!.km).toBeCloseTo(6.74, 2);
    expect(DAY.legs[2]).toMatchObject({ tripNs: [4], fromSiteId: "hfville", toSiteId: "hfville", viaUnknownStops: 0 });
    expect(DAY.legs[2]!.km).toBeCloseTo(0.375, 2);
    expect(RULES.referenceKm["hfville|hfville"]).toBeUndefined();
    expect(DAY.legs.flatMap((l) => l.tripNs)).not.toContain(1);
    expect(DAY.legs[0]!.start).toBe(at("13:34:15"));
    expect(DAY.legs[1]!.start).toBe(at("14:06:15"));
    expect(DAY.legs[1]!.end).toBe(at("14:18:15"));
  });

  it("should count one round trip and the time parked at each site", () => {
    expect(DAY.roundTrips).toBe(1);
    expect(DAY.firstDeparture).toBe(at("12:11:14"));
    expect(DAY.lastArrival).toBe(at("14:26:46"));
    expect(Object.keys(DAY.timeAtSiteS).sort()).toEqual(["hf", "hfville"]);
    expect(DAY.timeAtSiteS.hfville).toBe(7110); // 118.5 min — the three HF Ville stops
    expect(DAY.timeAtSiteS.hfville!).toBeGreaterThanOrEqual(100 * 60);
    expect(DAY.timeAtSiteS.hf).toBe(1080);
  });
});

describe("the 2026-09-05 fixture — findings", () => {
  it("should raise exactly one detour, no unknown stop and no outside-hours run", () => {
    expect(DAY.findings.map((f) => f.kind)).toEqual(["detour"]);
    expect(of("unknown-stop")).toHaveLength(0);
    expect(of("outside-hours")).toHaveLength(0);
  });

  it("should keep the 14:18–14:22 stop but call it HF Ville, not an unknown stop", () => {
    // It was reported as an unknown stop while the fence was 250 m. At 600 m it is
    // the truck sitting in the HF Ville lane, which is not worth the owner's time.
    const s = DAY.stops[3]!;
    expect(s.arrive).toBe(at("14:18:15"));
    expect(s.depart).toBe(at("14:22:15"));
    expect(s.depart - s.arrive).toBe(240);
    expect(s.depart - s.arrive).toBeGreaterThanOrEqual(RULES.unknownStopMinS); // long enough to have been one
    expect(s.siteId).toBe("hfville");
    expect(s.lat).toBeCloseTo(9.12332, 5);
    expect(s.lon).toBeCloseTo(99.34898, 5);
  });

  it("should call the hf → hfville leg a detour at ratio ~1.38", () => {
    const [d] = of("detour");
    expect(d!.leg.tripNs).toEqual([3]);
    expect(d!.referenceKm).toBe(4.9);
    expect(d!.ratio).toBeCloseTo(1.376, 2);
    expect(d!.ratio).toBeGreaterThan(RULES.detourRatio);
  });
});

// §3 rule 1, "engine events": every stop of the fixture carries the ignition
// story of its own fixes. The times below were measured on the box from the raw
// `Voltages=` readings inside each stop (docs/CONTRACTS.md §3).
describe("the 2026-09-05 fixture — engine events per stop", () => {
  it("should mark every real stop parked, and the book-end unknown", () => {
    expect(DAY.stops.map((s) => s.engine.kind)).toEqual(["unknown", "parked", "parked", "parked", "parked"]);
  });

  it("should time the HF Ville morning stop's engine off and restart", () => {
    // 70 minutes at HF Ville, of which 65 with the engine off: switched off three
    // minutes after arrival, restarted at 13:32:44 (the first of the two warm-up
    // fixes rule 1 keeps inside the stop).
    expect(DAY.stops[1]!.engine).toEqual({
      kind: "parked",
      offAt: at("12:27:44"),
      onAt: at("13:32:44"),
      offS: 3900,
    });
  });

  it("should show the HF unloading running for nine minutes before the engine stops", () => {
    // 13:48–14:06 at HF: engine on until 13:57:45, off for 8.5 minutes, running
    // again on the departure fix itself.
    expect(DAY.stops[2]!.engine).toEqual({
      kind: "parked",
      offAt: at("13:57:45"),
      onAt: at("14:06:15"),
      offS: 510,
    });
  });

  it("should leave onAt null where the engine never came back inside the stop", () => {
    expect(DAY.stops[3]!.engine).toEqual({ kind: "parked", offAt: at("14:18:45"), onAt: null, offS: 210 });
    expect(DAY.stops[4]!.engine).toEqual({ kind: "parked", offAt: at("14:28:13"), onAt: null, offS: 2583 });
  });

  it("should keep engineOnS and the engine events answering their own questions", () => {
    // Both read the raw voltage; they differ only in the null rule (engineOnS lets
    // a null fix count to nothing, offS carries the previous state), so on this
    // fixture — no null-voltage fix inside any stop — they sum to the duration.
    expect(DAY.stops[1]!.engineOnS).toBe(300);
    expect(DAY.stops[1]!.engine.offS).toBe(3900);
    expect(DAY.stops[1]!.depart - DAY.stops[1]!.arrive).toBe(4200);
  });
});
