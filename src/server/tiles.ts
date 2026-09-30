// linen-truck — the Google Map Tiles proxy (docs/CONTRACTS.md §5, §7, §8; ADR 0002).
//
// The browser never talks to Google. It asks OUR `/tiles/{z}/{x}/{y}` route, and
// this service fetches from the Map Tiles API with a server-held key and a session
// token. That gives three things a direct browser layer cannot:
//
//   * THE KEY STAYS ON THE SERVER. It appears in exactly one place — the upstream
//     request URL — and nowhere a browser, a response, a log line or an error can
//     carry it. See "SECRET HYGIENE" below.
//   * A HARD DAILY STOP. Every upstream tile request is counted per Bangkok day
//     BEFORE it is made; at TILE_DAILY_CAP the service answers `over-cap` and the
//     page keeps the route and stops on a blank basemap. The free tier is 100 000
//     billable tile requests a month, and this is the in-app half of the guard (the
//     owner-side Google quota override is the outer half, ADR 0002).
//   * A CACHE — ONLY AS GOOGLE ALLOWS. The Terms forbid caching Maps content
//     except as the response's Cache-Control permits, so a 200 is stored on disk
//     iff it is not `no-store`, not `private`, has `max-age > 0` (and, stricter than
//     the Terms need, is not `no-cache`), and it is served again only while
//     `now < expires_at`. A STALE TILE IS NEVER SERVED: the client "must respect the
//     max-age value", so a stale entry is revalidated (If-None-Match, when Google
//     sent an ETag) or refetched, or, over the cap, refused.
//
// SECRET HYGIENE (public repo, world-readable Actions logs): the key only ever
// sits inside an upstream URL. Nothing here logs a URL, a request, a response body
// or an exception's message (Bun's fetch errors can quote the URL). Log lines are
// `tiles: upstream 403 12/3200/1900` and `tiles: session created` and nothing else;
// what leaves this module is a `TileResult`, which carries no URL either.
//
// Everything outside the module arrives through `opts`: the clock, `fetch`, the
// data directory, the config and the log sink, so a test drives a whole day with a
// fake fetch and no network.

import type { Database } from "bun:sqlite";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bangkokDay } from "../shared/time.ts";
import { googleTilesEnabled, type Config } from "./config.ts";
import {
  bumpTileUsage,
  clearMapSession,
  deleteTileMeta,
  getMapSession,
  getTileMeta,
  getTileUsage,
  oldestTileMeta,
  setMapSession,
  tileCacheBytes,
  upsertTileMeta,
  type TileMeta,
} from "./db.ts";

// ── constants ───────────────────────────────────────────────────────────────

const GOOGLE_ORIGIN = "https://tile.googleapis.com";

/** createSession body (§7). Thai labels, Thai region: the audience is a Surat Thani hotel. */
export const SESSION_REQUEST = { mapType: "roadmap", language: "th", region: "TH" } as const;

/** A session is renewed when less than this is left (Google's own lifetime is two weeks). */
export const SESSION_RENEW_MARGIN_S = 86_400;
/** Used only when Google's `expiry` is missing or unreadable: well under the documented two weeks. */
const SESSION_FALLBACK_LIFETIME_S = 7 * 86_400;

/** 20 s on every upstream call, like sinotrack.ts. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/** The disk bound: past it the oldest tiles (by `fetched_at`) go until under 90 % of it. */
export const TILE_CACHE_MAX_BYTES = 200 * 1024 * 1024;
const EVICT_TO_FRACTION = 0.9;

export const ATTRIBUTION_TTL_MS = 10 * 60 * 1000;
const ATTRIBUTION_CACHE_MAX_ENTRIES = 256;

/** Zoom limit of the Map Tiles API. */
const MAX_Z = 22;

// ── Cache-Control ───────────────────────────────────────────────────────────

export interface CacheControl {
  maxAge: number | null;
  staleWhileRevalidate: number | null;
  noStore: boolean;
  noCache: boolean;
  mustRevalidate: boolean;
  private: boolean;
}

/** Splits on commas that are not inside a quoted string (`private="a, b"`). */
function splitDirectives(header: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A delta-seconds value: digits only, optionally quoted. Anything else is "not there". */
function deltaSeconds(raw: string): number | null {
  const v = raw.trim().replace(/^"(.*)"$/, "$1");
  return /^[0-9]{1,12}$/.test(v) ? Number(v) : null;
}

/**
 * Pure. Names are case-insensitive; an unreadable `max-age` is ignored (so the
 * response is not storable, the safe direction); when a directive repeats, the
 * SMALLER delta wins; `private="field"` still counts as `private`.
 */
export function parseCacheControl(header: string | null): CacheControl {
  const cc: CacheControl = {
    maxAge: null,
    staleWhileRevalidate: null,
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    private: false,
  };
  if (header === null) return cc;
  const smaller = (cur: number | null, next: number | null): number | null =>
    next === null ? cur : cur === null ? next : Math.min(cur, next);
  for (const part of splitDirectives(header)) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? "" : part.slice(eq + 1);
    switch (name) {
      case "max-age":
        cc.maxAge = smaller(cc.maxAge, deltaSeconds(value));
        break;
      case "stale-while-revalidate":
        cc.staleWhileRevalidate = smaller(cc.staleWhileRevalidate, deltaSeconds(value));
        break;
      case "no-store":
        cc.noStore = true;
        break;
      case "no-cache":
        cc.noCache = true;
        break;
      case "must-revalidate":
        cc.mustRevalidate = true;
        break;
      case "private":
        cc.private = true;
        break;
      default:
        break;
    }
  }
  return cc;
}

/**
 * Storable iff `!noStore && !private && maxAge > 0` (§3 of the design), plus
 * `!noCache`: `no-cache` means "revalidate before EVERY use", which a tile that is
 * served straight from disk inside its max-age cannot honour, and a cache that
 * revalidates every time saves nothing over not storing.
 */
const storable = (cc: CacheControl): boolean =>
  !cc.noStore && !cc.private && !cc.noCache && cc.maxAge !== null && cc.maxAge > 0;

/** What the BROWSER is told for a tile that was not stored: Google's own max-age, else nothing. */
const passThroughHeader = (cc: CacheControl): string =>
  cc.noStore || cc.noCache || cc.maxAge === null ? "private, no-store" : `private, max-age=${cc.maxAge}`;

// ── the public shapes ───────────────────────────────────────────────────────

export type TileResult =
  | { kind: "ok"; body: Uint8Array; contentType: string; cacheControl: string }
  | { kind: "over-cap" }
  | { kind: "upstream-error"; status: number }
  | { kind: "disabled" };

export type AttributionResult =
  | { kind: "ok"; copyright: string }
  | { kind: "upstream-error"; status: number }
  | { kind: "disabled" };

export interface MapStatus {
  enabled: boolean;
  cap: number;
  today: { ymd: string; upstream: number; hits: number };
  session: { expiresAt: number } | null;
  /**
   * The last upstream TILE response, in memory: how the owner reads Google's real
   * Cache-Control / Content-Type / ETag presence once a key exists (research note,
   * "open items"). `status` is 0 for a network failure or timeout.
   */
  lastUpstream: {
    at: number;
    status: number;
    cacheControl: string | null;
    contentType: string | null;
    etag: boolean;
  } | null;
}

export interface TileService {
  getTile(z: number, x: number, y: number): Promise<TileResult>;
  attribution(q: { zoom: number; north: number; south: number; east: number; west: number }): Promise<AttributionResult>;
  status(): MapStatus;
}

export interface TileServiceOptions {
  db: Database;
  config: Config;
  dataDir: string;
  fetch?: typeof fetch;
  now: () => Date;
  log?: (line: string) => void;
  /** Override of `TILE_CACHE_MAX_BYTES`; only tests pass it. */
  maxCacheBytes?: number;
}

/** Carries a status and nothing else: no URL, no body, no key. */
class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`upstream ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }
}

const validTile = (z: number, x: number, y: number): boolean => {
  if (![z, x, y].every(Number.isInteger)) return false;
  if (z < 0 || z > MAX_Z) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
};

/**
 * Does a 400/401/403 body say the SESSION is the problem (expired or invalid)?
 * Only then is a renewal worth a retry; a bad key or a quota answer is not
 * fixed by a new session. The body is read here and never stored or logged.
 */
const sessionProblem = (body: string): boolean => /session/i.test(body) && /expire|invalid/i.test(body);

// ── the service ─────────────────────────────────────────────────────────────

export function createTileService(opts: TileServiceOptions): TileService {
  const { db, config, dataDir } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? (() => {});
  const maxBytes = opts.maxCacheBytes ?? TILE_CACHE_MAX_BYTES;
  const enabled = googleTilesEnabled(config);
  const key = encodeURIComponent(config.googleMapsKey);

  const nowS = (): number => Math.floor(opts.now().getTime() / 1000);
  const today = (): string => bangkokDay(opts.now().toISOString());
  const tilePath = (z: number, x: number, y: number): string => join(dataDir, "tiles", String(z), String(x), String(y));

  let lastUpstream: MapStatus["lastUpstream"] = null;
  const inflight = new Map<string, Promise<TileResult>>();
  let sessionInflight: Promise<string> | null = null;
  let tmpCounter = 0;

  // ── the session ───────────────────────────────────────────────────────────

  async function createSession(): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(`${GOOGLE_ORIGIN}/v1/createSession?key=${key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(SESSION_REQUEST),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      log(`tiles: session failed ${err instanceof Error ? err.name : "error"}`);
      throw new UpstreamError(0);
    }
    if (!res.ok) {
      log(`tiles: session failed ${res.status}`);
      throw new UpstreamError(res.status);
    }
    let parsed: { session?: unknown; expiry?: unknown };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      log("tiles: session failed bad-body");
      throw new UpstreamError(502);
    }
    if (typeof parsed.session !== "string" || parsed.session === "") {
      log("tiles: session failed bad-body");
      throw new UpstreamError(502);
    }
    const now = nowS();
    // `expiry` is epoch seconds in a STRING.
    const expiry = Number(parsed.expiry);
    const expiresAt = Number.isFinite(expiry) && expiry > now ? Math.floor(expiry) : now + SESSION_FALLBACK_LIFETIME_S;
    setMapSession(db, parsed.session, expiresAt, now);
    log("tiles: session created");
    return parsed.session;
  }

  /** The current token, created lazily and renewed inside the last day of its life. */
  async function currentSession(): Promise<string> {
    const row = getMapSession(db);
    if (row && row.expiresAt - nowS() >= SESSION_RENEW_MARGIN_S) return row.token;
    sessionInflight ??= createSession().finally(() => {
      sessionInflight = null;
    });
    return sessionInflight;
  }

  /** Forgets `token` — only if it is still THE token, so a peer's fresh renewal survives. */
  function dropSession(token: string): void {
    if (getMapSession(db)?.token === token) clearMapSession(db);
  }

  // ── the disk ──────────────────────────────────────────────────────────────

  async function readTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(tilePath(z, x, y)));
    } catch {
      return null;
    }
  }

  async function removeTile(z: number, x: number, y: number): Promise<void> {
    deleteTileMeta(db, z, x, y);
    try {
      await unlink(tilePath(z, x, y));
    } catch {
      /* already gone */
    }
  }

  /** tmp + rename, so a reader never sees half a tile. */
  async function writeTile(z: number, x: number, y: number, body: Uint8Array): Promise<void> {
    const path = tilePath(z, x, y);
    await mkdir(join(dataDir, "tiles", String(z), String(x)), { recursive: true });
    tmpCounter += 1;
    const tmp = `${path}.${process.pid}.${tmpCounter}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async function evictIfNeeded(): Promise<void> {
    if (tileCacheBytes(db) <= maxBytes) return;
    const target = maxBytes * EVICT_TO_FRACTION;
    let total = tileCacheBytes(db);
    while (total > target) {
      const batch = oldestTileMeta(db, 50);
      if (batch.length === 0) break;
      for (const m of batch) {
        await removeTile(m.z, m.x, m.y);
        total -= m.bytes;
        if (total <= target) break;
      }
    }
  }

  // ── one tile ──────────────────────────────────────────────────────────────

  const overCap = (): boolean => getTileUsage(db, today()).upstream >= config.tileDailyCap;

  /**
   * ONE upstream tile request, counted before it is made. Returns the response, or
   * a terminal result. A session-expired answer renews the session and retries
   * ONCE; the retry is itself an upstream tile request, so it is capped and counted.
   */
  async function upstreamTile(
    z: number,
    x: number,
    y: number,
    etag: string | null,
  ): Promise<{ res: Response } | { done: TileResult }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (overCap()) return { done: { kind: "over-cap" } };
      let session: string;
      try {
        session = await currentSession();
      } catch (err) {
        return { done: { kind: "upstream-error", status: err instanceof UpstreamError ? err.status : 0 } };
      }
      bumpTileUsage(db, today(), { upstream: 1 });

      const headers: Record<string, string> = {};
      if (etag !== null) headers["if-none-match"] = etag;
      let res: Response;
      try {
        res = await doFetch(`${GOOGLE_ORIGIN}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session)}&key=${key}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } catch (err) {
        lastUpstream = { at: nowS(), status: 0, cacheControl: null, contentType: null, etag: false };
        log(`tiles: upstream ${err instanceof Error ? err.name : "error"} ${z}/${x}/${y}`);
        return { done: { kind: "upstream-error", status: 0 } };
      }
      lastUpstream = {
        at: nowS(),
        status: res.status,
        cacheControl: res.headers.get("cache-control"),
        contentType: res.headers.get("content-type"),
        etag: res.headers.has("etag"),
      };

      if (res.status === 200 || res.status === 304) return { res };

      if (attempt === 0 && (res.status === 400 || res.status === 401 || res.status === 403)) {
        let body = "";
        try {
          body = await res.text();
        } catch {
          /* unreadable body: not a session problem we can prove */
        }
        if (sessionProblem(body)) {
          dropSession(session);
          continue;
        }
      }
      log(`tiles: upstream ${res.status} ${z}/${x}/${y}`);
      return { done: { kind: "upstream-error", status: res.status } };
    }
    log(`tiles: upstream session ${z}/${x}/${y}`);
    return { done: { kind: "upstream-error", status: lastUpstream?.status ?? 0 } };
  }

  async function fetchTile(z: number, x: number, y: number): Promise<TileResult> {
    const meta = getTileMeta(db, z, x, y);
    // A stale tile with an ETag AND its file can be revalidated; anything else is a plain refetch.
    let stale: { meta: TileMeta; body: Uint8Array } | null = null;
    if (meta && meta.etag !== null) {
      const body = await readTile(z, x, y);
      if (body) stale = { meta, body };
    }

    const up = await upstreamTile(z, x, y, stale ? stale.meta.etag : null);
    if ("done" in up) return up.done;
    const { res } = up;
    const now = nowS();

    if (res.status === 304) {
      if (!stale) return { kind: "upstream-error", status: 304 };
      const raw = res.headers.get("cache-control");
      const cc = parseCacheControl(raw);
      const previousMaxAge = Math.max(0, stale.meta.expiresAt - stale.meta.fetchedAt);
      // The 304's own Cache-Control wins; without one, the previous max-age carries over.
      const keep = raw === null ? previousMaxAge > 0 : storable(cc);
      if (!keep) {
        await removeTile(z, x, y);
        return { kind: "ok", body: stale.body, contentType: stale.meta.contentType, cacheControl: passThroughHeader(cc) };
      }
      const maxAge = raw !== null && cc.maxAge !== null ? cc.maxAge : previousMaxAge;
      upsertTileMeta(db, { ...stale.meta, fetchedAt: now, expiresAt: now + maxAge });
      return { kind: "ok", body: stale.body, contentType: stale.meta.contentType, cacheControl: `private, max-age=${maxAge}` };
    }

    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // The connection dropped mid-body; the message could quote the URL, so only the name is logged.
      log(`tiles: upstream ${err instanceof Error ? err.name : "error"} ${z}/${x}/${y}`);
      return { kind: "upstream-error", status: 0 };
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    const cc = parseCacheControl(res.headers.get("cache-control"));

    if (!storable(cc)) {
      if (meta) await removeTile(z, x, y);
      return { kind: "ok", body, contentType, cacheControl: passThroughHeader(cc) };
    }

    const maxAge = cc.maxAge as number;
    try {
      await writeTile(z, x, y, body);
      upsertTileMeta(db, {
        z,
        x,
        y,
        fetchedAt: now,
        expiresAt: now + maxAge,
        etag: res.headers.get("etag"),
        contentType,
        bytes: body.byteLength,
      });
      await evictIfNeeded();
    } catch {
      // A full disk must not blank the map: serve the tile, skip the store.
      log(`tiles: store failed ${z}/${x}/${y}`);
    }
    return { kind: "ok", body, contentType, cacheControl: `private, max-age=${maxAge}` };
  }

  async function getTile(z: number, x: number, y: number): Promise<TileResult> {
    if (!enabled) return { kind: "disabled" };
    // The route validates first; this keeps a bad coordinate off the disk and the wire regardless.
    if (!validTile(z, x, y)) return { kind: "upstream-error", status: 400 };

    // A fresh HIT is served even over the cap, and never touches the upstream.
    const meta = getTileMeta(db, z, x, y);
    if (meta && nowS() < meta.expiresAt) {
      const body = await readTile(z, x, y);
      if (body) {
        bumpTileUsage(db, today(), { hits: 1 });
        return {
          kind: "ok",
          body,
          contentType: meta.contentType,
          cacheControl: `private, max-age=${meta.expiresAt - nowS()}`,
        };
      }
      deleteTileMeta(db, z, x, y); // the file vanished: a miss, not an empty tile
    }

    const id = `${z}/${x}/${y}`;
    const running = inflight.get(id);
    if (running) return running;
    const started = fetchTile(z, x, y).finally(() => inflight.delete(id));
    inflight.set(id, started);
    return started;
  }

  // ── attribution ───────────────────────────────────────────────────────────

  const attributionCache = new Map<string, { at: number; copyright: string }>();
  const round2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

  async function attribution(q: {
    zoom: number;
    north: number;
    south: number;
    east: number;
    west: number;
  }): Promise<AttributionResult> {
    if (!enabled) return { kind: "disabled" };
    const cacheKey = [q.zoom, round2(q.north), round2(q.south), round2(q.east), round2(q.west)].join("|");
    const cached = attributionCache.get(cacheKey);
    const nowMs = opts.now().getTime();
    if (cached && nowMs - cached.at < ATTRIBUTION_TTL_MS) return { kind: "ok", copyright: cached.copyright };

    for (let attempt = 0; attempt < 2; attempt++) {
      let session: string;
      try {
        session = await currentSession();
      } catch (err) {
        return { kind: "upstream-error", status: err instanceof UpstreamError ? err.status : 0 };
      }
      const params = new URLSearchParams({
        session,
        key: config.googleMapsKey,
        zoom: String(q.zoom),
        north: String(q.north),
        south: String(q.south),
        east: String(q.east),
        west: String(q.west),
      });
      let res: Response;
      try {
        res = await doFetch(`${GOOGLE_ORIGIN}/tile/v1/viewport?${params.toString()}`, {
          method: "GET",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } catch (err) {
        log(`tiles: viewport ${err instanceof Error ? err.name : "error"}`);
        return { kind: "upstream-error", status: 0 };
      }
      if (res.ok) {
        let copyright: unknown;
        try {
          copyright = ((await res.json()) as { copyright?: unknown }).copyright;
        } catch {
          copyright = undefined;
        }
        if (typeof copyright !== "string" || copyright === "") {
          log("tiles: viewport bad-body");
          return { kind: "upstream-error", status: 502 };
        }
        if (attributionCache.size >= ATTRIBUTION_CACHE_MAX_ENTRIES) attributionCache.clear();
        attributionCache.set(cacheKey, { at: nowMs, copyright });
        return { kind: "ok", copyright };
      }
      if (attempt === 0 && (res.status === 400 || res.status === 401 || res.status === 403)) {
        let body = "";
        try {
          body = await res.text();
        } catch {
          /* ignore */
        }
        if (sessionProblem(body)) {
          dropSession(session);
          continue;
        }
      }
      log(`tiles: viewport ${res.status}`);
      return { kind: "upstream-error", status: res.status };
    }
    log("tiles: viewport session");
    return { kind: "upstream-error", status: 400 };
  }

  // ── status ────────────────────────────────────────────────────────────────

  function status(): MapStatus {
    const ymd = today();
    const usage = getTileUsage(db, ymd);
    const session = getMapSession(db);
    return {
      enabled,
      cap: config.tileDailyCap,
      today: { ymd, upstream: usage.upstream, hits: usage.hits },
      session: session ? { expiresAt: session.expiresAt } : null,
      lastUpstream,
    };
  }

  return { getTile, attribution, status };
}
