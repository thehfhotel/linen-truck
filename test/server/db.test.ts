// The SQLite layer (docs/CONTRACTS.md §5).

import { describe, expect, test } from "bun:test";
import {
  bangkokDaySeconds,
  deviceStatusFromRaw,
  getDeviceStatus,
  insertObdRows,
  insertPoints,
  latestPoll,
  logPoll,
  openDatabase,
  pointRowFromRaw,
  pointsForDay,
  upsertDailyMileage,
  dailyMileage,
  upsertDeviceStatus,
  voltageFromOther,
  type PointRow,
} from "../../src/server/db.ts";
import { importRawRows } from "../../scripts/import.ts";
import raw from "../fixtures/2026-09-05.raw.json";

const TEID = "1000000001";

const point = (t: number, over: Partial<PointRow> = {}): PointRow => ({
  teid: TEID,
  t,
  lat: 9.14,
  lon: 99.33,
  speed: 0,
  direction: null,
  mileageM: null,
  carState: null,
  teState: null,
  alarmState: null,
  voltage: null,
  other: null,
  ...over,
});

describe("voltageFromOther", () => {
  test("reads Voltages= out of strOther", () => {
    expect(voltageFromOther("Voltages=13.2;RecvTime=1788585018")).toBe(13.2);
    expect(voltageFromOther("RecvTime=1788585019;Voltages=12.6")).toBe(12.6);
  });

  test("a missing voltage is null, never 0 — 0 would read as 'engine off'", () => {
    expect(voltageFromOther("RecvTime=1788585019")).toBeNull();
    expect(voltageFromOther(null)).toBeNull();
    expect(voltageFromOther(undefined)).toBeNull();
  });
});

describe("pointRowFromRaw", () => {
  test("maps the platform's field spellings", () => {
    const row = pointRowFromRaw(TEID, raw[0] as Record<string, unknown>);
    expect(row).toEqual(
      point(1788585074, {
        lat: 9.1479117,
        lon: 99.3356417,
        speed: 18,
        direction: 79,
        mileageM: 0,
        carState: 0,
        teState: 6569992,
        alarmState: 0,
        voltage: 13.2,
        other: "Voltages=13.2;RecvTime=1788585018",
      }),
    );
  });

  test("the caller's teid wins over the row's own strTEID", () => {
    expect(pointRowFromRaw("other", { nTime: "1", dbLat: "9", dbLon: "99", strTEID: TEID })?.teid).toBe("other");
  });

  test("a row with no usable time or position is dropped", () => {
    expect(pointRowFromRaw(TEID, { dbLat: "9", dbLon: "99" })).toBeNull();
    expect(pointRowFromRaw(TEID, { nTime: "0", dbLat: "9", dbLon: "99" })).toBeNull();
    expect(pointRowFromRaw(TEID, { nTime: "1", dbLon: "99" })).toBeNull();
  });
});

describe("insertPoints", () => {
  test("first observation of a second wins, and a re-import inserts nothing", () => {
    const db = openDatabase(":memory:");
    expect(insertPoints(db, [point(100, { speed: 40 }), point(100, { speed: 9 })], 1)).toEqual({ seen: 2, inserted: 1 });
    expect(pointsForDay(db, TEID, "1970-01-01")[0]?.speed).toBe(40);
    expect(insertPoints(db, [point(100, { speed: 9 })], 2)).toEqual({ seen: 1, inserted: 0 });
  });

  test("the archived day imports 82 of its 84 rows (two duplicate seconds)", () => {
    const db = openDatabase(":memory:");
    expect(importRawRows(db, TEID, raw, 1)).toEqual({ seen: 84, inserted: 82 });
    expect(importRawRows(db, TEID, raw, 2)).toEqual({ seen: 84, inserted: 0 });
    expect(pointsForDay(db, TEID, "2026-09-05")).toHaveLength(82);
  });
});

describe("pointsForDay", () => {
  test("is the Bangkok day, half-open, and excludes the neighbours", () => {
    const { from, to } = bangkokDaySeconds("2026-09-05");
    const db = openDatabase(":memory:");
    insertPoints(db, [point(from - 1), point(from), point(to - 1), point(to)], 1);
    expect(pointsForDay(db, TEID, "2026-09-05").map((p) => p.t)).toEqual([from, to - 1]);
  });

  test("a Bangkok day starts at 17:00 UTC the day before", () => {
    expect(new Date(bangkokDaySeconds("2026-09-05").from * 1000).toISOString()).toBe("2026-09-04T17:00:00.000Z");
  });
});

describe("device_status, daily_mileage, obd_rows", () => {
  test("device status round-trips through the last-position row", () => {
    const db = openDatabase(":memory:");
    upsertDeviceStatus(
      db,
      deviceStatusFromRaw(
        TEID,
        {
          nTime: "1788597467",
          dbLat: "9.120565",
          dbLon: "99.3521117",
          nSpeed: "0",
          nMileage: "18613",
          strOther: "Voltages=12.6",
          nParkTime: "1788593295",
          nRunTime: "1788596895",
        },
        1788597500,
      ),
    );
    expect(getDeviceStatus(db, TEID)).toEqual({
      teid: TEID,
      t: 1788597467,
      lat: 9.120565,
      lon: 99.3521117,
      speed: 0,
      mileageM: 18613,
      voltage: 12.6,
      parkSince: 1788593295,
      runSince: 1788596895,
      fetchedAt: 1788597500,
    });
  });

  test("device status is one row per device, overwritten in place", () => {
    const db = openDatabase(":memory:");
    upsertDeviceStatus(db, deviceStatusFromRaw(TEID, { nTime: "1" }, 1));
    upsertDeviceStatus(db, deviceStatusFromRaw(TEID, { nTime: "2" }, 2));
    expect(getDeviceStatus(db, TEID)?.t).toBe(2);
  });

  test("daily mileage is last-write-wins per (teid, ymd)", () => {
    const db = openDatabase(":memory:");
    upsertDailyMileage(db, TEID, "2026-09-05", 1000, 1);
    upsertDailyMileage(db, TEID, "2026-09-05", 18613, 2);
    expect(dailyMileage(db, TEID, "2026-09-05")).toBe(18613);
    expect(dailyMileage(db, TEID, "2026-09-04")).toBeNull();
  });

  test("obd rows are INSERT OR IGNORE on (teid, t)", () => {
    const db = openDatabase(":memory:");
    expect(insertObdRows(db, [{ teid: TEID, t: 1, obd: "a" }, { teid: TEID, t: 1, obd: "b" }], 1)).toEqual({
      seen: 2,
      inserted: 1,
    });
  });
});

describe("poll_log", () => {
  test("latestPoll returns the newest entry", () => {
    const db = openDatabase(":memory:");
    expect(latestPoll(db)).toBeNull();
    logPoll(db, { at: 1, ok: true, pointsSeen: 10, pointsNew: 3, error: null });
    logPoll(db, { at: 2, ok: false, pointsSeen: 0, pointsNew: 0, error: "Proc_GetTrack: HTTP 502" });
    expect(latestPoll(db)).toEqual({ at: 2, ok: false, pointsSeen: 0, pointsNew: 0, error: "Proc_GetTrack: HTTP 502" });
  });

  test("it is the one bounded table", () => {
    const db = openDatabase(":memory:");
    for (let i = 0; i < 2010; i++) logPoll(db, { at: i, ok: true, pointsSeen: 0, pointsNew: 0, error: null });
    const count = db.query("SELECT COUNT(*) AS c FROM poll_log").get() as { c: number };
    expect(count.c).toBe(2000);
    expect(latestPoll(db)?.at).toBe(2009);
  });
});
