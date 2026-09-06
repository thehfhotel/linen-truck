import { describe, expect, it } from "bun:test";
import { audit, legKey } from "../../src/domain/audit.ts";
import { segment } from "../../src/domain/segment.ts";
import type { Finding, Leg, Point, Rules } from "../../src/domain/types.ts";
import {
  HF,
  HFVILLE,
  RULES,
  SITES,
  beforeDeliveryDay,
  bkk,
  deliveryDay,
  lerp,
  parked,
  parkedEvening,
  pt,
} from "./support.ts";

const T0 = bkk("2026-09-05", "12:00:00");
const EMPTY_SEG = { stops: [], trips: [], legs: [] };
const kinds = (f: Finding[]): string[] => f.map((x) => x.kind);
/** Where `deliveryDay` (support.ts) stops between the two sites — no known site. */
const NOWHERE = lerp(HF, HFVILLE, 0.6);

describe("audit — unknown stops", () => {
  it("should report a long enough stop at no known site, with its map coordinates", () => {
    const points = deliveryDay(T0);
    const seg = segment(points, SITES, RULES);
    const found = audit("2026-09-05", seg, points, SITES, RULES);
    const unknown = found.filter((f) => f.kind === "unknown-stop");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ kind: "unknown-stop", durationS: 300, arrive: T0 + 780, depart: T0 + 1080 });
    expect(unknown[0]!.kind === "unknown-stop" && unknown[0]!.lat).toBeCloseTo(NOWHERE.lat, 6);
  });

  it("should stay quiet below unknownStopMinS and at a known site", () => {
    const points = deliveryDay(T0);
    const seg = segment(points, SITES, RULES);
    const patient: Rules = { ...RULES, unknownStopMinS: 600 };
    expect(kinds(audit("2026-09-05", seg, points, SITES, patient))).not.toContain("unknown-stop");
    // The HF and HF Ville stops are 10 minutes each and never reported.
    expect(seg.stops.filter((s) => s.siteId !== null)).toHaveLength(2);
  });

  it("should never report a virtual book-end, even at no known site", () => {
    const points = [beforeDeliveryDay(T0), ...deliveryDay(T0)];
    const seg = segment(points, SITES, RULES);
    expect(seg.stops[0]!.virtual).toBe("track-start");
    expect(audit("2026-09-05", seg, points, SITES, RULES).filter((f) => f.kind === "unknown-stop")).toHaveLength(1);
  });
});

describe("audit — detours", () => {
  const leg = (fromSiteId: string, toSiteId: string, km: number): Leg => ({
    tripNs: [1],
    fromSiteId,
    toSiteId,
    start: T0,
    end: T0 + 900,
    km,
    viaUnknownStops: 0,
  });

  it("should key referenceKm on the sorted pair, in both directions", () => {
    expect(legKey("hfville", "hf")).toBe("hf|hfville");
    expect(legKey("hf", "hfville")).toBe("hf|hfville");
    const seg = { ...EMPTY_SEG, legs: [leg("hfville", "hf", 9.8)] };
    const found = audit("2026-09-05", seg, [], SITES, RULES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "detour", referenceKm: 4.9, ratio: 2 });
  });

  it("should fire strictly above detourRatio and not at it", () => {
    const at = audit("2026-09-05", { ...EMPTY_SEG, legs: [leg("hf", "hfville", 4.9 * 1.25)] }, [], SITES, RULES);
    expect(kinds(at)).not.toContain("detour");
    const over = audit("2026-09-05", { ...EMPTY_SEG, legs: [leg("hf", "hfville", 4.9 * 1.26)] }, [], SITES, RULES);
    expect(kinds(over)).toEqual(["detour"]);
  });

  it("should say nothing about a pair with no reference distance", () => {
    const seg = { ...EMPTY_SEG, legs: [leg("hf", "depot", 40)] };
    expect(audit("2026-09-05", seg, [], SITES, RULES)).toEqual([]);
  });
});

describe("audit — outside hours", () => {
  const moving = (hhmmss: string, speed = 40): Point =>
    pt(bkk("2026-09-05", hhmmss), lerp(HF, HFVILLE, 0.3), { speed });

  it("should group moving fixes into runs and split on a gap over 600 s", () => {
    const points = [
      pt(bkk("2026-09-05", "09:00:00"), HF, { speed: 40 }),
      pt(bkk("2026-09-05", "09:01:00"), lerp(HF, HFVILLE, 0.25), { speed: 60 }),
      pt(bkk("2026-09-05", "09:02:00"), lerp(HF, HFVILLE, 0.5), { speed: 60 }),
      // 11 minutes later — a new errand, not the same run.
      pt(bkk("2026-09-05", "09:13:00"), lerp(HF, HFVILLE, 0.75), { speed: 60 }),
      pt(bkk("2026-09-05", "09:14:00"), HFVILLE, { speed: 30 }),
    ];
    const found = audit("2026-09-05", EMPTY_SEG, points, SITES, RULES);
    expect(kinds(found)).toEqual(["outside-hours", "outside-hours"]);
    const [a, b] = found as Extract<Finding, { kind: "outside-hours" }>[];
    expect(a!.start).toBe(bkk("2026-09-05", "09:00:00"));
    expect(a!.end).toBe(bkk("2026-09-05", "09:02:00"));
    expect(a!.km).toBeCloseTo(1.96, 1);
    expect(b!.start).toBe(bkk("2026-09-05", "09:13:00"));
    expect(b!.km).toBeCloseTo(0.98, 1);
  });

  it("should ignore fixes that are not moving faster than movingKmh", () => {
    const points = [moving("09:00:00", 5), moving("09:01:00", 0), moving("09:02:00", 5)];
    expect(audit("2026-09-05", EMPTY_SEG, points, SITES, RULES)).toEqual([]);
    expect(kinds(audit("2026-09-05", EMPTY_SEG, [moving("09:03:00", 6)], SITES, RULES))).toEqual(["outside-hours"]);
  });

  it("should treat the schedule as half-open Bangkok wall-clock [12:00, 16:00)", () => {
    const points = [moving("11:59:00"), moving("12:00:00"), moving("15:59:00"), moving("16:00:00")];
    const found = audit("2026-09-05", EMPTY_SEG, points, SITES, RULES) as Extract<
      Finding,
      { kind: "outside-hours" }
    >[];
    expect(found).toHaveLength(2);
    expect(found[0]!.start).toBe(bkk("2026-09-05", "11:59:00"));
    expect(found[1]!.start).toBe(bkk("2026-09-05", "16:00:00"));
  });

  it("should read the wall clock in Bangkok, not UTC", () => {
    // 09:00 UTC is 16:00 Bangkok — outside hours; 05:00 UTC is 12:00 Bangkok — inside.
    const at = (iso: string): Point => pt(Date.parse(iso) / 1000, HF, { speed: 40 });
    expect(kinds(audit("2026-09-05", EMPTY_SEG, [at("2026-09-05T05:00:00Z")], SITES, RULES))).toEqual([]);
    expect(kinds(audit("2026-09-05", EMPTY_SEG, [at("2026-09-05T09:00:00Z")], SITES, RULES))).toEqual([
      "outside-hours",
    ]);
  });

  it("should support a window that wraps midnight", () => {
    const night: Rules = { ...RULES, schedule: { start: "22:00", end: "05:00" } };
    const inside = [moving("23:30:00"), moving("04:00:00")];
    expect(audit("2026-09-05", EMPTY_SEG, inside, SITES, night)).toEqual([]);
    expect(kinds(audit("2026-09-05", EMPTY_SEG, [moving("12:00:00")], SITES, night))).toEqual(["outside-hours"]);
  });
});

// §3 rule 6c, second half: a parked tracker reports speeds it never drove. On
// 2026-09-06 16:00–21:00 the truck sat at HF Ville all evening and the day page
// still raised 17 outside-hours findings off those bogus speeds.
describe("audit — outside hours needs the engine ON, not just a speed", () => {
  const EVENING = bkk("2026-09-06", "16:05:00");
  const centre = { lat: HFVILLE.lat, lon: HFVILLE.lon };
  const outside = (points: Point[]): Finding[] =>
    audit("2026-09-06", EMPTY_SEG, points, SITES, RULES).filter((f) => f.kind === "outside-hours");

  it("should say nothing about an evening the truck spent parked at 12.5–12.7 V", () => {
    expect(outside(parkedEvening(EVENING, centre, [12.5, 12.6, 12.7]))).toHaveLength(0);
  });

  it("should still report the same track when the voltage says it really drove", () => {
    const found = outside(parkedEvening(EVENING, centre, [13.8])) as Extract<
      Finding,
      { kind: "outside-hours" }
    >[];
    expect(found).toHaveLength(1);
    expect(found[0]!.start).toBe(EVENING);
    expect(found[0]!.end).toBe(EVENING + 2260); // the last fix over movingKmh
  });

  it("should keep reporting a day with no voltage at all — null is unknown, not off", () => {
    const blind = parkedEvening(EVENING, centre, [12.6]).map((p) => ({ ...p, voltage: null }));
    expect(outside(blind)).toHaveLength(1);
  });
});
