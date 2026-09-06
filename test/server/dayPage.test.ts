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
