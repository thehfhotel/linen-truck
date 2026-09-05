import { describe, expect, it } from "bun:test";
import { bangkokDayWindow, bangkokMinuteOfDay, bangkokYmd, parseHhMm } from "../../src/domain/clock.ts";
import { bkk } from "./support.ts";

describe("bangkokMinuteOfDay", () => {
  it("should read the wall clock in Bangkok and truncate the seconds", () => {
    expect(bangkokMinuteOfDay(bkk("2026-09-05", "00:00:00"))).toBe(0);
    expect(bangkokMinuteOfDay(bkk("2026-09-05", "12:00:59"))).toBe(720);
    expect(bangkokMinuteOfDay(bkk("2026-09-05", "23:59:59"))).toBe(1439);
    expect(bangkokMinuteOfDay(Date.parse("2026-09-05T00:00:00Z") / 1000)).toBe(7 * 60);
  });
});

describe("bangkokYmd", () => {
  it("should roll the day over at Bangkok midnight, not UTC midnight", () => {
    expect(bangkokYmd(Date.parse("2026-09-04T17:00:00Z") / 1000)).toBe("2026-09-05");
    expect(bangkokYmd(Date.parse("2026-09-04T16:59:59Z") / 1000)).toBe("2026-09-04");
  });
});

describe("parseHhMm", () => {
  it("should read a schedule boundary", () => {
    expect(parseHhMm("00:00")).toBe(0);
    expect(parseHhMm("12:00")).toBe(720);
    expect(parseHhMm("16:00")).toBe(960);
  });

  it("should throw rather than silently accept a bad config value", () => {
    expect(() => parseHhMm("24:00")).toThrow();
    expect(() => parseHhMm("12:60")).toThrow();
    expect(() => parseHhMm("9:00")).toThrow();
    expect(() => parseHhMm("noon")).toThrow();
  });
});

describe("bangkokDayWindow", () => {
  it("should be the half-open Bangkok day in epoch seconds", () => {
    const { startS, endS } = bangkokDayWindow("2026-09-05");
    expect(startS).toBe(bkk("2026-09-05", "00:00:00"));
    expect(endS).toBe(bkk("2026-09-06", "00:00:00"));
    expect(endS - startS).toBe(86_400);
  });
});
