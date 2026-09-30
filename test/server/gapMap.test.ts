// GPS gaps on the day map (docs/CONTRACTS.md §3 rule 10, §8, §9).
//
// Two layers: the page (legend, the words the script is handed, the script's
// shape in BOTH basemap modes — the gap logic is shared, not in the basemap
// snippets), and the script itself run against a fake Leaflet, so "the dash
// survives every restyle" is executed rather than assumed.

import { describe, expect, test } from "bun:test";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Point } from "../../src/domain/types.ts";
import { mapScript, renderDayPage } from "../../src/server/pages/day.ts";
import { buildDayReport, type DayReport } from "../../src/server/report.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { LABELS, pair } from "../../src/shared/labels.ts";
import { HF, HFVILLE, bkk, lerp, parked, pt } from "../domain/support.ts";

const SITES = loadSites();
const RULES = loadRules();
const YMD = "2026-09-24";

// HF → HF Ville with a 656 s hole in the middle of the drive (24 Sep, trip 2 shape).
const T0 = bkk(YMD, "14:20:00");
const HOLE_FROM = T0 + 420;
const HOLE_TO = HOLE_FROM + 656;
const drive = (t: number, f: number): Point => pt(t, lerp(HF, HFVILLE, f), { speed: 47, voltage: 13.8 });
const GAP_DAY: Point[] = [
  ...parked(T0, HF, 6, 60, { voltage: 12.7 }),
  drive(T0 + 360, 0.05),
  drive(HOLE_FROM, 0.1),
  drive(HOLE_TO, 0.5),
  drive(HOLE_TO + 60, 0.6),
  drive(HOLE_TO + 120, 0.7),
  ...parked(HOLE_TO + 180, HFVILLE, 6, 60, { voltage: 12.7 }),
];
// The same drive at a 60 s cadence throughout: no silence to draw.
const QUIET_DAY: Point[] = [
  ...parked(T0, HF, 6, 60, { voltage: 12.7 }),
  ...Array.from({ length: 15 }, (_, i) => drive(T0 + 360 + i * 60, 0.05 + i * 0.06)),
  ...parked(T0 + 360 + 15 * 60, HFVILLE, 6, 60, { voltage: 12.7 }),
];

function reportFor(points: Point[], ymd = YMD): DayReport {
  return buildDayReport({
    teid: "1000000001",
    summary: summarizeDay(ymd, points, SITES, RULES),
    points,
    sites: SITES,
    rules: RULES,
    status: null,
    poll: null,
    pollerConfigured: true,
    generatedAt: 1788595367,
  });
}

const pageOf = (report: DayReport, basemap: "google" | "osm" = "osm"): string =>
  renderDayPage({ report, sites: SITES, nonce: "test-nonce", prevYmd: "x", nextYmd: null, todayYmd: YMD, basemap });

const mapDataOf = (html: string): { txt: Record<string, string> } => {
  const m = /<script type="application\/json" id="map-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m![1]!.replace(/\\u003c/g, "<"));
};

const WITH_GAP = reportFor(GAP_DAY);
const WITHOUT_GAP = reportFor(QUIET_DAY);

describe("the report the map is fed", () => {
  test("the gap day has exactly one gap, and the quiet day none", () => {
    expect(WITH_GAP.gaps).toHaveLength(1);
    expect(WITH_GAP.gaps![0]!.fromAt).toBe(HOLE_FROM);
    expect(WITH_GAP.gaps![0]!.toAt).toBe(HOLE_TO);
    expect(WITHOUT_GAP.gaps).toEqual([]);
  });
});

describe("the legend under the map", () => {
  const legend = pair(LABELS.gapLegend);

  test("says what the dashed line is, in both languages, when the report has a gap", () => {
    expect(legend).toBe("ไม่มีสัญญาณ GPS (ลากเส้นตรง) · No GPS data (straight line)");
    const html = pageOf(WITH_GAP);
    expect(html).toContain('<p class="gaplegend">');
    expect(html).toContain(legend);
    // Under the map, inside the same section.
    expect(html.indexOf('id="map"')).toBeLessThan(html.indexOf("gaplegend\">"));
  });

  test("is not rendered at all on a day without one", () => {
    const html = pageOf(WITHOUT_GAP);
    expect(html).not.toContain('<p class="gaplegend">');
    expect(html).not.toContain(legend);
  });

  test("is styled by a class in the nonce'd style block, never a style attribute", () => {
    for (const html of [pageOf(WITH_GAP), pageOf(WITH_GAP, "google")]) {
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).toMatch(/<style nonce="test-nonce">[\s\S]*\.gaplegend/);
    }
  });

  test("the map script is handed the popup's label line through map-data txt", () => {
    expect(mapDataOf(pageOf(WITH_GAP)).txt.gapStraight).toBe(
      "เส้นตรง ไม่ใช่เส้นทางจริง · straight line, not the route driven",
    );
  });
});

describe("the emitted script, in both basemap modes", () => {
  for (const mode of ["osm", "google"] as const) {
    describe(mode, () => {
      const script = mapScript(mode);

      test("draws the gap in the trip colour with long dashes, weight 3", () => {
        expect(script).toContain("var GAP_BASE = { color: '#8b0000', weight: 3, opacity: 0.85, dashArray: '10 8' };");
        // Not the thin dotted rest-of-day line.
        expect(script).toContain("dashArray: '2 6'");
        expect("10 8").not.toBe("2 6");
      });

      test("wires the popup: th bold, en, then the straight-line label, all through esc", () => {
        expect(script).toContain(
          "'<b>' + esc(gt.th) + '</b><br>' + esc(gt.en) + '<br>' + esc(txt.gapStraight)",
        );
      });

      test("restyles gap lines from GAP_BASE, never from TRIP_BASE", () => {
        expect(script).toContain("gapLayers[g][k].setStyle(GAP_BASE)");
        expect(script).toContain("mergeStyle(GAP_BASE, gapOn ? GAP_ON : GAP_DIM)");
        expect(script).not.toMatch(/gapLayers[^\n]*TRIP_BASE/);
      });

      test("is ES5: no template literals, arrow functions, let or const", () => {
        expect(script).not.toContain("`");
        expect(script).not.toContain("=>");
        expect(script).not.toMatch(/\blet\s/);
        expect(script).not.toMatch(/\bconst\s/);
      });
    });
  }

  test("the Google script still contains no OpenStreetMap URL, and the page neither", () => {
    expect(mapScript("google").toLowerCase()).not.toContain("openstreetmap");
    expect(pageOf(WITH_GAP, "google").toLowerCase()).not.toContain("openstreetmap");
  });

  test("the OSM script is still exactly what mapScript('osm') builds, OSM tiles and all", () => {
    expect(mapScript("osm")).toContain("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });
});

// ── the script, run ──────────────────────────────────────────────────────────

interface FakeLine {
  coords: number[][];
  base: Record<string, unknown>;
  /** What the script asked for, call by call — what Leaflet would merge into the options. */
  setStyleCalls: Record<string, unknown>[];
  /** The merged options, as Leaflet keeps them. */
  style: Record<string, unknown>;
  popup: string | null;
}

async function runMap(mode: "osm" | "google", report: unknown) {
  const lines: FakeLine[] = [];
  const handlers: Record<string, () => void> = {};
  const generic = (over: Record<string, unknown> = {}): any => {
    const proxy: any = new Proxy(function () {}, {
      get: (_t, key) => {
        if (typeof key === "symbol" || key === "then") return undefined;
        if (Object.prototype.hasOwnProperty.call(over, key)) return over[key as string];
        if (key === "isValid") return () => false;
        if (key === "getZoom") return () => 13;
        return proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  };
  const fits: { pts: number[][] }[] = [];
  const fakeBounds = (): any => {
    const b: any = {
      pts: [] as number[][],
      extend(x: any) {
        if (x && Array.isArray(x.pts)) b.pts.push(...x.pts);
        else if (Array.isArray(x)) b.pts.push(x);
        return b;
      },
      isValid: () => b.pts.length > 0,
      pad: () => b,
    };
    return b;
  };
  const L = generic({
    latLngBounds: () => fakeBounds(),
    map: () => generic({ fitBounds: (b: { pts: number[][] }) => fits.push({ pts: [...b.pts] }) }),
    polyline: (coords: number[][], style: Record<string, unknown>) => {
      const rec: FakeLine = { coords, base: style, setStyleCalls: [], style: { ...style }, popup: null };
      lines.push(rec);
      const obj: any = generic({
        addTo: () => obj,
        bindPopup: (html: string) => {
          rec.popup = html;
          return obj;
        },
        setStyle: (s: Record<string, unknown>) => {
          rec.setStyleCalls.push(s);
          rec.style = { ...rec.style, ...s };
          return obj;
        },
      });
      return obj;
    },
  });
  const cfg = {
    basemap: mode,
    sites: [],
    txt: {
      unknown: "?",
      minutes: "m",
      stopParked: "p",
      stopRunning: "r",
      gapStraight: pair(LABELS.gapStraightLine),
    },
    views: { all: "all" },
  };
  const el = { getAttribute: (k: string) => (k === "data-ymd" ? YMD : null) };
  const doc = {
    getElementById: (id: string) =>
      ({ map: el, "map-data": { textContent: JSON.stringify(cfg) }, "map-view-text": { textContent: "" } })[id] ?? null,
    querySelectorAll: () => [],
    createElement: () => ({}),
  };
  const win = {
    location: { hash: "" },
    addEventListener: (ev: string, fn: () => void) => {
      handlers[ev] = fn;
    },
  };
  new Function("document", "window", "L", "fetch", "history", "console", "setTimeout", "clearTimeout", mapScript(mode))(
    doc,
    win,
    L,
    () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(report))) }),
    { replaceState() {} },
    { error() {} },
    setTimeout,
    clearTimeout,
  );
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  const select = (hash: string) => {
    win.location.hash = hash;
    handlers.hashchange!();
  };
  return { lines, select, fits };
}

const DASH = "10 8";
const dashed = (lines: FakeLine[]) => lines.filter((l) => l.base.dashArray === DASH);
const solid = (lines: FakeLine[]) => lines.filter((l) => l.base.weight === 4);

for (const mode of ["osm", "google"] as const) {
  describe(`the map script run in ${mode} mode`, () => {
    const path = WITH_GAP.path!;
    const at = (t: number): number[] => {
      const p = path.find((q) => q[2] === t)!;
      return [p[0], p[1]];
    };

    test("breaks the trip at the gap: solid to the first fix, one dashed 2-point line, solid again from the second", async () => {
      const { lines } = await runMap(mode, WITH_GAP);
      const gaps = dashed(lines);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.coords).toEqual([at(HOLE_FROM), at(HOLE_TO)]);
      expect(gaps[0]!.base).toEqual({ color: "#8b0000", weight: 3, opacity: 0.85, dashArray: DASH });

      const trip = solid(lines);
      expect(trip).toHaveLength(2);
      expect(trip[0]!.coords[trip[0]!.coords.length - 1]).toEqual(at(HOLE_FROM));
      expect(trip[1]!.coords[0]).toEqual(at(HOLE_TO));
      // Nothing of the solid line crosses the hole.
      for (const l of trip) {
        const flat = l.coords.map((c) => c.join(","));
        expect(flat.includes(at(HOLE_FROM).join(",")) && flat.includes(at(HOLE_TO).join(","))).toBe(false);
      }
    });

    test("tapping the gap opens: bold Thai sentence, English sentence, then the straight-line label", async () => {
      const { lines } = await runMap(mode, WITH_GAP);
      const g = WITH_GAP.gaps![0]!;
      expect(g.text.th).toBe("ไม่มีสัญญาณ GPS 10 นาที (14:27–14:37)");
      expect(dashed(lines)[0]!.popup).toBe(
        `<b>${g.text.th}</b><br>${g.text.en}<br>เส้นตรง ไม่ใช่เส้นทางจริง · straight line, not the route driven`,
      );
    });

    test("escapes everything it puts in the popup", async () => {
      const evil = JSON.parse(JSON.stringify(WITH_GAP));
      evil.gaps[0].text = { th: "<img src=x onerror=alert(1)>", en: 'a & "b"' };
      const { lines } = await runMap(mode, evil);
      const popup = dashed(lines)[0]!.popup!;
      expect(popup).not.toContain("<img");
      expect(popup).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(popup).toContain("a &amp; &quot;b&quot;");
    });

    test("selecting the trip bolds the gap line, another trip dims it, all restores it — dashed every time", async () => {
      const { lines, select } = await runMap(mode, WITH_GAP);
      const gap = dashed(lines)[0]!;
      const trip = solid(lines)[0]!;

      select("#trip-1");
      expect(gap.style).toMatchObject({ weight: 5, opacity: 1, color: "#8b0000", dashArray: DASH });
      expect(trip.style.weight).toBe(6);

      select("#trip-9");
      expect(gap.style).toMatchObject({ weight: 2, opacity: 0.25, dashArray: DASH });
      expect(trip.style.opacity).toBe(0.25);

      select("#all");
      expect(gap.style).toEqual({ color: "#8b0000", weight: 3, opacity: 0.85, dashArray: DASH });
      expect(trip.style.weight).toBe(4);

      // The dash is in every style the script ASKED for — it never leans on Leaflet
      // remembering it, and never borrows the trip's (dash-less) base style.
      expect(gap.setStyleCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of gap.setStyleCalls) expect(call.dashArray).toBe(DASH);
    });

    test("a day with no gap draws no dashed line and one solid trip line", async () => {
      const { lines } = await runMap(mode, WITHOUT_GAP);
      expect(dashed(lines)).toHaveLength(0);
      expect(solid(lines)).toHaveLength(1);
    });

    test("a report from before the field existed still draws the trip", async () => {
      const old = JSON.parse(JSON.stringify(WITH_GAP));
      delete old.gaps;
      const { lines } = await runMap(mode, old);
      expect(dashed(lines)).toHaveLength(0);
      expect(solid(lines)).toHaveLength(1);
    });

    test("malformed gaps are silent and never blank the rest of the map", async () => {
      for (const bad of ["nope", [null], [{}], [{ fromAt: HOLE_FROM, toAt: HOLE_TO }], [{ fromAt: HOLE_FROM, toAt: HOLE_TO, text: null }]]) {
        const broken = JSON.parse(JSON.stringify(WITH_GAP));
        broken.gaps = bad;
        const { lines } = await runMap(mode, broken);
        expect(solid(lines).length).toBeGreaterThanOrEqual(1);
      }
    });
  });
}

describe("selecting a trip whose whole path is one gap", () => {
  // 2026-09-06 trip 1 in miniature: the trip is exactly two fixes, 395 minutes
  // apart, so both solid segments have fewer than two coordinates and the trip
  // has no solid line at all — only the dashed one.
  const ONLY_GAP_DAY: Point[] = [
    ...parked(T0, HF, 6, 60, { voltage: 12.7 }),
    ...parked(T0 + 300 + 395 * 60, HFVILLE, 6, 60, { voltage: 12.7 }),
  ];
  const report = reportFor(ONLY_GAP_DAY);

  for (const mode of ["osm", "google"] as const) {
    test(`zooms to both fixes (${mode})`, async () => {
      expect(report.trips).toHaveLength(1);
      expect(report.gaps).toHaveLength(1);
      const g = report.gaps![0]!;
      const point = (t: number): number[] => {
        const p = report.path!.find((q) => q[2] === t)!;
        return [p[0], p[1]];
      };
      const { lines, select, fits } = await runMap(mode, report);
      expect(solid(lines)).toHaveLength(0);
      expect(dashed(lines)).toHaveLength(1);

      const before = fits.length;
      select("#trip-1");
      expect(fits.length).toBe(before + 1);
      const framed = fits[fits.length - 1]!.pts.map((c) => c.join(","));
      expect(framed).toContain(point(g.fromAt).join(","));
      expect(framed).toContain(point(g.toAt).join(","));
    });
  }
});
