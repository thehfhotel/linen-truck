// Stop spans (docs/CONTRACTS.md §3, "Stop spans"; §9 "Additive since 2026-09-30").
//
// A day report only sees one Bangkok day, so a stop that crosses midnight is
// clipped. `stopSpans` looks into the neighbouring days for the TWO stops that
// touch the day's edges and nothing else. Every case here is synthetic (device
// 1000000001 never appears — the domain takes points, not ids): parked at HF
// Ville across the midnight of 2026-09-29 → 2026-09-30, the very shape the owner
// saw in production.

import { describe, expect, test } from "bun:test";
import { bangkokDayWindow } from "../../src/domain/clock.ts";
import { cleanPoints, segment } from "../../src/domain/segment.ts";
import { SPAN_WINDOW_DAYS, stopSpans, type StopSpan } from "../../src/domain/span.ts";
import type { Point, Stop } from "../../src/domain/types.ts";
import { HF, HFVILLE, RULES, SITES, bkk, lerp, parked, pt } from "./support.ts";

const D29 = "2026-09-29";
const D30 = "2026-09-30";

/** Fixes driving HF → HF Ville that end `gapS` seconds before `tArrive`, at driving voltage. */
const driveIn = (tArrive: number, from = HF, to = HFVILLE): Point[] =>
  [0.2, 0.4, 0.6, 0.8].map((f, i) => pt(tArrive - 60 * (4 - i), lerp(from, to, f), { speed: 47, voltage: 13.8 }));

/** Fixes driving away from `a` towards `b`, starting `60 s` after `tDepart`. */
const driveOut = (tDepart: number, a = HFVILLE, b = HF): Point[] =>
  [0.2, 0.4, 0.6, 0.8].map((f, i) => pt(tDepart + 60 * (i + 1), lerp(a, b, f), { speed: 47, voltage: 13.8 }));

/** Everything the server would hand `stopSpans`: the day, the window and the day's own stops. */
function scene(ymd: string, all: Point[]) {
  const windowPoints = cleanPoints(all);
  const { startS, endS } = bangkokDayWindow(ymd);
  const dayPoints = windowPoints.filter((p) => p.t >= startS && p.t < endS);
  const dayStops = segment(dayPoints, SITES, RULES).stops;
  return { windowPoints, dayPoints, dayStops, spans: stopSpans(dayPoints, windowPoints, dayStops, SITES, RULES) };
}

const defaultSpan = (s: Stop): StopSpan => ({
  arriveAt: s.arrive,
  arriveOpen: false,
  departAt: s.depart,
  engineOffAt: s.engine.offAt,
  engineOnAt: s.engine.onAt,
});

// HF Ville from 2026-09-29 14:34 to 2026-09-30 13:08, arrived by road, then a
// drive to HF and a parked spell there. 10-minute cadence overnight (the slow
// parked cadence of the real tracker), 12.7 V = engine off.
const ARRIVE_29 = bkk(D29, "14:34:00");
const overnight = (): Point[] => parked(ARRIVE_29, HFVILLE, 136, 600, { voltage: 12.7 });
const LAST_OVERNIGHT = ARRIVE_29 + 135 * 600; // 2026-09-30 13:14:00

test("the window is seven days either side", () => {
  expect(SPAN_WINDOW_DAYS).toBe(7);
});

describe("a stop carried over from the previous day", () => {
  const all = [...driveIn(ARRIVE_29), ...overnight(), ...driveOut(LAST_OVERNIGHT)];
  const { dayStops, dayPoints, spans } = scene(D30, all);

  test("the day sees a real HF Ville stop that opens on the day's first fix", () => {
    expect(dayStops[0]!.siteId).toBe("hfville");
    expect(dayStops[0]!.virtual).toBeUndefined();
    expect(dayStops[0]!.arrive).toBe(dayPoints[0]!.t);
    expect(dayStops[0]!.arrive).toBeGreaterThan(bkk(D30, "00:00:00") - 1);
  });

  test("its real arrival is on the 29th and it is not open", () => {
    expect(spans).toHaveLength(dayStops.length);
    expect(spans[0]!.arriveAt).toBe(ARRIVE_29);
    expect(spans[0]!.arriveOpen).toBe(false);
  });

  test("the departure is the day's own (the stop ends inside the day)", () => {
    expect(spans[0]!.departAt).toBe(dayStops[0]!.depart);
    expect(spans[0]!.departAt).toBe(LAST_OVERNIGHT);
  });

  test("the arrival fix reads engine-off, and the span carries that time", () => {
    expect(spans[0]!.engineOffAt).toBe(ARRIVE_29);
  });
});

describe("a stop running into the next day", () => {
  // 2026-09-29: parked at HF in the morning, drive, HF Ville from 14:34 across
  // midnight. The engine is restarted (13.8 V, settled) at 13:00 on the 30th and
  // the truck leaves at 13:14 — the day only sees 00:00–23:59 of it.
  const morning = [...parked(bkk(D29, "09:00:00"), HF, 11, 60, { voltage: 12.7 })];
  const tail = parked(LAST_OVERNIGHT - 14 * 60, HFVILLE, 15, 60, { voltage: 13.8 });
  const stay = parked(ARRIVE_29, HFVILLE, 130, 600, { voltage: 12.7 }); // to 2026-09-30 12:04
  const all = [...morning, ...driveIn(ARRIVE_29), ...stay, ...tail, ...driveOut(LAST_OVERNIGHT)];
  const { dayStops, spans, windowPoints } = scene(D29, all);
  const last = dayStops.length - 1;

  test("the day's last stop ends on the day's last fix", () => {
    expect(dayStops[last]!.siteId).toBe("hfville");
    expect(dayStops[last]!.depart).toBeLessThan(bkk(D30, "00:00:00"));
  });

  test("the real departure is on the 30th", () => {
    expect(spans[last]!.departAt).toBe(LAST_OVERNIGHT);
    expect(spans[last]!.departAt).toBeGreaterThan(dayStops[last]!.depart);
  });

  test("the engine restart comes from the whole stop, not the clipped one", () => {
    expect(dayStops[last]!.engine.onAt).toBeNull();
    expect(spans[last]!.engineOnAt).toBe(LAST_OVERNIGHT - 14 * 60);
  });

  test("the arrival is untouched and closed", () => {
    expect(spans[last]!.arriveAt).toBe(ARRIVE_29);
    expect(spans[last]!.arriveOpen).toBe(false);
  });

  test("the window really did reach past the day", () => {
    expect(windowPoints[windowPoints.length - 1]!.t).toBeGreaterThan(bkk(D30, "00:00:00"));
  });
});

describe("still parked at the window's last fix", () => {
  const all = [...driveIn(ARRIVE_29), ...parked(ARRIVE_29, HFVILLE, 120, 600, { voltage: 12.7 })];
  const { dayStops, spans } = scene(D30, all);

  test("departAt is null — there is no departure in the data", () => {
    expect(dayStops).toHaveLength(1);
    expect(spans[0]!.departAt).toBeNull();
    expect(spans[0]!.arriveAt).toBe(ARRIVE_29);
  });
});

describe("the window starting inside the stop", () => {
  const start = bkk(D29, "20:00:00");
  const all = [...parked(start, HFVILLE, 100, 600, { voltage: 12.7 }), ...driveOut(start + 99 * 600)];
  const { windowPoints, dayStops, spans } = scene(D30, all);

  test("the arrival is only a bound: arriveOpen, and arriveAt is the window's first fix", () => {
    expect(windowPoints[0]!.t).toBe(start);
    expect(spans[0]!.arriveAt).toBe(start);
    expect(spans[0]!.arriveOpen).toBe(true);
    expect(dayStops[0]!.arrive).toBeGreaterThan(start);
  });
});

describe("a stop that spans the whole day (both boundaries)", () => {
  const arrive = bkk(D29, "20:00:00");
  const parkedRun = parked(arrive, HFVILLE, 220, 600, { voltage: 12.7 }); // → 2026-10-01 08:50
  const leaves = arrive + 219 * 600;
  const all = [...driveIn(arrive), ...parkedRun, ...driveOut(leaves)];
  const { dayStops, spans } = scene(D30, all);

  test("one stop, extended at both ends", () => {
    expect(dayStops).toHaveLength(1);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.arriveAt).toBe(arrive);
    expect(spans[0]!.arriveOpen).toBe(false);
    expect(spans[0]!.departAt).toBe(leaves);
    expect(spans[0]!.departAt).toBeGreaterThan(bkk("2026-10-01", "00:00:00"));
  });
});

describe("virtual book-ends", () => {
  // The day opens and closes mid-move, with one real 20-minute stop between, and
  // there is more travel on both sides of the day for the window to see.
  const dayStart = bkk(D30, "00:00:00");
  const dayEnd = bkk("2026-10-01", "00:00:00");
  const moving = (t: number, f: number): Point => pt(t, lerp(HF, HFVILLE, f), { speed: 47, voltage: 13.8 });
  const t0 = bkk(D30, "12:00:00");
  const edge = [
    moving(dayStart - 240, 0.1),
    moving(dayStart - 180, 0.2),
    moving(dayStart + 60, 0.3),
    moving(dayStart + 120, 0.4),
    ...driveIn(t0),
    ...parked(t0, HFVILLE, 21, 60, { voltage: 12.7 }),
    ...driveOut(t0 + 20 * 60),
    moving(dayEnd - 120, 0.5),
    moving(dayEnd - 60, 0.6),
    moving(dayEnd + 60, 0.7),
    moving(dayEnd + 120, 0.8),
  ];
  const { dayStops, spans } = scene(D30, edge);

  test("the day is book-ended around one real stop", () => {
    expect(dayStops.map((s) => s.virtual ?? "real")).toEqual(["track-start", "real", "track-end"]);
  });

  test("both book-ends keep the default, byte for byte", () => {
    expect(spans[0]).toEqual(defaultSpan(dayStops[0]!));
    expect(spans[2]).toEqual(defaultSpan(dayStops[2]!));
  });

  test("the real stop between them is neither boundary, so it keeps the default too", () => {
    expect(spans[1]).toEqual(defaultSpan(dayStops[1]!));
  });
});

describe("mid-day stops", () => {
  // Three real stops: HF Ville across the previous midnight, HF in the middle of
  // the day, HF Ville across the next midnight. Only the outer two may extend.
  const tHf = bkk(D30, "12:00:00");
  const leaveA = bkk(D30, "10:00:00");
  const arriveC = bkk(D30, "16:00:00");
  const a = parked(ARRIVE_29, HFVILLE, 1 + Math.floor((leaveA - ARRIVE_29) / 600), 600, { voltage: 12.7 });
  const c = parked(arriveC, HFVILLE, 1 + Math.floor((bkk("2026-10-01", "09:00:00") - arriveC) / 600), 600, { voltage: 12.7 });
  const all = [
    ...driveIn(ARRIVE_29),
    ...a,
    ...driveOut(a[a.length - 1]!.t, HFVILLE, HF),
    ...parked(tHf, HF, 21, 60, { voltage: 12.7 }),
    ...driveIn(arriveC),
    ...c,
    ...driveOut(c[c.length - 1]!.t),
  ];
  const { dayStops, spans } = scene(D30, all);

  test("three real stops", () => {
    expect(dayStops.filter((s) => !s.virtual)).toHaveLength(3);
  });

  test("the middle one is untouched", () => {
    expect(spans[1]).toEqual(defaultSpan(dayStops[1]!));
  });

  test("the outer two are extended", () => {
    expect(spans[0]!.arriveAt).toBe(ARRIVE_29);
    expect(spans[2]!.departAt).toBe(c[c.length - 1]!.t);
  });
});

describe("no matching window stop", () => {
  const all = [...driveIn(ARRIVE_29), ...overnight(), ...driveOut(LAST_OVERNIGHT)];
  const { dayPoints, dayStops } = scene(D30, all);

  test("an empty window keeps every default", () => {
    const spans = stopSpans(dayPoints, [], dayStops, SITES, RULES);
    expect(spans).toEqual(dayStops.map(defaultSpan));
  });

  test("a window that does not contain the day keeps every default", () => {
    // A week of travel in September, unrelated to the day being asked about.
    const elsewhere = cleanPoints([
      ...driveIn(bkk("2026-09-25", "10:00:00")),
      ...parked(bkk("2026-09-25", "10:00:00"), HFVILLE, 12, 60, { voltage: 12.7 }),
    ]);
    const spans = stopSpans(dayPoints, elsewhere, dayStops, SITES, RULES);
    expect(spans).toEqual(dayStops.map(defaultSpan));
  });

  test("an empty day gives an empty result", () => {
    expect(stopSpans([], [], [], SITES, RULES)).toEqual([]);
  });
});
