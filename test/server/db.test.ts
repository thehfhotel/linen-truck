// The SQLite layer (docs/CONTRACTS.md §5).

import { describe, expect, test } from "bun:test";
import {
  bangkokDaySeconds,
  bumpTileUsage,
  clearMapSession,
  deleteTileMeta,
  deviceStatusFromRaw,
  getMapSession,
  getTileMeta,
  getTileUsage,
  getDeviceStatus,
  insertObdRows,
  insertPoints,
  latestPoll,
  logPoll,
  oldestTileMeta,
  openDatabase,
  pointRowFromRaw,
  pointsForDay,
  setMapSession,
  tileCacheBytes,
  upsertDailyMileage,
  dailyMileage,
  upsertDeviceStatus,
  upsertTileMeta,
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

describe("the tile proxy tables (schema v2)", () => {
  const meta = (x: number, over: Partial<Parameters<typeof upsertTileMeta>[1]> = {}) => ({
    z: 12,
    x,
    y: 5,
    fetchedAt: 1000 + x,
    expiresAt: 2000,
    etag: '"e"' as string | null,
    contentType: "image/png",
    bytes: 100,
    ...over,
  });

  test("migration v2 creates the three tables on a fresh database and on a v1 one", () => {
    const fresh = openDatabase(":memory:");
    const tables = (fresh.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["tile_cache", "tile_usage", "map_session"]));
    expect((fresh.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
  });

  test("a v1 database (points already there) upgrades without losing rows", async () => {
    const { Database } = await import("bun:sqlite");
    const { migrate } = await import("../../src/server/db.ts");
    const db = new Database(":memory:");
    db.run("CREATE TABLE points (teid TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, speed INTEGER NOT NULL, direction INTEGER, mileage_m INTEGER, car_state INTEGER, te_state INTEGER, alarm_state INTEGER, voltage REAL, other TEXT, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, t)) WITHOUT ROWID");
    db.run("CREATE TABLE device_status (teid TEXT PRIMARY KEY, t INTEGER, lat REAL, lon REAL, speed INTEGER, mileage_m INTEGER, voltage REAL, park_since INTEGER, run_since INTEGER, fetched_at INTEGER NOT NULL)");
    db.run("CREATE TABLE daily_mileage (teid TEXT NOT NULL, ymd TEXT NOT NULL, mileage_m INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, ymd))");
    db.run("CREATE TABLE obd_rows (teid TEXT NOT NULL, t INTEGER NOT NULL, obd TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, t))");
    db.run("CREATE TABLE poll_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, points_seen INTEGER, points_new INTEGER, error TEXT)");
    db.run("INSERT INTO points VALUES ('1000000001', 1788585018, 9.1, 99.3, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)");
    db.run("PRAGMA user_version = 1");
    migrate(db);
    expect((db.query("SELECT COUNT(*) AS c FROM points").get() as { c: number }).c).toBe(1);
    expect(getTileMeta(db, 1, 1, 1)).toBeNull();
    migrate(db); // idempotent
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
  });

  test("tile meta: upsert, read back, replace on the same z/x/y, delete", () => {
    const db = openDatabase(":memory:");
    expect(getTileMeta(db, 12, 1, 5)).toBeNull();
    upsertTileMeta(db, meta(1));
    expect(getTileMeta(db, 12, 1, 5)).toEqual(meta(1));
    upsertTileMeta(db, meta(1, { etag: null, bytes: 7, expiresAt: 3000 }));
    expect(getTileMeta(db, 12, 1, 5)).toEqual(meta(1, { etag: null, bytes: 7, expiresAt: 3000 }));
    deleteTileMeta(db, 12, 1, 5);
    expect(getTileMeta(db, 12, 1, 5)).toBeNull();
  });

  test("tileCacheBytes sums, oldestTileMeta orders by fetched_at", () => {
    const db = openDatabase(":memory:");
    expect(tileCacheBytes(db)).toBe(0);
    upsertTileMeta(db, meta(3, { bytes: 30 }));
    upsertTileMeta(db, meta(1, { bytes: 10 }));
    upsertTileMeta(db, meta(2, { bytes: 20 }));
    expect(tileCacheBytes(db)).toBe(60);
    expect(oldestTileMeta(db, 2).map((m) => m.x)).toEqual([1, 2]);
  });

  test("tile usage: zeros by default, additive per day", () => {
    const db = openDatabase(":memory:");
    expect(getTileUsage(db, "2026-09-05")).toEqual({ ymd: "2026-09-05", upstream: 0, hits: 0 });
    bumpTileUsage(db, "2026-09-05", { upstream: 1 });
    bumpTileUsage(db, "2026-09-05", { hits: 1 });
    bumpTileUsage(db, "2026-09-05", { upstream: 1, hits: 2 });
    bumpTileUsage(db, "2026-09-06", { hits: 1 });
    expect(getTileUsage(db, "2026-09-05")).toEqual({ ymd: "2026-09-05", upstream: 2, hits: 3 });
    expect(getTileUsage(db, "2026-09-06")).toEqual({ ymd: "2026-09-06", upstream: 0, hits: 1 });
  });

  test("map session: a single row, replaced, cleared", () => {
    const db = openDatabase(":memory:");
    expect(getMapSession(db)).toBeNull();
    setMapSession(db, "tok-1", 500, 100);
    setMapSession(db, "tok-2", 900, 200);
    expect(getMapSession(db)).toEqual({ token: "tok-2", expiresAt: 900, createdAt: 200 });
    expect((db.query("SELECT COUNT(*) AS c FROM map_session").get() as { c: number }).c).toBe(1);
    clearMapSession(db);
    expect(getMapSession(db)).toBeNull();
  });
});
