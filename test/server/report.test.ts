// The DayReport boundary (docs/CONTRACTS.md §9).

import { describe, expect, test } from "bun:test";
import type { DaySummary, Point } from "../../src/domain/types.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import { unknownStopText, detourText, outsideHoursText } from "../../src/shared/labels.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { bangkokStamp, buildDayReport, hhmm, km1, minutesOf, ratio2, summaryOnly } from "../../src/server/report.ts";

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
    expect(minutesOf(510)).toBe(8);
    expect(minutesOf(6870)).toBe(114);
    expect(minutesOf(59)).toBe(0);
    expect(km1(15.710809232468103)).toBe(15.7);
    expect(ratio2(7.4 / 4.9)).toBe(1.51);
  });
});

describe("the finding sentences", () => {
  test("read as §9 spells them", () => {
    expect(unknownStopText(4, "14:18", "14:22")).toEqual({
      th: "จอดที่ไม่รู้จัก 4 นาที (14:18–14:22)",
      en: "Unknown stop 4 min (14:18–14:22)",
    });
    expect(detourText({ th: "โรงแรม HF", en: "HF Hotel" }, { th: "HF Ville", en: "HF Ville" }, 7.4, 4.9, 1.51).en).toBe(
      "Detour HF Hotel → HF Ville 7.4 km (normally 4.9 km, 1.51×)",
    );
    expect(outsideHoursText("08:12", "08:40", 3.1).th).toBe("วิ่งนอกเวลางาน 08:12–08:40 ระยะ 3.1 กม.");
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
