// The day page's basemap modes (docs/CONTRACTS.md §8; ADR 0002).
//
// OSM mode is today's page, unchanged. Google mode must contain NO OpenStreetMap
// anywhere — not in the CSP, not in the markup, not in the map script — because
// Google's Terms (3.2.3(e)) forbid using its tiles "with or near" a non-Google
// map. Those absences are asserted on the whole rendered page rather than on
// fragments, so a fallback added later has nowhere to hide.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pointFromRow } from "../../src/domain/sinotrackRow.ts";
import { summarizeDay } from "../../src/domain/summary.ts";
import type { Point } from "../../src/domain/types.ts";
import { createApp } from "../../src/server/app.ts";
import { loadConfig, type Env } from "../../src/server/config.ts";
import { openDatabase } from "../../src/server/db.ts";
import { MAP_SCRIPT, mapScript, renderDayPage } from "../../src/server/pages/day.ts";
import { GOOGLE_LOGO_DATA_URI } from "../../src/server/pages/googleLogo.ts";
import { escapeHtml, pageHeaders } from "../../src/server/pages/layout.ts";
import { buildDayReport } from "../../src/server/report.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import type { MapStatus, TileService } from "../../src/server/tiles.ts";
import { LABELS, pair } from "../../src/shared/labels.ts";
import rawRows from "../fixtures/2026-09-05.raw.json";

const SITES = loadSites();
const RULES = loadRules();
const POINTS: Point[] = (rawRows as unknown as Record<string, string>[])
  .map(pointFromRow)
  .filter((p): p is Point => p !== null);

function page(extra: { basemap?: "google" | "osm"; basemapPaused?: boolean } = {}): string {
  const report = buildDayReport({
    teid: "1000000001",
    summary: summarizeDay("2026-09-05", POINTS, SITES, RULES),
    points: POINTS,
    sites: SITES,
    rules: RULES,
    status: null,
    poll: null,
    pollerConfigured: true,
    generatedAt: 1788595367,
  });
  return renderDayPage({
    report,
    sites: SITES,
    nonce: "test-nonce",
    prevYmd: "2026-09-04",
    nextYmd: null,
    todayYmd: "2026-09-05",
    ...extra,
  });
}

const mapDataOf = (html: string): Record<string, unknown> => {
  const m = /<script type="application\/json" id="map-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m![1]!.replace(/\\u003c/g, "<"));
};

const HEAD = 'rel="noreferrer noopener" target="_blank"';

// ── pageHeaders ─────────────────────────────────────────────────────────────

describe("pageHeaders and the CSP", () => {
  const csp = (h: Headers) => h.get("content-security-policy") ?? "";

  test("osm (the default) is exactly today's policy", () => {
    const expected = [
      "default-src 'self'",
      "script-src 'nonce-N' https://cdnjs.cloudflare.com",
      "style-src 'nonce-N' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://tile.openstreetmap.org",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    expect(csp(pageHeaders("N"))).toBe(expected);
    expect(csp(pageHeaders("N", undefined, "osm"))).toBe(expected);
  });

  test("google: img-src is 'self' data: and no openstreetmap host appears anywhere in the headers", () => {
    const h = pageHeaders("N", undefined, "google");
    expect(csp(h)).toContain("img-src 'self' data:; ");
    expect(csp(h)).not.toContain("openstreetmap");
    let all = "";
    h.forEach((v, k) => (all += `${k}: ${v}\n`));
    expect(all.toLowerCase()).not.toContain("openstreetmap");
    // Everything else in the policy is as before.
    expect(csp(h)).toContain("script-src 'nonce-N' https://cdnjs.cloudflare.com");
    expect(csp(h)).toContain("connect-src 'self'");
  });

  test("the extra headers argument still works alongside the basemap", () => {
    expect(pageHeaders("N", { "x-extra": "1" }, "google").get("x-extra")).toBe("1");
  });
});

// ── the page ────────────────────────────────────────────────────────────────

describe("OSM mode is today's page", () => {
  test("defaults to osm and renders identically when osm is asked for explicitly", () => {
    expect(page({ basemap: "osm", basemapPaused: false })).toBe(page());
  });

  test("keeps the OSM layer, and none of the Google furniture", () => {
    const html = page();
    expect(html).toContain("'https://tile.openstreetmap.org/{z}/{x}/{y}.png'");
    expect(html).not.toContain("/tiles/{z}/{x}/{y}");
    expect(html).not.toContain("map-note");
    expect(html).not.toContain("Google Maps");
    expect(html).not.toContain("policies.google.com");
    expect(html).not.toContain("gmaps-logo");
    expect(mapDataOf(html).basemap).toBe("osm");
    expect(mapDataOf(html).attributionUrl).toBeUndefined();
    expect(mapDataOf(html).logo).toBeUndefined();
  });

  test("the OSM map script is byte-for-byte MAP_SCRIPT", () => {
    expect(mapScript("osm")).toBe(MAP_SCRIPT);
    expect(page()).toContain(MAP_SCRIPT);
  });
});

describe("Google mode", () => {
  const html = page({ basemap: "google", basemapPaused: false });

  test("NO OpenStreetMap anywhere on the page or in the script", () => {
    expect(html.toLowerCase()).not.toContain("openstreetmap");
    expect(html).not.toContain("tile.openstreetmap.org");
    expect(mapScript("google").toLowerCase()).not.toContain("openstreetmap");
    expect(JSON.stringify(mapDataOf(html)).toLowerCase()).not.toContain("openstreetmap");
  });

  test("the script asks OUR route for tiles", () => {
    expect(html).toContain("/tiles/{z}/{x}/{y}");
    expect(html).toContain("maxZoom: 19");
    expect(html).toContain("tileSize: 256");
  });

  test("map-data carries the basemap, the attribution endpoint and the logo", () => {
    const data = mapDataOf(html);
    expect(data.basemap).toBe("google");
    expect(data.attributionUrl).toBe("/api/map/attribution");
    expect(data.logo).toBe(GOOGLE_LOGO_DATA_URI);
    // The rest of map-data is unchanged.
    expect(data.sites).toBeDefined();
    expect(data.views).toBeDefined();
    expect(data.stopText).toBeDefined();
  });

  test("#map-note is server-rendered and hidden while the basemap is not paused", () => {
    expect(html).toMatch(/<p class="note" id="map-note" hidden>/);
    expect(html).toContain(escapeText(pair(LABELS.basemapPaused)));
  });

  test("#map-note is visible when the basemap is paused", () => {
    const paused = page({ basemap: "google", basemapPaused: true });
    expect(paused).toMatch(/<p class="note" id="map-note">/);
    expect(paused).not.toMatch(/id="map-note" hidden/);
    expect(paused).toContain("แผนที่พื้นหลังหยุดชั่วคราว");
  });

  test("the footer credits Google Maps and links its Terms and Privacy Policy", () => {
    expect(html).toContain("แผนที่ · Map: Google Maps · ");
    expect(html).toContain(`<a href="https://maps.google.com/help/terms_maps/" ${HEAD}>ข้อกำหนด · Terms</a>`);
    expect(html).toContain(`<a href="https://policies.google.com/privacy" ${HEAD}>ความเป็นส่วนตัว · Privacy</a>`);
    // …inside the layout, after the page body.
    expect(html.indexOf("policies.google.com")).toBeGreaterThan(html.indexOf('id="map"'));
  });

  test("no style= attribute sneaks in (the CSP has no unsafe-inline)", () => {
    expect(html).not.toMatch(/\sstyle="/);
  });

  test("the extra style block for the logo, note and footer carries the nonce", () => {
    expect(html).toContain('<style nonce="test-nonce">');
    expect(html).toContain(".gmaps-logo");
  });

  test("the attribution width cap sits on the bottom-right corner, not the control", () => {
    // A percentage max-width on the control resolves against the shrink-wrapped
    // corner and squeezed the copyright into a ~48 px column on the live page.
    expect(html).toContain(".leaflet-bottom.leaflet-right { max-width: calc(100% - 130px); }");
    expect(html).not.toMatch(/\.leaflet-control-attribution\s*\{[^}]*max-width/);
  });
});

const escapeText = escapeHtml;

// ── the label ───────────────────────────────────────────────────────────────

describe("labels", () => {
  test("basemapPaused says what the owner wrote", () => {
    expect(LABELS.basemapPaused).toEqual({
      th: "แผนที่พื้นหลังหยุดชั่วคราว (เกินโควตาวันนี้หรือโหลดไม่ได้) — เส้นทางยังแสดงครบ",
      en: "Basemap paused (today's quota reached or unavailable) — the route is still shown",
    });
  });
});

// ── the logo ────────────────────────────────────────────────────────────────

describe("the Google Maps logo", () => {
  test("is a base64 SVG data URI of the official asset", () => {
    expect(GOOGLE_LOGO_DATA_URI.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(GOOGLE_LOGO_DATA_URI.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 105 22"');
    expect(svg).not.toContain("<script");
  });

  test("its source file names the official Google URL it came from", () => {
    const src = readFileSync(new URL("../../src/server/pages/googleLogo.ts", import.meta.url), "utf8");
    expect(src).toContain("https://developers.google.com/static/maps/documentation/images/Google_Maps_Attribution_Assets.zip");
    expect(src).toContain("GoogleMaps_Logo_WithLightOutline.svg");
  });
});

// ── the routes ──────────────────────────────────────────────────────────────

describe("/day/:ymd picks the basemap", () => {
  const NOW = new Date(1788595367 * 1000);
  const statusWith = (upstream: number): MapStatus => ({
    enabled: true,
    cap: 2500,
    today: { ymd: "2026-09-05", upstream, hits: 0 },
    session: null,
    lastUpstream: null,
  });
  const fakeTiles = (upstream: number): TileService => ({
    getTile: async () => ({ kind: "disabled" }),
    attribution: async () => ({ kind: "disabled" }),
    status: () => statusWith(upstream),
  });
  const get = async (extra: Env, tiles?: TileService) => {
    const app = createApp(openDatabase(":memory:"), {
      config: loadConfig({ DATA_DIR: "./data", ALLOW_DEV_AUTH: "1", ...extra }),
      now: () => NOW,
      sites: SITES,
      rules: RULES,
      ...(tiles ? { tiles } : {}),
    });
    const res = await app.handle(
      new Request("http://truck.local/day/2026-09-05", { headers: { "x-dev-email": "owner@example.com" } }),
    );
    return { res, html: await res.text() };
  };

  test("no key: OSM, exactly as today", async () => {
    const { res, html } = await get({});
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data: https://tile.openstreetmap.org");
    expect(html).toContain("'https://tile.openstreetmap.org/{z}/{x}/{y}.png'");
    expect(html).not.toContain("map-note");
  });

  test("a key: Google, no OSM in the headers or the page, note hidden below the cap", async () => {
    const { res, html } = await get({ GOOGLE_MAPS_KEY: "k" }, fakeTiles(2499));
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data:;");
    expect(res.headers.get("content-security-policy")).not.toContain("openstreetmap");
    expect(html.toLowerCase()).not.toContain("openstreetmap");
    expect(html).toMatch(/id="map-note" hidden>/);
    expect(mapDataOf(html).basemap).toBe("google");
    expect(html).not.toContain(">k<"); // (paranoia) the key is not rendered
  });

  test("a key and today's upstream at the cap: the note is visible from the first byte", async () => {
    const { html } = await get({ GOOGLE_MAPS_KEY: "k" }, fakeTiles(2500));
    expect(html).toMatch(/<p class="note" id="map-note">/);
    const over = await get({ GOOGLE_MAPS_KEY: "k", TILE_DAILY_CAP: "10" }, fakeTiles(11));
    expect(over.html).toMatch(/<p class="note" id="map-note">/);
    const under = await get({ GOOGLE_MAPS_KEY: "k", TILE_DAILY_CAP: "10" }, fakeTiles(9));
    expect(under.html).toMatch(/id="map-note" hidden>/);
  });

  test("the page never contains the key", async () => {
    const { html } = await get({ GOOGLE_MAPS_KEY: "distinctive-key-value-42" }, fakeTiles(0));
    expect(html).not.toContain("distinctive-key-value-42");
  });
});

// ── the client script in google mode, against a fake DOM ────────────────────

interface Layer {
  url: string;
  opts: Record<string, unknown>;
  handlers: Record<string, (() => void)[]>;
}

async function runGoogleScript(opts: { copyrights?: string[]; script?: string; failAttribution?: boolean } = {}) {
  const layers: Layer[] = [];
  const mapHandlers: Record<string, (() => void)[]> = {};
  const attribution = { added: [] as string[], removed: [] as string[] };
  const controls: { proto: Record<string, any>; container: any }[] = [];
  const timers: { id: number; ms: number; fn: () => void }[] = [];
  let timerId = 0;
  const fetched: string[] = [];
  const copyrights = [...(opts.copyrights ?? ["Map data ©2026 Google"])];
  const noteCalls: string[] = [];
  const created: any[] = [];

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

  const bounds = { getNorth: () => 9.2, getSouth: () => 9.1, getEast: () => 99.4, getWest: () => 99.3 };
  const mapObj = generic({
    on: (ev: string, fn: () => void) => {
      (mapHandlers[ev] ??= []).push(fn);
      return mapObj;
    },
    getBounds: () => bounds,
    getZoom: () => 13.0,
    attributionControl: {
      addAttribution: (s: string) => attribution.added.push(s),
      removeAttribution: (s: string) => attribution.removed.push(s),
    },
  });
  const L = generic({
    map: () => mapObj,
    tileLayer: (url: string, o: Record<string, unknown>) => {
      const layer: Layer = { url, opts: o, handlers: {} };
      layers.push(layer);
      const obj: any = generic({
        on: (ev: string, fn: () => void) => {
          (layer.handlers[ev] ??= []).push(fn);
          return obj;
        },
        addTo: () => obj,
      });
      return obj;
    },
    Control: {
      extend: (proto: Record<string, any>) =>
        function (this: any) {
          this.addTo = () => {
            controls.push({ proto, container: proto.onAdd(mapObj) });
            return this;
          };
        },
    },
    DomUtil: {
      create: (tag: string, cls: string) => ({
        tagName: tag,
        className: cls,
        children: [] as unknown[],
        appendChild(c: unknown) {
          this.children.push(c);
        },
      }),
    },
  });

  const cfg = {
    basemap: "google",
    attributionUrl: "/api/map/attribution",
    logo: GOOGLE_LOGO_DATA_URI,
    sites: [],
    txt: { unknown: "?", minutes: "m", stopParked: "p", stopRunning: "r" },
    views: { all: "all" },
  };
  const el = { getAttribute: (k: string) => (k === "data-ymd" ? "2026-09-05" : null) };
  const dataEl = { textContent: JSON.stringify(cfg) };
  const note = { removeAttribute: (a: string) => noteCalls.push(a) };
  const doc = {
    getElementById: (id: string) => ({ map: el, "map-data": dataEl, "map-note": note })[id] ?? null,
    querySelectorAll: () => [],
    createElement: (tag: string) => {
      const node = { tagName: tag } as Record<string, unknown>;
      created.push(node);
      return node;
    },
  };
  const fetchStub = (url: string) => {
    fetched.push(url);
    if (url.startsWith("/api/map/attribution")) {
      if (opts.failAttribution) return Promise.reject(new Error("network down"));
      const c = copyrights.shift() ?? "Map data ©2026 Google";
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ copyright: c }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ path: [], trips: [], stops: [] }) });
  };
  const win = { location: { hash: "" }, addEventListener: () => {} };
  new Function("document", "window", "L", "fetch", "history", "console", "setTimeout", "clearTimeout", opts.script ?? mapScript("google"))(
    doc,
    win,
    L,
    fetchStub,
    { replaceState() {} },
    { error() {} },
    (fn: () => void, ms: number) => {
      timerId += 1;
      timers.push({ id: timerId, ms, fn });
      return timerId;
    },
    (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  );
  const tick = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  return {
    layers,
    controls,
    attribution,
    fetched,
    noteCalls,
    created,
    timers,
    tick,
    moveend: () => (mapHandlers.moveend ?? []).forEach((f) => f()),
    flushTimers: async () => {
      const due = timers.splice(0, timers.length);
      due.forEach((t) => t.fn());
      await tick();
    },
    tileerror: () => (layers[0]?.handlers.tileerror ?? []).forEach((f) => f()),
  };
}

describe("MAP_SCRIPT in Google mode, on a fake DOM", () => {
  test("is ES5 like the OSM script", () => {
    const s = mapScript("google");
    expect(s).not.toContain("`");
    expect(s).not.toContain("=>");
    expect(s).toContain("textContent");
  });

  test("creates exactly one tile layer, on our /tiles route, and never an OSM one", async () => {
    const run = await runGoogleScript();
    expect(run.layers).toHaveLength(1);
    expect(run.layers[0]!.url).toBe("/tiles/{z}/{x}/{y}");
    expect(run.layers[0]!.opts).toEqual({ maxZoom: 19, tileSize: 256 });
    for (const l of run.layers) expect(JSON.stringify(l).toLowerCase()).not.toContain("openstreetmap");
  });

  test("the first tileerror unhides #map-note; later ones do nothing more", async () => {
    const run = await runGoogleScript();
    expect(run.noteCalls).toEqual([]);
    run.tileerror();
    expect(run.noteCalls).toEqual(["hidden"]);
    run.tileerror();
    run.tileerror();
    expect(run.noteCalls).toEqual(["hidden"]);
  });

  test("adds a bottom-left control holding the Google Maps logo image", async () => {
    const run = await runGoogleScript();
    expect(run.controls).toHaveLength(1);
    const { proto, container } = run.controls[0]!;
    expect(proto.options.position).toBe("bottomleft");
    expect(container.className).toContain("gmaps-logo");
    const img = container.children[0];
    expect(img.tagName).toBe("img");
    expect(img.alt).toBe("Google Maps");
    expect(img.src).toBe(GOOGLE_LOGO_DATA_URI);
  });

  test("a moveend burst is debounced by 400 ms into ONE attribution fetch for the current view", async () => {
    const run = await runGoogleScript();
    const before = run.fetched.filter((u) => u.startsWith("/api/map/attribution")).length;
    run.moveend();
    run.moveend();
    run.moveend();
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0]!.ms).toBe(400);
    await run.flushTimers();
    const urls = run.fetched.filter((u) => u.startsWith("/api/map/attribution"));
    expect(urls.length - before).toBe(1);
    expect(urls[urls.length - 1]).toBe("/api/map/attribution?zoom=13&north=9.2&south=9.1&east=99.4&west=99.3");
  });

  test("swaps the attribution: removes the previous string, adds the new one, escaped", async () => {
    const run = await runGoogleScript({ copyrights: ["Map data ©2026", "Map data ©2027 <b>x</b> & co"] });
    run.moveend();
    await run.flushTimers();
    expect(run.attribution.added).toEqual(["Map data ©2026"]);
    expect(run.attribution.removed).toEqual([]);
    run.moveend();
    await run.flushTimers();
    expect(run.attribution.removed).toEqual(["Map data ©2026"]);
    expect(run.attribution.added).toEqual(["Map data ©2026", "Map data ©2027 &lt;b&gt;x&lt;/b&gt; &amp; co"]);
  });

  test("an attribution failure is silent: no throw, no attribution change", async () => {
    const run = await runGoogleScript({ failAttribution: true });
    run.moveend();
    await run.flushTimers();
    expect(run.attribution.added).toEqual([]);
    expect(run.layers).toHaveLength(1);
  });
});

describe("the OSM script is untouched by the Google work", () => {
  test("still builds exactly one OSM layer with the Referer opt-in", () => {
    expect(MAP_SCRIPT).toContain("L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png'");
    expect(MAP_SCRIPT).toContain("referrerPolicy: 'strict-origin-when-cross-origin'");
    expect(MAP_SCRIPT).not.toContain("/tiles/");
    expect(MAP_SCRIPT).not.toContain("map-note");
  });
});
