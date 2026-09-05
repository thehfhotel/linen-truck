// The in-process nightly backup (docs/CONTRACTS.md §1 BACKUP_TIME, §10).
//
// Nothing here waits on a timer: `nextFireMs` is pure and `runNow()` is the same
// code path the timer fires, so the schedule and the backup are tested without a
// single second of sleeping.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP, runBackup } from "../../scripts/backup.ts";
import { nextFireMs, startBackupScheduler } from "../../src/server/backupScheduler.ts";
import { loadConfig, type Config } from "../../src/server/config.ts";
import { openDatabase } from "../../src/server/db.ts";

const bkk = (iso: string): number => Date.parse(iso);
const made: string[] = [];

/** A throwaway DATA_DIR with a real (migrated) database in it. */
function tempConfig(extra: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "truck-backup-"));
  made.push(dir);
  const config = loadConfig({ DATA_DIR: dir, ...extra });
  openDatabase(config.dbPath).close();
  mkdirSync(config.backupDir, { recursive: true });
  return config;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("nextFireMs", () => {
  test("today's 02:35 Bangkok when it is still ahead, tomorrow's once it is past", () => {
    expect(nextFireMs(bkk("2026-09-05T01:00:00+07:00"), "02:35")).toBe(bkk("2026-09-05T02:35:00+07:00"));
    expect(nextFireMs(bkk("2026-09-05T03:00:00+07:00"), "02:35")).toBe(bkk("2026-09-06T02:35:00+07:00"));
    // Bangkok, not UTC: 19:00 UTC on the 5th is already 02:00 on the 6th here, so
    // the fire is 35 minutes away — not 24 h and 35 minutes.
    expect(nextFireMs(bkk("2026-09-05T19:00:00Z"), "02:35")).toBe(bkk("2026-09-06T02:35:00+07:00"));
  });

  test("the fire instant itself schedules the NEXT one, so a run cannot re-fire", () => {
    const at = bkk("2026-09-05T02:35:00+07:00");
    expect(nextFireMs(at, "02:35")).toBe(bkk("2026-09-06T02:35:00+07:00"));
    expect(nextFireMs(at + 1, "02:35")).toBe(bkk("2026-09-06T02:35:00+07:00"));
    expect(nextFireMs(at - 1, "02:35")).toBe(at);
  });

  test("any HH:MM, over a month boundary too", () => {
    expect(nextFireMs(bkk("2026-09-30T23:59:00+07:00"), "00:05")).toBe(bkk("2026-10-01T00:05:00+07:00"));
    expect(nextFireMs(bkk("2026-09-05T12:00:00+07:00"), "23:59")).toBe(bkk("2026-09-05T23:59:00+07:00"));
  });
});

describe("startBackupScheduler", () => {
  test("an empty BACKUP_TIME arms nothing", () => {
    const scheduler = startBackupScheduler({ config: tempConfig({ BACKUP_TIME: "" }), nowMs: () => Date.now() });
    expect(scheduler.nextAtMs()).toBeNull();
    scheduler.runNow(); // a no-op, and it must not throw
    scheduler.stop();
  });

  test("a configured one points at the next Bangkok 02:35 and stops cleanly", () => {
    const nowMs = bkk("2026-09-05T15:02:00+07:00");
    const scheduler = startBackupScheduler({ config: tempConfig(), nowMs: () => nowMs, run: () => "/dev/null" });
    expect(scheduler.nextAtMs()).toBe(bkk("2026-09-06T02:35:00+07:00"));
    scheduler.stop();
    expect(scheduler.nextAtMs()).toBeNull();
  });

  test("a run writes a snapshot and prunes to 14 (§1)", () => {
    const config = tempConfig();
    // 20 nights already on the volume, oldest first by name.
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(config.backupDir, `truck-202608${String(10 + i)}-023500.db`), "old");
    }
    const nowMs = bkk("2026-09-05T02:35:00+07:00");
    const scheduler = startBackupScheduler({ config, nowMs: () => nowMs });

    scheduler.runNow();
    scheduler.stop();

    const files = readdirSync(config.backupDir).sort();
    expect(files).toHaveLength(KEEP);
    // The new snapshot survives, the six oldest nights are gone.
    expect(files).toContain("truck-20260905-023500.db");
    expect(files).not.toContain("truck-20260810-023500.db");
    expect(files[0]).toBe("truck-20260817-023500.db");
    expect(existsSync(join(config.backupDir, "truck-20260905-023500.db"))).toBe(true);
  });

  test("a failing backup is a log line, never a thrown error", () => {
    const scheduler = startBackupScheduler({
      config: tempConfig(),
      nowMs: () => Date.now(),
      run: () => {
        throw new Error("disk full");
      },
    });
    expect(() => scheduler.runNow()).not.toThrow();
    scheduler.stop();
  });

  test("runBackup refuses a DATA_DIR with no database, rather than writing an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "truck-backup-"));
    made.push(dir);
    expect(() => runBackup(new Date(), loadConfig({ DATA_DIR: dir }))).toThrow(/no database/);
  });
});
