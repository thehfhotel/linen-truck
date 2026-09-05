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

  test("the unknown-stop finding carries data-stop for the same index its stop row uses", () => {
    expect(html).toMatch(/<li class="unknown-stop" data-stop="3">/);
    expect(html).toContain('data-select="stop-3"');
  });

  test("the detour finding carries data-trips and a trip-select button", () => {
    expect(html).toMatch(/<li class="detour" data-trips="3,4">/);
    expect(html).toContain('data-select="trip-3-4"');
  });

  test("no stray template artefacts reach the page (every interpolation resolved)", () => {
    expect(html).not.toContain("[object Object]");
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
