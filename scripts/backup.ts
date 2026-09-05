// linen-truck — the nightly SQLite backup (docs/CONTRACTS.md §10).
//
// Two callers, ONE implementation:
//   * `src/server/backupScheduler.ts`, nightly at BACKUP_TIME inside the running
//     container — the HF Ville box has no host timer we may install (§0);
//   * by hand, `docker exec truck bun scripts/backup.ts`, which runs this file's
//     `import.meta.main` branch (§10).
//
// `VACUUM INTO` — not a file copy — because the database runs in WAL mode: the
// .db file on its own is a torn snapshot without its -wal sibling, and a copy
// taken mid-write restores as a corrupt database. VACUUM INTO asks SQLite for a
// consistent, already-compacted copy while the app keeps serving.
//
// Prints the path it wrote and exits non-zero on any failure: silence must never
// be mistaken for a successful backup.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig, type Config } from "../src/server/config.ts";

/** How many backups stay on the volume (§1). */
export const KEEP = 14;

/** `20260902-031500`, Bangkok wall clock — the hotel reads these filenames. */
export function backupStamp(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

export const BACKUP_NAME_RE = /^truck-\d{8}-\d{6}\.db$/;

/** Deletes all but the newest `keep` backups. Returns what it removed. */
export function pruneBackups(dir: string, keep = KEEP): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => BACKUP_NAME_RE.test(name))
    .sort()
    .reverse();
  const doomed = files.slice(keep);
  for (const name of doomed) rmSync(join(dir, name), { force: true });
  return doomed;
}

/**
 * One consistent snapshot, then the prune. `config` is a parameter so the
 * scheduler hands in the config the server already loaded (and a test hands in a
 * temp directory) rather than this file reading `process.env` a second time.
 */
export function runBackup(now: Date = new Date(), config: Config = loadConfig(process.env)): string {
  if (!existsSync(config.dbPath)) throw new Error(`backup: no database at ${config.dbPath}`);
  mkdirSync(config.backupDir, { recursive: true });

  const target = join(config.backupDir, `truck-${backupStamp(now)}.db`);
  if (existsSync(target)) rmSync(target, { force: true }); // VACUUM INTO refuses an existing file

  const db = new Database(config.dbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  if (!existsSync(target)) throw new Error(`backup: VACUUM INTO produced nothing at ${target}`);

  const pruned = pruneBackups(config.backupDir);
  const size = statSync(target).size;
  console.log(`[backup] ${target} (${size} bytes)`);
  if (pruned.length > 0) console.log(`[backup] pruned ${pruned.length} older backup(s), keeping ${KEEP}`);
  return target;
}

if (import.meta.main) {
  try {
    runBackup();
  } catch (err) {
    console.error(`[backup] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
