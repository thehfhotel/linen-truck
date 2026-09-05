// The poll cycle (docs/CONTRACTS.md §6).
//
// `createPoller` arms no timer, so every test here drives `runOnce()` directly
// against a fake client — no network, no clock, nothing left ticking.

import { describe, expect, test } from "bun:test";
import { loadConfig, type Config, type Env } from "../../src/server/config.ts";
import { dailyMileage, getDeviceStatus, latestPoll, openDatabase, pointsForDay } from "../../src/server/db.ts";
import {
  backoffMs,
  createPoller,
  MAX_BACKOFF_MS,
  mileageDaysFrom,
  normaliseYmd,
  obdRowsFrom,
  publicPollError,
} from "../../src/server/poller.ts";
import { SinotrackError, type SinotrackClient, type SinotrackRow } from "../../src/server/sinotrack.ts";
import raw from "../fixtures/2026-09-05.raw.json";

const TEID = "1000000001";
/** 2026-09-05 15:02 Bangkok, in ms. */
const NOW_MS = 1788595367_000;

const config = (extra: Env = {}): Config =>
  loadConfig({ DATA_DIR: "./data", SINOTRACK_USER: TEID, SINOTRACK_PASSWORD: "unused", ...extra });

interface Stub {
  client: SinotrackClient;
  calls: string[];
}

function stubClient(over: Partial<Record<keyof SinotrackClient, () => Promise<SinotrackRow[]>>> = {}): Stub {
  const calls: string[] = [];
  const answer = (name: keyof SinotrackClient, fallback: SinotrackRow[]) => async () => {
    calls.push(name);
    const custom = over[name];
    return custom ? custom() : fallback;
  };
  const client = {
    call: answer("call", []),
    getLoginType: answer("getLoginType", [{ nType: "2" }]),
    getCarInfo: answer("getCarInfo", []),
    getLastPosition: answer("getLastPosition", [
      { nTime: "1788597467", dbLat: "9.120565", dbLon: "99.3521117", nSpeed: "0", strOther: "Voltages=12.6" },
    ]),
    getTrack: answer("getTrack", raw as unknown as SinotrackRow[]),
    getMileageEveryDay: answer("getMileageEveryDay", [{ strDate: "2026-09-05", nMileage: "18613" }]),
    getObd: answer("getObd", [{ nTime: "1788585074", strOBD: "rpm=800" }]),
  } as unknown as SinotrackClient;
  return { client, calls };
}

describe("one cycle", () => {
  test("stores points, device status, obd and — on the first cycle — daily mileage", async () => {
    const db = openDatabase(":memory:");
    const { client, calls } = stubClient();
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    await poller.runOnce();

    expect(calls).toEqual(["getTrack", "getLastPosition", "getObd", "getMileageEveryDay"]);
    expect(pointsForDay(db, TEID, "2026-09-05")).toHaveLength(82);
    expect(getDeviceStatus(db, TEID)?.voltage).toBe(12.6);
    expect(dailyMileage(db, TEID, "2026-09-05")).toBe(18613);
    expect(db.query("SELECT COUNT(*) AS c FROM obd_rows").get()).toEqual({ c: 1 });

    expect(poller.status()).toEqual({
      configured: true,
      lastAt: Math.floor(NOW_MS / 1000),
      lastOk: true,
      lastError: null,
      lastSeen: 84,
      lastNew: 82,
    });
    expect(latestPoll(db)).toEqual({
      at: Math.floor(NOW_MS / 1000),
      ok: true,
      pointsSeen: 84,
      pointsNew: 82,
      error: null,
    });
  });

  test("the second cycle inserts nothing new and skips the hourly mileage call", async () => {
    const db = openDatabase(":memory:");
    const { client, calls } = stubClient();
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    await poller.runOnce();
    calls.length = 0;
    await poller.runOnce();

    expect(calls).toEqual(["getTrack", "getLastPosition", "getObd"]);
    expect(poller.status().lastNew).toBe(0);
  });

  test("a platform failure is logged, never thrown", async () => {
    const db = openDatabase(":memory:");
    const { client, calls } = stubClient({
      getTrack: () => Promise.reject(new SinotrackError("Proc_GetTrack", "platform answered HTTP 502")),
    });
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    await poller.runOnce();

    const status = poller.status();
    expect(status.lastOk).toBe(false);
    // /healthz-safe text: our own proc plus our own short reason (§4).
    expect(status.lastError).toBe("Proc_GetTrack: platform answered HTTP 502");
    expect(latestPoll(db)?.ok).toBe(false);
    expect(latestPoll(db)?.error).toBe("Proc_GetTrack: platform answered HTTP 502");
    expect(pointsForDay(db, TEID, "2026-09-05")).toHaveLength(0);
    // A platform that just refused the poll is not asked three more questions.
    expect(calls).toEqual(["getTrack"]);
  });

  test("an unexpected exception never reaches /healthz as raw text", async () => {
    const db = openDatabase(":memory:");
    const { client } = stubClient({
      getTrack: () => Promise.reject(new Error("connect ECONNREFUSED /run/secret/path 242.example")),
    });
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    await poller.runOnce();

    expect(poller.status().lastError).toBe("internal");
    // The full text is still on record where only staff and the box can read it.
    expect(latestPoll(db)?.error).toContain("ECONNREFUSED");
  });

  test("a failing getObd is a warning, not a failed poll (§6)", async () => {
    const db = openDatabase(":memory:");
    const { client, calls } = stubClient({
      getObd: () => Promise.reject(new SinotrackError("Proc_GetOBD", "table UOBD_x does not exist")),
    });
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    await poller.runOnce();

    const status = poller.status();
    expect(status.lastOk).toBe(true);
    expect(status.lastError).toBeNull();
    expect(latestPoll(db)).toEqual({
      at: Math.floor(NOW_MS / 1000),
      ok: true,
      pointsSeen: 84,
      pointsNew: 82,
      error: null,
    });
    // The points still landed, and the hourly call still ran after the warning.
    expect(pointsForDay(db, TEID, "2026-09-05")).toHaveLength(82);
    expect(calls).toEqual(["getTrack", "getLastPosition", "getObd", "getMileageEveryDay"]);
  });

  test("a failing hourly getMileageEveryDay is a warning too, and is not retried next cycle", async () => {
    const db = openDatabase(":memory:");
    const { client, calls } = stubClient({
      getMileageEveryDay: () => Promise.reject(new SinotrackError("Proc_GetMileageEveryDay", "timeout after 20000 ms")),
    });
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    await poller.runOnce();
    expect(poller.status().lastOk).toBe(true);
    expect(latestPoll(db)?.ok).toBe(true);

    calls.length = 0;
    await poller.runOnce();
    expect(calls).toEqual(["getTrack", "getLastPosition", "getObd"]);
  });

  test("consecutive getTrack failures back off, and one success clears it", async () => {
    const db = openDatabase(":memory:");
    let fail = true;
    const { client, calls } = stubClient({
      getTrack: () => (fail ? Promise.reject(new SinotrackError("Proc_GetTrack", "platform answered HTTP 502")) : Promise.resolve([])),
    });
    let nowMs = NOW_MS;
    const poller = createPoller(db, { config: config(), nowMs: () => nowMs, client });
    const intervalMs = 600_000; // POLL_INTERVAL_SECONDS default

    await poller.runOnce(); // failure 1 → wait one interval
    expect(calls).toEqual(["getTrack"]);

    nowMs += intervalMs - 1_000; // the timer fires before the backoff is over
    await poller.runOnce();
    expect(calls).toEqual(["getTrack"]); // skipped: the platform was not touched

    nowMs += 2_000; // now past it
    await poller.runOnce(); // failure 2 → wait two intervals
    expect(calls).toEqual(["getTrack", "getTrack"]);

    nowMs += intervalMs + 1_000;
    await poller.runOnce();
    expect(calls).toEqual(["getTrack", "getTrack"]); // still inside the doubled wait

    nowMs += intervalMs;
    fail = false;
    await poller.runOnce();
    expect(poller.status().lastOk).toBe(true);

    // Cleared: the very next cycle runs at the normal cadence again.
    nowMs += 1_000;
    calls.length = 0;
    await poller.runOnce();
    expect(calls[0]).toBe("getTrack");
  });

  test("an unconfigured poller does nothing at all", async () => {
    const db = openDatabase(":memory:");
    const { client, calls } = stubClient();
    const poller = createPoller(db, {
      config: config({ SINOTRACK_USER: "", SINOTRACK_PASSWORD: "" }),
      nowMs: () => NOW_MS,
      client,
    });

    await poller.runOnce();

    expect(calls).toEqual([]);
    expect(poller.status().configured).toBe(false);
    expect(latestPoll(db)).toBeNull();
  });

  test("cycles never overlap", async () => {
    const db = openDatabase(":memory:");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, calls } = stubClient({
      getTrack: async () => {
        await gate;
        return [];
      },
    });
    const poller = createPoller(db, { config: config(), nowMs: () => NOW_MS, client });

    const first = poller.runOnce();
    await poller.runOnce(); // returns immediately: the flag is up
    expect(calls).toEqual(["getTrack"]);
    release?.();
    await first;
    expect(calls).toEqual(["getTrack", "getLastPosition", "getObd", "getMileageEveryDay"]);
  });
});

describe("backoff and the public error text", () => {
  test("doubles from one interval and stops at 30 minutes", () => {
    const interval = 600_000;
    expect(backoffMs(0, interval)).toBe(0);
    expect(backoffMs(1, interval)).toBe(600_000);
    expect(backoffMs(2, interval)).toBe(1_200_000);
    expect(backoffMs(3, interval)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(50, interval)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBe(30 * 60_000);
  });

  test("publishes our own errors and hides everyone else's (§4)", () => {
    expect(publicPollError(new SinotrackError("Proc_GetTrack", "platform answered HTTP 502"))).toBe(
      "Proc_GetTrack: platform answered HTTP 502",
    );
    expect(publicPollError(new SinotrackError("Proc_GetTrack", "a\n  very\tlong\nreason " + "x".repeat(200)))).toHaveLength(
      "Proc_GetTrack: ".length + 120,
    );
    expect(publicPollError(new Error("ENOENT /data/truck.db"))).toBe("internal");
    expect(publicPollError("plain string")).toBe("internal");
  });
});

describe("row helpers", () => {
  test("obd rows need a usable timestamp", () => {
    expect(obdRowsFrom(TEID, [{ nTime: "10", strOBD: "x" }, { strOBD: "y" }, { nTime: "0", strOBD: "z" }])).toEqual([
      { teid: TEID, t: 10, obd: "x" },
    ]);
  });

  test("every plausible day spelling normalises to YYYY-MM-DD", () => {
    expect(normaliseYmd("20260905")).toBe("2026-09-05");
    expect(normaliseYmd("2026-09-05")).toBe("2026-09-05");
    expect(normaliseYmd("2026/09/05")).toBe("2026-09-05");
    expect(normaliseYmd("2026-09-05 00:00:00")).toBe("2026-09-05");
    expect(normaliseYmd("nope")).toBeNull();
  });

  test("an unrecognised mileage row is skipped rather than failing the poll", () => {
    expect(mileageDaysFrom([{ strDate: "20260905", nMileage: "1200" }, { nothing: "useful" }])).toEqual([
      { ymd: "2026-09-05", mileageM: 1200 },
    ]);
  });
});
