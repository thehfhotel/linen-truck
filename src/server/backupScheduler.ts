// linen-truck — the nightly backup, in this process (docs/CONTRACTS.md §1, §10).
//
// WHY IN-PROCESS. Every other HF service backs up from a host timer. The HF Ville
// box gives us none: docker is the only passwordless sudo there, there is no
// systemd unit we may install and no crontab we own (§0). So the container that
// writes the database is also the thing that has to snapshot it — a scheduler
// that lives and dies with the app, and whose only trace is one log line a night.
//
// Three properties matter more than cleverness here:
//
//   1. IT NEVER THROWS. Same reason as the poller: a rejected timer callback
//      takes the process down, and losing the truck audit at 02:35 to protect a
//      backup would be an absurd trade. Every run is wrapped; a failure is a log
//      line and the next night is tried as usual.
//   2. IT REUSES `scripts/backup.ts`. `runBackup` is the VACUUM INTO + prune that
//      `docker exec truck bun scripts/backup.ts` runs by hand (§10). One
//      implementation, so the ad-hoc backup and the nightly one cannot drift.
//   3. IT RE-READS THE CLOCK EVERY NIGHT. The next fire is recomputed after each
//      run from `src/shared/time.ts` rather than by adding 24 h, so a long run, a
//      suspended host or a future zone-rule change cannot walk the schedule off
//      02:35 an hour at a time.

import { runBackup } from "../../scripts/backup.ts";
import { parseHhMm } from "../domain/clock.ts";
import { addBangkokDays, bangkokDay, bangkokDayBounds } from "../shared/time.ts";
import type { Config } from "./config.ts";

export interface BackupSchedulerDeps {
  config: Config;
  /** Epoch MILLISECONDS, like `Date.now()`. */
  nowMs: () => number;
  /** The backup itself; injected only by tests. */
  run?: (now: Date, config: Config) => string;
}

export interface BackupScheduler {
  /** Epoch ms of the next scheduled run; `null` when backups are off. */
  nextAtMs(): number | null;
  /** One run, right now. Never throws — for tests and for a manual kick. */
  runNow(): void;
  stop(): void;
}

/**
 * The next instant at which the Bangkok wall clock reads `hhmm` — today's if it
 * is still ahead, otherwise tomorrow's.
 *
 * The day's midnight comes from `src/shared/time.ts`, the repo's ONE zone source
 * (§0: never do wall-clock arithmetic by hand), so this is a real 02:35 in
 * Bangkok rather than a hard-coded +07:00 that a zone change would rot.
 */
export function nextFireMs(nowMs: number, hhmm: string): number {
  const minutes = parseHhMm(hhmm);
  const at = (ymd: string): number => Date.parse(bangkokDayBounds(ymd).sinceIso) + minutes * 60_000;
  const today = bangkokDay(new Date(nowMs).toISOString());
  const todayFire = at(today);
  return todayFire > nowMs ? todayFire : at(addBangkokDays(today, 1));
}

const OFF: BackupScheduler = { nextAtMs: () => null, runNow() {}, stop() {} };

/**
 * Arms the nightly backup. An empty `BACKUP_TIME` (§1) means "no backups in this
 * process" and returns a scheduler that does nothing at all.
 */
export function startBackupScheduler(deps: BackupSchedulerDeps): BackupScheduler {
  const time = deps.config.backupTime;
  if (time === "") {
    console.log("[backup] BACKUP_TIME is empty - no nightly backup runs in this process");
    return OFF;
  }

  const run = deps.run ?? runBackup;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAt: number | null = null;

  function runNow(): void {
    const startedMs = deps.nowMs();
    try {
      const path = run(new Date(startedMs), deps.config);
      console.log(`backup ok ${path} ms=${deps.nowMs() - startedMs}`);
    } catch (err) {
      console.error(`backup fail: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function schedule(): void {
    try {
      const at = nextFireMs(deps.nowMs(), time);
      nextAt = at;
      // At least a second: a same-millisecond reschedule must not spin.
      timer = setTimeout(tick, Math.max(at - deps.nowMs(), 1_000));
      // The backup must never be the reason the process stays alive.
      timer.unref?.();
    } catch (err) {
      nextAt = null;
      console.error(`backup fail (scheduling): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function tick(): void {
    runNow();
    schedule();
  }

  schedule();
  console.log(
    `[backup] nightly at ${time} Asia/Bangkok, keeping 14 - next ${nextAt === null ? "never" : new Date(nextAt).toISOString()}`,
  );

  return {
    nextAtMs: () => nextAt,
    runNow,
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      nextAt = null;
    },
  };
}
