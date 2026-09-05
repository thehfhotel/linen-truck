// linen-truck — the background poll (docs/CONTRACTS.md §6).
//
// The tracker keeps roughly one day of history on the device and the platform
// serves it back; nothing here is a webhook, so the only way the audit gets data
// is this loop. Its three rules, in the order they matter:
//
//   1. IT NEVER THROWS. An unhandled rejection in a `setInterval` callback takes
//      the process down, and a truck app that dies at 03:00 because the platform
//      hiccuped is worse than one that logs `poll fail` and tries again in ten
//      minutes. Every cycle is wrapped, and the failure is written to `poll_log`
//      so /healthz and the day page can say the data is stale.
//   2. IT NEVER OVERLAPS. One in-flight flag. A slow platform must not stack
//      cycles until they collide on the same INSERT.
//   3. THE WINDOW OVERLAPS ON PURPOSE. 48 hours re-fetched every 10 minutes, into
//      `INSERT OR IGNORE` — that is what closes a multi-hour outage without any
//      cursor state to get wrong.
//   4. ONE CALL DEFINES THE POLL. `getTrack` + `insertPoints` ARE the archive; the
//      device line, the OBD table and the daily-mileage table are extras the
//      report degrades gracefully without. So the extras each carry their own
//      try/catch and a failure there is a `poll warn` line — it must never mark
//      the poll failed, because a page that says "the data is stale" when only an
//      empty OBD table is missing trains the owner to ignore the warning.
//   5. A DEAD PLATFORM IS NOT HAMMERED. Consecutive `getTrack` failures back the
//      loop off exponentially to a 30-minute ceiling; one success clears it.
//
// `getMileageEveryDay` runs at most once an hour: it is a 60-day answer that only
// moves once a day, and asking for it every cycle would be 144 identical calls.

import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { sinotrackConfigured } from "./config.ts";
import {
  deviceStatusFromRaw,
  insertObdRows,
  insertPoints,
  logPoll,
  pointRowFromRaw,
  upsertDailyMileage,
  upsertDeviceStatus,
  type ObdRow,
  type PointRow,
} from "./db.ts";
import { createSinotrackClient, SinotrackError, type SinotrackClient, type SinotrackRow } from "./sinotrack.ts";

/** In-memory, read by /healthz (§6). */
export interface PollerStatus {
  configured: boolean;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastSeen: number | null;
  lastNew: number | null;
}

export interface Poller {
  status(): PollerStatus;
  /** One cycle, for tests and for the boot kick. Never rejects. */
  runOnce(): Promise<void>;
  stop(): void;
}

export interface PollerDeps {
  config: Config;
  /** Epoch MILLISECONDS, like `Date.now()`. */
  nowMs: () => number;
  client?: SinotrackClient;
  fetch?: typeof fetch;
}

/** Boot kick delay (§6): late enough that the HTTP listener is already up. */
export const START_DELAY_MS = 5_000;
/** `getMileageEveryDay` cadence. */
export const MILEAGE_INTERVAL_MS = 60 * 60_000;
/** How far back the daily-mileage call reaches (§6). */
export const MILEAGE_WINDOW_DAYS = 60;
/** The ceiling on the `getTrack` backoff — half an hour, never longer. */
export const MAX_BACKOFF_MS = 30 * 60_000;

// ── raw-row helpers ─────────────────────────────────────────────────────────

const int = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * `Proc_GetOBD` rows. The field selector asks for `strOBD`; the timestamp column
 * keeps the platform's usual `nTime` name. A row without a usable timestamp is
 * dropped rather than stored under 0, which would collide on the primary key.
 */
export function obdRowsFrom(teid: string, rows: readonly SinotrackRow[]): ObdRow[] {
  const out: ObdRow[] = [];
  for (const row of rows) {
    const t = int(row.nTime);
    if (t === null || t <= 0) continue;
    const obd = typeof row.strOBD === "string" && row.strOBD !== "" ? row.strOBD : JSON.stringify(row);
    out.push({ teid, t, obd });
  }
  return out;
}

/** `20260905`, `2026-09-05`, `2026/09/05` and `2026-09-05 00:00:00` all → `2026-09-05`. */
export function normaliseYmd(value: string): string | null {
  const text = value.trim();
  let m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export interface MileageDay {
  ymd: string;
  mileageM: number;
}

/**
 * `Proc_GetMileageEveryDay` rows. The platform's column names for this call are
 * not pinned by a captured fixture, so every plausible spelling of "the day" and
 * "the metres" is accepted and anything unrecognised is skipped — a poll must not
 * fail over an optional table.
 */
export function mileageDaysFrom(rows: readonly SinotrackRow[]): MileageDay[] {
  const out: MileageDay[] = [];
  for (const row of rows) {
    const rawDay = row.strDate ?? row.nDate ?? row.strDay ?? row.strTime ?? row.nTime;
    const rawMileage = row.nMileage ?? row.dbMileage ?? row.nDayMileage;
    if (typeof rawDay !== "string" || rawMileage === undefined) continue;
    const ymd = normaliseYmd(rawDay);
    const mileageM = int(rawMileage);
    if (ymd === null || mileageM === null) continue;
    out.push({ ymd, mileageM });
  }
  return out;
}

// ── the loop ────────────────────────────────────────────────────────────────

/** The bare failure text — `SinotrackError` already carries its proc separately. */
const reason = (err: unknown): string =>
  err instanceof SinotrackError ? err.reason : err instanceof Error ? err.message : String(err);

/** The proc a failure belongs to, for the log line. */
const procOf = (err: unknown, fallback: string): string => (err instanceof SinotrackError ? err.proc : fallback);

/**
 * What /healthz is allowed to say about a failure (§4, §7).
 *
 * `status.lastError` is published unauthenticated on `/healthz`, so it may never
 * carry raw exception text: a stack, a filesystem path or a rendered URL is free
 * reconnaissance. A `SinotrackError` is ours — `<proc>: <short reason>`, a bounded
 * one-line string — and anything else collapses to the fixed word `internal`. The
 * FULL text still goes to `poll_log` and to stderr, which are behind Access and
 * behind SSH respectively.
 */
export function publicPollError(err: unknown): string {
  if (!(err instanceof SinotrackError)) return "internal";
  const short = err.reason.replace(/\s+/g, " ").trim().slice(0, 120);
  return short === "" ? err.proc : `${err.proc}: ${short}`;
}

/**
 * How long to wait after `n` consecutive `getTrack` failures: one poll interval,
 * then doubling, capped at `MAX_BACKOFF_MS`. `n = 0` (or a success) means the
 * normal cadence, so a healthy poller never waits on this at all.
 */
export function backoffMs(consecutiveFailures: number, intervalMs: number): number {
  if (consecutiveFailures <= 0) return 0;
  const grown = intervalMs * 2 ** (consecutiveFailures - 1);
  return Number.isFinite(grown) ? Math.min(grown, MAX_BACKOFF_MS) : MAX_BACKOFF_MS;
}

export function createPoller(db: Database, deps: PollerDeps): Poller {
  const config = deps.config;
  const configured = sinotrackConfigured(config);

  const status: PollerStatus = {
    configured,
    lastAt: null,
    lastOk: null,
    lastError: null,
    lastSeen: null,
    lastNew: null,
  };

  const client: SinotrackClient | null = configured
    ? (deps.client ??
      createSinotrackClient({
        server: config.sinotrackServer,
        user: config.sinotrackUser,
        password: config.sinotrackPassword,
        fetch: deps.fetch,
      }))
    : null;

  let inFlight = false;
  let lastMileageAtMs = 0;
  /** Consecutive `getTrack`/`insertPoints` failures — the backoff's only state. */
  let trackFailures = 0;
  /** Epoch ms before which no cycle may talk to the platform (rule 5). */
  let nextAttemptMs = 0;

  /**
   * One SECONDARY call. Its failure is a warning, never a failed poll (rule 4):
   * `poll warn <proc>: <reason>`, no `lastOk = false`, no `poll_log` row.
   */
  async function attempt(fallbackProc: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      console.warn(`poll warn ${procOf(err, fallbackProc)}: ${reason(err)}`);
    }
  }

  async function cycle(): Promise<void> {
    if (client === null || inFlight) return;
    const startedMs = deps.nowMs();
    if (startedMs < nextAttemptMs) {
      console.warn(
        `poll skip: backing off ${Math.round((nextAttemptMs - startedMs) / 1000)}s after ${trackFailures} consecutive getTrack failures`,
      );
      return;
    }
    inFlight = true;
    const nowS = Math.floor(startedMs / 1000);
    const teid = config.sinotrackTeid;
    const fromS = nowS - config.pollWindowHours * 3600;

    let seen = 0;
    let inserted = 0;
    let archived = false;
    try {
      // ── the poll itself: the raw archive, and nothing else ──────────────────
      try {
        const track = await client.getTrack(teid, fromS, nowS);
        const rows: PointRow[] = [];
        for (const raw of track) {
          const row = pointRowFromRaw(teid, raw);
          if (row !== null) rows.push(row);
        }
        const result = insertPoints(db, rows, nowS);
        seen = result.seen;
        inserted = result.inserted;
        archived = true;

        trackFailures = 0;
        nextAttemptMs = 0;
        status.lastAt = nowS;
        status.lastOk = true;
        status.lastError = null;
        status.lastSeen = seen;
        status.lastNew = inserted;
        logPoll(db, { at: nowS, ok: true, pointsSeen: seen, pointsNew: inserted, error: null });
        console.log(`poll ok seen=${seen} new=${inserted} ms=${deps.nowMs() - startedMs}`);
      } catch (err) {
        const proc = procOf(err, "poll");
        const message = reason(err);
        trackFailures += 1;
        nextAttemptMs = startedMs + backoffMs(trackFailures, config.pollIntervalSeconds * 1000);
        status.lastAt = nowS;
        status.lastOk = false;
        // /healthz publishes this string unauthenticated — never the raw text.
        status.lastError = publicPollError(err);
        // The counts stay at whatever the failed cycle managed, so a partial poll is
        // still visible rather than being reported as zero.
        status.lastSeen = seen;
        status.lastNew = inserted;
        try {
          logPoll(db, { at: nowS, ok: false, pointsSeen: seen, pointsNew: inserted, error: `${proc}: ${message}` });
        } catch (logErr) {
          console.error(`poll fail (and poll_log write failed): ${reason(logErr)}`);
        }
        console.error(
          `poll fail ${proc}: ${message} (retry in ${Math.round((nextAttemptMs - startedMs) / 1000)}s)`,
        );
      }

      // ── the extras. Skipped entirely when the platform just refused the poll:
      //    three more calls into a dead API buy nothing but log noise. ─────────
      if (archived) {
        await attempt("Proc_GetLastPosition", async () => {
          const position = await client.getLastPosition(config.sinotrackUser);
          const first = position[0];
          if (first) upsertDeviceStatus(db, deviceStatusFromRaw(teid, first, nowS));
        });

        await attempt("Proc_GetOBD", async () => {
          const obd = await client.getObd(teid, fromS, nowS);
          insertObdRows(db, obdRowsFrom(teid, obd), nowS);
        });

        if (startedMs - lastMileageAtMs >= MILEAGE_INTERVAL_MS) {
          // Stamped BEFORE the call: a platform that always fails this one must
          // still only be asked once an hour.
          lastMileageAtMs = startedMs;
          await attempt("Proc_GetMileageEveryDay", async () => {
            const mileage = await client.getMileageEveryDay(teid, nowS - MILEAGE_WINDOW_DAYS * 86400, nowS);
            for (const day of mileageDaysFrom(mileage)) upsertDailyMileage(db, teid, day.ymd, day.mileageM, nowS);
          });
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    status: () => ({ ...status }),
    runOnce: cycle,
    // `createPoller` never arms a timer — `startPoller` does, and a test drives
    // `runOnce()` directly, so nothing is left ticking under `bun test`.
    stop() {},
  };
}

let loggedDormant = false;

/**
 * Creates the poller and arms its timers (§6). Returns it so the caller can read
 * `status()` for /healthz and `stop()` on SIGTERM.
 */
export function startPoller(db: Database, deps: PollerDeps): Poller {
  const poller = createPoller(db, deps);
  if (!sinotrackConfigured(deps.config)) {
    if (!loggedDormant) {
      loggedDormant = true;
      console.warn("[poller] SINOTRACK_USER/SINOTRACK_PASSWORD are unset - the poller is dormant and no data will arrive");
    }
    return poller;
  }

  const kick = setTimeout(() => {
    void poller.runOnce();
  }, START_DELAY_MS);
  const timer = setInterval(() => {
    void poller.runOnce();
  }, deps.config.pollIntervalSeconds * 1000);
  // Neither timer should hold the process open on its own.
  kick.unref?.();
  timer.unref?.();

  const stop = poller.stop;
  return {
    ...poller,
    stop() {
      clearTimeout(kick);
      clearInterval(timer);
      stop();
    },
  };
}

/** Test-only handle — same shape as every sibling module's `_internal`. */
export const _internal = {
  resetWarningsForTests(): void {
    loggedDormant = false;
  },
};
