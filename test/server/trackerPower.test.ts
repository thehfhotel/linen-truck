// Tracker power findings at the boundaries (docs/CONTRACTS.md §3 rule 11, §8, §9):
// the loader that feeds the domain, the rules file, the report text and shape, the
// day page, the week page and the routes. The rule itself is in test/domain/power.test.ts.

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Point } from "../../src/domain/types.ts";
import { createApp } from "../../src/server/app.ts";
import { loadConfig, type Env } from "../../src/server/config.ts";
import { insertPoints, openDatabase, pointsBetween, pointsForDay, type PointRow } from "../../src/server/db.ts";
import { renderDayPage } from "../../src/server/pages/day.ts";
import { renderWeekPage } from "../../src/server/pages/week.ts";
import { buildDayReport, summaryOnly, type DayReport, type ReportFinding } from "../../src/server/report.ts";
import { DEFAULT_RULES, loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { FINDING_KIND, alarmLabels, powerReasonText, trackerAlarmText, trackerPowerText } from "../../src/shared/labels.ts";
import { HF, bkk, deliveryDay } from "../domain/support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEID = "1000000001";
const YMD = "2026-09-05";
const GENERATED_AT = 1788595367;
const SITES = loadSites();
const RULES = loadRules();
const T0 = bkk(YMD, "12:00:00");

const te = (battery: number, extra = 0): number => (((battery << 16) | 0x4000 | extra) >>> 0);

/** The synthetic delivery day with fixes 3-5 on backup battery (80 %, 60 %, 60 %) and fix 8 raising alarm 64 (over speed). */
function markedDay(): Point[] {
  return deliveryDay(T0).map((p, i) => {
    const marked: Point = { ...p, teState: te(100), alarm: 0 };
    if (i === 3) marked.teState = te(80);
    if (i === 4 || i === 5) marked.teState = te(60);
    if (i === 8) marked.alarm = 64;
    return marked;
  });
}

const reportFor = (points: Point[]): DayReport =>
  buildDayReport({
    teid: TEID,
    summary: summarizeDay(YMD, points, SITES, RULES),
    points,
    sites: SITES,
    rules: RULES,
    status: null,
    poll: null,
    pollerConfigured: true,
    generatedAt: GENERATED_AT,
  });

describe("the rules file", () => {
  const dirWith = (json: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "rules-"));
    writeFileSync(join(dir, "rules.json"), json);
    return dir;
  };

  test("an older rules.json keeps unpluggedVolts = 10, and an owner value wins", () => {
    expect(loadRules(dirWith('{ "gapS": 300 }')).unpluggedVolts).toBe(10);
    expect(loadRules(dirWith('{ "unpluggedVolts": 11 }')).unpluggedVolts).toBe(11);
    expect(loadRules(dirWith('{ "unpluggedVolts": "low" }')).unpluggedVolts).toBe(10);
    expect(DEFAULT_RULES.unpluggedVolts).toBe(10);
  });
});

describe("the loader feeds the domain", () => {
  const row = (t: number, teState: number | null, alarmState: number | null): PointRow => ({
    teid: TEID,
    t,
    lat: HF.lat,
    lon: HF.lon,
    speed: 0,
    direction: null,
    mileageM: null,
    carState: null,
    teState,
    alarmState: alarmState,
    voltage: 12.7,
    other: "Voltages=12.7",
  });

  test("pointsBetween and pointsForDay carry alarm_state and te_state, a high-bit word unsigned", () => {
    const db = openDatabase(":memory:");
    insertPoints(db, [row(T0, 0xe0644000, 8), row(T0 + 60, null, null)], T0);
    const [a, b] = pointsForDay(db, TEID, YMD);
    expect(a).toMatchObject({ alarm: 8, teState: 0xe0644000 });
    expect(b).toMatchObject({ alarm: null, teState: null });
    expect(pointsBetween(db, TEID, T0, T0 + 1)[0]).toMatchObject({ alarm: 8, teState: 0xe0644000 });
  });
});

describe("the report text", () => {
  test("a tracker-power sentence joins the reasons, with the worst battery and supply readings", () => {
    expect(trackerPowerText("14:02", "14:20", ["battery"], 80, null)).toEqual({
      th: "เครื่องติดตามอาจถูกถอดปลั๊ก 14:02–14:20 (ใช้แบตสำรอง เหลือ 80%)",
      en: "Tracker possibly unplugged 14:02–14:20 (on its backup battery, 80% left)",
    });
    expect(trackerPowerText("14:02", "14:20", ["battery", "power-cut", "on-battery", "shutdown", "low-supply"], 40, 3.94)).toEqual({
      th: "เครื่องติดตามอาจถูกถอดปลั๊ก 14:02–14:20 (ใช้แบตสำรอง เหลือ 40%, แจ้งเตือนไฟหลักถูกตัด, สถานะใช้แบตเตอรี่, สถานะปิดเครื่อง, ไฟเลี้ยงต่ำ 3.9 V)",
      en: "Tracker possibly unplugged 14:02–14:20 (on its backup battery, 40% left, main power cut alarm, battery-power status, shutdown status, supply collapsed to 3.9 V)",
    });
  });

  test("a run with no-supply reads the no-supply clause, last after low-supply", () => {
    expect(trackerPowerText("14:02", "14:20", ["no-supply"], null, null)).toEqual({
      th: "เครื่องติดตามอาจถูกถอดปลั๊ก 14:02–14:20 (ไม่มีค่าไฟเลี้ยง)",
      en: "Tracker possibly unplugged 14:02–14:20 (no supply reading)",
    });
    expect(trackerPowerText("14:02", "14:20", ["low-supply", "no-supply"], null, 3.94)).toEqual({
      th: "เครื่องติดตามอาจถูกถอดปลั๊ก 14:02–14:20 (ไฟเลี้ยงต่ำ 3.9 V, ไม่มีค่าไฟเลี้ยง)",
      en: "Tracker possibly unplugged 14:02–14:20 (supply collapsed to 3.9 V, no supply reading)",
    });
  });

  test("each reason has its own Thai and English clause", () => {
    expect(powerReasonText("no-supply", null, null)).toEqual({ th: "ไม่มีค่าไฟเลี้ยง", en: "no supply reading" });
    expect(powerReasonText("power-cut", null, null)).toEqual({ th: "แจ้งเตือนไฟหลักถูกตัด", en: "main power cut alarm" });
    expect(powerReasonText("on-battery", null, null)).toEqual({ th: "สถานะใช้แบตเตอรี่", en: "battery-power status" });
    expect(powerReasonText("shutdown", null, null)).toEqual({ th: "สถานะปิดเครื่อง", en: "shutdown status" });
    expect(powerReasonText("low-supply", null, 9)).toEqual({ th: "ไฟเลี้ยงต่ำ 9.0 V", en: "supply collapsed to 9.0 V" });
  });

  test("the alarm decode names every set bit, lowest first, and an unknown bit by its hex", () => {
    expect(alarmLabels(1)).toEqual([{ th: "ชน", en: "Bump" }]);
    expect(alarmLabels(2 | 4).map((l) => l.en)).toEqual(["Cut off circuit", "Fuel cut off"]);
    expect(alarmLabels(16 | 32 | 64 | 128).map((l) => l.en)).toEqual(["Out of fence", "Into fence", "Over speed", "SOS"]);
    expect(alarmLabels(128)[0]!.th).toBe("ขอความช่วยเหลือ (SOS)");
    expect(alarmLabels(32768 | 131072).map((l) => l.th)).toEqual(["แรงดันไฟต่ำ", "สั่นสะเทือน"]);
    expect(alarmLabels(16384).map((l) => l.en)).toEqual(["Steal"]);
    expect(alarmLabels(134217728).map((l) => l.en)).toEqual(["Steal"]);
    expect(alarmLabels(16384 | 134217728).map((l) => l.en)).toEqual(["Steal"]); // one word for two bits
    expect(alarmLabels(0x100000)).toEqual([{ th: "รหัส 0x100000", en: "code 0x100000" }]);
    expect(alarmLabels(0x80000000 + 64).map((l) => l.en)).toEqual(["Over speed", "code 0x80000000"]);
  });

  test("a tracker-alarm sentence lists the labels and the range", () => {
    expect(trackerAlarmText(alarmLabels(1 | 64), "14:02", "14:20")).toEqual({
      th: "เครื่องติดตามแจ้งเตือน: ชน, ขับเร็วเกิน (14:02–14:20)",
      en: "Tracker alarm: Bump, Over speed (14:02–14:20)",
    });
  });

  test("the finding headings", () => {
    expect(FINDING_KIND["tracker-power"]).toEqual({ th: "อาจถูกถอดปลั๊ก", en: "Possibly unplugged" });
    expect(FINDING_KIND["tracker-alarm"]).toEqual({ th: "แจ้งเตือนจากเครื่อง", en: "Tracker alarm" });
  });
});

describe("the DayReport", () => {
  const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
  const FIXTURE: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);

  test("findingCount always carries both new keys, 0 on the fixture", () => {
    const report = reportFor(FIXTURE);
    expect(report.summary.findingCount).toEqual({
      "unknown-stop": 0,
      detour: 1,
      "outside-hours": 0,
      "tracker-power": 0,
      "tracker-alarm": 0,
    });
    expect(report.findings.map((f) => f.kind)).toEqual(["detour"]);
    expect(summaryOnly(report).summary.findingCount).toHaveProperty("tracker-power", 0);
  });

  const marked = reportFor(markedDay());
  const power = marked.findings.find((f) => f.kind === "tracker-power") as Extract<ReportFinding, { kind: "tracker-power" }>;
  const alarm = marked.findings.find((f) => f.kind === "tracker-alarm") as Extract<ReportFinding, { kind: "tracker-alarm" }>;

  test("both findings come first, and are counted", () => {
    expect(marked.findings.slice(0, 2).map((f) => f.kind)).toEqual(["tracker-power", "tracker-alarm"]);
    expect(marked.summary.findingCount["tracker-power"]).toBe(1);
    expect(marked.summary.findingCount["tracker-alarm"]).toBe(1);
  });

  test("tracker-power carries the §9 fields", () => {
    // fixes 3..5 of the delivery day: 12:03, 12:04, 12:05 Bangkok
    expect(power).toEqual({
      kind: "tracker-power",
      text: {
        th: "เครื่องติดตามอาจถูกถอดปลั๊ก 12:03–12:05 (ใช้แบตสำรอง เหลือ 60%)",
        en: "Tracker possibly unplugged 12:03–12:05 (on its backup battery, 60% left)",
      },
      start: "12:03",
      end: "12:05",
      startAt: T0 + 180,
      endAt: T0 + 300,
      reasons: ["battery"],
      minBatteryPct: 60,
      minVoltage: null,
      fixes: 3,
      mapUrl: power.mapUrl,
    });
    expect(power.mapUrl).toMatch(/^https:\/\/www\.google\.com\/maps\?q=9\.\d{5},99\.\d{5}$/);
  });

  test("tracker-alarm carries the §9 fields", () => {
    expect(alarm).toEqual({
      kind: "tracker-alarm",
      text: {
        th: `เครื่องติดตามแจ้งเตือน: ขับเร็วเกิน (${alarm.start}–${alarm.end})`,
        en: `Tracker alarm: Over speed (${alarm.start}–${alarm.end})`,
      },
      start: alarm.start,
      end: alarm.end,
      startAt: T0 + 480,
      endAt: T0 + 480,
      code: 64,
      labels: [{ th: "ขับเร็วเกิน", en: "Over speed" }],
      fixes: 1,
      mapUrl: alarm.mapUrl,
    });
    // a single-fix run keeps the range, like every other finding sentence
    expect(alarm.start).toBe(alarm.end);
  });

  test("nothing but the two new kinds and their counts changed against the same day without the words", () => {
    const plain = reportFor(deliveryDay(T0));
    expect(marked.findings.slice(2)).toEqual(plain.findings);
    expect(marked.trips).toEqual(plain.trips);
    expect(marked.stops).toEqual(plain.stops);
    expect(marked.summary.km).toBe(plain.summary.km);
  });
});

describe("the day page", () => {
  const html = (report: DayReport): string =>
    renderDayPage({ report, sites: SITES, nonce: "test-nonce", prevYmd: "2026-09-04", nextYmd: null, todayYmd: YMD });

  test("renders both kinds as findings with a Maps link, first in the list", () => {
    const page = html(reportFor(markedDay()));
    expect(page).toContain('<li class="tracker-power">');
    expect(page).toContain('<li class="tracker-alarm">');
    const list = page.slice(page.indexOf('<ul class="findings">'), page.indexOf("</ul>", page.indexOf('<ul class="findings">')));
    expect(list.indexOf("tracker-power")).toBeLessThan(list.indexOf("tracker-alarm"));
    // the delivery day also raises an unknown stop: the two new kinds sit ahead of it
    expect(list.indexOf("tracker-alarm")).toBeLessThan(list.indexOf('class="unknown-stop"'));
    for (const kind of ["tracker-power", "tracker-alarm"]) {
      const li = list.slice(list.indexOf(`<li class="${kind}">`), list.indexOf("</li>", list.indexOf(`<li class="${kind}">`)));
      expect(li).toMatch(/<a href="https:\/\/www\.google\.com\/maps\?q=[^"]+" rel="noreferrer noopener" target="_blank">/);
    }
    expect(list).toContain("เครื่องติดตามอาจถูกถอดปลั๊ก 12:03–12:05");
    expect(list).toContain("Tracker alarm: Over speed");
  });

  test("styles them as the most serious through a class, never a style attribute", () => {
    const page = html(reportFor(markedDay()));
    expect(page).toContain("ul.findings li.tracker-power");
    expect(page).toContain("ul.findings li.tracker-alarm");
    expect(page).not.toMatch(/<li[^>]*style=/);
    expect(page).not.toMatch(/<a[^>]*style=/);
  });

  test("escapes every interpolated value of a finding", () => {
    const evil = '<img src=x onerror=alert(1)>"&';
    const report = reportFor([]);
    report.findings = [
      {
        kind: "tracker-power",
        text: { th: evil, en: evil },
        start: "12:00",
        end: "12:01",
        startAt: 1,
        endAt: 2,
        reasons: ["battery"],
        minBatteryPct: 1,
        minVoltage: null,
        fixes: 1,
        mapUrl: `https://example.test/?q=${evil}`,
      },
      {
        kind: "tracker-alarm",
        text: { th: evil, en: evil },
        start: "12:00",
        end: "12:01",
        startAt: 1,
        endAt: 2,
        code: 1,
        labels: [],
        fixes: 1,
        mapUrl: `https://example.test/?q=${evil}`,
      },
    ];
    const list = html(report);
    const items = list.slice(list.indexOf('<ul class="findings">'), list.indexOf("</ul>", list.indexOf('<ul class="findings">')));
    expect(items).not.toContain("<img");
    expect(items).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&amp;");
  });
});

describe("the week page", () => {
  test("counts both kinds in the day's findings cell", () => {
    const day = summaryOnly(reportFor(markedDay()));
    const page = renderWeekPage({ days: [day], sites: SITES, nonce: "n", ymd: YMD, todayYmd: YMD });
    expect(page).toContain("อาจถูกถอดปลั๊ก 1");
    expect(page).toContain("แจ้งเตือนจากเครื่อง 1");
    const clean = renderWeekPage({ days: [summaryOnly(reportFor([]))], sites: SITES, nonce: "n", ymd: YMD, todayYmd: YMD });
    expect(clean).not.toContain("อาจถูกถอดปลั๊ก");
  });
});

describe("the routes read the stored words end to end", () => {
  const NOW = new Date(GENERATED_AT * 1000);
  const config = (extra: Env = {}) =>
    loadConfig({ DATA_DIR: "./data", SINOTRACK_USER: TEID, SINOTRACK_PASSWORD: "x", ALLOW_DEV_AUTH: "1", FEED_TOKEN: "feed-secret", ...extra });
  const app = (db: Database) => createApp(db, { config: config(), now: () => NOW, sites: SITES, rules: RULES });
  const staff = (path: string): Request => new Request(`http://truck.local${path}`, { headers: { "x-dev-email": "owner@example.com" } });

  function seeded(): Database {
    const db = openDatabase(":memory:");
    const rows: PointRow[] = markedDay().map((p) => ({
      teid: TEID,
      t: p.t,
      lat: p.lat,
      lon: p.lon,
      speed: p.speed,
      direction: null,
      mileageM: null,
      carState: null,
      teState: p.teState ?? null,
      alarmState: p.alarm ?? null,
      voltage: p.voltage,
      other: p.voltage === null ? null : `Voltages=${p.voltage}`,
    }));
    insertPoints(db, rows, T0);
    return db;
  }

  test("/api/day and /feed/daily carry the findings and the counts", async () => {
    for (const path of [`/api/day/${YMD}`]) {
      const res = await app(seeded()).handle(staff(path));
      const body = (await res.json()) as DayReport;
      expect(body.findings.slice(0, 2).map((f) => f.kind)).toEqual(["tracker-power", "tracker-alarm"]);
      expect(body.summary.findingCount["tracker-power"]).toBe(1);
      expect(body.summary.findingCount["tracker-alarm"]).toBe(1);
    }
    const feed = await app(seeded()).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { authorization: "Bearer feed-secret" } }),
    );
    const body = (await feed.json()) as DayReport;
    expect(body.findings[0]!.text.en).toContain("Tracker possibly unplugged");
  });

  test("/api/week keeps them in the summary rows, and /week renders the counts", async () => {
    const res = await app(seeded()).handle(staff(`/api/week/${YMD}`));
    const days = ((await res.json()) as { days: DayReport[] }).days;
    expect(days[6]!.summary.findingCount["tracker-power"]).toBe(1);
    expect(days[6]!.findings.map((f) => f.kind)).toContain("tracker-alarm");
    const page = await (await app(seeded()).handle(staff(`/week/${YMD}`))).text();
    expect(page).toContain("อาจถูกถอดปลั๊ก 1");
  });
});
