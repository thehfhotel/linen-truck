// linen-truck — the raw-archive importer (docs/CONTRACTS.md §10).
//
//   bun scripts/import.ts test/fixtures/2026-09-05.raw.json [more.json …]
//
// Seeds `points` from files of RAW PLATFORM ROWS — the exact objects
// `Proc_GetTrack` returns (`nTime`, `dbLat`, `dbLon`, `nSpeed`, `nDirection`,
// `nMileage`, `nCarState`, `nTEState`, `nAlarmState`, `strOther`) — which is how
// the 2026-09-05 day archived on the owner's Mac gets into a fresh database.
//
// `importRawRows` is exported and is the SAME code path the poller uses
// (`pointRowFromRaw` + `insertPoints`), so a test that seeds a database through
// this function is testing the real ingest, not a test-only shortcut.
//
// Idempotent by construction: `INSERT OR IGNORE` on `(teid, t)` means re-running
// the import over the same file inserts nothing and reports `new=0`.

import type { Database } from "bun:sqlite";
import { insertPoints, openDatabase, pointRowFromRaw, type InsertResult, type PointRow } from "../src/server/db.ts";
import { loadConfig } from "../src/server/config.ts";

/** Rows that are not objects, or carry no usable time/position, are skipped. */
export function pointRowsFromRaw(teid: string, raw: unknown): PointRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PointRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = pointRowFromRaw(teid, entry as Record<string, unknown>);
    if (row !== null) out.push(row);
  }
  return out;
}

/** Parse → map → `INSERT OR IGNORE`. The one ingest path (see the header). */
export function importRawRows(db: Database, teid: string, raw: unknown, fetchedAt: number): InsertResult {
  return insertPoints(db, pointRowsFromRaw(teid, raw), fetchedAt);
}

export async function importFiles(db: Database, teid: string, paths: readonly string[], fetchedAt: number): Promise<InsertResult> {
  let seen = 0;
  let inserted = 0;
  for (const path of paths) {
    const raw = (await Bun.file(path).json()) as unknown;
    const result = importRawRows(db, teid, raw, fetchedAt);
    seen += result.seen;
    inserted += result.inserted;
    console.log(`[import] ${path}: seen=${result.seen} new=${result.inserted}`);
  }
  return { seen, inserted };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("[import] usage: bun scripts/import.ts <file.json …>");
    process.exit(1);
  }
  const config = loadConfig(process.env);
  const teid = config.sinotrackTeid;
  if (teid === "") {
    console.error("[import] SINOTRACK_TEID (or SINOTRACK_USER) must be set — points are stored per device id");
    process.exit(1);
  }
  const db = openDatabase(config.dbPath);
  try {
    const total = await importFiles(db, teid, paths, Math.floor(Date.now() / 1000));
    console.log(`[import] done: seen=${total.seen} new=${total.inserted} into ${config.dbPath}`);
  } catch (err) {
    console.error(`[import] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
