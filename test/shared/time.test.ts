// The Thai date helpers the day page's headings and stop rows read.

import { describe, expect, test } from "bun:test";
import { thaiDateTime, thaiLongDate, thaiShortDate } from "../../src/shared/time.ts";

describe("Thai dates (Gregorian year, matching the page header)", () => {
  test("short date has no zero padding", () => {
    expect(thaiShortDate("2026-09-30")).toBe("30 ก.ย.");
    expect(thaiShortDate("2026-09-05")).toBe("5 ก.ย.");
  });

  test("long date adds the Gregorian year", () => {
    expect(thaiLongDate("2026-09-30")).toBe("30 ก.ย. 2026");
  });

  test("all twelve month abbreviations", () => {
    const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    months.forEach((m, i) => {
      const mm = String(i + 1).padStart(2, "0");
      expect(thaiShortDate(`2026-${mm}-15`)).toBe(`15 ${m}`);
    });
  });

  test("a malformed day is refused", () => {
    expect(() => thaiShortDate("2026-9-30")).toThrow(RangeError);
    expect(() => thaiLongDate("nope")).toThrow(RangeError);
  });

  test("an instant reads in Bangkok, across the UTC date line", () => {
    // 2026-09-29T17:34:00Z is 2026-09-30 00:34 in Bangkok.
    expect(thaiDateTime("2026-09-29T17:34:00.000Z")).toBe("30 ก.ย. 00:34");
    expect(thaiDateTime("2026-09-29T07:34:00.000Z")).toBe("29 ก.ย. 14:34");
  });
});
