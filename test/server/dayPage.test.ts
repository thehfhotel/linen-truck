// The day page's trip/stop filter (feature: filter the day map by trip or
// stop). Renders the real page HTML off the real fixture and asserts on the
// chip row and the data attributes the client script (day.ts's MAP_SCRIPT)
// selects on — no browser here, that lives in the Playwright check under
// scratchpad/pw; this is the fast, no-network regression net.

import { describe, expect, test } from "bun:test";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Point } from "../../src/domain/types.ts";
import { buildDayReport } from "../../src/server/report.ts";
import { renderDayPage } from "../../src/server/pages/day.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { HF, HFVILLE, bkk, lerp, parked, pt } from "../domain/support.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

const TEID = "1000000001";
const GENERATED_AT = 1788595367;
const SITES = loadSites();
const RULES = loadRules();

function pageFor(ymd: string, points: Point[]): string {
  const summary = summarizeDay(ymd, points, SITES, RULES);
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
    expect(fixture).toContain("12:27 → 13:32");
  });

  test("a stop the engine never restarted in shows the off time and an open arrow", () => {
    expect(fixture).toContain("14:28 →</td>");
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
