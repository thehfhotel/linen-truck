// The regression that matters: the archived 2026-09-05 track, end to end.
//
// Every number below is from docs/CONTRACTS.md §3 ("Expected on the fixture") and
// was first produced by the Python prototype the owner reviewed. If a change to the
// segmentation moves one of them, that is a decision, not a detail.

import { describe, expect, it } from "bun:test";
import { cleanPoints } from "../../src/domain/segment.ts";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Finding, Point } from "../../src/domain/types.ts";
import { RULES, SITES, bkk, pt } from "./support.ts";
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
    expect(DAY.stops.map((s) => s.siteId)).toEqual([null, "hfville", "hf", null, "hfville"]);
    expect(DAY.stops[0]!.virtual).toBe("track-start");
    expect(DAY.stops.slice(1).every((s) => s.virtual === undefined)).toBe(true);
    expect(DAY.stops[1]!.arrive).toBe(at("12:24:15"));
    expect(DAY.stops[1]!.depart).toBe(at("13:34:15"));
    expect(DAY.stops[2]!.depart - DAY.stops[2]!.arrive).toBe(510); // 8.5 min at HF
    expect(DAY.stops[4]!.depart).toBe(at("15:11:16")); // still parked at HF Ville at the last fix
  });

  it("should find four trips totalling 15.7 km", () => {
    expect(DAY.tripCount).toBe(4);
    expect(DAY.km).toBeCloseTo(15.71, 2);
    expect(DAY.trips.map((t) => t.n)).toEqual([1, 2, 3, 4]);
    expect(DAY.trips.map((t) => t.from.siteId)).toEqual([null, "hfville", "hf", null]);
    expect(DAY.trips.map((t) => t.to.siteId)).toEqual(["hfville", "hf", null, "hfville"]);
    expect(DAY.trips[0]!.start).toBe(at("12:11:14"));
    expect(DAY.trips[0]!.end).toBe(at("12:24:15"));
    expect(DAY.trips[0]!.km).toBeCloseTo(3.5, 1);
    expect(DAY.trips[0]!.maxKmh).toBe(44);
    expect(DAY.trips[0]!.pointCount).toBe(14);
    expect(DAY.trips[0]!.path).toHaveLength(14);
    expect(DAY.trips[1]!.km).toBeCloseTo(4.9, 1);
    expect(DAY.trips[1]!.maxKmh).toBe(81);
  });
});

describe("the 2026-09-05 fixture — legs and the day's headline numbers", () => {
  it("should form two legs, and none for the unlabelled trip 1", () => {
    expect(DAY.legs).toHaveLength(2);
    expect(DAY.legs[0]).toMatchObject({ tripNs: [2], fromSiteId: "hfville", toSiteId: "hf", viaUnknownStops: 0 });
    expect(DAY.legs[0]!.km).toBeCloseTo(4.9, 1);
    expect(DAY.legs[1]).toMatchObject({ tripNs: [3, 4], fromSiteId: "hf", toSiteId: "hfville", viaUnknownStops: 1 });
    expect(DAY.legs[1]!.km).toBeCloseTo(7.4, 1);
    expect(DAY.legs.flatMap((l) => l.tripNs)).not.toContain(1);
    expect(DAY.legs[1]!.start).toBe(at("13:57:45"));
    expect(DAY.legs[1]!.end).toBe(at("14:26:46"));
  });

  it("should count one round trip and the time parked at each site", () => {
    expect(DAY.roundTrips).toBe(1);
    expect(DAY.firstDeparture).toBe(at("12:11:14"));
    expect(DAY.lastArrival).toBe(at("14:26:46"));
    expect(Object.keys(DAY.timeAtSiteS).sort()).toEqual(["hf", "hfville"]);
    expect(DAY.timeAtSiteS.hfville).toBe(6870); // 114.5 min — the two HF Ville stops
    expect(DAY.timeAtSiteS.hfville!).toBeGreaterThanOrEqual(100 * 60);
    expect(DAY.timeAtSiteS.hf).toBe(510);
  });
});

describe("the 2026-09-05 fixture — findings", () => {
  it("should raise exactly one unknown stop, one detour and no outside-hours run", () => {
    expect(DAY.findings.map((f) => f.kind)).toEqual(["unknown-stop", "detour"]);
    expect(of("outside-hours")).toHaveLength(0);
  });

  it("should place the unknown stop at 14:18–14:22, ~400 m short of HF Ville", () => {
    const [u] = of("unknown-stop");
    expect(u!.arrive).toBe(at("14:18:15"));
    expect(u!.depart).toBe(at("14:22:15"));
    expect(u!.durationS).toBe(240);
    expect(u!.lat).toBeCloseTo(9.12332, 5);
    expect(u!.lon).toBeCloseTo(99.34898, 5);
  });

  it("should call the hf → hfville leg a detour at ratio ~1.5", () => {
    const [d] = of("detour");
    expect(d!.leg.tripNs).toEqual([3, 4]);
    expect(d!.referenceKm).toBe(4.9);
    expect(d!.ratio).toBeCloseTo(1.5, 1);
    expect(d!.ratio).toBeGreaterThan(RULES.detourRatio);
  });
});
