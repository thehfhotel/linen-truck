// The tile and map routes (docs/CONTRACTS.md §7): /tiles/:z/:x/:y,
// /api/map/attribution and /api/map/status.
//
// Two layers. The route mapping (status codes, headers, validation, gating) is
// driven with a stub TileService so each TileResult kind is one line. A second
// block wires the REAL service to a fake fetch and asserts the key reaches no
// response body or header. No network, no disk beyond a temp dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { _internal as authInternal } from "../../src/server/auth.ts";
import { loadConfig, type Env } from "../../src/server/config.ts";
import { openDatabase } from "../../src/server/db.ts";
import { loadRules, loadSites } from "../../src/server/siteConfig.ts";
import { createTileService, type MapStatus, type TileResult, type TileService } from "../../src/server/tiles.ts";

const NOW = new Date(1788595367 * 1000);
const KEY = "route-test-key-Pq7";

const STATUS: MapStatus = {
  enabled: true,
  cap: 2500,
  today: { ymd: "2026-09-05", upstream: 3, hits: 9 },
  session: { expiresAt: 1789800000 },
  lastUpstream: { at: 1788595000, status: 200, cacheControl: "public, max-age=3600", contentType: "image/png", etag: true },
};

interface Stub extends TileService {
  tileCalls: [number, number, number][];
  attrCalls: unknown[];
  nextTile: TileResult | Error;
  nextAttr: Awaited<ReturnType<TileService["attribution"]>> | Error;
  statusValue: MapStatus;
}

function stub(): Stub {
  const s: Stub = {
    tileCalls: [],
    attrCalls: [],
    nextTile: {
      kind: "ok",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      cacheControl: "private, max-age=600",
    },
    nextAttr: { kind: "ok", copyright: "Map data ©2026 Google" },
    statusValue: STATUS,
    async getTile(z, x, y) {
      s.tileCalls.push([z, x, y]);
      if (s.nextTile instanceof Error) throw s.nextTile;
      return s.nextTile;
    },
    async attribution(q) {
      s.attrCalls.push(q);
      if (s.nextAttr instanceof Error) throw s.nextAttr;
      return s.nextAttr;
    },
    status: () => s.statusValue,
  };
  return s;
}

const cfg = (extra: Env = {}) =>
  loadConfig({ DATA_DIR: "./data", ALLOW_DEV_AUTH: "1", FEED_TOKEN: "feed-secret", ...extra });

const appWith = (tiles: TileService | undefined, extra: Env = {}) =>
  createApp(openDatabase(":memory:"), {
    config: cfg(extra),
    now: () => NOW,
    sites: loadSites(),
    rules: loadRules(),
    ...(tiles ? { tiles } : {}),
  });

const staffReq = (path: string): Request =>
  new Request(`http://truck.local${path}`, { headers: { "x-dev-email": "owner@example.com" } });

beforeEach(() => {
  authInternal.resetJwksCacheForTests();
  authInternal.resetWarningsForTests();
});

const ATTR = "/api/map/attribution?zoom=13&north=9.16&south=9.10&east=99.37&west=99.31";

describe("Access gating — the same refusals as /api/day", () => {
  const paths = ["/tiles/12/3200/1900", ATTR, "/api/map/status"];

  test("503 while CF_ACCESS_AUD is empty", async () => {
    for (const path of paths) {
      const s = stub();
      const res = await appWith(s, { ALLOW_DEV_AUTH: "" }).handle(new Request(`http://truck.local${path}`));
      expect(`${path} ${res.status}`).toBe(`${path} 503`);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(s.tileCalls).toHaveLength(0);
      expect(s.attrCalls).toHaveLength(0);
    }
  });

  test("401 when an audience is configured and no JWT is presented", async () => {
    for (const path of paths) {
      const s = stub();
      const res = await appWith(s, { CF_ACCESS_AUD: "aud-1", ALLOW_DEV_AUTH: "" }).handle(
        new Request(`http://truck.local${path}`),
      );
      expect(`${path} ${res.status}`).toBe(`${path} 401`);
      expect(s.tileCalls).toHaveLength(0);
    }
  });
});

describe("GET /tiles/:z/:x/:y", () => {
  test("ok: the bytes, content-type, our cache-control and nosniff", async () => {
    const s = stub();
    const res = await appWith(s).handle(staffReq("/tiles/12/3200/1900"));
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(s.tileCalls).toEqual([[12, 3200, 1900]]);
  });

  test("the corners of the valid range are accepted", async () => {
    const s = stub();
    const a = appWith(s);
    expect((await a.handle(staffReq("/tiles/0/0/0"))).status).toBe(200);
    expect((await a.handle(staffReq("/tiles/22/4194303/4194303"))).status).toBe(200);
    expect((await a.handle(staffReq("/tiles/3/7/7"))).status).toBe(200);
  });

  test("bad coordinates are a 400 bad-tile and never reach the service", async () => {
    const s = stub();
    const a = appWith(s);
    for (const path of [
      "/tiles/23/0/0",
      "/tiles/3/8/0",
      "/tiles/3/0/8",
      "/tiles/0/1/0",
      "/tiles/-1/0/0",
      "/tiles/a/0/0",
      "/tiles/3/1.5/0",
      "/tiles/3/1e1/0",
      "/tiles/3/%2B1/0",
      "/tiles/3/0/0x1",
      "/tiles/999999999999/0/0",
    ]) {
      const res = await a.handle(staffReq(path));
      expect(`${path} ${res.status}`).toBe(`${path} 400`);
      expect(await res.json()).toEqual({ error: "bad-tile" });
    }
    expect(s.tileCalls).toHaveLength(0);
  });

  test("disabled is 404", async () => {
    const s = stub();
    s.nextTile = { kind: "disabled" };
    expect((await appWith(s).handle(staffReq("/tiles/3/1/1"))).status).toBe(404);
  });

  test("over-cap is 503 tile-budget", async () => {
    const s = stub();
    s.nextTile = { kind: "over-cap" };
    const res = await appWith(s).handle(staffReq("/tiles/3/1/1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "tile-budget" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("upstream-error is 502 tile-upstream, whatever the upstream status was", async () => {
    const s = stub();
    s.nextTile = { kind: "upstream-error", status: 403 };
    const res = await appWith(s).handle(staffReq("/tiles/3/1/1"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "tile-upstream" });
  });

  test("a service that throws is a 502 with no exception text", async () => {
    const s = stub();
    s.nextTile = new Error(`boom https://x.example/?key=${KEY}`);
    const res = await appWith(s).handle(staffReq("/tiles/3/1/1"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({ error: "tile-upstream" });
  });

  test("without an injected service and without a key the route is simply 404", async () => {
    const res = await appWith(undefined).handle(staffReq("/tiles/3/1/1"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/map/attribution", () => {
  test("ok: {copyright}, params passed as numbers", async () => {
    const s = stub();
    const res = await appWith(s).handle(staffReq(ATTR));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ copyright: "Map data ©2026 Google" });
    expect(s.attrCalls).toEqual([{ zoom: 13, north: 9.16, south: 9.1, east: 99.37, west: 99.31 }]);
  });

  test("bad params are 400", async () => {
    const s = stub();
    const a = appWith(s);
    for (const qs of [
      "",
      "zoom=13&north=9.16&south=9.10&east=99.37",
      "zoom=abc&north=9.16&south=9.10&east=99.37&west=99.31",
      "zoom=23&north=9.16&south=9.10&east=99.37&west=99.31",
      "zoom=-1&north=9.16&south=9.10&east=99.37&west=99.31",
      "zoom=1.5&north=9.16&south=9.10&east=99.37&west=99.31",
      "zoom=13&north=91&south=9.10&east=99.37&west=99.31",
      "zoom=13&north=9.16&south=-91&east=99.37&west=99.31",
      "zoom=13&north=9.16&south=9.10&east=181&west=99.31",
      "zoom=13&north=9.16&south=9.10&east=99.37&west=-181",
      "zoom=13&north=9.00&south=9.10&east=99.37&west=99.31",
      "zoom=13&north=&south=9.10&east=99.37&west=99.31",
      "zoom=13&north=NaN&south=9.10&east=99.37&west=99.31",
      "zoom=13&north=Infinity&south=9.10&east=99.37&west=99.31",
    ]) {
      const res = await a.handle(staffReq(`/api/map/attribution?${qs}`));
      expect(`${qs} ${res.status}`).toBe(`${qs} 400`);
      expect(await res.json()).toEqual({ error: "bad-params" });
    }
    expect(s.attrCalls).toHaveLength(0);
  });

  test("disabled is 404, upstream-error is 502", async () => {
    const s = stub();
    s.nextAttr = { kind: "disabled" };
    expect((await appWith(s).handle(staffReq(ATTR))).status).toBe(404);
    s.nextAttr = { kind: "upstream-error", status: 500 };
    const res = await appWith(s).handle(staffReq(ATTR));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "tile-upstream" });
  });
});

describe("GET /api/map/status", () => {
  test("enabled: the service's status, verbatim", async () => {
    const res = await appWith(stub()).handle(staffReq("/api/map/status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(STATUS);
  });

  test("disabled: just {enabled:false}", async () => {
    const s = stub();
    s.statusValue = { ...STATUS, enabled: false };
    const res = await appWith(s).handle(staffReq("/api/map/status"));
    expect(await res.json()).toEqual({ enabled: false });
  });

  test("with no key configured and no injected service", async () => {
    const res = await appWith(undefined).handle(staffReq("/api/map/status"));
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("the real service behind the routes never leaks the key", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "truck-routes-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function realApp(tileStatus: number) {
    const config = cfg({ DATA_DIR: dir, GOOGLE_MAPS_KEY: KEY });
    const db = openDatabase(":memory:");
    const calls: string[] = [];
    const fake = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("createSession")) return Response.json({ session: "sess-1", expiry: String(1788595367 + 14 * 86400) });
      if (url.includes("viewport")) return Response.json({ copyright: "Map data ©2026 Google" });
      return new Response(tileStatus === 200 ? new Uint8Array([9, 9]) : `error mentions ${KEY}`, {
        status: tileStatus,
        headers: tileStatus === 200 ? { "cache-control": "public, max-age=3600", "content-type": "image/png", etag: '"z"' } : {},
      });
    }) as unknown as typeof fetch;
    const tiles = createTileService({ db, config, dataDir: dir, fetch: fake, now: () => NOW, log: () => {} });
    return { app: createApp(db, { config, now: () => NOW, sites: loadSites(), rules: loadRules(), tiles }), calls };
  }

  const dump = async (res: Response): Promise<string> => {
    let h = "";
    res.headers.forEach((v, k) => (h += `${k}: ${v}\n`));
    return h + Buffer.from(await res.arrayBuffer()).toString("latin1");
  };

  test("a good tile, a hit, the attribution and the status", async () => {
    const { app, calls } = realApp(200);
    const first = await app.handle(staffReq("/tiles/12/3200/1900"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(await dump(first)).not.toContain(KEY);
    const before = calls.length;
    const second = await app.handle(staffReq("/tiles/12/3200/1900"));
    expect(second.status).toBe(200);
    expect(calls.length).toBe(before); // a hit
    for (const path of [ATTR, "/api/map/status"]) {
      const res = await app.handle(staffReq(path));
      expect(res.status).toBe(200);
      const text = await dump(res);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("sess-1");
    }
  });

  test("an upstream failure that echoes the key in its body", async () => {
    const { app } = realApp(500);
    const res = await app.handle(staffReq("/tiles/12/3200/1900"));
    expect(res.status).toBe(502);
    expect(await dump(res)).not.toContain(KEY);
  });

  test("the cap turns into a 503 on the route", async () => {
    const config = cfg({ DATA_DIR: dir, GOOGLE_MAPS_KEY: KEY, TILE_DAILY_CAP: "0" });
    const db = openDatabase(":memory:");
    const tiles = createTileService({ db, config, dataDir: dir, fetch: (async () => new Response("x")) as unknown as typeof fetch, now: () => NOW });
    const app = createApp(db, { config, now: () => NOW, sites: loadSites(), rules: loadRules(), tiles });
    const res = await app.handle(staffReq("/tiles/12/3200/1900"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "tile-budget" });
  });
});
