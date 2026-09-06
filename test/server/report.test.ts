// The DayReport boundary (docs/CONTRACTS.md §9).

import { describe, expect, test } from "bun:test";
import type { DaySummary, Point } from "../../src/domain/types.ts";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import { unknownStopText, detourText, outsideHoursText } from "../../src/shared/labels.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import {
  bangkokStamp,
  buildDayReport,
  hhmm,
  km1,
  minutesOf,
  ratio2,
  summaryOnly,
  type ReportFinding,
} from "../../src/server/report.ts";
import { HF, HFVILLE, bkk, lerp, parked, pt } from "../domain/support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

const TEID = "1000000001";
const GENERATED_AT = 1788595367;

const emptySummary = (ymd: string): DaySummary => ({
  ymd,
  pointCount: 0,
  firstPointAt: null,
  lastPointAt: null,
  km: 0,
  tripCount: 0,
  roundTrips: 0,
  firstDeparture: null,
  lastArrival: null,
  timeAtSiteS: {},
  stops: [],
  trips: [],
  legs: [],
  findings: [],
});

const build = (summary: DaySummary, over: Partial<Parameters<typeof buildDayReport>[0]> = {}) =>
  buildDayReport({
    teid: TEID,
    summary,
    points: [],
    sites: loadSites(),
    rules: loadRules(),
    status: null,
    poll: null,
    pollerConfigured: true,
    generatedAt: GENERATED_AT,
    ...over,
  });

describe("formatting", () => {
  test("times are Bangkok wall clock", () => {
    expect(hhmm(1788585074)).toBe("12:11");
    expect(bangkokStamp(1788595367)).toBe("2026-09-05 15:02");
  });

  test("minutes floor, km round to one place, ratios to two", () => {
    expect(minutesOf(240)).toBe(4);
    expect(minutesOf(7110)).toBe(118); // the fixture's HF Ville total: 118.5 min is not 119
    expect(minutesOf(59)).toBe(0);
    expect(km1(15.352071187308024)).toBe(15.4); // the fixture's day, unrounded
    // The fixture's hf → hfville leg against its 4.9 km reference, unrounded too.
    expect(ratio2(6.740855209569951 / 4.9)).toBe(1.38);
  });
});

describe("the finding sentences", () => {
  test("read as §9 spells them", () => {
    expect(unknownStopText(4, "14:18", "14:22", "unknown")).toEqual({
      th: "จอดที่ไม่รู้จัก 4 นาที (14:18–14:22)",
      en: "Unknown stop 4 min (14:18–14:22)",
    });
    expect(detourText({ th: "โรงแรม HF", en: "HF Hotel" }, { th: "HF Ville", en: "HF Ville" }, 6.7, 4.9, 1.38).en).toBe(
      "Detour HF Hotel → HF Ville 6.7 km (normally 4.9 km, 1.38×)",
    );
    expect(outsideHoursText("08:12", "08:40", 3.1).th).toBe("วิ่งนอกเวลางาน 08:12–08:40 ระยะ 3.1 กม.");
  });

  test("an unknown stop says what the engine was doing, and says nothing when it cannot tell", () => {
    // The owner's wording (2026-09-06): a halt with the engine running is not
    // the same event as a truck parked up, and the sentence must say which.
    expect(unknownStopText(19, "14:27", "14:47", "running")).toEqual({
      th: "จอดที่ไม่รู้จัก 19 นาที (14:27–14:47) · เครื่องติด",
      en: "Unknown stop 19 min (14:27–14:47), engine running",
    });
    expect(unknownStopText(19, "14:27", "14:47", "parked")).toEqual({
      th: "จอดที่ไม่รู้จัก 19 นาที (14:27–14:47) · ดับเครื่อง",
      en: "Unknown stop 19 min (14:27–14:47), engine off",
    });
    // No voltage, no claim — the sentence is exactly what it was before.
    expect(unknownStopText(4, "14:18", "14:22", "unknown").th).toBe("จอดที่ไม่รู้จัก 4 นาที (14:18–14:22)"); // no suffix when the ignition is unreadable
  });
});

describe("buildDayReport", () => {
  test("a day with nothing in it still answers the full §9 shape", () => {
    const report = build(emptySummary("2026-09-01"));
    expect(report.date).toBe("2026-09-01");
    expect(report.tz).toBe("Asia/Bangkok");
    expect(report.generatedAt).toBe(GENERATED_AT);
    expect(report.summary.findingCount).toEqual({ "unknown-stop": 0, detour: 0, "outside-hours": 0 });
    expect(report.device).toEqual({ teid: TEID, lastSeenAt: null, voltage: null, moving: false, online: false });
    expect(report.trips).toEqual([]);
    expect(report.path).toEqual([]);
  });

  test("dataQuality names the reason the numbers may be wrong", () => {
    expect(build(emptySummary("2026-09-01")).dataQuality).toEqual({ lastPollAt: null, lastPollOk: null, note: "no-poll-yet" });
    expect(build(emptySummary("2026-09-01"), { pollerConfigured: false }).dataQuality.note).toBe("poller-not-configured");
    expect(
      build(emptySummary("2026-09-01"), {
        poll: { at: 1, ok: false, pointsSeen: 0, pointsNew: 0, error: "boom" },
      }).dataQuality.note,
    ).toBe("last-poll-failed");
    expect(
      build(emptySummary("2026-09-01"), { poll: { at: 1, ok: true, pointsSeen: 0, pointsNew: 0, error: null } })
        .dataQuality.note,
    ).toBe("no-points-for-day");
  });

  test("the device line prefers device_status and calls a stale one offline", () => {
    const status = {
      teid: TEID,
      t: GENERATED_AT - 60,
      lat: 9.12,
      lon: 99.35,
      speed: 40,
      mileageM: 1,
      voltage: 13.4,
      parkSince: null,
      runSince: null,
      fetchedAt: GENERATED_AT,
    };
    expect(build(emptySummary("2026-09-05"), { status }).device).toEqual({
      teid: TEID,
      lastSeenAt: GENERATED_AT - 60,
      voltage: 13.4,
      moving: true,
      online: true,
    });
    const stale = build(emptySummary("2026-09-05"), { status: { ...status, t: GENERATED_AT - 3600, speed: 0 } }).device;
    expect(stale.online).toBe(false);
    expect(stale.moving).toBe(false);
  });
});

describe("the map path (§9)", () => {
  /** 2026-09-05 12:00 Bangkok. */
  const T0 = Date.parse("2026-09-05T12:00:00+07:00") / 1000;
  const AT = { lat: 9.1213396, lon: 99.3516676 };

  /**
   * The platform repeats rows and emits `dbLat=0` while the GPS is cold. Both are
   * dropped by `cleanPoints` before the summary counts anything, so the report's
   * `path` — which is what the Leaflet script draws — must come off the same
   * cleaned array, or the map draws a line to null island and `path.length`
   * disagrees with `summary.pointCount`.
   */
  const dirty = (): Point[] => [
    { t: T0 + 60, lat: 0, lon: 0, speed: 0, voltage: null }, // cold fix
    { t: T0, lat: AT.lat, lon: AT.lon, speed: 0, voltage: 12.7 }, // out of order
    { t: T0, lat: AT.lat + 0.01, lon: AT.lon, speed: 9, voltage: 12.7 }, // duplicate second
    { t: T0 + 120, lat: AT.lat, lon: AT.lon, speed: 0, voltage: 12.7 },
    { t: T0 + 180, lat: 9.1213396, lon: 0, speed: 0, voltage: null }, // half-cold fix, last
  ];

  test("path.length === summary.pointCount, and no (0,0) reaches the map", () => {
    const points = dirty();
    const summary = summarizeDay("2026-09-05", points, loadSites(), loadRules());
    const report = build(summary, { points });

    expect(summary.pointCount).toBe(2);
    expect(report.path).toHaveLength(summary.pointCount);
    expect(report.path!.map((p) => p[2])).toEqual([T0, T0 + 120]);
    expect(report.path!.some(([lat, lon]) => lat === 0 || lon === 0)).toBe(false);
  });

  test("the device fallback reads the last CLEAN fix, not the cold one", () => {
    const points = dirty();
    const summary = summarizeDay("2026-09-05", points, loadSites(), loadRules());
    const device = build(summary, { points, status: null }).device;

    expect(device.lastSeenAt).toBe(T0 + 120);
    expect(device.voltage).toBe(12.7);
  });
});

describe("the day-page filter fields (additive, §9)", () => {
  const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
  const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);
  const SITES = loadSites();
  const RULES = loadRules();
  const summary = summarizeDay("2026-09-05", POINTS, SITES, RULES);
  const report = build(summary, { points: POINTS });

  test("every trip carries startAt/endAt matching the domain trip, alongside the existing HH:MM pair", () => {
    expect(report.trips).toHaveLength(summary.trips.length);
    report.trips!.forEach((trip, i) => {
      const domainTrip = summary.trips[i]!;
      expect(trip.startAt).toBe(domainTrip.start);
      expect(trip.endAt).toBe(domainTrip.end);
      expect(trip.start).toBe(hhmm(domainTrip.start));
      expect(trip.end).toBe(hhmm(domainTrip.end));
    });
  });

  test("every stop carries arriveAt/departAt matching the domain stop", () => {
    expect(report.stops).toHaveLength(summary.stops.length);
    report.stops!.forEach((stop, i) => {
      const domainStop = summary.stops[i]!;
      expect(stop.arriveAt).toBe(domainStop.arrive);
      expect(stop.departAt).toBe(domainStop.depart);
    });
  });

  test("an unknown-stop finding points at the stop row it came from", () => {
    // The fixture itself has raised no unknown stop since the fences widened to
    // 600 m (§3), so the index wiring is proven on a day that does have one:
    // parked at HF, five minutes at nowhere, parked at HF Ville.
    const T = bkk("2026-09-03", "12:00:00");
    const day = [
      ...parked(T, HF, 11, 60, { voltage: 12.7 }),
      pt(T + 660, lerp(HF, HFVILLE, 0.25), { speed: 40, voltage: 13.8 }),
      ...parked(T + 720, lerp(HF, HFVILLE, 0.5), 6, 60, { voltage: 13.8 }),
      pt(T + 1140, lerp(HF, HFVILLE, 0.75), { speed: 55, voltage: 13.8 }),
      ...parked(T + 1200, HFVILLE, 11, 60, { voltage: 12.7 }),
    ];
    const withUnknown = build(summarizeDay("2026-09-03", day, SITES, RULES), { points: day });
    const unknown = withUnknown.findings.find((f) => f.kind === "unknown-stop");
    expect(unknown).toBeDefined();
    expect(unknown!.kind === "unknown-stop" && unknown!.stopIndex).toBe(1);
    const stop = withUnknown.stops![1]!;
    expect(stop.arrive).toBe("12:12");
    expect(stop.depart).toBe("12:17");
    expect(stop.site).toBeNull();
  });

  test("the fixture's own findings are one detour and nothing else", () => {
    expect(report.findings.map((f) => f.kind)).toEqual(["detour"]);
    expect(report.summary.findingCount).toEqual({ "unknown-stop": 0, detour: 1, "outside-hours": 0 });
  });

  test("an outside-hours finding carries startAt/endAt", () => {
    const nightRules = { ...RULES, schedule: { start: "00:00", end: "00:00" } }; // never inside → every move counts
    const nightSummary = summarizeDay("2026-09-05", POINTS, SITES, nightRules);
    const nightReport = build(nightSummary, { points: POINTS, rules: nightRules });
    const outside = nightReport.findings.find((f) => f.kind === "outside-hours");
    expect(outside).toBeDefined();
    if (outside && outside.kind === "outside-hours") {
      // startAt/endAt are the raw epochs `start`/`end` were formatted from — the
      // additive fields must round-trip through the same clock, not a new one.
      expect(hhmm(outside.startAt)).toBe(outside.start);
      expect(hhmm(outside.endAt)).toBe(outside.end);
      expect(outside.endAt).toBeGreaterThanOrEqual(outside.startAt);
    }
  });
});

// §9, additive: every stop carries its engine story, and an unknown-stop
// finding repeats it in a form hf-mcp can print without re-deriving anything.
describe("the engine fields (additive, §9)", () => {
  const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
  const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);
  const SITES = loadSites();
  const RULES = loadRules();
  const report = build(summarizeDay("2026-09-05", POINTS, SITES, RULES), { points: POINTS });

  test("every stop reports its engine kind, and the book-end reports unknown", () => {
    expect(report.stops!.map((s) => s.engine)).toEqual(["unknown", "parked", "parked", "parked", "parked"]);
    expect(report.stops![0]).toMatchObject({ engineOffAt: null, engineOnAt: null, engineOffMin: 0 });
  });

  test("the engine times are Bangkok HH:MM and the off minutes are floored", () => {
    expect(report.stops![1]).toMatchObject({
      engine: "parked",
      engineOffAt: "12:27",
      engineOnAt: "13:32",
      engineOffMin: 65,
      engineOnMin: 5, // the existing column is untouched
    });
    // 510 s at HF is 8 minutes, floored like every other duration in §9.
    expect(report.stops![2]).toMatchObject({ engineOffAt: "13:57", engineOnAt: "14:06", engineOffMin: 8 });
    // The engine never came back inside these two stops.
    expect(report.stops![3]).toMatchObject({ engineOffAt: "14:18", engineOnAt: null, engineOffMin: 3 });
    expect(report.stops![4]).toMatchObject({ engineOffAt: "14:28", engineOnAt: null, engineOffMin: 43 });
  });

  test("an unknown-stop finding carries the engine kind, its off minutes and the suffixed text", () => {
    // The fixture raises none (§3), so both readings are proven on the synthetic
    // day the stopIndex test uses: five minutes at nowhere, once switched off and
    // once idling.
    const T = bkk("2026-09-03", "12:00:00");
    const nowhere = lerp(HF, HFVILLE, 0.5);
    const day = (nowhereVolts: number): Point[] => [
      ...parked(T, HF, 11, 60, { voltage: 12.7 }),
      pt(T + 660, lerp(HF, HFVILLE, 0.25), { speed: 40, voltage: 13.8 }),
      ...parked(T + 720, nowhere, 6, 60, { voltage: nowhereVolts }),
      pt(T + 1140, lerp(HF, HFVILLE, 0.75), { speed: 55, voltage: 13.8 }),
      ...parked(T + 1200, HFVILLE, 11, 60, { voltage: 12.7 }),
    ];
    const findingFor = (volts: number) => {
      const points = day(volts);
      const r = build(summarizeDay("2026-09-03", points, SITES, RULES), { points });
      const f = r.findings.find((x) => x.kind === "unknown-stop");
      expect(f).toBeDefined();
      return f as Extract<ReportFinding, { kind: "unknown-stop" }>;
    };

    const idling = findingFor(13.8);
    expect(idling.engine).toBe("running");
    expect(idling.engineOffMin).toBe(0);
    expect(idling.text.th).toBe("จอดที่ไม่รู้จัก 5 นาที (12:12–12:17) · เครื่องติด");
    expect(idling.text.en).toBe("Unknown stop 5 min (12:12–12:17), engine running");

    const switchedOff = findingFor(12.7);
    expect(switchedOff.engine).toBe("parked");
    expect(switchedOff.engineOffMin).toBe(5);
    expect(switchedOff.text.th).toBe("จอดที่ไม่รู้จัก 5 นาที (12:12–12:17) · ดับเครื่อง");
    expect(switchedOff.text.en).toBe("Unknown stop 5 min (12:12–12:17), engine off");
  });
});

describe("summaryOnly", () => {
  test("drops trips, stops, legs and path and keeps findings (§9)", () => {
    const slim = summaryOnly(build(emptySummary("2026-09-05")));
    expect(slim).not.toHaveProperty("trips");
    expect(slim).not.toHaveProperty("stops");
    expect(slim).not.toHaveProperty("legs");
    expect(slim).not.toHaveProperty("path");
    expect(slim).toHaveProperty("findings");
    expect(slim).toHaveProperty("summary");
    expect(slim).toHaveProperty("device");
    expect(slim).toHaveProperty("dataQuality");
  });
});
