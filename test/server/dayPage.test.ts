// The day page's trip/stop filter (feature: filter the day map by trip or
// stop). Renders the real page HTML off the real fixture and asserts on the
// chip row and the data attributes the client script (day.ts's MAP_SCRIPT)
// selects on — no browser here, that lives in the Playwright check under
// scratchpad/pw; this is the fast, no-network regression net.

import { describe, expect, test } from "bun:test";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { StopSpan } from "../../src/domain/span.ts";
import type { Point } from "../../src/domain/types.ts";
import { buildDayReport } from "../../src/server/report.ts";
import { MAP_SCRIPT, renderDayPage } from "../../src/server/pages/day.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { HF, HFVILLE, bkk, lerp, northOf, parked, pt } from "../domain/support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

const TEID = "1000000001";
const GENERATED_AT = 1788595367;
const SITES = loadSites();
const RULES = loadRules();

/**
 * The day page for `points`. With `tweak`, the report is built with stop spans:
 * every stop starts from its own (identity) span and `tweak` edits them — the
 * page tests state only the span facts they are about.
 */
function pageFor(ymd: string, points: Point[], tweak?: (spans: StopSpan[]) => void): string {
  const summary = summarizeDay(ymd, points, SITES, RULES);
  let spans: StopSpan[] | undefined;
  if (tweak) {
    spans = summary.stops.map((s) => ({
      arriveAt: s.arrive,
      arriveOpen: false,
      departAt: s.depart,
      engineOffAt: s.engine.offAt,
      engineOnAt: s.engine.onAt,
    }));
    tweak(spans);
  }
  const report = buildDayReport({
    teid: TEID,
    summary,
    points,
    sites: SITES,
    rules: RULES,
    status: null,
    poll: null,
    pollerConfigured: true,
    generatedAt: GENERATED_AT,
    ...(spans ? { spans } : {}),
  });
  return renderDayPage({
    report,
    sites: SITES,
    nonce: "test-nonce",
    prevYmd: "2026-09-04",
    nextYmd: null,
    todayYmd: ymd,
  });
}

describe("the day page's chip row and data attributes", () => {
  const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
  const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);
  const html = pageFor("2026-09-05", POINTS);

  test('one chip for "All day" plus one per trip (4 trips on the fixture)', () => {
    const chipMatches = html.match(/class="chip( active)?"/g) ?? [];
    expect(chipMatches).toHaveLength(5);
    expect(html).toContain('data-select="all"');
    for (let n = 1; n <= 4; n++) expect(html).toContain(`data-select="trip-${n}"`);
  });

  test('the "All day" chip renders active by default and carries both languages', () => {
    expect(html).toMatch(/<button type="button" class="chip active" data-select="all"[^>]*>ทั้งวัน · All day<\/button>/);
  });

  test("every trip row carries data-trip and a keyboard-focusable button, not just a click zone", () => {
    for (let n = 1; n <= 4; n++) {
      expect(html).toContain(`<tr data-trip="${n}">`);
      expect(html).toContain(`data-select="trip-${n}"`);
    }
    expect(html).toContain('<button type="button" class="rowlink"');
  });

  test("every stop row carries a data-stop index matching its position in the stops table", () => {
    for (let i = 0; i < 5; i++) expect(html).toContain(`<tr data-stop="${i}"`);
  });

  test("the detour finding carries data-trips and a trip-select button", () => {
    // One trip, not two: with the 600 m fence the 14:18 stop is HF Ville, so the
    // hf → hfville leg no longer walks through an unknown stop (§3 rules 5–6).
    expect(html).toMatch(/<li class="detour" data-trips="3">/);
    expect(html).toContain('data-select="trip-3"');
  });

  test("this day raises no unknown stop, so no finding claims a stop row", () => {
    expect(html).not.toContain('class="unknown-stop"');
  });

  test("no stray template artefacts reach the page (every interpolation resolved)", () => {
    expect(html).not.toContain("[object Object]");
  });
});

// The fixture has had no unknown stop since the geofences widened to 600 m, so
// the `data-stop` wiring between a finding and its stop row needs a day that
// does: parked at HF, five minutes at nowhere, parked at HF Ville.
describe("an unknown-stop finding and its stop row", () => {
  const T = bkk("2026-09-03", "12:00:00");
  const nowhere = lerp(HF, HFVILLE, 0.5);
  const html = pageFor("2026-09-03", [
    ...parked(T, HF, 11, 60, { voltage: 12.7 }),
    pt(T + 660, lerp(HF, HFVILLE, 0.25), { speed: 40, voltage: 13.8 }),
    ...parked(T + 720, nowhere, 6, 60, { voltage: 13.8 }),
    pt(T + 1140, lerp(HF, HFVILLE, 0.75), { speed: 55, voltage: 13.8 }),
    ...parked(T + 1200, HFVILLE, 11, 60, { voltage: 12.7 }),
  ]);

  test("the finding carries data-stop for the same index its stop row uses", () => {
    expect(html).toMatch(/<li class="unknown-stop" data-stop="1">/);
    expect(html).toContain('data-select="stop-1"');
    expect(html).toContain('<tr data-stop="1"');
  });
});

// The engine badge and the engine-times column (owner ask, 2026-09-06): every
// stop row says whether the truck was parked with the engine off or merely
// halted with it running, and when the ignition went off and came back.
describe("the stops table's engine badge and times", () => {
  const RAW: Record<string, string>[] = rawRows as unknown as Record<string, string>[];
  const POINTS: Point[] = RAW.map(pointFromRow).filter((p): p is Point => p !== null);
  const fixture = pageFor("2026-09-05", POINTS);

  test("the stops table gains an engine off → on column", () => {
    expect(fixture).toContain("ดับ → ติดเครื่อง");
  });

  test("the morning HF Ville stop shows both its engine times", () => {
    // Dated since 2026-09-30 (stop spans): the engine cell reads the span values.
    expect(fixture).toContain("5 ก.ย. 12:27 → 5 ก.ย. 13:32");
  });

  test("a stop the engine never restarted in shows the off time and an open arrow", () => {
    expect(fixture).toContain("5 ก.ย. 14:28 →</td>");
  });

  test("every parked stop of the fixture carries the parked badge", () => {
    // Scoped to the stops table: the map-data blob ships BOTH badge words to the
    // client script, so a whole-page `not.toContain` would prove nothing.
    const from = fixture.indexOf('<tr data-stop="0"');
    const stopsTable = fixture.slice(from, fixture.indexOf("</tbody>", from));
    const badges = stopsTable.match(/จอด\/ดับเครื่อง/g) ?? [];
    expect(badges.length).toBeGreaterThanOrEqual(4); // the day's four real stops
    expect(stopsTable).not.toContain("จอด/เครื่องติด"); // nothing idled through a stop
  });

  test("the virtual book-end gets no badge and no engine times", () => {
    const firstRow = fixture.slice(fixture.indexOf('<tr data-stop="0"'), fixture.indexOf('<tr data-stop="1"'));
    expect(firstRow).not.toContain("จอด/ดับเครื่อง");
    expect(firstRow).not.toContain("จอด/เครื่องติด");
    expect(firstRow).toContain("—");
  });

  test("a stop the truck idled through carries the engine-running badge instead", () => {
    // The synthetic 2026-09-03 day: HF and HF Ville parked at 12.7 V, the stop at
    // nowhere idling at 13.8 V.
    const T = bkk("2026-09-03", "12:00:00");
    const html = pageFor("2026-09-03", [
      ...parked(T, HF, 11, 60, { voltage: 12.7 }),
      pt(T + 660, lerp(HF, HFVILLE, 0.25), { speed: 40, voltage: 13.8 }),
      ...parked(T + 720, lerp(HF, HFVILLE, 0.5), 6, 60, { voltage: 13.8 }),
      pt(T + 1140, lerp(HF, HFVILLE, 0.75), { speed: 55, voltage: 13.8 }),
      ...parked(T + 1200, HFVILLE, 11, 60, { voltage: 12.7 }),
    ]);
    expect(html).toContain("จอด/เครื่องติด");
    expect(html).toContain("จอด/ดับเครื่อง");
    // …and the finding sentence says it too (§9 text, one source for both).
    expect(html).toContain("เครื่องติด</span>");
  });

  test("the map script is told both badge words, so a popup can show them", () => {
    expect(fixture).toContain("จอด/ดับเครื่อง");
    const mapData = fixture.slice(fixture.indexOf('id="map-data"'));
    expect(mapData).toContain("stopParked");
    expect(mapData).toContain("stopRunning");
  });
});

describe("a day with no points", () => {
  const html = pageFor("2026-09-04", []);

  test('renders only the "All day" chip and no trip rows', () => {
    const chipMatches = html.match(/class="chip( active)?"/g) ?? [];
    expect(chipMatches).toHaveLength(1);
    expect(html).toContain('data-select="all"');
    expect(html).not.toContain("data-select=\"trip-");
    expect(html).not.toContain("<tr data-trip=");
  });
});

// ── stop dates (owner decisions 2026-09-30) ───────────────────────────────────
//
// The fixture day is 2026-09-05: stops are [track-start 12:11, HF Ville 12:24–13:34,
// HF 13:48–14:06, HF Ville 14:18–14:22, HF Ville 14:26–15:11]. Spans are edited by
// hand so each case says exactly which real-world fact it stands for.

const RAW_POINTS: Point[] = (rawRows as unknown as Record<string, string>[])
  .map(pointFromRow)
  .filter((p): p is Point => p !== null);

/** The `<tr data-stop="i">…</tr>` markup of one stop row. */
const stopRowHtml = (html: string, i: number): string => {
  const from = html.indexOf(`<tr data-stop="${i}"`);
  return html.slice(from, html.indexOf("</tr>", from));
};

const mapDataOf = (html: string): { views: Record<string, string> } & Record<string, unknown> => {
  const m = /<script type="application\/json" id="map-data"[^>]*>(.*?)<\/script>/s.exec(html);
  return JSON.parse(m![1]!);
};

/** Every value a `data-select` attribute takes anywhere on the page. */
const selectKeys = (html: string): string[] => [...new Set([...html.matchAll(/data-select="([^"]+)"/g)].map((m) => m[1]!))];

describe("the stops table shows true, dated arrival and departure", () => {
  const T = (ymd: string, hhmm: string) => bkk(ymd, `${hhmm}:00`);
  const html = pageFor("2026-09-05", RAW_POINTS, (spans) => {
    // HF Ville really arrived the evening before, and the window starts inside it.
    spans[1] = { ...spans[1]!, arriveAt: T("2026-09-04", "23:30"), arriveOpen: true };
    // The last HF Ville stop has no departure in the data: the truck is still there.
    spans[4] = { ...spans[4]!, departAt: null };
  });
  const plain = pageFor("2026-09-05", RAW_POINTS, () => {});

  test("the arrive cell is the rowlink button with the dated span arrival, prefixed ก่อน when open", () => {
    expect(stopRowHtml(html, 1)).toMatch(/<td><button type="button" class="rowlink" data-select="stop-1"[^>]*>ก่อน 4 ก\.ย\. 23:30<\/button><\/td>/);
  });

  test("the depart cell carries date and time", () => {
    expect(stopRowHtml(html, 1)).toContain("<td>5 ก.ย. 13:34</td>");
  });

  test("dates appear on every row, same-day ones included", () => {
    expect(stopRowHtml(html, 2)).toContain(">5 ก.ย. 13:48</button>");
    expect(stopRowHtml(html, 2)).toContain("<td>5 ก.ย. 14:06</td>");
    expect(stopRowHtml(html, 3)).toContain(">5 ก.ย. 14:18</button>");
  });

  test("a stop with no departure reads ยังจอดอยู่ with both languages in its title", () => {
    expect(stopRowHtml(html, 4)).toContain('<td title="ยังจอดอยู่ · still parked">ยังจอดอยู่</td>');
  });

  test("minutes get * where the stop runs past the day, and only there", () => {
    expect(stopRowHtml(html, 1)).toContain('<td class="num">70*</td>'); // arrival before the day
    expect(stopRowHtml(html, 4)).toContain('<td class="num">44*</td>'); // still parked
    expect(stopRowHtml(html, 2)).toContain('<td class="num">18</td>');
    expect(stopRowHtml(html, 3)).toContain('<td class="num">4</td>');
  });

  test("a departure after the day's own also stars the minutes", () => {
    const later = pageFor("2026-09-05", RAW_POINTS, (spans) => {
      spans[3] = { ...spans[3]!, departAt: T("2026-09-06", "01:00") };
    });
    expect(stopRowHtml(later, 3)).toContain('<td class="num">4*</td>');
    expect(stopRowHtml(later, 3)).toContain("<td>6 ก.ย. 01:00</td>");
  });

  test("the footnote is rendered when any row is starred", () => {
    expect(html).toContain("* นับเฉพาะเวลาในวันนี้ · * minutes within this day only");
  });

  test("no star, no footnote when every stop lies inside the day", () => {
    expect(plain).not.toContain("* นับเฉพาะเวลาในวันนี้");
    expect(plain).not.toMatch(/<td class="num">\d+\*<\/td>/);
  });

  test("the engine off → on cell keeps its rules but reads the dated span values", () => {
    expect(stopRowHtml(html, 1)).toContain("5 ก.ย. 12:27 → 5 ก.ย. 13:32");
    expect(stopRowHtml(html, 4)).toContain("5 ก.ย. 14:28 →</td>"); // no restart in the stop
    expect(stopRowHtml(html, 0)).toContain("<td>—</td>"); // virtual book-end: no off event
  });

  test("an engine event on another day carries that day's date", () => {
    const carried = pageFor("2026-09-05", RAW_POINTS, (spans) => {
      spans[1] = { ...spans[1]!, engineOffAt: T("2026-09-04", "23:45") };
    });
    expect(stopRowHtml(carried, 1)).toContain("4 ก.ย. 23:45 → 5 ก.ย. 13:32");
  });

  test("place, badge and minutes columns are otherwise as before", () => {
    expect(stopRowHtml(html, 1)).toContain(">HF Ville</a>");
    expect(stopRowHtml(html, 1)).toContain("จอด/ดับเครื่อง");
    expect(stopRowHtml(html, 0)).toContain("เริ่มบันทึก");
  });
});

describe("the date in the section headings", () => {
  const html = pageFor("2026-09-05", RAW_POINTS);

  test("Trips, Stops and Route each carry the viewed date in an .hdate span", () => {
    for (const heading of [
      'เที่ยววิ่ง <span class="pair-en">· Trips</span>',
      'จุดจอด <span class="pair-en">· Stops</span>',
      'เส้นทาง <span class="pair-en">· Route</span>',
    ]) {
      expect(html).toContain(`<h2>${heading} <span class="hdate">5 ก.ย. 2026</span></h2>`);
    }
  });

  test("the other headings are left alone", () => {
    expect((html.match(/class="hdate"/g) ?? []).length).toBe(3);
  });

  test("the style is in the nonce'd block and no style= attribute is ever emitted", () => {
    expect(html).toMatch(/<style nonce="test-nonce">[\s\S]*\.hdate[\s\S]*<\/style>/);
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("the Viewing line and the map-data views", () => {
  const html = pageFor("2026-09-05", RAW_POINTS, (spans) => {
    spans[1] = { ...spans[1]!, arriveAt: bkk("2026-09-04", "23:30:00"), arriveOpen: true };
    spans[4] = { ...spans[4]!, departAt: null };
  });
  const { views } = mapDataOf(html);

  test("the line sits between the chips and the map and works without JS", () => {
    const chips = html.indexOf('id="trip-chips"');
    const line = html.indexOf('<p class="viewing" id="map-view">');
    const map = html.indexOf('<div id="map"');
    expect(chips).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(chips);
    expect(map).toBeGreaterThan(line);
    expect(html).toContain(
      '<p class="viewing" id="map-view">กำลังดู <span class="pair-en">· Viewing</span>: <span id="map-view-text">ทั้งวัน · 5 ก.ย. 2026</span></p>',
    );
  });

  test("all, and every trip", () => {
    expect(views.all).toBe("ทั้งวัน · 5 ก.ย. 2026");
    expect(views["trip-1"]).toBe("เที่ยว 1 · Trip 1 · 5 ก.ย. 12:11–12:24");
    expect(views["trip-3"]).toMatch(/^เที่ยว 3 · Trip 3 · 5 ก\.ย\. \d\d:\d\d–\d\d:\d\d$/);
  });

  test("a stop that began on an earlier date and is open: dated on both ends", () => {
    expect(views["stop-1"]).toBe("HF Ville · ก่อน 4 ก.ย. 23:30 – 5 ก.ย. 13:34");
  });

  test("a stop inside one date: one date, an unspaced range", () => {
    expect(views["stop-2"]).toBe("โรงแรม HF · 5 ก.ย. 13:48–14:06");
  });

  test("a stop still parked", () => {
    expect(views["stop-4"]).toBe("HF Ville · 5 ก.ย. 14:26 – ยังจอดอยู่");
  });

  test("a virtual book-end is a single instant, not a range", () => {
    expect(views["stop-0"]).toBe("เริ่มบันทึก · 5 ก.ย. 12:11");
  });

  test("every data-select key the page renders has a view (fixture day)", () => {
    const keys = selectKeys(html);
    expect(keys.length).toBeGreaterThan(8);
    for (const k of keys) expect(views).toHaveProperty(k);
  });

  test("…including detour legs through an unknown stop, and unknown-stop findings", () => {
    // HF → an unknown stop 2.5 km off the road → HF Ville: one leg of two trips,
    // long enough to be a detour, so the finding selects `trip-1-2`.
    const T = bkk("2026-09-03", "12:00:00");
    const nowhere = northOf(lerp(HF, HFVILLE, 0.5), 2500);
    const synthetic = pageFor("2026-09-03", [
      ...parked(T, HF, 11, 60, { voltage: 12.7 }),
      pt(T + 660, lerp(HF, HFVILLE, 0.25), { speed: 40, voltage: 13.8 }),
      ...parked(T + 720, nowhere, 6, 60, { voltage: 13.8 }),
      pt(T + 1140, lerp(HF, HFVILLE, 0.75), { speed: 55, voltage: 13.8 }),
      ...parked(T + 1200, HFVILLE, 11, 60, { voltage: 12.7 }),
    ]);
    const keys = selectKeys(synthetic);
    expect(keys).toContain("trip-1-2");
    expect(keys).toContain("stop-1");
    const v = mapDataOf(synthetic).views;
    for (const k of keys) expect(v).toHaveProperty(k);
    expect(v["trip-1-2"]).toMatch(/^เที่ยว 1 · Trip 1 \+ เที่ยว 2 · Trip 2 · 3 ก\.ย\. 12:10–12:20$/);
    expect(v["stop-1"]).toBe("ไม่รู้จัก · 3 ก.ย. 12:12–12:17");
  });

  test("an empty day still has views.all", () => {
    const empty = pageFor("2026-09-04", []);
    expect(mapDataOf(empty).views).toEqual({ all: "ทั้งวัน · 4 ก.ย. 2026" });
    expect(empty).toContain('<span id="map-view-text">ทั้งวัน · 4 ก.ย. 2026</span>');
  });

  test("view text goes through escapeHtml in the line and the JSON block", () => {
    expect(html).not.toContain("</script><");
    expect(html).not.toContain("[object Object]");
  });
});

// ── the client script, run against a fake DOM ────────────────────────────────

/** A permissive stand-in for Leaflet: every call answers with itself, except the few that decide flow. */
function leafletStub(popups: string[] = []): unknown {
  const stub: unknown = new Proxy(function () {}, {
    get: (_t, key) => {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key === "bindPopup")
        return (html: unknown) => {
          popups.push(String(html));
          return stub;
        };
      if (key === "isValid") return () => false;
      if (key === "getZoom") return () => 10;
      return stub;
    },
    apply: () => stub,
  });
  return stub;
}

interface FakeNode {
  attrs: Record<string, string>;
  click: (() => void)[];
}

async function runMapScript(opts: {
  hash: string;
  views: Record<string, string>;
  selectKeys: string[];
  /** The `stopText` of map-data, when the page has it. */
  stopText?: unknown[];
  /** The `stops` `/api/day` answers with. */
  stops?: unknown[];
}) {
  const popups: string[] = [];
  const viewEl = { textContent: "ทั้งวัน · initial" };
  const mapEl = { getAttribute: (k: string) => (k === "data-ymd" ? "2026-09-05" : null) };
  const dataEl = { textContent: JSON.stringify({
      sites: [],
      txt: { unknown: "ไม่รู้จัก", minutes: "นาที", stopParked: "จอด/ดับเครื่อง", stopRunning: "จอด/เครื่องติด" },
      views: opts.views,
      ...(opts.stopText ? { stopText: opts.stopText } : {}),
    }) };
  const nodes: FakeNode[] = opts.selectKeys.map((k) => ({ attrs: { "data-select": k }, click: [] }));
  const listeners: Record<string, (() => void)[]> = {};
  const win = {
    location: { hash: opts.hash },
    addEventListener: (ev: string, fn: () => void) => (listeners[ev] ??= []).push(fn),
  };
  const doc = {
    getElementById: (id: string) => ({ map: mapEl, "map-data": dataEl, "map-view-text": viewEl })[id] ?? null,
    querySelectorAll: (sel: string) =>
      sel === "[data-select]"
        ? nodes.map((n) => ({
            getAttribute: (k: string) => n.attrs[k],
            addEventListener: (_ev: string, fn: (e: unknown) => void) => n.click.push(() => fn({ preventDefault() {} })),
          }))
        : [],
  };
  const fetchStub = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ path: [], trips: [], stops: opts.stops ?? [] }) });
  new Function("document", "window", "L", "fetch", "history", "console", MAP_SCRIPT)(
    doc,
    win,
    leafletStub(popups),
    fetchStub,
    { replaceState() {} },
    { error() {} },
  );
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return {
    popups,
    text: () => viewEl.textContent,
    click: (key: string) => nodes.find((n) => n.attrs["data-select"] === key)!.click.forEach((f) => f()),
    hashchange: (hash: string) => {
      win.location.hash = hash;
      (listeners.hashchange ?? []).forEach((f) => f());
    },
  };
}

describe("the Viewing line's client script", () => {
  const views = {
    all: "ทั้งวัน · 5 ก.ย. 2026",
    "trip-2": "เที่ยว 2 · Trip 2 · 5 ก.ย. 13:46–13:54",
    "trip-2-3": "combined",
    "stop-1": "HF Ville · 5 ก.ย. 12:24 – 5 ก.ย. 13:34",
  };
  const keys = Object.keys(views);

  test("is ES5: no template literals, no arrow functions", () => {
    expect(MAP_SCRIPT).not.toContain("`");
    expect(MAP_SCRIPT).not.toContain("=>");
  });

  test("never writes the label with innerHTML", () => {
    expect(MAP_SCRIPT).toContain("textContent");
    expect(MAP_SCRIPT).not.toMatch(/map-view[^;]*innerHTML/);
  });

  test("a hash applied on load sets the label", async () => {
    const run = await runMapScript({ hash: "#trip-2", views, selectKeys: keys });
    expect(run.text()).toBe(views["trip-2"]);
  });

  test("no hash: the all label", async () => {
    const run = await runMapScript({ hash: "", views, selectKeys: keys });
    expect(run.text()).toBe(views.all);
  });

  test("a click on a chip, a row or a finding button changes the label", async () => {
    const run = await runMapScript({ hash: "", views, selectKeys: keys });
    run.click("stop-1");
    expect(run.text()).toBe(views["stop-1"]);
    run.click("trip-2-3");
    expect(run.text()).toBe("combined");
    run.click("all");
    expect(run.text()).toBe(views.all);
  });

  test("a hashchange (back button, pasted link) changes the label", async () => {
    const run = await runMapScript({ hash: "", views, selectKeys: keys });
    run.hashchange("#trip-2");
    expect(run.text()).toBe(views["trip-2"]);
  });

  test("an unknown key falls back to the all label", async () => {
    const run = await runMapScript({ hash: "#nonsense", views, selectKeys: keys });
    expect(run.text()).toBe(views.all);
    run.hashchange("#stop-99");
    expect(run.text()).toBe(views.all);
    run.hashchange("#constructor");
    expect(run.text()).toBe(views.all);
  });

  test("a page whose map-data predates views leaves the server-rendered text alone", async () => {
    const run = await runMapScript({ hash: "#trip-2", views: {} as Record<string, string>, selectKeys: [] });
    expect(run.text()).toBe("ทั้งวัน · initial");
  });
});

// ── the stop popup speaks the same words as the table and the Viewing line ────

describe("stopText in map-data", () => {
  const html = pageFor("2026-09-05", RAW_POINTS, (spans) => {
    spans[1] = { ...spans[1]!, arriveAt: bkk("2026-09-04", "23:30:00"), arriveOpen: true };
    spans[4] = { ...spans[4]!, departAt: null };
  });
  const data = mapDataOf(html) as unknown as {
    stopText: { place: string; range: string; engine: string; past: boolean }[];
    views: Record<string, string>;
  };

  test("one entry per stop, in the stops table's order", () => {
    expect(data.stopText).toHaveLength(5);
    expect(data.stopText.map((e) => e.place)).toEqual(["เริ่มบันทึก", "HF Ville", "โรงแรม HF", "HF Ville", "HF Ville"]);
  });

  test("the range is exactly the Viewing line's range", () => {
    data.stopText.forEach((e, i) => expect(data.views[`stop-${i}`]).toBe(`${e.place} · ${e.range}`));
  });

  test("a stop carried in from the evening before, and one still parked", () => {
    expect(data.stopText[1]!.range).toBe("ก่อน 4 ก.ย. 23:30 – 5 ก.ย. 13:34");
    expect(data.stopText[4]!.range).toBe("5 ก.ย. 14:26 – ยังจอดอยู่");
  });

  test("past is the table's * rule, computed once on the server", () => {
    expect(data.stopText.map((e) => e.past)).toEqual([false, true, false, false, true]);
    // …and it agrees with the rows the table starred.
    for (const [i, e] of data.stopText.entries()) {
      expect(/<td class="num">\d+\*<\/td>/.test(stopRowHtml(html, i))).toBe(e.past);
    }
  });

  test("the engine text is plain, unescaped and dated; empty with no off event", () => {
    expect(data.stopText[1]!.engine).toBe("5 ก.ย. 12:27 → 5 ก.ย. 13:32");
    expect(data.stopText[4]!.engine).toBe("5 ก.ย. 14:28 →");
    expect(data.stopText[0]!.engine).toBe("");
    for (const e of data.stopText) expect(e.engine).not.toContain("&");
  });

  test("an empty day has an empty stopText", () => {
    expect((mapDataOf(pageFor("2026-09-04", [])) as unknown as { stopText: unknown[] }).stopText).toEqual([]);
  });
});

describe("the stop popup, executed", () => {
  const apiStop = { site: "hfville", lat: 9.12, lon: 99.35, engine: "parked", engineOffAt: "00:04", engineOnAt: null, arrive: "00:04", depart: "13:04", minutes: 780 };

  test("uses the precomputed span text: escaped, starred when past the day, then the badge and engine line", async () => {
    const run = await runMapScript({
      hash: "",
      views: { all: "x" },
      selectKeys: [],
      stops: [apiStop],
      stopText: [{ place: "HF <Ville>", range: "29 ก.ย. 14:34 – 30 ก.ย. 13:04", engine: "29 ก.ย. 14:34 →", past: true }],
    });
    expect(run.popups).toEqual([
      "<b>HF &lt;Ville&gt;</b><br>29 ก.ย. 14:34 – 30 ก.ย. 13:04 (780* นาที)<br>จอด/ดับเครื่อง 29 ก.ย. 14:34 →",
    ]);
  });

  test("no star when the stop lies inside the day, no engine text when there is none", async () => {
    const run = await runMapScript({
      hash: "",
      views: { all: "x" },
      selectKeys: [],
      stops: [{ ...apiStop, engine: "running", engineOffAt: null }],
      stopText: [{ place: "โรงแรม HF", range: "5 ก.ย. 13:48–14:06", engine: "", past: false }],
    });
    expect(run.popups).toEqual(["<b>โรงแรม HF</b><br>5 ก.ย. 13:48–14:06 (780 นาที)<br>จอด/เครื่องติด"]);
  });

  test("an entry that is missing falls back to the old popup", async () => {
    const run = await runMapScript({ hash: "", views: { all: "x" }, selectKeys: [], stops: [apiStop], stopText: [] });
    expect(run.popups).toEqual(["<b>hfville</b><br>00:04–13:04 (780 นาที)<br>จอด/ดับเครื่อง 00:04 →"]);
    const older = await runMapScript({ hash: "", views: { all: "x" }, selectKeys: [], stops: [apiStop] });
    expect(older.popups).toEqual(run.popups);
  });
});
