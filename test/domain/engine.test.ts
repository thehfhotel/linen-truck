// The engine-state mask (docs/CONTRACTS.md §3, rule 1).
//
// Every number below is taken from the two archived days the rule was designed
// against: real driving reads 13.4–14.0 V from the first fix after a start and
// stays there (2026-09-05 13:35:15 = 14.0 V at 37 km/h), the only dips are
// single fixes (13:40:45 = 12.2 V at 40 km/h, with 13.8 V neighbours 90 s either
// side), and a parked truck sits at 12.4–12.9 V while still reporting speeds.

import { describe, expect, it } from "bun:test";
import { engineEvents, engineOnMask } from "../../src/domain/engine.ts";
import type { Point, Rules } from "../../src/domain/types.ts";
import { HF, RULES, bkk, pt } from "./support.ts";

const T0 = bkk("2026-09-05", "13:35:15");
const volts = (ts: number[], vs: (number | null)[]): Point[] =>
  ts.map((t, i) => pt(T0 + t, HF, { voltage: vs[i]!, speed: 40 }));

describe("engineOnMask", () => {
  it("should hold the engine ON across a single voltage dip inside engineHoldS", () => {
    // 2026-09-05 13:39:15 → 13:42:15: 13.8, 12.2, 13.8 at 90 s spacing. The dip
    // is one fix in the middle of a 60 km/h run; it is not an engine stop.
    const mask = engineOnMask(volts([0, 90, 180], [13.8, 12.2, 13.8]), RULES);
    expect(mask).toEqual([true, true, true]);
  });

  it("should call a fix ENGINE-OFF once no hot fix is within engineHoldS either side", () => {
    // The hold is symmetric and inclusive: exactly engineHoldS away still counts,
    // one second more does not. (Offline batch — non-causal is fine.)
    const hold = RULES.engineHoldS;
    const mask = engineOnMask(volts([0, hold, hold + 1], [13.8, 12.6, 12.6]), RULES);
    expect(mask).toEqual([true, true, false]);
  });

  it("should treat the threshold itself as ON and anything under it as OFF", () => {
    const at = engineOnMask(volts([0], [RULES.engineOnVolts]), RULES);
    const under = engineOnMask(volts([0], [RULES.engineOnVolts - 0.1]), RULES);
    expect(at).toEqual([true]);
    expect(under).toEqual([false]);
  });

  it("should call a whole parked evening OFF, however fast the tracker says it went", () => {
    // 2026-09-06 16:00–21:00: 12.4–12.7 V throughout, speeds up to 107 km/h.
    const evening = volts([0, 600, 1200, 1800, 2400], [12.7, 12.5, 12.6, 12.4, 12.7]);
    expect(engineOnMask(evening, RULES)).toEqual([false, false, false, false, false]);
  });

  it("should leave a day with NO voltage at all exactly as it is today — every fix ON", () => {
    // A future point source without a `Voltages=` field must not silently turn
    // the whole day into "engine off": null is unknown, not zero.
    const blind = volts([0, 600, 1200], [null, null, null]);
    expect(engineOnMask(blind, RULES)).toEqual([true, true, true]);
  });

  it("should let a null fix inherit the state of its neighbours on a day that does have voltage", () => {
    // 2026-09-05 12:11:15 carries no voltage and sits between 13.2 V fixes.
    const mixed = volts([0, 1, 5, 3600], [13.2, null, 13.3, null]);
    expect(engineOnMask(mixed, RULES)).toEqual([true, true, true, false]);
  });

  it("should be inert when engineHoldS is 0 — each fix answers for itself", () => {
    const strict: Rules = { ...RULES, engineHoldS: 0 };
    const mask = engineOnMask(volts([0, 90, 180], [13.8, 12.2, 13.8]), strict);
    expect(mask).toEqual([true, false, true]);
  });

  it("should return one flag per point, and nothing for an empty day", () => {
    expect(engineOnMask([], RULES)).toEqual([]);
    expect(engineOnMask(volts([0, 60], [13.8, 12.6]), RULES)).toHaveLength(2);
  });
});

// The per-stop ignition events (docs/CONTRACTS.md §3, rule 1 "engine events").
//
// A different question from the mask above, and deliberately a different
// reading of the same volts: the mask HOLDS a fix on across a dip because it
// answers "was the truck under power while it moved", and a stop asks "did the
// driver switch the engine off while he sat here" — which is the raw voltage,
// fix by fix, over the stop's OWN range. Every number below is from the box's
// own measurements of 2026-09-05 (docs/CONTRACTS.md §3, "Expected on the
// fixture").
describe("engineEvents", () => {
  const eventsOf = (points: Point[]) => engineEvents(points, 0, points.length - 1, RULES);

  it("should report the off and the restart of a stop the driver waited out", () => {
    // The 12:24–13:34 HF Ville stop in miniature: arrives running, engine off
    // three minutes later, restarted 65 minutes on, still there for one more fix.
    const stop = volts([0, 30, 210, 240, 3900, 3990], [13.6, 13.6, 12.9, 12.8, 13.9, 13.8]);
    expect(eventsOf(stop)).toEqual({
      kind: "parked",
      offAt: T0 + 210,
      onAt: T0 + 3900,
      offS: 3690,
    });
  });

  it("should take the FIRST fix as offAt when the truck arrived with the engine already off", () => {
    const stop = volts([0, 60, 120], [12.7, 12.7, 12.6]);
    expect(eventsOf(stop)).toEqual({ kind: "parked", offAt: T0, onAt: null, offS: 120 });
  });

  it("should call a stop RUNNING when every reading is at or above engineOnVolts", () => {
    // 2026-09-06 14:27–14:47: twenty minutes at an unknown place, engine running
    // throughout. The threshold itself is ON, as everywhere else in this file.
    const stop = volts([0, 600, 1200], [13.8, RULES.engineOnVolts, 13.9]);
    expect(eventsOf(stop)).toEqual({ kind: "running", offAt: null, onAt: null, offS: 0 });
  });

  it("should call a stop with NO voltage at all unknown, never parked", () => {
    expect(eventsOf(volts([0, 60, 120], [null, null, null]))).toEqual({
      kind: "unknown",
      offAt: null,
      onAt: null,
      offS: 0,
    });
  });

  it("should carry the previous state through a null fix, and count a leading null to nothing", () => {
    // Null is unknown, not off: the fix before the first reading answers for
    // nothing, and the fix after an off reading is still off.
    const stop = volts([0, 60, 120, 180], [null, 12.7, null, 13.8]);
    expect(eventsOf(stop)).toEqual({ kind: "parked", offAt: T0 + 60, onAt: T0 + 180, offS: 120 });
  });

  it("should count offS by sample-and-hold, so the last fix's state adds nothing", () => {
    const stop = volts([0, 60, 300], [13.8, 12.6, 12.6]);
    expect(eventsOf(stop)).toEqual({ kind: "parked", offAt: T0 + 60, onAt: null, offS: 240 });
  });

  it("should report onAt after the LAST off-run when the engine cycles twice", () => {
    const stop = volts([0, 60, 120, 180, 240, 300], [12.6, 13.8, 12.6, 12.6, 13.8, 13.9]);
    expect(eventsOf(stop)).toEqual({ kind: "parked", offAt: T0, onAt: T0 + 240, offS: 180 });
  });

  it("should read the stop's OWN range and nothing either side of it", () => {
    const day = volts([0, 60, 120, 180, 240], [12.6, 13.8, 13.9, 13.8, 12.6]);
    expect(engineEvents(day, 1, 3, RULES)).toEqual({ kind: "running", offAt: null, onAt: null, offS: 0 });
    expect(engineEvents(day, 0, 4, RULES).kind).toBe("parked");
  });

  it("should answer unknown for an empty range rather than throw", () => {
    expect(engineEvents([], 0, -1, RULES)).toEqual({ kind: "unknown", offAt: null, onAt: null, offS: 0 });
  });
});
