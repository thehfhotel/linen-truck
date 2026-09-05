// The HTTP surface (docs/CONTRACTS.md §7–§9).
//
// Every test drives `app.handle(req)` against an in-memory database seeded
// through `scripts/import.ts` — the same ingest path the poller uses — so what is
// asserted here is the real route, the real domain maths and the real report
// shape, with no network and no disk.

import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApp, isYmd, weekDays } from "../../src/server/app.ts";
import { _internal as authInternal } from "../../src/server/auth.ts";
import { loadConfig, type Config, type Env } from "../../src/server/config.ts";
import { openDatabase } from "../../src/server/db.ts";
import { MAP_ESC_FN } from "../../src/server/pages/day.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { importRawRows } from "../../scripts/import.ts";
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
    expect(body.summary.km).toBe(15.7);
    expect(body.summary.timeAtSiteMin).toEqual({ hf: 8, hfville: 114 });
    expect(body.summary.findingCount).toEqual({ "unknown-stop": 1, detour: 1, "outside-hours": 0 });
    expect(body.summary.firstDeparture).toMatch(/^\d{2}:\d{2}$/);

    expect(body.trips).toHaveLength(4);
    expect(body.legs).toHaveLength(2);
    expect(body.path).toHaveLength(82);
    expect(body.path[0]).toHaveLength(3);

    const kinds = body.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(["unknown-stop", "detour"]);
    const unknown = body.findings[0];
    expect(unknown.text.th).toContain("จอดที่ไม่รู้จัก");
    expect(unknown.text.en).toContain("Unknown stop");
    expect(unknown.mapUrl).toContain("https://www.google.com/maps?q=");
    const detour = body.findings[1];
    expect(detour.referenceKm).toBe(4.9);
    expect(detour.ratio).toBeGreaterThan(1.25);

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

    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain('integrity="sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg=="');
    expect(html).toContain(`data-ymd="${YMD}"`);
    expect(html).toContain("/api/day/");
    // Findings first, tables after — the §8 order.
    expect(html.indexOf("จอดที่ไม่รู้จัก")).toBeLessThan(html.indexOf('<div id="map"'));
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
