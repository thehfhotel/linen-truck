// linen-truck — tracker power findings (docs/CONTRACTS.md §3, rule 11).
//
// The owner wants a finding when the truck's GPS tracker may have been unplugged.
// We have NEVER observed an unplug, so this is an OR of independent signals taken
// from docs/research/tracker-unplug-voltage.md, built now and tuned after the first
// real event. Every signal is silent on today's data (5,878 production fixes: the
// alarm word is 0 on every row, the battery byte is 100 wherever it is present and
// 0 on the store-and-forward rows, the supply never below 11 V), so a finding here
// is news.
//
// REPORT ONLY. Nothing here feeds a number of rules 1-10, and there is no push of
// any kind (CLAUDE.md: no notification path).
//
// BIT MATH. `nTEState` uses bit 31, and JS `&` is a SIGNED 32-bit operator, so a
// word like 0xE0644000 goes negative under it. Every read below normalises with
// `>>> 0` first and tests single bits with `!== 0` (or, for bit 31, `>>> 31`).

import type { Finding, Point, PowerReason, Rules } from "./types.ts";

/** The reasons in the fixed order a finding lists them. */
export const POWER_REASONS: readonly PowerReason[] = ["battery", "power-cut", "on-battery", "shutdown", "low-supply"];

/** `nTEState` bit 3 — the vendor's "send stored data": a store-and-forward row, late by hours. */
const TE_STORED = 0x8;
/** `nTEState` bit 29 — the vendor's client labels it "Battery power". */
const TE_ON_BATTERY = 0x20000000;
/** `nTEState` bit 30 — "Shutdown". (Bit 31, "Sleep", is a normal parked mode and is NOT a reason.) */
const TE_SHUTDOWN = 0x40000000;
/** `nAlarmState` bit 3 — "Main power cut off alarm". */
const ALARM_POWER_CUT = 8;

const unsigned = (n: number): number => n >>> 0;

/** The vendor's battery-level byte, bits 16-23 of `nTEState`: 100 = full, 0 = unknown. */
export const batteryByte = (te: number): number => (unsigned(te) >>> 16) & 0xff;

const isStored = (te: number | null | undefined): boolean =>
  te !== null && te !== undefined && (unsigned(te) & TE_STORED) !== 0;

/** Why this one fix reads possibly-unplugged, in `POWER_REASONS` order; empty = no reason. */
export function fixReasons(p: Point, rules: Rules): PowerReason[] {
  const out: PowerReason[] = [];
  const te = p.teState ?? null;
  const alarm = p.alarm ?? null;
  if (te !== null) {
    // 0 is "unknown" and 100 is "full": neither is ever a reason. A stored row
    // (bit 3) carries whatever the cell read when it was RECORDED, hours ago.
    const b = batteryByte(te);
    if (!isStored(te) && b >= 1 && b <= 99) out.push("battery");
  }
  if (alarm !== null && (unsigned(alarm) & ALARM_POWER_CUT) !== 0) out.push("power-cut");
  if (te !== null && (unsigned(te) & TE_ON_BATTERY) !== 0) out.push("on-battery");
  if (te !== null && (unsigned(te) & TE_SHUTDOWN) !== 0) out.push("shutdown");
  if (p.voltage !== null && p.voltage < rules.unpluggedVolts) out.push("low-supply");
  return out;
}

type PowerFinding = Extract<Finding, { kind: "tracker-power" }>;
type AlarmFinding = Extract<Finding, { kind: "tracker-alarm" }>;

/**
 * Rule 11a: runs of fixes that read possibly-unplugged. A run starts at a FLAGGED
 * fix (at least one reason), extends over flagged and NEUTRAL fixes (no reason and
 * a store-and-forward row: it says nothing about the present) and ends before the
 * first CLEAR fix (no reason otherwise, a null `teState` included). Its `end` is
 * its last FLAGGED fix. `points` must be time-ordered (`cleanPoints`).
 */
export function trackerPower(points: readonly Point[], rules: Rules): PowerFinding[] {
  const out: PowerFinding[] = [];
  let run: {
    start: number;
    end: number;
    reasons: Set<PowerReason>;
    minBattery: number | null;
    minVolts: number | null;
    fixes: number;
    lat: number;
    lon: number;
  } | null = null;
  const flush = (): void => {
    if (run === null) return;
    out.push({
      kind: "tracker-power",
      start: run.start,
      end: run.end,
      reasons: POWER_REASONS.filter((r) => run!.reasons.has(r)),
      minBatteryPct: run.minBattery,
      minVoltage: run.minVolts,
      fixes: run.fixes,
      lat: run.lat,
      lon: run.lon,
    });
    run = null;
  };
  for (const p of points) {
    const reasons = fixReasons(p, rules);
    if (reasons.length === 0) {
      if (isStored(p.teState)) continue; // NEUTRAL: neither extends `end` nor closes the run
      flush(); // CLEAR
      continue;
    }
    if (run === null) {
      run = { start: p.t, end: p.t, reasons: new Set(), minBattery: null, minVolts: null, fixes: 0, lat: p.lat, lon: p.lon };
    }
    run.end = p.t;
    run.fixes += 1;
    for (const r of reasons) run.reasons.add(r);
    if (reasons.includes("battery")) {
      const b = batteryByte(p.teState!);
      run.minBattery = run.minBattery === null ? b : Math.min(run.minBattery, b);
    }
    if (reasons.includes("low-supply")) {
      run.minVolts = run.minVolts === null ? p.voltage! : Math.min(run.minVolts, p.voltage!);
    }
  }
  flush();
  return out;
}

/** `nAlarmState` without the power-cut bit (already rule 11a's `power-cut`), unsigned. */
export const alarmCode = (alarm: number): number => unsigned(unsigned(alarm) & ~ALARM_POWER_CUT);

/**
 * Rule 11b: maximal runs of consecutive fixes carrying the same non-zero alarm
 * code. A fix with a null alarm is neutral — it neither extends a run of another
 * code nor ends one; a fix with any different code, 0 included, ends it. `end` is
 * the last fix that carried the code.
 */
export function trackerAlarms(points: readonly Point[]): AlarmFinding[] {
  const out: AlarmFinding[] = [];
  let run: AlarmFinding | null = null;
  const flush = (): void => {
    if (run !== null) out.push(run);
    run = null;
  };
  for (const p of points) {
    const alarm = p.alarm ?? null;
    if (alarm === null) continue;
    const code = alarmCode(alarm);
    if (code === 0) {
      flush();
      continue;
    }
    if (run !== null && run.code === code) {
      run.end = p.t;
      run.fixes += 1;
      continue;
    }
    flush();
    run = { kind: "tracker-alarm", start: p.t, end: p.t, code, fixes: 1, lat: p.lat, lon: p.lon };
  }
  flush();
  return out;
}

/** Both rule-11 findings for a day's cleaned points: power runs first, then alarm runs. */
export function trackerFindings(points: readonly Point[], rules: Rules): Finding[] {
  return [...trackerPower(points, rules), ...trackerAlarms(points)];
}
