// The Google tile proxy (docs/CONTRACTS.md §5, §7, §8; ADR 0002).
//
// NO NETWORK anywhere in this file: every upstream call goes to a fake `fetch`
// that records the URL it was given and answers from canned responses. The
// service under test owns the session, the disk cache, the per-day counter and
// the daily hard stop, and the API key must never surface anywhere the browser
// or a log could see it — the last describe block proves that end to end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/server/config.ts";
import {
  getMapSession,
  getTileMeta,
  getTileUsage,
  openDatabase,
  setMapSession,
} from "../../src/server/db.ts";
import {
  createTileService,
  parseCacheControl,
  SESSION_REQUEST,
  SESSION_STYLE_VERSION,
  TILE_CACHE_MAX_BYTES,
  type TileResult,
  type TileService,
} from "../../src/server/tiles.ts";

// ── parseCacheControl ───────────────────────────────────────────────────────

const CC = (over: Partial<ReturnType<typeof parseCacheControl>> = {}) => ({
  maxAge: null,
  staleWhileRevalidate: null,
  noStore: false,
  noCache: false,
  mustRevalidate: false,
  private: false,
  ...over,
});

describe("parseCacheControl", () => {
  const table: [string, string | null, ReturnType<typeof parseCacheControl>][] = [
    ["null header", null, CC()],
    ["empty header", "", CC()],
    ["whitespace only", "   ", CC()],
    ["public with max-age", "public, max-age=86400", CC({ maxAge: 86400 })],
    ["private with max-age", "private, max-age=3600", CC({ private: true, maxAge: 3600 })],
    ["no-store", "no-store", CC({ noStore: true })],
    ["no-cache", "no-cache", CC({ noCache: true })],
    ["max-age zero", "max-age=0", CC({ maxAge: 0 })],
    ["must-revalidate", "max-age=60, must-revalidate", CC({ maxAge: 60, mustRevalidate: true })],
    [
      "stale-while-revalidate",
      "max-age=600, stale-while-revalidate=86400",
      CC({ maxAge: 600, staleWhileRevalidate: 86400 }),
    ],
    ["upper case names and spaces", "  Max-Age = 120 ,  PRIVATE ", CC({ maxAge: 120, private: true })],
    ["quoted max-age", 'max-age="300"', CC({ maxAge: 300 })],
    ["non-numeric max-age is ignored", "max-age=soon", CC()],
    ["negative max-age is ignored", "max-age=-5", CC()],
    ["fractional max-age is ignored", "max-age=1.5", CC()],
    ["private with field names is still private", 'private="set-cookie, x-thing", max-age=99', CC({ private: true, maxAge: 99 })],
    ["unknown directives are skipped", "immutable, community=UCI, max-age=10", CC({ maxAge: 10 })],
    ["s-maxage alone is not max-age", "s-maxage=500", CC()],
    ["duplicate max-age: the smaller wins", "max-age=100, max-age=50", CC({ maxAge: 50 })],
    ["everything at once", "private, no-store, no-cache, must-revalidate, max-age=1, stale-while-revalidate=2", CC({ private: true, noStore: true, noCache: true, mustRevalidate: true, maxAge: 1, staleWhileRevalidate: 2 })],
  ];
  for (const [name, header, expected] of table) {
    test(name, () => {
      expect(parseCacheControl(header)).toEqual(expected);
    });
  }
});

// ── harness ─────────────────────────────────────────────────────────────────

const KEY = "test-key-Zq81xY";
const SESSION = "sess-token-A1";
const T0 = Date.UTC(2026, 8, 5, 5, 0, 0); // 2026-09-05 12:00 Bangkok
const PNG = (n: number, size = 100): Uint8Array => new Uint8Array(size).fill(n);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null;
}

interface TileReply {
  status?: number;
  cacheControl?: string | null;
  etag?: string | null;
  contentType?: string | null;
  body?: Uint8Array | string;
}

class Harness {
  nowMs = T0;
  calls: Call[] = [];
  logs: string[] = [];
  dir = mkdtempSync(join(tmpdir(), "truck-tiles-"));
  db: Database = openDatabase(":memory:");
  sessionCounter = 0;
  /** Session tokens the fake upstream still accepts. */
  validSessions = new Set<string>();
  /** Next answers for /v1/2dtiles, consumed in order; falls back to `defaultTile`. */
  tileQueue: (TileReply | ((c: Call) => TileReply | Promise<TileReply>))[] = [];
  defaultTile: TileReply = { cacheControl: "public, max-age=86400", etag: '"e1"', contentType: "image/png", body: PNG(7) };
  viewport: { status: number; body: unknown } = { status: 200, body: { copyright: "Map data ©2026 Google" } };
  /** Next answers for the viewport endpoint, consumed in order; falls back to `viewport`. */
  viewportQueue: { status: number; body: string }[] = [];
  createStatus = 200;
  createExpiryS: number | null = null;
  throwOnFetch: Error | null = null;
  config: Config;
  service: TileService;

  constructor(env: Record<string, string> = {}, opts: { maxCacheBytes?: number; key?: string } = {}) {
    this.config = loadConfig({ DATA_DIR: this.dir, GOOGLE_MAPS_KEY: opts.key ?? KEY, ...env });
    this.service = this.build(opts.maxCacheBytes);
  }

  build(maxCacheBytes?: number): TileService {
    return createTileService({
      db: this.db,
      config: this.config,
      dataDir: this.dir,
      fetch: this.fetch,
      now: () => new Date(this.nowMs),
      log: (line) => this.logs.push(line),
      ...(maxCacheBytes === undefined ? {} : { maxCacheBytes }),
    });
  }

  get nowS(): number {
    return Math.floor(this.nowMs / 1000);
  }

  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
      signal: (init?.signal as AbortSignal | undefined) ?? null,
    };
    this.calls.push(call);
    if (this.throwOnFetch) throw this.throwOnFetch;

    if (url.includes("/v1/createSession")) {
      if (this.createStatus !== 200) return new Response('{"error":{"message":"nope"}}', { status: this.createStatus });
      this.sessionCounter += 1;
      const token = this.sessionCounter === 1 ? SESSION : `sess-token-A${this.sessionCounter}`;
      this.validSessions.add(token);
      const expiry = this.createExpiryS ?? this.nowS + 14 * 86400;
      return Response.json({ session: token, expiry: String(expiry), tileWidth: 256, tileHeight: 256, imageFormat: "png" });
    }
    if (url.includes("/tile/v1/viewport")) {
      const queued = this.viewportQueue.shift();
      if (queued) return new Response(queued.body, { status: queued.status });
      return Response.json(this.viewport.body, { status: this.viewport.status });
    }
    if (url.includes("/v1/2dtiles/")) {
      const session = new URL(url).searchParams.get("session") ?? "";
      if (!this.validSessions.has(session) && this.tileQueue.length === 0) {
        return new Response('{"error":{"message":"The provided session token has expired."}}', { status: 400 });
      }
      const next = this.tileQueue.shift();
      const reply = typeof next === "function" ? await next(call) : (next ?? this.defaultTile);
      const h = new Headers();
      if (reply.cacheControl !== null && reply.cacheControl !== undefined) h.set("cache-control", reply.cacheControl);
      if (reply.etag) h.set("etag", reply.etag);
      if (reply.contentType !== null && reply.contentType !== undefined) h.set("content-type", reply.contentType);
      const status = reply.status ?? 200;
      const body = status === 304 ? null : (reply.body ?? PNG(7));
      return new Response(body as BodyInit | null, { status, headers: h });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

  tileCalls(): Call[] {
    return this.calls.filter((c) => c.url.includes("/v1/2dtiles/"));
  }
  sessionCalls(): Call[] {
    return this.calls.filter((c) => c.url.includes("/v1/createSession"));
  }
  viewportCalls(): Call[] {
    return this.calls.filter((c) => c.url.includes("/tile/v1/viewport"));
  }
  file(z: number, x: number, y: number): string {
    return join(this.dir, "tiles", String(z), String(x), String(y));
  }
  ymd(): string {
    return new Date(this.nowMs + 7 * 3600_000).toISOString().slice(0, 10);
  }
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.db.close();
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.cleanup());

const asOk = (r: TileResult) => {
  expect(r.kind).toBe("ok");
  return r as Extract<TileResult, { kind: "ok" }>;
};

// ── disabled ────────────────────────────────────────────────────────────────

describe("disabled mode (empty GOOGLE_MAPS_KEY)", () => {
  test("getTile and attribution answer disabled and never touch the network or the disk", async () => {
    const off = new Harness({ GOOGLE_MAPS_KEY: "" });
    try {
      expect(await off.service.getTile(12, 3, 4)).toEqual({ kind: "disabled" });
      expect(
        await off.service.attribution({ zoom: 12, north: 9.2, south: 9.1, east: 99.4, west: 99.3 }),
      ).toEqual({ kind: "disabled" });
      expect(off.calls).toHaveLength(0);
      expect(existsSync(join(off.dir, "tiles"))).toBe(false);
      expect(off.service.status().enabled).toBe(false);
    } finally {
      off.cleanup();
    }
  });
});

// ── miss, store, hit ────────────────────────────────────────────────────────

describe("a miss, a store and a hit", () => {
  test("first request: createSession, then the tile; stored on disk with a meta row", async () => {
    const r = asOk(await h.service.getTile(12, 3200, 1900));
    expect(r.contentType).toBe("image/png");
    expect(Array.from(r.body)).toEqual(Array.from(PNG(7)));
    expect(r.cacheControl).toBe("private, max-age=86400");

    expect(h.calls).toHaveLength(2);
    const [create, tile] = h.calls;
    expect(create!.method).toBe("POST");
    expect(create!.url).toBe(`https://tile.googleapis.com/v1/createSession?key=${KEY}`);
    expect(create!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(create!.body!)).toEqual({
      mapType: "roadmap",
      language: "th",
      region: "TH",
      styles: [{ featureType: "poi.business", stylers: [{ visibility: "on" }] }],
    });
    expect(tile!.method).toBe("GET");
    expect(tile!.url).toBe(`https://tile.googleapis.com/v1/2dtiles/12/3200/1900?session=${SESSION}&key=${KEY}`);

    expect(readFileSync(h.file(12, 3200, 1900)).length).toBe(100);
    const meta = getTileMeta(h.db, 12, 3200, 1900)!;
    expect(meta.expiresAt).toBe(h.nowS + 86400);
    expect(meta.fetchedAt).toBe(h.nowS);
    expect(meta.etag).toBe('"e1"');
    expect(meta.contentType).toBe("image/png");
    expect(meta.bytes).toBe(100);
    expect(getTileUsage(h.db, h.ymd())).toEqual({ ymd: h.ymd(), upstream: 1, hits: 0 });
  });

  test("second request is a hit: no upstream, hits counted, remaining seconds in cache-control", async () => {
    await h.service.getTile(12, 3200, 1900);
    h.calls.length = 0;
    h.advance(1000);
    const r = asOk(await h.service.getTile(12, 3200, 1900));
    expect(h.calls).toHaveLength(0);
    expect(Array.from(r.body)).toEqual(Array.from(PNG(7)));
    expect(r.cacheControl).toBe("private, max-age=85400");
    expect(getTileUsage(h.db, h.ymd())).toMatchObject({ upstream: 1, hits: 1 });
  });

  test("a hit whose file has vanished from disk is refetched, not served empty", async () => {
    await h.service.getTile(5, 1, 1);
    rmSync(h.file(5, 1, 1));
    h.calls.length = 0;
    const r = asOk(await h.service.getTile(5, 1, 1));
    expect(h.tileCalls()).toHaveLength(1);
    expect(r.body.length).toBe(100);
  });

  test("a missing content-type header falls back to image/png", async () => {
    h.defaultTile = { cacheControl: "max-age=60", contentType: null };
    expect(asOk(await h.service.getTile(1, 0, 0)).contentType).toBe("image/png");
  });

  test("every upstream call carries a 20 s timeout signal", async () => {
    await h.service.getTile(12, 3200, 1900);
    await h.service.attribution({ zoom: 12, north: 9.2, south: 9.1, east: 99.4, west: 99.3 });
    expect(h.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of h.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });
});

// ── expiry: conditional GET, stale without etag ─────────────────────────────

describe("expiry", () => {
  test("stale with an etag: If-None-Match, and a 304 refreshes from the previous max-age", async () => {
    await h.service.getTile(12, 3, 4);
    h.advance(86401);
    h.tileQueue.push({ status: 304, cacheControl: null, etag: '"e1"' });
    h.calls.length = 0;

    const r = asOk(await h.service.getTile(12, 3, 4));
    expect(h.tileCalls()).toHaveLength(1);
    expect(h.tileCalls()[0]!.headers["if-none-match"]).toBe('"e1"');
    expect(Array.from(r.body)).toEqual(Array.from(PNG(7)));
    expect(r.cacheControl).toBe("private, max-age=86400");
    expect(getTileMeta(h.db, 12, 3, 4)!.expiresAt).toBe(h.nowS + 86400);

    // …and inside the refreshed window it is a hit again.
    h.advance(60);
    h.calls.length = 0;
    asOk(await h.service.getTile(12, 3, 4));
    expect(h.tileCalls()).toHaveLength(0);
  });

  test("a 304 that carries its own max-age wins over the previous one", async () => {
    await h.service.getTile(12, 3, 4);
    h.advance(86401);
    h.tileQueue.push({ status: 304, cacheControl: "public, max-age=120", etag: '"e1"' });
    const r = asOk(await h.service.getTile(12, 3, 4));
    expect(r.cacheControl).toBe("private, max-age=120");
    expect(getTileMeta(h.db, 12, 3, 4)!.expiresAt).toBe(h.nowS + 120);
  });

  test("a 304 that turns the tile private drops the stored copy but serves it once", async () => {
    await h.service.getTile(12, 3, 4);
    h.advance(86401);
    h.tileQueue.push({ status: 304, cacheControl: "private, max-age=120", etag: '"e1"' });
    const r = asOk(await h.service.getTile(12, 3, 4));
    expect(Array.from(r.body)).toEqual(Array.from(PNG(7)));
    expect(getTileMeta(h.db, 12, 3, 4)).toBeNull();
    expect(existsSync(h.file(12, 3, 4))).toBe(false);
  });

  test("stale with an etag but a 200 answer replaces the stored tile", async () => {
    await h.service.getTile(12, 3, 4);
    h.advance(90000);
    h.tileQueue.push({ cacheControl: "max-age=500", etag: '"e2"', body: PNG(9) });
    const r = asOk(await h.service.getTile(12, 3, 4));
    expect(Array.from(r.body)).toEqual(Array.from(PNG(9)));
    const meta = getTileMeta(h.db, 12, 3, 4)!;
    expect(meta.etag).toBe('"e2"');
    expect(meta.expiresAt).toBe(h.nowS + 500);
    expect(readFileSync(h.file(12, 3, 4))[0]).toBe(9);
  });

  test("stale without an etag: a plain refetch, no If-None-Match", async () => {
    h.defaultTile = { cacheControl: "max-age=100", etag: null, body: PNG(3) };
    await h.service.getTile(8, 2, 2);
    h.advance(101);
    h.calls.length = 0;
    const r = asOk(await h.service.getTile(8, 2, 2));
    expect(h.tileCalls()).toHaveLength(1);
    expect(h.tileCalls()[0]!.headers["if-none-match"]).toBeUndefined();
    expect(r.body.length).toBe(100);
  });

  test("a stale tile is NEVER served when the upstream fails", async () => {
    await h.service.getTile(12, 3, 4);
    h.advance(86401);
    h.tileQueue.push({ status: 503, cacheControl: null, body: "down" });
    const r = await h.service.getTile(12, 3, 4);
    expect(r).toEqual({ kind: "upstream-error", status: 503 });
  });
});

// ── not storable ────────────────────────────────────────────────────────────

describe("responses that must not be stored", () => {
  const cases: [string, TileReply, string][] = [
    ["private", { cacheControl: "private, max-age=600" }, "private, max-age=600"],
    ["no-store", { cacheControl: "no-store, max-age=600" }, "private, no-store"],
    ["no-cache", { cacheControl: "no-cache, max-age=600" }, "private, no-store"],
    ["no max-age", { cacheControl: "public" }, "private, no-store"],
    ["no Cache-Control header at all", { cacheControl: null }, "private, no-store"],
    ["max-age=0", { cacheControl: "max-age=0" }, "private, max-age=0"],
  ];
  for (const [name, reply, browser] of cases) {
    test(`${name}: passed through, never stored, browser header ${browser}`, async () => {
      h.defaultTile = { ...reply, body: PNG(5) };
      const r = asOk(await h.service.getTile(9, 4, 4));
      expect(r.cacheControl).toBe(browser);
      expect(Array.from(r.body)).toEqual(Array.from(PNG(5)));
      expect(getTileMeta(h.db, 9, 4, 4)).toBeNull();
      expect(existsSync(h.file(9, 4, 4))).toBe(false);
      // A second request goes upstream again.
      h.calls.length = 0;
      asOk(await h.service.getTile(9, 4, 4));
      expect(h.tileCalls()).toHaveLength(1);
    });
  }
});

// ── the daily cap ───────────────────────────────────────────────────────────

describe("the daily hard stop", () => {
  test("over the cap: over-cap with NO upstream tile call, but a fresh hit is still served", async () => {
    const capped = new Harness({ TILE_DAILY_CAP: "2" });
    try {
      asOk(await capped.service.getTile(10, 1, 1));
      asOk(await capped.service.getTile(10, 1, 2));
      capped.calls.length = 0;
      expect(await capped.service.getTile(10, 1, 3)).toEqual({ kind: "over-cap" });
      expect(capped.tileCalls()).toHaveLength(0);
      // Fresh hit: served over the cap.
      asOk(await capped.service.getTile(10, 1, 1));
      expect(capped.tileCalls()).toHaveLength(0);
      expect(getTileUsage(capped.db, capped.ymd())).toMatchObject({ upstream: 2, hits: 1 });
    } finally {
      capped.cleanup();
    }
  });

  test("a cap of 0 stops every upstream request", async () => {
    const zero = new Harness({ TILE_DAILY_CAP: "0" });
    try {
      expect(await zero.service.getTile(10, 1, 1)).toEqual({ kind: "over-cap" });
      expect(zero.tileCalls()).toHaveLength(0);
    } finally {
      zero.cleanup();
    }
  });

  test("a conditional request is an upstream request too: stale + over cap is over-cap, never the stale bytes", async () => {
    const capped = new Harness({ TILE_DAILY_CAP: "1" });
    try {
      capped.defaultTile = { cacheControl: "max-age=60", etag: '"e"', body: PNG(2) };
      asOk(await capped.service.getTile(10, 1, 1));
      capped.advance(61);
      capped.calls.length = 0;
      expect(await capped.service.getTile(10, 1, 1)).toEqual({ kind: "over-cap" });
      expect(capped.tileCalls()).toHaveLength(0);
    } finally {
      capped.cleanup();
    }
  });

  test("the counter counts ATTEMPTS, not successes", async () => {
    h.tileQueue.push({ status: 500, cacheControl: null, body: "boom" });
    expect(await h.service.getTile(6, 1, 1)).toEqual({ kind: "upstream-error", status: 500 });
    expect(getTileUsage(h.db, h.ymd()).upstream).toBe(1);
    asOk(await h.service.getTile(6, 1, 2));
    expect(getTileUsage(h.db, h.ymd()).upstream).toBe(2);
  });

  test("session and viewport calls are not counted", async () => {
    await h.service.attribution({ zoom: 12, north: 9.2, south: 9.1, east: 99.4, west: 99.3 });
    expect(h.sessionCalls()).toHaveLength(1);
    expect(h.viewportCalls()).toHaveLength(1);
    expect(getTileUsage(h.db, h.ymd()).upstream).toBe(0);
  });

  test("the count is per Bangkok day: it starts again at Bangkok midnight", async () => {
    const capped = new Harness({ TILE_DAILY_CAP: "1" });
    try {
      capped.defaultTile = { cacheControl: "max-age=60", etag: null, body: PNG(2) };
      asOk(await capped.service.getTile(10, 1, 1));
      expect(await capped.service.getTile(10, 1, 2)).toEqual({ kind: "over-cap" });
      // 2026-09-05 12:00 Bangkok + 13 h = 2026-09-06 01:00 Bangkok.
      capped.advance(13 * 3600);
      asOk(await capped.service.getTile(10, 1, 2));
    } finally {
      capped.cleanup();
    }
  });
});

// ── in-flight dedupe ────────────────────────────────────────────────────────

describe("in-flight dedupe", () => {
  test("three concurrent calls for one tile make ONE upstream tile call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.tileQueue.push(async () => {
      await gate;
      return { cacheControl: "max-age=60", etag: null, body: PNG(4) };
    });
    const all = Promise.all([h.service.getTile(11, 7, 7), h.service.getTile(11, 7, 7), h.service.getTile(11, 7, 7)]);
    // Let the first call reach the upstream before releasing it.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await all;
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    expect(h.tileCalls()).toHaveLength(1);
    expect(getTileUsage(h.db, h.ymd()).upstream).toBe(1);
  });

  test("different tiles are NOT merged", async () => {
    await Promise.all([h.service.getTile(11, 7, 7), h.service.getTile(11, 7, 8)]);
    expect(h.tileCalls()).toHaveLength(2);
    expect(h.sessionCalls()).toHaveLength(1);
  });
});

// ── the session ─────────────────────────────────────────────────────────────

const PARAMS = JSON.stringify(SESSION_REQUEST);

describe("the session token", () => {
  test("created lazily once, persisted, and reused across tiles", async () => {
    expect(h.sessionCalls()).toHaveLength(0);
    await h.service.getTile(3, 1, 1);
    await h.service.getTile(3, 1, 2);
    expect(h.sessionCalls()).toHaveLength(1);
    const row = getMapSession(h.db)!;
    expect(row.token).toBe(SESSION);
    expect(row.expiresAt).toBe(h.nowS + 14 * 86400);
    expect(row.createdAt).toBe(h.nowS);
  });

  test("a restart (new service, same database) reuses the persisted session", async () => {
    await h.service.getTile(3, 1, 1);
    const again = h.build();
    h.calls.length = 0;
    await again.getTile(3, 1, 2);
    expect(h.sessionCalls()).toHaveLength(0);
    expect(h.tileCalls()[0]!.url).toContain(`session=${SESSION}`);
  });

  test("createSession asks for business POIs to be on (the styles array is in the request body)", async () => {
    await h.service.getTile(3, 1, 1);
    const body = JSON.parse(h.sessionCalls()[0]!.body!);
    expect(body.styles).toEqual([{ featureType: "poi.business", stylers: [{ visibility: "on" }] }]);
    expect(body.mapType).toBe("roadmap");
    expect(body.language).toBe("th");
    expect(body.region).toBe("TH");
  });

  test("the created session stores the request it was made with, in params", async () => {
    await h.service.getTile(3, 1, 1);
    expect(getMapSession(h.db)!.params).toBe(PARAMS);
  });

  test("a stored session made with different params is NOT reused; a new one replaces the row", async () => {
    setMapSession(h.db, "old-token", h.nowS + 14 * 86400, h.nowS - 1000, JSON.stringify({ mapType: "roadmap", language: "th", region: "TH" }));
    h.validSessions.add("old-token");
    await h.service.getTile(3, 1, 1);
    expect(h.sessionCalls()).toHaveLength(1);
    expect(h.tileCalls()[0]!.url).toContain(`session=${SESSION}`);
    expect(h.tileCalls()[0]!.url).not.toContain("old-token");
    const row = getMapSession(h.db)!;
    expect(row.token).toBe(SESSION);
    expect(row.params).toBe(PARAMS);
  });

  test("a pre-migration session (params '') is NOT reused", async () => {
    setMapSession(h.db, "old-token", h.nowS + 14 * 86400, h.nowS - 1000, "");
    h.validSessions.add("old-token");
    await h.service.getTile(3, 1, 1);
    expect(h.sessionCalls()).toHaveLength(1);
    expect(h.tileCalls()[0]!.url).not.toContain("old-token");
  });

  test("a stored session with matching params IS reused", async () => {
    setMapSession(h.db, "old-token", h.nowS + 14 * 86400, h.nowS - 1000, PARAMS);
    h.validSessions.add("old-token");
    await h.service.getTile(3, 1, 1);
    expect(h.sessionCalls()).toHaveLength(0);
    expect(h.tileCalls()[0]!.url).toContain("session=old-token");
  });

  test("renewed when less than a day is left", async () => {
    setMapSession(h.db, "old-token", h.nowS + 86400 - 1, h.nowS - 1000, PARAMS);
    h.validSessions.add("old-token");
    await h.service.getTile(3, 1, 1);
    expect(h.sessionCalls()).toHaveLength(1);
    expect(h.tileCalls()[0]!.url).toContain(`session=${SESSION}`); // the freshly minted token
    expect(h.tileCalls()[0]!.url).not.toContain("old-token");
  });

  test("not renewed with exactly a day left", async () => {
    setMapSession(h.db, "old-token", h.nowS + 86400, h.nowS - 1000, PARAMS);
    h.validSessions.add("old-token");
    await h.service.getTile(3, 1, 1);
    expect(h.sessionCalls()).toHaveLength(0);
    expect(h.tileCalls()[0]!.url).toContain("session=old-token");
  });

  test("an expired-session answer renews the session and retries the tile ONCE", async () => {
    await h.service.getTile(3, 1, 1); // session A1 minted
    h.validSessions.delete(SESSION); // google forgets it
    h.calls.length = 0;
    const r = asOk(await h.service.getTile(3, 1, 2));
    expect(r.body.length).toBe(100);
    expect(h.sessionCalls()).toHaveLength(1);
    const tiles = h.tileCalls();
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.url).toContain(`session=${SESSION}`);
    expect(tiles[1]!.url).toContain("session=sess-token-A2");
    expect(getMapSession(h.db)!.token).toBe("sess-token-A2");
  });

  test("a second expired-session answer is an upstream-error: no loop", async () => {
    h.tileQueue.push(
      { status: 403, cacheControl: null, body: "Session token expired" },
      { status: 403, cacheControl: null, body: "Session token expired" },
      { status: 403, cacheControl: null, body: "Session token expired" },
    );
    const r = await h.service.getTile(3, 1, 1);
    expect(r).toEqual({ kind: "upstream-error", status: 403 });
    expect(h.tileCalls()).toHaveLength(2);
    expect(h.sessionCalls()).toHaveLength(2);
  });

  test("a 403 that is not about the session (a bad key) does not renew or retry", async () => {
    h.tileQueue.push({ status: 403, cacheControl: null, body: '{"error":{"message":"API key not valid."}}' });
    const r = await h.service.getTile(3, 1, 1);
    expect(r).toEqual({ kind: "upstream-error", status: 403 });
    expect(h.tileCalls()).toHaveLength(1);
    expect(h.sessionCalls()).toHaveLength(1);
  });

  test("createSession failing is an upstream-error and no tile is requested", async () => {
    h.createStatus = 403;
    const r = await h.service.getTile(3, 1, 1);
    expect(r).toEqual({ kind: "upstream-error", status: 403 });
    expect(h.tileCalls()).toHaveLength(0);
    expect(getMapSession(h.db)).toBeNull();
  });

  test("an expired-session retry that hits the cap stops with over-cap", async () => {
    const capped = new Harness({ TILE_DAILY_CAP: "1" });
    try {
      capped.tileQueue.push({ status: 401, cacheControl: null, body: "The session is invalid" });
      const r = await capped.service.getTile(3, 1, 1);
      expect(r).toEqual({ kind: "over-cap" });
      expect(capped.tileCalls()).toHaveLength(1);
    } finally {
      capped.cleanup();
    }
  });
});

// ── disk bound ──────────────────────────────────────────────────────────────

describe("the disk bound", () => {
  test("the default is 200 MiB", () => {
    expect(TILE_CACHE_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  test("over the byte cap the oldest tiles go first, until under 90%", async () => {
    const small = new Harness({}, { maxCacheBytes: 250 });
    try {
      for (let i = 1; i <= 3; i++) {
        small.defaultTile = { cacheControl: "max-age=99999", etag: null, body: PNG(i, 100) };
        asOk(await small.service.getTile(4, i, 0));
        small.advance(10);
      }
      // 300 bytes > 250: evict the oldest (100) -> 200 <= 225, stop.
      expect(getTileMeta(small.db, 4, 1, 0)).toBeNull();
      expect(existsSync(small.file(4, 1, 0))).toBe(false);
      expect(getTileMeta(small.db, 4, 2, 0)).not.toBeNull();
      expect(getTileMeta(small.db, 4, 3, 0)).not.toBeNull();
      expect(existsSync(small.file(4, 3, 0))).toBe(true);
    } finally {
      small.cleanup();
    }
  });

  test("eviction keeps going until the total is under 90% of the cap", async () => {
    const small = new Harness({}, { maxCacheBytes: 300 });
    try {
      for (let i = 1; i <= 3; i++) {
        small.defaultTile = { cacheControl: "max-age=99999", etag: null, body: PNG(i, 100) };
        asOk(await small.service.getTile(4, i, 0));
        small.advance(10);
      }
      small.defaultTile = { cacheControl: "max-age=99999", etag: null, body: PNG(4, 100) };
      asOk(await small.service.getTile(4, 4, 0)); // 400 > 300 -> evict to <= 270 -> two tiles left
      const left = [1, 2, 3, 4].filter((i) => getTileMeta(small.db, 4, i, 0) !== null);
      expect(left).toEqual([3, 4]);
    } finally {
      small.cleanup();
    }
  });
});

// ── attribution ─────────────────────────────────────────────────────────────

describe("attribution", () => {
  const q = { zoom: 13, north: 9.15432, south: 9.10111, east: 99.36999, west: 99.31001 };

  test("asks the /tile/v1/viewport endpoint with the session and key, returns the copyright", async () => {
    const r = await h.service.attribution(q);
    expect(r).toEqual({ kind: "ok", copyright: "Map data ©2026 Google" });
    const call = h.viewportCalls()[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("https://tile.googleapis.com/tile/v1/viewport");
    expect(url.searchParams.get("session")).toBe(SESSION);
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(url.searchParams.get("zoom")).toBe("13");
    expect(url.searchParams.get("north")).toBe("9.15432");
    expect(url.searchParams.get("south")).toBe("9.10111");
    expect(url.searchParams.get("east")).toBe("99.36999");
    expect(url.searchParams.get("west")).toBe("99.31001");
  });

  test("cached per zoom and the bbox rounded to 2 dp, for 10 minutes", async () => {
    await h.service.attribution(q);
    // Same rounded box (9.15/9.10/99.37/99.31): a cache hit.
    await h.service.attribution({ ...q, north: 9.15499, west: 99.30999 });
    expect(h.viewportCalls()).toHaveLength(1);
    // A different zoom is a different key.
    await h.service.attribution({ ...q, zoom: 14 });
    expect(h.viewportCalls()).toHaveLength(2);
    // Still cached at 9 min 59 s, refetched after 10 min.
    h.advance(599);
    await h.service.attribution(q);
    expect(h.viewportCalls()).toHaveLength(2);
    h.advance(2);
    await h.service.attribution(q);
    expect(h.viewportCalls()).toHaveLength(3);
  });

  test("an upstream error is reported and not cached", async () => {
    h.viewport = { status: 403, body: { error: "x" } };
    expect(await h.service.attribution(q)).toEqual({ kind: "upstream-error", status: 403 });
    h.viewport = { status: 200, body: { copyright: "ok" } };
    expect(await h.service.attribution(q)).toEqual({ kind: "ok", copyright: "ok" });
  });

  test("a body without a copyright string is an upstream-error, never an empty attribution", async () => {
    h.viewport = { status: 200, body: { maxZoomRects: [] } };
    expect((await h.service.attribution(q)).kind).toBe("upstream-error");
  });

  test("an expired session renews and retries once", async () => {
    h.viewportQueue.push({ status: 400, body: '{"error":{"message":"session token expired"}}' });
    const r = await h.service.attribution(q);
    expect(r.kind).toBe("ok");
    expect(h.viewportCalls()).toHaveLength(2);
    expect(h.sessionCalls()).toHaveLength(2);
    expect(h.viewportCalls()[1]!.url).toContain("session=sess-token-A2");
  });

  test("a second expired answer is an upstream-error", async () => {
    h.viewportQueue.push(
      { status: 400, body: "session expired" },
      { status: 400, body: "session expired" },
    );
    expect(await h.service.attribution(q)).toEqual({ kind: "upstream-error", status: 400 });
    expect(h.viewportCalls()).toHaveLength(2);
  });
});

// ── status ──────────────────────────────────────────────────────────────────

describe("status()", () => {
  test("before any call", () => {
    expect(h.service.status()).toEqual({
      enabled: true,
      cap: 2500,
      today: { ymd: h.ymd(), upstream: 0, hits: 0 },
      session: null,
      lastUpstream: null,
    });
  });

  test("after traffic: counts, session expiry and Google's real headers", async () => {
    h.defaultTile = { cacheControl: "public, max-age=3600", etag: '"abc"', contentType: "image/jpeg", body: PNG(1) };
    await h.service.getTile(3, 1, 1);
    await h.service.getTile(3, 1, 1);
    const s = h.service.status();
    expect(s.today).toEqual({ ymd: h.ymd(), upstream: 1, hits: 1 });
    expect(s.session).toEqual({ expiresAt: h.nowS + 14 * 86400 });
    expect(s.lastUpstream).toEqual({
      at: h.nowS,
      status: 200,
      cacheControl: "public, max-age=3600",
      contentType: "image/jpeg",
      etag: true,
    });
  });

  test("lastUpstream records failures too", async () => {
    h.tileQueue.push({ status: 500, cacheControl: null, body: "x", contentType: null });
    await h.service.getTile(3, 1, 1);
    expect(h.service.status().lastUpstream).toEqual({
      at: h.nowS,
      status: 500,
      cacheControl: null,
      contentType: null,
      etag: false,
    });
  });
});

// ── bad tile coordinates never reach the disk or the upstream ───────────────

describe("defensive input checks", () => {
  test("non-integer or out-of-range coordinates are refused without an upstream call", async () => {
    for (const [z, x, y] of [
      [-1, 0, 0],
      [23, 0, 0],
      [3, 8, 0],
      [3, 0, 8],
      [3, 1.5, 0],
      [Number.NaN, 0, 0],
    ] as [number, number, number][]) {
      const r = await h.service.getTile(z, x, y);
      expect(r.kind).toBe("upstream-error");
    }
    expect(h.calls).toHaveLength(0);
  });
});

// ── the key never leaks ─────────────────────────────────────────────────────

describe("SECRET HYGIENE", () => {
  test("the key and the session token appear in no result, no status and no log line", async () => {
    const seen: unknown[] = [];
    seen.push(await h.service.getTile(12, 1, 1)); // ok, stored
    seen.push(await h.service.getTile(12, 1, 1)); // hit
    h.tileQueue.push({ status: 500, cacheControl: null, body: `boom ${KEY}` });
    seen.push(await h.service.getTile(12, 1, 2)); // upstream 500 (the body echoes the key)
    h.tileQueue.push({ status: 403, cacheControl: null, body: `API key ${KEY} not valid` });
    seen.push(await h.service.getTile(12, 1, 3));
    seen.push(await h.service.attribution({ zoom: 12, north: 9.2, south: 9.1, east: 99.4, west: 99.3 }));
    h.viewport = { status: 403, body: { error: KEY } };
    seen.push(await h.service.attribution({ zoom: 13, north: 9.2, south: 9.1, east: 99.4, west: 99.3 }));
    seen.push(h.service.status());

    const everything = JSON.stringify(seen, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v)) + h.logs.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(SESSION);
    expect(everything).not.toContain("googleapis");
    expect(everything).not.toContain("http");
    // The log lines are the documented shapes.
    expect(h.logs).toContain("tiles: session created");
    expect(h.logs.some((l) => /^tiles: upstream 500 12\/1\/2$/.test(l))).toBe(true);
    expect(h.logs.some((l) => /^tiles: upstream 403 12\/1\/3$/.test(l))).toBe(true);
  });

  test("a network failure whose message carries the URL (and key) is neither logged nor returned", async () => {
    h.throwOnFetch = new Error(`Unable to connect https://tile.googleapis.com/v1/2dtiles/1/0/0?session=s&key=${KEY}`);
    const results = [await h.service.getTile(1, 0, 0), await h.service.attribution({ zoom: 1, north: 1, south: 0, east: 1, west: 0 })];
    expect(results[0]!.kind).toBe("upstream-error");
    expect(results[1]!.kind).toBe("upstream-error");
    const everything = JSON.stringify(results) + h.logs.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("googleapis");
  });

  test("a timeout is an upstream-error too", async () => {
    const t = new Error("The operation timed out");
    t.name = "TimeoutError";
    h.throwOnFetch = t;
    expect((await h.service.getTile(1, 0, 0)).kind).toBe("upstream-error");
  });
});

// ── the style version ───────────────────────────────────────────────────────

describe("SESSION_STYLE_VERSION", () => {
  test("is the first 8 hex chars of the SHA-256 of the session request JSON", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    expect(SESSION_STYLE_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(SESSION_STYLE_VERSION).toBe(createHash("sha256").update(JSON.stringify(SESSION_REQUEST)).digest("hex").slice(0, 8));
  });

  test("is pinned: changing the session request must change it (and this test, deliberately)", () => {
    expect(SESSION_STYLE_VERSION).toBe("c3d38d26");
  });
});
