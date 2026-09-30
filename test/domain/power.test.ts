// §3 rule 11 — tracker power findings (report only). Nobody has ever observed the
// tracker being unplugged, so every case below is a statement about the RULE as
// specified from docs/research/tracker-unplug-voltage.md, not about a real event.
//
// `nTEState` uses bit 31, so several cases use real high-bit words (0xE0644000,
// 0x80644000) and one hands the rule the SIGNED spelling of the same word: the
// rule must read both the same, which is what `>>> 0` is for.

import { describe, expect, it } from "bun:test";
import { alarmCode, batteryByte, fixReasons, trackerAlarms, trackerFindings, trackerPower } from "../../src/domain/power.ts";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Point, PowerReason } from "../../src/domain/types.ts";
import { HF, RULES, SITES, bkk, deliveryDay, pt } from "./support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

/** `nTEState` as the tracker composes it: battery byte in bits 16-23 plus bit 14 (meaning unknown, always set on live rows). */
const te = (battery: number, extra = 0): number => (((battery << 16) | 0x4000 | extra) >>> 0);
const STORED = 0x8;
const ON_BATTERY = 0x20000000;
const SHUTDOWN = 0x40000000;
const SLEEP = 0x80000000;

const YMD = "2026-09-05";
const T0 = bkk(YMD, "14:00:00");

/** A fix `i` minutes after 14:00 at HF, with only the power-relevant fields stated. */
const at = (i: number, over: Partial<Point> = {}): Point => ({ ...pt(T0 + i * 60, HF), ...over });

const reasons = (p: Partial<Point>): PowerReason[] => fixReasons(at(0, p), RULES);

describe("the shipped threshold", () => {
  it("should ship unpluggedVolts = 10 in config/rules.json", () => {
    expect(RULES.unpluggedVolts).toBe(10);
  });
});

describe("per fix — the battery byte", () => {
  it("should decode bits 16-23 unsigned, whatever the high bits say", () => {
    expect(batteryByte(0x644000)).toBe(100);
    expect(batteryByte(0xe0504000)).toBe(80);
    expect(batteryByte(0xe0504000 | 0)).toBe(80); // the signed spelling of the same word
    expect(batteryByte(0x8)).toBe(0);
  });

  it("should flag 1..99 on a live row", () => {
    expect(reasons({ teState: te(99) })).toEqual(["battery"]);
    expect(reasons({ teState: te(80) })).toEqual(["battery"]);
    expect(reasons({ teState: te(1) })).toEqual(["battery"]);
  });

  it("should never flag 100 (full) or 0 (unknown)", () => {
    expect(reasons({ teState: te(100) })).toEqual([]);
    expect(reasons({ teState: te(0) })).toEqual([]);
    expect(reasons({ teState: 0x644000 })).toEqual([]); // the production word: 100 %, nothing else
  });

  it("should not flag a stored row whose byte reads 1..99 (it was recorded hours ago)", () => {
    expect(reasons({ teState: te(80, STORED) })).toEqual([]);
  });

  it("should say nothing when teState is null or absent", () => {
    expect(reasons({ teState: null })).toEqual([]);
    expect(fixReasons({ t: T0, lat: HF.lat, lon: HF.lon, speed: 0, voltage: null }, RULES)).toEqual([]);
  });
});

describe("per fix — the alarm word", () => {
  it("should flag power-cut on bit 8 only", () => {
    expect(reasons({ alarm: 8 })).toEqual(["power-cut"]);
    expect(reasons({ alarm: 8 | 16 })).toEqual(["power-cut"]);
    expect(reasons({ alarm: 0 })).toEqual([]);
    expect(reasons({ alarm: 16 })).toEqual([]);
    expect(reasons({ alarm: 32768 })).toEqual([]); // low-voltage alarm is a rule-11b alarm, not a power-cut
    expect(reasons({ alarm: null })).toEqual([]);
  });

  it("should read a high-bit alarm unsigned", () => {
    expect(reasons({ alarm: (134217728 | 8) >>> 0 })).toEqual(["power-cut"]);
    expect(reasons({ alarm: 0x80000000 })).toEqual([]);
  });
});

describe("per fix — the status word's bits 29, 30, 31", () => {
  it("should flag bit 29 as on-battery and bit 30 as shutdown", () => {
    expect(reasons({ teState: te(100, ON_BATTERY) })).toEqual(["on-battery"]);
    expect(reasons({ teState: te(100, SHUTDOWN) })).toEqual(["shutdown"]);
  });

  it("should read the high bits UNSIGNED: 0xE0644000 is on-battery AND shutdown, however it is spelled", () => {
    expect(reasons({ teState: 0xe0644000 })).toEqual(["on-battery", "shutdown"]);
    expect(reasons({ teState: 0xe0644000 | 0 })).toEqual(["on-battery", "shutdown"]);
    expect(reasons({ teState: Number(String(0xe0644000)) })).toEqual(["on-battery", "shutdown"]); // as the platform sends it: a decimal string
  });

  it("should NOT flag bit 31 (Sleep) alone: it is a normal parked mode", () => {
    expect(reasons({ teState: 0x80644000 })).toEqual([]);
    expect(reasons({ teState: te(100, SLEEP) })).toEqual([]);
    expect(reasons({ teState: (SLEEP | 0x8) >>> 0 })).toEqual([]);
  });

  it("should still flag these on a stored row (only the battery byte is muted there)", () => {
    expect(reasons({ teState: te(100, ON_BATTERY | STORED) })).toEqual(["on-battery"]);
    expect(reasons({ teState: te(100, SHUTDOWN | STORED) })).toEqual(["shutdown"]);
  });
});

describe("per fix — the supply voltage", () => {
  it("should be strictly less than unpluggedVolts: 10.0 is not low, 9.9 is", () => {
    expect(reasons({ voltage: 10 })).toEqual([]);
    expect(reasons({ voltage: 9.9 })).toEqual(["low-supply"]);
    expect(reasons({ voltage: 3.9 })).toEqual(["low-supply"]);
    expect(reasons({ voltage: 12.7 })).toEqual([]);
  });

  it("should never read a null voltage as low", () => {
    expect(reasons({ voltage: null })).toEqual([]);
  });

  it("should read the threshold from the rules it is given", () => {
    expect(fixReasons(at(0, { voltage: 11.5 }), { ...RULES, unpluggedVolts: 12 })).toEqual(["low-supply"]);
    expect(fixReasons(at(0, { voltage: 11.5 }), RULES)).toEqual([]);
  });
});

describe("per fix — order", () => {
  it("should list every reason in the fixed order", () => {
    expect(reasons({ teState: te(80, ON_BATTERY | SHUTDOWN), alarm: 8, voltage: 3.9 })).toEqual([
      "battery",
      "power-cut",
      "on-battery",
      "shutdown",
      "low-supply",
    ]);
  });
});

describe("runs — trackerPower", () => {
  const LIVE = te(100);
  const clear = (i: number): Point => at(i, { teState: LIVE, voltage: 12.7 });
  const low = (i: number, pct: number): Point => at(i, { teState: te(pct), voltage: 12.7 });
  const stored = (i: number): Point => at(i, { teState: STORED, voltage: null });

  it("should find nothing on a clear day", () => {
    expect(trackerPower([clear(0), clear(1), clear(2)], RULES)).toEqual([]);
    expect(trackerPower([], RULES)).toEqual([]);
  });

  it("should start at a flagged fix, and end at the LAST FLAGGED fix before a clear one", () => {
    const out = trackerPower([clear(0), low(1, 80), low(2, 60), clear(3), clear(4)], RULES);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "tracker-power",
      start: T0 + 60,
      end: T0 + 120,
      reasons: ["battery"],
      minBatteryPct: 60,
      minVoltage: null,
      fixes: 2,
      lat: HF.lat,
      lon: HF.lon,
    });
  });

  it("should bridge neutral store-and-forward rows, but not count them or let them extend the end", () => {
    const out = trackerPower([low(0, 80), stored(1), stored(2), low(3, 60), stored(4)], RULES);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: T0, end: T0 + 180, fixes: 2, minBatteryPct: 60 });
    // a trailing neutral row after the last flagged fix does not move `end`
    expect(trackerPower([low(0, 80), stored(1)], RULES)[0]!.end).toBe(T0);
  });

  it("should never START a run on a neutral row", () => {
    expect(trackerPower([stored(0), stored(1), clear(2)], RULES)).toEqual([]);
  });

  it("should end a run at a clear row, and start another after it", () => {
    const out = trackerPower([low(0, 80), clear(1), low(2, 40)], RULES);
    expect(out.map((f) => [f.start, f.end, f.minBatteryPct])).toEqual([
      [T0, T0, 80],
      [T0 + 120, T0 + 120, 40],
    ]);
  });

  it("should treat a null-teState fix as CLEAR (it ends a run)", () => {
    const out = trackerPower([low(0, 80), at(1, { teState: null, voltage: 12.7 }), low(2, 80)], RULES);
    expect(out).toHaveLength(2);
  });

  it("should treat a stored row with no reason as neutral even with a null voltage (the 53 real 0x8 rows)", () => {
    expect(trackerPower([low(0, 80), at(1, { teState: 0x8, voltage: null }), low(2, 70)], RULES)).toHaveLength(1);
  });

  it("should flag a stored row that carries a real reason, and count it", () => {
    const out = trackerPower([at(0, { teState: STORED, voltage: 3.9 })], RULES);
    expect(out[0]).toMatchObject({ reasons: ["low-supply"], fixes: 1, minVoltage: 3.9, minBatteryPct: null });
  });

  it("should union the reasons in fixed order and take the min battery / voltage only over the fixes that carry them", () => {
    const out = trackerPower(
      [
        at(0, { teState: te(100, SHUTDOWN), voltage: 12.7, lat: 9.1, lon: 99.3 }), // first flagged fix: shutdown
        at(1, { teState: te(70), voltage: 9.5 }), // battery 70 + low 9.5
        at(2, { teState: te(100), voltage: 12.7, alarm: 8 }), // power-cut only, battery byte 100 → not a battery fix
        at(3, { teState: te(40), voltage: 3.9 }), // battery 40 + low 3.9
        at(4, { teState: te(90), voltage: 12.7 }), // battery 90
      ],
      RULES,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "tracker-power",
      start: T0,
      end: T0 + 240,
      reasons: ["battery", "power-cut", "shutdown", "low-supply"],
      minBatteryPct: 40,
      minVoltage: 3.9,
      fixes: 5,
      lat: 9.1,
      lon: 99.3,
    });
  });

  it("should give the high-bit word a run of its own reasons", () => {
    const out = trackerPower([at(0, { teState: 0xe0644000, voltage: 12.7 }), at(1, { teState: 0x80644000, voltage: 12.7 })], RULES);
    // bit 31 alone (the second fix) is CLEAR, so the run is the first fix only
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reasons: ["on-battery", "shutdown"], start: T0, end: T0, fixes: 1 });
  });
});

describe("runs — trackerAlarms", () => {
  const a = (i: number, alarm: number | null): Point => at(i, { alarm });

  it("should find nothing while every alarm word is 0", () => {
    expect(trackerAlarms([a(0, 0), a(1, 0), a(2, 0)])).toEqual([]);
    expect(trackerAlarms([])).toEqual([]);
  });

  it("should mask the power-cut bit off: 8 alone is not an alarm here, 8|16 is code 16", () => {
    expect(alarmCode(8)).toBe(0);
    expect(alarmCode(8 | 16)).toBe(16);
    expect(trackerAlarms([a(0, 8), a(1, 8)])).toEqual([]);
    expect(trackerAlarms([a(0, 8 | 16)])[0]).toMatchObject({ code: 16, fixes: 1 });
  });

  it("should group consecutive fixes of the same code into one finding", () => {
    const out = trackerAlarms([a(0, 0), a(1, 64), a(2, 64), a(3, 64), a(4, 0), a(5, 64)]);
    expect(out).toEqual([
      { kind: "tracker-alarm", start: T0 + 60, end: T0 + 180, code: 64, fixes: 3, lat: HF.lat, lon: HF.lon },
      { kind: "tracker-alarm", start: T0 + 300, end: T0 + 300, code: 64, fixes: 1, lat: HF.lat, lon: HF.lon },
    ]);
  });

  it("should let a null alarm be neutral: it neither ends the run nor extends it", () => {
    const out = trackerAlarms([a(0, 64), a(1, null), a(2, 64), a(3, null)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: T0, end: T0 + 120, fixes: 2 }); // the trailing null does not move `end`
  });

  it("should end a run at a DIFFERENT code and start a new one", () => {
    const out = trackerAlarms([a(0, 64), a(1, 128), a(2, 128)]);
    expect(out.map((f) => [f.code, f.fixes])).toEqual([
      [64, 1],
      [128, 2],
    ]);
  });

  it("should read a code above bit 30 unsigned and positive", () => {
    const out = trackerAlarms([a(0, 0x80000000 | 8)]);
    expect(out[0]!.code).toBe(0x80000000);
  });

  it("should record the position of the first fix of the run", () => {
    const out = trackerAlarms([at(0, { alarm: 32, lat: 9.2, lon: 99.4 }), at(1, { alarm: 32, lat: 9.3, lon: 99.5 })]);
    expect(out[0]).toMatchObject({ lat: 9.2, lon: 99.4 });
  });
});

describe("summarizeDay carries the findings, first", () => {
  const t0 = bkk(YMD, "12:00:00");

  it("should put tracker-power and tracker-alarm ahead of every existing kind, unchanged numbers behind them", () => {
    const base = deliveryDay(t0);
    const plain = summarizeDay(YMD, base, SITES, RULES);
    const marked = base.map((p, i) =>
      i === 3 ? { ...p, teState: te(80) } : i === 4 ? { ...p, alarm: 64 } : { ...p, teState: te(100), alarm: 0 },
    );
    const day = summarizeDay(YMD, marked, SITES, RULES);
    expect(day.findings.map((f) => f.kind)).toEqual([
      "tracker-power",
      "tracker-alarm",
      ...plain.findings.map((f) => f.kind),
    ]);
    expect(day.findings.slice(2)).toEqual(plain.findings);
    expect(day.km).toBe(plain.km);
    expect(day.stops).toEqual(plain.stops);
    expect(day.trips.map((t) => t.n)).toEqual(plain.trips.map((t) => t.n));
  });

  it("should agree with trackerFindings on the same cleaned points", () => {
    const marked = deliveryDay(t0).map((p, i) => (i === 2 ? { ...p, alarm: 128 } : p));
    expect(summarizeDay(YMD, marked, SITES, RULES).findings).toEqual([
      ...trackerFindings(marked, RULES),
      ...summarizeDay(YMD, deliveryDay(t0), SITES, RULES).findings,
    ]);
  });
});

describe("the archived 2026-09-05 fixture", () => {
  const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
  const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);

  it("carries an alarm word of 0 on every raw row, and teState only 0x644008, 0x644000 and 0x8", () => {
    expect(RAW.every((r) => r.nAlarmState === "0")).toBe(true);
    expect([...new Set(RAW.map((r) => Number(r.nTEState)))].sort((x, y) => x - y)).toEqual([0x8, 0x644000, 0x644008]);
    expect(POINTS.every((p) => p.alarm === 0)).toBe(true);
  });

  it("should raise 0 tracker-power and 0 tracker-alarm, and leave the day exactly as it was", () => {
    expect(trackerPower(POINTS, RULES)).toEqual([]);
    expect(trackerAlarms(POINTS)).toEqual([]);
    const day = summarizeDay(YMD, POINTS, SITES, RULES);
    expect(day.findings.map((f) => f.kind)).toEqual(["detour"]);
    expect(day.pointCount).toBe(82);
    expect(day.tripCount).toBe(4);
  });
});
