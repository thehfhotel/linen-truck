// linen-truck — the SQLite layer (docs/CONTRACTS.md §5).
//
// The ONLY file in the repo that writes SQL, and the only one that maps the
// platform's `nTime`/`dbLat` vocabulary onto rows the rest of the app reads.
//
// Three invariants everything else leans on:
//
//   1. POINTS ARE APPEND-ONLY AND FIRST-OBSERVATION-WINS. Every insert is
//      `INSERT OR IGNORE` on `(teid, t)`. A poll window overlaps the previous one
//      by design (48 h window, 10 min interval), so the same second arrives dozens
//      of times; re-writing it would let a later, degraded fix overwrite a good
//      one. Raw rows are kept forever — ~300 a day is ~2 MB a year.
//   2. TIME IS EPOCH SECONDS, everywhere, exactly as the platform sends it. The
//      Bangkok day is a QUERY concern: `pointsForDay` converts the ymd to a
//      half-open `[since, until)` second range through `shared/time.ts` and the
//      column itself never learns about zones.
//   3. `poll_log` IS BOUNDED. It is the only table that deletes: the newest 2000
//      rows stay, which is ~2 weeks at a 10-minute cadence.
//
// Every function takes the Database explicitly: tests open ":memory:" and get a
// fully migrated, isolated database with no globals to reset.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Point } from "../domain/types.ts";
import { bangkokDayBounds } from "../shared/time.ts";

// ── schema (§5, verbatim) ───────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE points (teid TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, speed INTEGER NOT NULL,
  direction INTEGER, mileage_m INTEGER, car_state INTEGER, te_state INTEGER, alarm_state INTEGER, voltage REAL, other TEXT,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, t)) WITHOUT ROWID;
CREATE TABLE device_status (teid TEXT PRIMARY KEY, t INTEGER, lat REAL, lon REAL, speed INTEGER, mileage_m INTEGER,
  voltage REAL, park_since INTEGER, run_since INTEGER, fetched_at INTEGER NOT NULL);
CREATE TABLE daily_mileage (teid TEXT NOT NULL, ymd TEXT NOT NULL, mileage_m INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, ymd));
CREATE TABLE obd_rows (teid TEXT NOT NULL, t INTEGER NOT NULL, obd TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, t));
CREATE TABLE poll_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, points_seen INTEGER, points_new INTEGER, error TEXT);
`;

/** Replays from the stored `PRAGMA user_version`; safe to call on every open. */
export function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current >= SCHEMA_VERSION) return;
  db.transaction(() => {
    if (current < 1) db.run(SCHEMA_V1);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

/**
 * Opens (creating if needed) the truck database and brings it up to schema.
 * Pass ":memory:" in tests for a throwaway, fully migrated database.
 */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // WAL keeps the poller's insert from blocking a manager's day page; NORMAL sync
  // is the usual WAL pairing (a crash can lose the last commit, not the file).
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

// ── the stored point row ────────────────────────────────────────────────────

/** One `points` row in app vocabulary. `t` is epoch SECONDS. */
export interface PointRow {
  teid: string;
  t: number;
  lat: number;
  lon: number;
  speed: number;
  direction: number | null;
  mileageM: number | null;
  carState: number | null;
  teState: number | null;
  alarmState: number | null;
  voltage: number | null;
  other: string | null;
}

const int = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const real = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * `Voltages=13.2;RecvTime=1788585018` → 13.2.
 *
 * Half the rows carry no `Voltages=` at all (the tracker only reports it when the
 * GSM/GPS pair is healthy), so a missing value is `null` and NEVER 0 — the domain
 * reads voltage to decide "engine on", and a fabricated 0 would read as "engine
 * off" for every gap.
 */
export function voltageFromOther(other: string | null | undefined): number | null {
  if (typeof other !== "string") return null;
  const m = /(?:^|;)\s*Voltages\s*=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(other);
  return m ? Number(m[1]) : null;
}

/**
 * A raw platform row (`Proc_GetTrack`, or an archived JSON file) → a `points`
 * row. Returns null when the row has no usable timestamp or position, which is
 * how a truncated archive file loses only its broken lines.
 *
 * NOTE the platform's own field spellings: `dbLat`/`dbLon` are strings, and the
 * whole record is strings even where it means a number.
 */
export function pointRowFromRaw(teid: string, raw: Record<string, unknown>): PointRow | null {
  const t = int(raw.nTime);
  const lat = real(raw.dbLat);
  const lon = real(raw.dbLon);
  if (t === null || t <= 0 || lat === null || lon === null) return null;
  const other = typeof raw.strOther === "string" ? raw.strOther : null;
  return {
    // A row may carry its own strTEID; the caller's teid wins so an archive
    // cannot smuggle points in under another device id.
    teid,
    t,
    lat,
    lon,
    speed: int(raw.nSpeed) ?? 0,
    direction: int(raw.nDirection),
    mileageM: int(raw.nMileage),
    carState: int(raw.nCarState),
    teState: int(raw.nTEState),
    alarmState: int(raw.nAlarmState),
    voltage: voltageFromOther(other),
    other,
  };
}

// ── points ──────────────────────────────────────────────────────────────────

export interface InsertResult {
  /** Rows offered. */
  seen: number;
  /** Rows that were not already stored. */
  inserted: number;
}

const INSERT_POINT = `
INSERT OR IGNORE INTO points
  (teid, t, lat, lon, speed, direction, mileage_m, car_state, te_state, alarm_state, voltage, other, fetched_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** `INSERT OR IGNORE` in one transaction. First observation of a second wins (§5). */
export function insertPoints(db: Database, rows: readonly PointRow[], fetchedAt: number): InsertResult {
  if (rows.length === 0) return { seen: 0, inserted: 0 };
  const stmt = db.query(INSERT_POINT);
  let inserted = 0;
  db.transaction(() => {
    for (const r of rows) {
      const result = stmt.run(
        r.teid,
        r.t,
        r.lat,
        r.lon,
        r.speed,
        r.direction,
        r.mileageM,
        r.carState,
        r.teState,
        r.alarmState,
        r.voltage,
        r.other,
        fetchedAt,
      );
      inserted += result.changes;
    }
  })();
  return { seen: rows.length, inserted };
}

interface PointDbRow {
  t: number;
  lat: number;
  lon: number;
  speed: number;
  voltage: number | null;
}

const toPoint = (r: PointDbRow): Point => ({
  t: r.t,
  lat: r.lat,
  lon: r.lon,
  speed: r.speed,
  voltage: r.voltage === null ? null : r.voltage,
});

/** Ordered `[fromS, toS)` — half-open, the same shape every range query has. */
export function pointsBetween(db: Database, teid: string, fromS: number, toS: number): Point[] {
  const rows = db
    .query("SELECT t, lat, lon, speed, voltage FROM points WHERE teid = ? AND t >= ? AND t < ? ORDER BY t ASC")
    .all(teid, Math.floor(fromS), Math.floor(toS)) as PointDbRow[];
  return rows.map(toPoint);
}

/** `[00:00, 24:00)` of the Bangkok calendar day `ymd` (§5, §3 rule 8). */
export function pointsForDay(db: Database, teid: string, ymd: string): Point[] {
  const { from, to } = bangkokDaySeconds(ymd);
  return pointsBetween(db, teid, from, to);
}

/** The Bangkok day as an epoch-second half-open range. */
export function bangkokDaySeconds(ymd: string): { from: number; to: number } {
  const { sinceIso, untilIso } = bangkokDayBounds(ymd);
  return { from: Math.floor(Date.parse(sinceIso) / 1000), to: Math.floor(Date.parse(untilIso) / 1000) };
}

// ── device status ───────────────────────────────────────────────────────────

export interface DeviceStatus {
  teid: string;
  t: number | null;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  mileageM: number | null;
  voltage: number | null;
  /** `nParkTime` — when the current park began, 0/absent while moving. */
  parkSince: number | null;
  /** `nRunTime` — when the current run began. */
  runSince: number | null;
  fetchedAt: number;
}

interface DeviceStatusDbRow {
  teid: string;
  t: number | null;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  mileage_m: number | null;
  voltage: number | null;
  park_since: number | null;
  run_since: number | null;
  fetched_at: number;
}

/** `Proc_GetLastPosition` row → the single-row `device_status` upsert value. */
export function deviceStatusFromRaw(teid: string, raw: Record<string, unknown>, fetchedAt: number): DeviceStatus {
  const other = typeof raw.strOther === "string" ? raw.strOther : null;
  return {
    teid,
    t: int(raw.nTime),
    lat: real(raw.dbLat),
    lon: real(raw.dbLon),
    speed: int(raw.nSpeed),
    mileageM: int(raw.nMileage),
    voltage: voltageFromOther(other),
    parkSince: int(raw.nParkTime),
    runSince: int(raw.nRunTime),
    fetchedAt,
  };
}

export function upsertDeviceStatus(db: Database, status: DeviceStatus): void {
  db.query(
    `INSERT INTO device_status (teid, t, lat, lon, speed, mileage_m, voltage, park_since, run_since, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(teid) DO UPDATE SET t = excluded.t, lat = excluded.lat, lon = excluded.lon, speed = excluded.speed,
       mileage_m = excluded.mileage_m, voltage = excluded.voltage, park_since = excluded.park_since,
       run_since = excluded.run_since, fetched_at = excluded.fetched_at`,
  ).run(
    status.teid,
    status.t,
    status.lat,
    status.lon,
    status.speed,
    status.mileageM,
    status.voltage,
    status.parkSince,
    status.runSince,
    status.fetchedAt,
  );
}

export function getDeviceStatus(db: Database, teid: string): DeviceStatus | null {
  const row = db.query("SELECT * FROM device_status WHERE teid = ?").get(teid) as DeviceStatusDbRow | null;
  if (!row) return null;
  return {
    teid: row.teid,
    t: row.t,
    lat: row.lat,
    lon: row.lon,
    speed: row.speed,
    mileageM: row.mileage_m,
    voltage: row.voltage,
    parkSince: row.park_since,
    runSince: row.run_since,
    fetchedAt: row.fetched_at,
  };
}

// ── daily mileage ───────────────────────────────────────────────────────────

/** Last write wins: the platform revises the current day as it goes. */
export function upsertDailyMileage(db: Database, teid: string, ymd: string, mileageM: number, fetchedAt: number): void {
  db.query(
    `INSERT INTO daily_mileage (teid, ymd, mileage_m, fetched_at) VALUES (?,?,?,?)
     ON CONFLICT(teid, ymd) DO UPDATE SET mileage_m = excluded.mileage_m, fetched_at = excluded.fetched_at`,
  ).run(teid, ymd, Math.trunc(mileageM), fetchedAt);
}

export function dailyMileage(db: Database, teid: string, ymd: string): number | null {
  const row = db.query("SELECT mileage_m FROM daily_mileage WHERE teid = ? AND ymd = ?").get(teid, ymd) as
    | { mileage_m: number }
    | null;
  return row ? row.mileage_m : null;
}

// ── OBD ─────────────────────────────────────────────────────────────────────

export interface ObdRow {
  teid: string;
  t: number;
  obd: string;
}

export function insertObdRows(db: Database, rows: readonly ObdRow[], fetchedAt: number): InsertResult {
  if (rows.length === 0) return { seen: 0, inserted: 0 };
  const stmt = db.query("INSERT OR IGNORE INTO obd_rows (teid, t, obd, fetched_at) VALUES (?,?,?,?)");
  let inserted = 0;
  db.transaction(() => {
    for (const r of rows) {
      inserted += stmt.run(r.teid, r.t, r.obd, fetchedAt).changes;
    }
  })();
  return { seen: rows.length, inserted };
}

// ── poll log ────────────────────────────────────────────────────────────────

export interface PollLogEntry {
  at: number;
  ok: boolean;
  pointsSeen: number | null;
  pointsNew: number | null;
  error: string | null;
}

/** The only table that deletes: the newest `POLL_LOG_KEEP` rows survive (§5). */
export const POLL_LOG_KEEP = 2000;

export function logPoll(db: Database, entry: PollLogEntry): void {
  db.query("INSERT INTO poll_log (at, ok, points_seen, points_new, error) VALUES (?,?,?,?,?)").run(
    entry.at,
    entry.ok ? 1 : 0,
    entry.pointsSeen,
    entry.pointsNew,
    entry.error,
  );
  db.query(`DELETE FROM poll_log WHERE id NOT IN (SELECT id FROM poll_log ORDER BY id DESC LIMIT ${POLL_LOG_KEEP})`).run();
}

interface PollLogDbRow {
  id: number;
  at: number;
  ok: number;
  points_seen: number | null;
  points_new: number | null;
  error: string | null;
}

export function latestPoll(db: Database): PollLogEntry | null {
  const row = db.query("SELECT * FROM poll_log ORDER BY id DESC LIMIT 1").get() as PollLogDbRow | null;
  if (!row) return null;
  return {
    at: row.at,
    ok: row.ok === 1,
    pointsSeen: row.points_seen,
    pointsNew: row.points_new,
    error: row.error,
  };
}
