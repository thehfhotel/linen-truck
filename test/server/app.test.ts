// The HTTP surface (docs/CONTRACTS.md §7–§9).
//
// Every test drives `app.handle(req)` against an in-memory database seeded
// through `scripts/import.ts` — the same ingest path the poller uses — so what is
// asserted here is the real route, the real domain maths and the real report
// shape, with no network and no disk.

import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApp, dayReport, isYmd, resolveDeps, weekDays } from "../../src/server/app.ts";
import { _internal as authInternal } from "../../src/server/auth.ts";
import { loadConfig, type Config, type Env } from "../../src/server/config.ts";
import { insertPoints, openDatabase, type PointRow } from "../../src/server/db.ts";
import { MAP_ESC_FN } from "../../src/server/pages/day.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { importRawRows } from "../../scripts/import.ts";
import { HF, HFVILLE, bkk, lerp, parked, pt } from "../domain/support.ts";
import type { Point } from "../../src/domain/types.ts";
import raw from "../fixtures/2026-09-05.raw.json";

const TEID = "1000000001";
const YMD = "2026-09-05";
/** 2026-09-05 15:02 Bangkok — inside the fixture's day, so "today" is stable. */
const NOW = new Date(1788595367 * 1000);

const config = (extra: Env = {}): Config =>
  loadConfig({
    DATA_DIR: "./data",
    SINOTRACK_USER: TEID,
    SINOTRACK_PASSWORD: "unused-in-tests",
    ALLOW_DEV_AUTH: "1",
    FEED_TOKEN: "feed-secret",
    ...extra,
  });

function seeded(): Database {
  const db = openDatabase(":memory:");
  importRawRows(db, TEID, raw, 1788595000);
  return db;
}

const app = (db: Database, extra: Env = {}) =>
  createApp(db, {
    config: config(extra),
    now: () => NOW,
    sites: loadSites(),
    rules: loadRules(),
  });

/** The dev bypass stands in for the Access JWT while CF_ACCESS_AUD is empty (§7). */
const staffReq = (path: string): Request =>
  new Request(`http://truck.local${path}`, { headers: { "x-dev-email": "owner@example.com" } });

beforeEach(() => {
  authInternal.resetJwksCacheForTests();
  authInternal.resetWarningsForTests();
});

describe("/healthz", () => {
  test("the §7 shape, and it never touches the database", async () => {
    const res = await app(openDatabase(":memory:"), { GIT_SHA: "abc1234", CF_ACCESS_AUD: "aud-1" }).handle(
      new Request("http://truck.local/healthz"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.commit).toBe("abc1234");
    expect(body.time).toBe(NOW.toISOString());
    expect(body.staffAuth).toBe("configured");
    expect(body.feed).toBe("on");
    expect(body.poller).toEqual({
      configured: true,
      lastAt: null,
      lastOk: null,
      lastError: null,
      lastSeen: null,
      lastNew: null,
    });
  });

  test("carries nosniff, like every other response", async () => {
    const res = await app(openDatabase(":memory:")).handle(new Request("http://truck.local/healthz"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("says so when the audience and the feed token are unset", async () => {
    const res = await app(openDatabase(":memory:"), { FEED_TOKEN: "" }).handle(new Request("http://truck.local/healthz"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.staffAuth).toBe("missing");
    expect(body.feed).toBe("off");
  });

  test("answers without any credential", async () => {
    const res = await app(openDatabase(":memory:"), { CF_ACCESS_AUD: "aud-1", ALLOW_DEV_AUTH: "" }).handle(
      new Request("http://truck.local/healthz"),
    );
    expect(res.status).toBe(200);
  });
});

describe("/feed/* auth (§7)", () => {
  const bearer = { authorization: "Bearer feed-secret" };

  test("404 for anything that arrived through Cloudflare", async () => {
    const res = await app(seeded()).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { ...bearer, "cf-ray": "8a1b2c3d4e5f-BKK" } }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("404 for CF-Connecting-IP too, before the token is read", async () => {
    const res = await app(seeded()).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { "cf-connecting-ip": "1.2.3.4" } }),
    );
    expect(res.status).toBe(404);
  });

  test("401 without a bearer", async () => {
    const res = await app(seeded()).handle(new Request(`http://truck.local/feed/daily?date=${YMD}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("401 for a wrong bearer, and for a prefix of the right one", async () => {
    const a = await app(seeded()).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { authorization: "Bearer wrong-secret" } }),
    );
    const b = await app(seeded()).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { authorization: "Bearer feed-sec" } }),
    );
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
  });

  test("200 with the right bearer", async () => {
    const res = await app(seeded()).handle(new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: bearer }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { date: string }).date).toBe(YMD);
  });

  test("an unset FEED_TOKEN makes the feed 404, not 503", async () => {
    const res = await app(seeded(), { FEED_TOKEN: "" }).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: bearer }),
    );
    expect(res.status).toBe(404);
  });

  test("/feed/range is inclusive and refuses more than 62 days", async () => {
    const ok = await app(seeded()).handle(
      new Request("http://truck.local/feed/range?from=2026-09-04&to=2026-09-05", { headers: bearer }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { days: { date: string; trips?: unknown }[] };
    expect(body.days.map((d) => d.date)).toEqual(["2026-09-04", "2026-09-05"]);
    // §9: the range shape drops trips/stops/legs/path and keeps findings.
    expect(body.days[1]).not.toHaveProperty("trips");
    expect(body.days[1]).not.toHaveProperty("path");
    expect(body.days[1]).toHaveProperty("findings");

    const tooLong = await app(seeded()).handle(
      new Request("http://truck.local/feed/range?from=2026-01-01&to=2026-12-31", { headers: bearer }),
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "bad-range" });
  });

  test("a bad date is 400 bad-date", async () => {
    const res = await app(seeded()).handle(new Request("http://truck.local/feed/daily?date=2026-02-31", { headers: bearer }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-date" });
  });
});

describe("the Access guard (§7)", () => {
  test("every gated route answers 503 while CF_ACCESS_AUD is empty", async () => {
    const db = seeded();
    const gated = ["/", "/robots.txt", `/day/${YMD}`, `/week/${YMD}`, `/api/day/${YMD}`, `/api/week/${YMD}`];
    for (const path of gated) {
      // ALLOW_DEV_AUTH off, so the fail-closed branch is the one under test.
      const res = await app(db, { ALLOW_DEV_AUTH: "" }).handle(new Request(`http://truck.local${path}`));
      expect(`${path} ${res.status}`).toBe(`${path} 503`);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
  });

  test("401 when an audience IS configured and no JWT is presented", async () => {
    const res = await app(seeded(), { CF_ACCESS_AUD: "aud-1" }).handle(new Request(`http://truck.local/api/day/${YMD}`));
    expect(res.status).toBe(401);
  });

  test("/feed/* and /healthz are outside the guard", async () => {
    const db = seeded();
    const health = await app(db, { ALLOW_DEV_AUTH: "" }).handle(new Request("http://truck.local/healthz"));
    const feed = await app(db, { ALLOW_DEV_AUTH: "" }).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { authorization: "Bearer feed-secret" } }),
    );
    expect(health.status).toBe(200);
    expect(feed.status).toBe(200);
  });
});

describe("/api/day/:ymd", () => {
  test("the §9 DayReport for the archived 2026-09-05", async () => {
    const res = await app(seeded()).handle(staffReq(`/api/day/${YMD}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.date).toBe(YMD);
    expect(body.tz).toBe("Asia/Bangkok");
    expect(body.device.teid).toBe(TEID);

    // The numbers CONTRACTS §3 pins for this fixture.
    expect(body.summary.pointCount).toBe(82);
    expect(body.summary.tripCount).toBe(4);
    expect(body.summary.roundTrips).toBe(1);
    expect(body.summary.km).toBe(15.4);
    expect(body.summary.timeAtSiteMin).toEqual({ hf: 18, hfville: 118 });
    expect(body.summary.findingCount).toEqual({ "unknown-stop": 0, detour: 1, "outside-hours": 0 });
    expect(body.summary.firstDeparture).toMatch(/^\d{2}:\d{2}$/);

    expect(body.trips).toHaveLength(4);
    expect(body.legs).toHaveLength(3);
    expect(body.path).toHaveLength(82);
    expect(body.path[0]).toHaveLength(3);

    // Every stop of this day is at a known site (§3), so the only finding left is
    // the long way round from HF to HF Ville.
    const kinds = body.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(["detour"]);
    const detour = body.findings[0];
    expect(detour.text.th).toContain("อ้อมทาง");
    expect(detour.text.en).toContain("Detour");
    expect(detour.trips).toEqual([3]);
    expect(detour.referenceKm).toBe(4.9);
    expect(detour.ratio).toBeGreaterThan(1.25);

    // §9, additive: the engine story of every stop travels with the feed, so
    // hf-mcp never re-derives it from the raw voltages.
    expect(body.stops.map((s: { engine: string }) => s.engine)).toEqual([
      "unknown",
      "parked",
      "parked",
      "parked",
      "parked",
    ]);
    expect(body.stops[1]).toMatchObject({
      engine: "parked",
      engineOffAt: "12:27",
      engineOnAt: "13:32",
      engineOffMin: 65,
    });
    expect(body.stops[4]).toMatchObject({ engineOffAt: "14:28", engineOnAt: null });

    expect(body.dataQuality).toEqual({ lastPollAt: null, lastPollOk: null, note: "no-poll-yet" });
  });

  test("a day with no points is an empty report, not a 404", async () => {
    const res = await app(seeded()).handle(staffReq("/api/day/2026-09-01"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.summary.pointCount).toBe(0);
    expect(body.summary.km).toBe(0);
    expect(body.findings).toEqual([]);
    expect(body.path).toEqual([]);
  });

  test("a bad date is 400 bad-date", async () => {
    for (const bad of ["2026-13-01", "2026-02-31", "20260905", "not-a-date"]) {
      const res = await app(seeded()).handle(staffReq(`/api/day/${bad}`));
      expect(`${bad} ${res.status}`).toBe(`${bad} 400`);
      expect(await res.json()).toEqual({ error: "bad-date" });
    }
  });
});

describe("/api/week/:ymd", () => {
  test("seven days ending at ymd, summary fields only", async () => {
    const res = await app(seeded()).handle(staffReq(`/api/week/${YMD}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Record<string, unknown>[] };
    expect(body.days).toHaveLength(7);
    expect(body.days.map((d) => d.date)).toEqual(weekDays(YMD));
    expect(body.days[6]).not.toHaveProperty("stops");
    expect(body.days[6]).toHaveProperty("findings");
  });
});

describe("the pages", () => {
  test("/ redirects to today", async () => {
    const res = await app(seeded()).handle(staffReq("/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/day/${YMD}`);
  });

  test("/day/:ymd renders the report, the SRI-pinned Leaflet and a nonce'd CSP", async () => {
    const res = await app(seeded()).handle(staffReq(`/day/${YMD}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("https://cdnjs.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: https://tile.openstreetmap.org");

    const html = await res.text();
    // OSM answers a tile request without a Referer with a 403 "Access blocked"
    // image, and the page policy (same-origin) sends none cross-origin — so the
    // tile layer must opt in to the bare origin, on the host the CSP allows.
    expect(html).toContain("'https://tile.openstreetmap.org/{z}/{x}/{y}.png'");
    expect(html).toContain("referrerPolicy: 'strict-origin-when-cross-origin'");
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain('integrity="sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg=="');
    expect(html).toContain(`data-ymd="${YMD}"`);
    expect(html).toContain("/api/day/");
    // Findings first, tables after — the §8 order.
    expect(html).toContain("อ้อมทาง"); // the fixture's one finding, a detour
    expect(html.indexOf("อ้อมทาง")).toBeLessThan(html.indexOf('<div id="map"'));
    // "today" hides the next-day link rather than offering an empty future.
    expect(html).not.toContain('href="/day/2026-09-06"');
  });

  test("the map script never derives its FIRST view from an added layer's getBounds()", async () => {
    // Regression for the production bug: `L.featureGroup(layers).getBounds()` on
    // circles added before any setView/fitBounds throws in Leaflet 1.9 (a layer's
    // projection is deferred until the map has a view), which killed the whole
    // map script silently — no tiles, no route, attribution stuck on "Leaflet"
    // with no "© OpenStreetMap". The initial view must come from plain lat/lon
    // math (`L.LatLng#toBounds`), never from `getBounds()` on a layer.
    const html = await (await app(seeded()).handle(staffReq(`/day/${YMD}`))).text();
    const firstFit = html.indexOf("fitBounds(");
    const firstSetView = html.indexOf("setView(");
    expect(firstFit).toBeGreaterThan(-1);
    expect(firstSetView).toBeGreaterThan(-1);
    const firstView = Math.min(firstFit, firstSetView);
    const beforeFirstView = html.slice(0, firstView);
    expect(beforeFirstView).not.toMatch(/featureGroup\([^)]*\)\.getBounds\(\)/);
    expect(html).toContain("toBounds(");
  });

  test("/week/:ymd renders one row per day, each linking to its day page", async () => {
    const res = await app(seeded()).handle(staffReq(`/week/${YMD}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const day of weekDays(YMD)) expect(html).toContain(`href="/day/${day}"`);
  });

  test("a bad ymd is 400 on the pages too", async () => {
    const res = await app(seeded()).handle(staffReq("/day/2026-99-99"));
    expect(res.status).toBe(400);
  });

  test("/robots.txt disallows everything", async () => {
    const res = await app(seeded()).handle(staffReq("/robots.txt"));
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  test("the map popup escaper escapes for real, and is what the page ships", async () => {
    // `bindPopup` takes HTML. The shipped `esc` is executed here rather than
    // pattern-matched, so this test fails the day it goes back to String(v).
    const esc = new Function(`${MAP_ESC_FN} return esc;`)() as (v: unknown) => string;
    expect(esc('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(esc("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s");
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(42)).toBe("42");

    const html = await (await app(seeded()).handle(staffReq(`/day/${YMD}`))).text();
    expect(html).toContain("replace(/&/g, '&amp;')");
  });

  test("every response carries x-content-type-options: nosniff", async () => {
    const db = seeded();
    for (const req of [
      staffReq(`/day/${YMD}`),
      staffReq(`/week/${YMD}`),
      staffReq(`/api/day/${YMD}`),
      staffReq(`/api/week/${YMD}`),
      staffReq("/robots.txt"),
      staffReq("/"),
      staffReq("/day/2026-99-99"),
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { authorization: "Bearer feed-secret" } }),
      new Request(`http://truck.local/feed/daily?date=${YMD}`, { headers: { "cf-ray": "8a1b2c3d4e5f-BKK" } }),
    ]) {
      const res = await app(db).handle(req);
      expect(`${new URL(req.url).pathname} ${res.headers.get("x-content-type-options")}`).toBe(
        `${new URL(req.url).pathname} nosniff`,
      );
    }
  });

  test("an unknown route is 404", async () => {
    const res = await app(seeded()).handle(staffReq("/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("isYmd", () => {
  test("accepts real Bangkok calendar days only", () => {
    expect(isYmd("2026-09-05")).toBe(true);
    expect(isYmd("2024-02-29")).toBe(true);
    expect(isYmd("2026-02-29")).toBe(false);
    expect(isYmd("2026-00-10")).toBe(false);
    expect(isYmd("2026-9-5")).toBe(false);
    expect(isYmd("")).toBe(false);
  });
});

// ── stop spans (docs/CONTRACTS.md §9, "Additive since 2026-09-30") ───────────
//
// The production shape of the bug: the truck parked at HF Ville on the 29th at
// 14:34 and stayed the night, went to HF and back, and is STILL at HF Ville at
// the moment the report is read. Synthetic points only.

describe("stop spans on the day routes", () => {
  const NOW_30 = new Date(bkk("2026-09-30", "19:00:00") * 1000);
  const ARRIVE_29 = bkk("2026-09-29", "14:34:00");
  const YMD_30 = "2026-09-30";

  const driveIn = (tArrive: number): Point[] =>
    [0.2, 0.4, 0.6, 0.8].map((f, i) => pt(tArrive - 60 * (4 - i), lerp(HF, HFVILLE, f), { speed: 47, voltage: 13.8 }));
  const leg = (t0: number, a: typeof HF, b: typeof HF): Point[] =>
    [0.2, 0.4, 0.6, 0.8].map((f, i) => pt(t0 + 60 * i, lerp(a, b, f), { speed: 47, voltage: 13.8 }));

  const overnight = parked(ARRIVE_29, HFVILLE, 136, 600, { voltage: 12.7 }); // to 2026-09-30 13:04
  const leftVille = overnight[overnight.length - 1]!.t;
  const atHf = bkk(YMD_30, "13:21:00");
  const backAt = bkk(YMD_30, "14:26:00");
  const points: Point[] = [
    ...driveIn(ARRIVE_29),
    ...overnight,
    ...leg(leftVille + 60, HFVILLE, HF),
    ...parked(atHf, HF, 26, 60, { voltage: 12.7 }), // 13:21–13:46
    ...leg(bkk(YMD_30, "13:47:00"), HF, HFVILLE),
    ...parked(backAt, HFVILLE, 275, 60, { voltage: 12.7 }), // 14:26–19:00, the last fix is "now"
  ];

  const toRow = (p: Point): PointRow => ({
    teid: TEID,
    t: p.t,
    lat: p.lat,
    lon: p.lon,
    speed: p.speed,
    direction: null,
    mileageM: null,
    carState: null,
    teState: null,
    alarmState: null,
    voltage: p.voltage,
    other: null,
  });

  function seededSpans(): Database {
    const db = openDatabase(":memory:");
    insertPoints(db, points.map(toRow), 1);
    return db;
  }
  const appNow = (db: Database) =>
    createApp(db, { config: config(), now: () => NOW_30, sites: loadSites(), rules: loadRules() });

  test("the last synthetic fix is exactly `now` (the window's upper bound is inclusive of it)", () => {
    expect(points[points.length - 1]!.t).toBe(NOW_30.getTime() / 1000);
  });

  test("/api/day: the clipped first row keeps its numbers and gains the true arrival", async () => {
    const res = await appNow(seededSpans()).handle(staffReq(`/api/day/${YMD_30}`));
    const body = (await res.json()) as Record<string, any>;
    const first = body.stops[0];
    expect(first.site).toBe("hfville");
    // The day's own view: clipped at midnight, minutes counted inside the day.
    expect(first.arriveAt).toBeGreaterThanOrEqual(bkk(YMD_30, "00:00:00"));
    expect(first.arrive).toMatch(/^00:0\d$/);
    expect(first.minutes).toBe(Math.floor((first.departAt - first.arriveAt) / 60));
    // The truth, additively.
    expect(first.spanArriveAt).toBe(ARRIVE_29);
    expect(first.spanArriveOpen).toBe(false);
    expect(first.spanDepartAt).toBe(first.departAt);
    expect(first.spanEngineOffAt).toBe(ARRIVE_29);
    // The whole stop: 29 ก.ย. 14:34 to the last fix at 13:04 = 22 h 30 min. The day's own count stays in-day.
    expect(first.spanMinutes).toBe(22 * 60 + 30);
    expect(first.spanMinutes).toBeGreaterThan(first.minutes);
    expect(first.spanEngineOnMin).toBe(0);
  });

  test("/api/day: the last row is still parked — spanDepartAt null, minutes as the day counted them", async () => {
    const res = await appNow(seededSpans()).handle(staffReq(`/api/day/${YMD_30}`));
    const body = (await res.json()) as Record<string, any>;
    const last = body.stops[body.stops.length - 1];
    expect(last.arrive).toBe("14:26");
    expect(last.depart).toBe("19:00");
    expect(last.spanArriveAt).toBe(last.arriveAt);
    expect(last.spanDepartAt).toBeNull();
    expect(last.minutes).toBe(274);
    expect(last.spanMinutes).toBe(274); // begun and still going within the day
  });

  test("every stop carries all five span fields, and the old fields are still there", async () => {
    const res = await appNow(seededSpans()).handle(staffReq(`/api/day/${YMD_30}`));
    const body = (await res.json()) as Record<string, any>;
    for (const stop of body.stops) {
      for (const key of ["spanArriveAt", "spanArriveOpen", "spanDepartAt", "spanEngineOffAt", "spanEngineOnAt"]) {
        expect(stop).toHaveProperty(key);
      }
      for (const key of ["arrive", "depart", "arriveAt", "departAt", "minutes", "engine", "engineOffAt", "engineOnAt", "engineOffMin", "engineOnMin"]) {
        expect(stop).toHaveProperty(key);
      }
    }
  });

  test("the summary does not move: time at site is still the day's own", async () => {
    const res = await appNow(seededSpans()).handle(staffReq(`/api/day/${YMD_30}`));
    const body = (await res.json()) as Record<string, any>;
    const ville = body.stops.filter((s: any) => s.site === "hfville").reduce((n: number, s: any) => n + s.minutes, 0);
    expect(body.summary.timeAtSiteMin.hfville).toBe(ville);
  });

  test("/feed/daily carries the span fields too", async () => {
    const res = await appNow(seededSpans()).handle(
      new Request(`http://truck.local/feed/daily?date=${YMD_30}`, { headers: { authorization: "Bearer feed-secret" } }),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.stops[0].spanArriveAt).toBe(ARRIVE_29);
    expect(body.stops[body.stops.length - 1].spanDepartAt).toBeNull();
  });

  test("/api/week is unaffected: no stops, and the same summary the day route gives", async () => {
    const db = seededSpans();
    const week = (await (await appNow(db).handle(staffReq(`/api/week/${YMD_30}`))).json()) as { days: Record<string, any>[] };
    const day = (await (await appNow(db).handle(staffReq(`/api/day/${YMD_30}`))).json()) as Record<string, any>;
    const entry = week.days[week.days.length - 1]!;
    expect(entry.date).toBe(YMD_30);
    expect(entry).not.toHaveProperty("stops");
    expect(entry.summary).toEqual(day.summary);
    expect(entry.findings).toEqual(day.findings);
  });

  test("dayReport without the option is identity: the week and range routes never look past the day", () => {
    const deps = resolveDeps({ config: config(), now: () => NOW_30, sites: loadSites(), rules: loadRules() });
    const plain = dayReport(seededSpans(), deps, YMD_30);
    const first = plain.stops![0]!;
    expect(first.spanArriveAt).toBe(first.arriveAt);
    expect(first.spanArriveOpen).toBe(false);
    expect(first.spanDepartAt).toBe(first.departAt);
    expect(first.spanMinutes).toBe(first.minutes);
    const last = plain.stops![plain.stops!.length - 1]!;
    expect(last.spanDepartAt).toBe(last.departAt);
    const spanned = dayReport(seededSpans(), deps, YMD_30, { spans: true });
    expect(spanned.stops![0]!.spanArriveAt).toBe(ARRIVE_29);
  });

  test("/day renders the true dates, the still-parked cell, the whole duration and the heading dates", async () => {
    const html = await (await appNow(seededSpans()).handle(staffReq(`/day/${YMD_30}`))).text();
    expect(html).toContain(">29 ก.ย. 14:34</button>");
    expect(html).toContain('<td title="ยังจอดอยู่ · still parked">ยังจอดอยู่</td>');
    expect(html).toContain('<td class="num">22 ชม. 30 น.</td>');
    expect(html).not.toContain("นับเฉพาะเวลาในวันนี้");
    expect(html).toContain('<span class="hdate">30 ก.ย. 2026</span>');
    expect(html).toContain('<span id="map-view-text">ทั้งวัน · 30 ก.ย. 2026</span>');
  });

  test("the day page's map-data carries a view for the stop that crossed midnight", async () => {
    const html = await (await appNow(seededSpans()).handle(staffReq(`/day/${YMD_30}`))).text();
    const m = /id="map-data"[^>]*>(.*?)<\/script>/s.exec(html);
    const views = JSON.parse(m![1]!).views as Record<string, string>;
    expect(views["stop-0"]).toMatch(/^HF Ville · 29 ก\.ย\. 14:34 – 30 ก\.ย\. \d\d:\d\d$/);
  });
});
