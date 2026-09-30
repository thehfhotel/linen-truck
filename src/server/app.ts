// linen-truck — the Elysia application (docs/CONTRACTS.md §7).
//
// `createApp` owns the WHOLE dynamic surface; src/server/server.ts only wraps it
// in a `Bun.serve` (same split as guest-feedback), which is what lets every test
// here call `app.handle(req)` with no port, no disk and no network.
//
// THREE trees, and the boundary between them is the first thing every handler
// does:
//
//   /healthz      open. Database-free (§0) — it is the container's health probe,
//                 and a probe that reads SQLite reports "unhealthy" for a locked
//                 file rather than for a dead process.
//   /feed/*       bearer-gated and INTERNAL ONLY. A request that arrives with
//                 `Cf-Ray` or `CF-Connecting-IP` came through Cloudflare and is
//                 answered 404, before the token is even read, so a prober off
//                 the internet cannot learn the path exists.
//   everything    Cloudflare Access JWT, fail closed: no audience configured
//   else          means 503 on every page and every API (§1).
//
// Everything a handler could reach for outside itself arrives through `Deps`: the
// clock, `fetch`, the config, the two config files and the poller's in-memory
// status. There is exactly one `process.env` reader in `src/server` (config.ts)
// and exactly one `Date` (the default `now`), so a test can pin both.
//
// The surface is GET-ONLY (§7), so there is no CSRF check here and no socket peer
// address to weigh against TRUSTED_PROXY_CIDRS: neither had a caller, and code
// that is never executed is code nobody notices going wrong. See the note in
// auth.ts — the first mutating route brings the check back with it.

import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { StopSpan } from "../domain/span.ts";
import type { Rules, Site } from "../domain/types.ts";
import { cleanPoints } from "../domain/segment.ts";
import { SPAN_WINDOW_DAYS, stopSpans } from "../domain/span.ts";
import { summarizeDay } from "../domain/summary.ts";
import { addBangkokDays, bangkokDay } from "../shared/time.ts";
import { authenticateStaff } from "./auth.ts";
import { googleTilesEnabled, loadConfig, sinotrackConfigured, type Config } from "./config.ts";
import { bangkokDaySeconds, getDeviceStatus, latestPoll, openDatabase, pointsBetween, pointsForDay } from "./db.ts";
import type { PollerStatus } from "./poller.ts";
import { renderDayPage } from "./pages/day.ts";
import { newNonce, pageHeaders, type Basemap } from "./pages/layout.ts";
import { renderWeekPage } from "./pages/week.ts";
import { buildDayReport, summaryOnly, type DayReport } from "./report.ts";
import { loadRules, loadSites } from "./siteConfig.ts";
import { createTileService, type TileService } from "./tiles.ts";

export interface Deps {
  now: () => Date;
  fetch: typeof fetch;
  config: Config;
  sites: Site[];
  rules: Rules;
  /** The live poller's in-memory status (§6); a dormant default in tests. */
  pollerStatus: () => PollerStatus;
  /** The Google tile proxy (§7). Inert (`disabled`) while GOOGLE_MAPS_KEY is empty. */
  tiles: TileService;
}

const DORMANT: PollerStatus = {
  configured: false,
  lastAt: null,
  lastOk: null,
  lastError: null,
  lastSeen: null,
  lastNew: null,
};

/**
 * `db` is only needed to build the default tile service; `createApp` passes it,
 * and `server.ts` builds its own service explicitly, so a caller that has neither
 * (a test resolving deps for `dayReport`) still gets a complete `Deps`.
 */
export function resolveDeps(partial?: Partial<Deps>, db?: Database): Deps {
  const config = partial?.config ?? loadConfig(process.env);
  const now = partial?.now ?? (() => new Date());
  const doFetch = partial?.fetch ?? globalThis.fetch;
  return {
    now,
    fetch: doFetch,
    config,
    sites: partial?.sites ?? loadSites(),
    rules: partial?.rules ?? loadRules(),
    pollerStatus: partial?.pollerStatus ?? (() => ({ ...DORMANT, configured: sinotrackConfigured(config) })),
    tiles:
      partial?.tiles ??
      createTileService({ db: db ?? openDatabase(":memory:"), config, dataDir: config.dataDir, fetch: doFetch, now }),
  };
}

// ── responses ───────────────────────────────────────────────────────────────

/**
 * `nosniff` on everything this file answers with: a browser that sniffs a JSON
 * body as HTML is one reflected value away from executing it, and the day report
 * carries site names and finding text straight into the response.
 */
const jsonHeaders = (): Headers =>
  new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders() });

export const fail = (error: string, status: number): Response => json({ error }, status);

/** §7.1 — a body would already be one bit more than a prober deserves. */
const notFoundBare = (): Response =>
  new Response(null, {
    status: 404,
    headers: new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" }),
  });

// ── dates ───────────────────────────────────────────────────────────────────

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real Bangkok calendar date, not just four-two-two digits. `2026-02-31` parses
 * as a shape and would silently become 3 March in every downstream range query,
 * so the round trip through UTC is checked.
 */
export function isYmd(value: string): boolean {
  const m = YMD_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** Today in Bangkok, from the injected clock. */
export const todayYmd = (deps: Deps): string => bangkokDay(deps.now().toISOString());

// ── the report ──────────────────────────────────────────────────────────────

/**
 * One day, end to end: stored points → the pure domain summary → the §9 wire
 * shape. Every route that answers with numbers goes through here, which is why
 * the week table and the day page can never disagree.
 *
 * `spans: true` also loads `SPAN_WINDOW_DAYS` either side of the day (never past
 * `now`) and fills the stops' `span*` fields with their real, cross-midnight
 * extent (§3 "Stop spans"). Only the three routes that SHOW stops ask for it; the
 * week and range routes strip stops anyway, so they do not pay for the window.
 */
export function dayReport(db: Database, deps: Deps, ymd: string, opts?: { spans?: boolean }): DayReport {
  const teid = deps.config.sinotrackTeid;
  const points = pointsForDay(db, teid, ymd);
  const summary = summarizeDay(ymd, points, deps.sites, deps.rules);
  const nowS = Math.floor(deps.now().getTime() / 1000);
  let spans: StopSpan[] | undefined;
  if (opts?.spans) {
    const { from, to } = bangkokDaySeconds(ymd);
    const windowPoints = cleanPoints(
      pointsBetween(db, teid, from - SPAN_WINDOW_DAYS * 86400, Math.min(to + SPAN_WINDOW_DAYS * 86400, nowS + 1)),
    );
    spans = stopSpans(cleanPoints(points), windowPoints, summary.stops, deps.sites, deps.rules);
  }
  return buildDayReport({
    teid,
    summary,
    points,
    sites: deps.sites,
    rules: deps.rules,
    status: getDeviceStatus(db, teid),
    poll: latestPoll(db),
    pollerConfigured: deps.pollerStatus().configured,
    generatedAt: nowS,
    ...(spans ? { spans } : {}),
  });
}

/** The seven Bangkok days ending at `ymd`, oldest first. */
export const weekDays = (ymd: string): string[] => [-6, -5, -4, -3, -2, -1, 0].map((n) => addBangkokDays(ymd, n));

// ── /feed/* auth (§7) ───────────────────────────────────────────────────────

/**
 * `Authorization: Bearer <token>`, constant-time over equal-length buffers.
 *
 * A length mismatch returns before the compare — `timingSafeEqual` throws on
 * unequal lengths — so a prefix of the real token is a plain 401 and leaks only
 * the length, which the header already carries.
 */
export function bearerMatches(header: string | null, token: string): boolean {
  if (header === null || token === "") return false;
  const trimmed = header.trim();
  if (!/^Bearer\s/i.test(trimmed)) return false;
  const presented = Buffer.from(trimmed.slice(trimmed.indexOf(" ") + 1).trim(), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(presented, expected);
}

/**
 * The three checks of §7, in order. Returns the refusal, or `null` to continue.
 *
 *   1. INTERNAL ONLY. Anything through the Cloudflare tunnel carries `Cf-Ray` and
 *      `CF-Connecting-IP`; hf-mcp, which reaches this container over the estate's
 *      private site-to-site link (the URL is its own `TRUCK_FEED_URL`), carries
 *      neither.
 *   2. NO TOKEN → 404, not 503 (§1). The feed is not "temporarily unavailable"
 *      when it was never turned on; it does not exist.
 *   3. BEARER.
 */
export function authorizeFeed(request: Request, deps: Deps): Response | null {
  if (request.headers.has("cf-ray") || request.headers.has("cf-connecting-ip")) return notFoundBare();
  const token = deps.config.feedToken;
  if (token === "") return notFoundBare();
  if (!bearerMatches(request.headers.get("authorization"), token)) return fail("unauthorized", 401);
  return null;
}

// ── the app ─────────────────────────────────────────────────────────────────

/** How many days `/feed/range` will answer in one call (§7). */
export const RANGE_MAX_DAYS = 62;

// ── the Google basemap (rev 4) ──────────────────────────────────────────────

/** Which basemap a page draws: Google only while a key is configured (§8). */
const basemapOf = (deps: Deps): Basemap => (googleTilesEnabled(deps.config) ? "google" : "osm");

/** A base-10 unsigned integer string, or null. Rejects signs, decimals, exponents, hex, blanks. */
const uint = (raw: unknown): number | null => {
  if (typeof raw !== "string" || !/^[0-9]{1,9}$/.test(raw)) return null;
  return Number(raw);
};

/** A finite decimal number string (no NaN/Infinity, no blanks), or null. */
const decimal = (raw: string | null): number | null => {
  if (raw === null || !/^-?[0-9]+(\.[0-9]+)?$/.test(raw)) return null;
  return Number(raw);
};

/**
 * `zoom` 0..22 as an integer; `north`/`south` within ±90 with north >= south;
 * `east`/`west` within ±180 (east < west is legal: a box across the antimeridian).
 */
function parseViewport(
  params: URLSearchParams,
): { zoom: number; north: number; south: number; east: number; west: number } | null {
  const zoom = uint(params.get("zoom"));
  const north = decimal(params.get("north"));
  const south = decimal(params.get("south"));
  const east = decimal(params.get("east"));
  const west = decimal(params.get("west"));
  if (zoom === null || zoom > 22 || north === null || south === null || east === null || west === null) return null;
  if (Math.abs(north) > 90 || Math.abs(south) > 90 || north < south) return null;
  if (Math.abs(east) > 180 || Math.abs(west) > 180) return null;
  return { zoom, north, south, east, west };
}

export function createApp(db: Database, partial?: Partial<Deps>): Elysia {
  const deps = resolveDeps(partial, db);

  /** The Access guard every route but `/healthz` and `/feed/*` runs first. */
  const guard = async (request: Request): Promise<Response | null> => {
    const result = await authenticateStaff(request, deps);
    return result.ok ? null : fail(result.error, result.status);
  };

  const app: Elysia = new Elysia().onError(({ error, code }) => {
    if (code === "NOT_FOUND") return fail("not_found", 404);
    if (code === "VALIDATION" || code === "PARSE") return fail("bad_request", 400);
    // The server never echoes exception text — it can carry paths and hostnames.
    console.error(`app: unhandled ${code}: ${error instanceof Error ? error.message : String(error)}`);
    return fail("internal", 500);
  }) as unknown as Elysia;

  // ── open ──────────────────────────────────────────────────────────────────

  app.get("/healthz", () => {
    const poller = deps.pollerStatus();
    return json({
      ok: true,
      commit: deps.config.gitSha,
      time: deps.now().toISOString(),
      staffAuth: deps.config.cfAccessAud.length > 0 ? "configured" : "missing",
      feed: deps.config.feedToken !== "" ? "on" : "off",
      poller: {
        // `lastError` is already the /healthz-safe text (poller.ts
        // `publicPollError`): our own `<proc>: <reason>`, or `internal`. Raw
        // exception text never leaves poll_log and stderr (§4).
        configured: poller.configured,
        lastAt: poller.lastAt,
        lastOk: poller.lastOk,
        lastError: poller.lastError,
        lastSeen: poller.lastSeen,
        lastNew: poller.lastNew,
      },
    });
  });

  // ── internal feed ─────────────────────────────────────────────────────────

  app.get("/feed/daily", ({ request }) => {
    const refusal = authorizeFeed(request, deps);
    if (refusal) return refusal;
    const date = new URL(request.url).searchParams.get("date") ?? "";
    if (!isYmd(date)) return fail("bad-date", 400);
    return json(dayReport(db, deps, date, { spans: true }));
  });

  app.get("/feed/range", ({ request }) => {
    const refusal = authorizeFeed(request, deps);
    if (refusal) return refusal;
    const params = new URL(request.url).searchParams;
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (!isYmd(from) || !isYmd(to) || from > to) return fail("bad-date", 400);
    const days: string[] = [];
    for (let ymd = from; ymd <= to; ymd = addBangkokDays(ymd, 1)) {
      days.push(ymd);
      if (days.length > RANGE_MAX_DAYS) return fail("bad-range", 400);
    }
    return json({ days: days.map((ymd) => summaryOnly(dayReport(db, deps, ymd))) });
  });

  // ── gated ─────────────────────────────────────────────────────────────────

  app.get("/", async ({ request }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    return new Response(null, {
      status: 302,
      headers: {
        location: `/day/${todayYmd(deps)}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get("/robots.txt", async ({ request }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get("/day/:ymd", async ({ request, params }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const ymd = String(params.ymd);
    if (!isYmd(ymd)) return fail("bad-date", 400);
    const today = todayYmd(deps);
    const nonce = newNonce();
    const basemap = basemapOf(deps);
    const html = renderDayPage({
      report: dayReport(db, deps, ymd, { spans: true }),
      sites: deps.sites,
      nonce,
      prevYmd: addBangkokDays(ymd, -1),
      // The future holds no track, so the link is rendered dead rather than
      // walking a manager into an empty page.
      nextYmd: ymd >= today ? null : addBangkokDays(ymd, 1),
      todayYmd: today,
      basemap,
      // The note shows from the first byte when today's budget is already spent,
      // rather than waiting for the first tile to fail.
      basemapPaused: basemap === "google" && deps.tiles.status().today.upstream >= deps.config.tileDailyCap,
    });
    return new Response(html, { headers: pageHeaders(nonce, undefined, basemap) });
  });

  app.get("/week/:ymd", async ({ request, params }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const ymd = String(params.ymd);
    if (!isYmd(ymd)) return fail("bad-date", 400);
    const nonce = newNonce();
    const html = renderWeekPage({
      days: weekDays(ymd).map((d) => summaryOnly(dayReport(db, deps, d))),
      sites: deps.sites,
      nonce,
      ymd,
      todayYmd: todayYmd(deps),
    });
    return new Response(html, { headers: pageHeaders(nonce, undefined, basemapOf(deps)) });
  });

  app.get("/api/day/:ymd", async ({ request, params }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const ymd = String(params.ymd);
    if (!isYmd(ymd)) return fail("bad-date", 400);
    return json(dayReport(db, deps, ymd, { spans: true }));
  });

  app.get("/api/week/:ymd", async ({ request, params }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const ymd = String(params.ymd);
    if (!isYmd(ymd)) return fail("bad-date", 400);
    return json({ days: weekDays(ymd).map((d) => summaryOnly(dayReport(db, deps, d))) });
  });

  // ── the Google tile proxy (rev 4) ─────────────────────────────────────────

  app.get("/tiles/:z/:x/:y", async ({ request, params }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const z = uint(params.z);
    const x = uint(params.x);
    const y = uint(params.y);
    if (z === null || x === null || y === null || z > 22) return fail("bad-tile", 400);
    if (x >= 2 ** z || y >= 2 ** z) return fail("bad-tile", 400);

    let result;
    try {
      result = await deps.tiles.getTile(z, x, y);
    } catch {
      // The service returns results, it does not throw; and whatever it threw, its
      // message could quote an upstream URL. Only the fixed error leaves here.
      return fail("tile-upstream", 502);
    }
    switch (result.kind) {
      case "disabled":
        return fail("tiles-disabled", 404);
      case "over-cap":
        return fail("tile-budget", 503);
      case "upstream-error":
        return fail("tile-upstream", 502);
      case "ok":
        return new Response(result.body as BodyInit, {
          headers: {
            "content-type": result.contentType,
            "cache-control": result.cacheControl,
            "x-content-type-options": "nosniff",
          },
        });
    }
  });

  app.get("/api/map/attribution", async ({ request }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const q = parseViewport(new URL(request.url).searchParams);
    if (!q) return fail("bad-params", 400);
    let result;
    try {
      result = await deps.tiles.attribution(q);
    } catch {
      return fail("tile-upstream", 502);
    }
    if (result.kind === "disabled") return fail("tiles-disabled", 404);
    if (result.kind === "upstream-error") return fail("tile-upstream", 502);
    return json({ copyright: result.copyright });
  });

  app.get("/api/map/status", async ({ request }) => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    const status = deps.tiles.status();
    return json(status.enabled ? status : { enabled: false });
  });

  return app;
}
