// linen-truck — the process (docs/CONTRACTS.md §7).
//
// ONE `Bun.serve`, and it does nothing but hand every request to the Elysia app:
// unlike guest-feedback there is no `dist/` here, no client bundle and therefore
// no static tree to answer first. The split is kept anyway — `createApp` is a
// complete description of the surface, and `app.handle(req)` in a test exercises
// exactly what production serves.
//
// Boot order matters: the database is opened and migrated BEFORE the listener,
// so a schema failure is a dead container rather than a live one answering 500s;
// the poller is armed AFTER the listener, on a 5-second delay, so the health
// probe can pass while the first (potentially slow) platform call is in flight.
//
// The nightly backup runs IN THIS PROCESS (§1 BACKUP_TIME): the HF Ville box
// gives us no systemd unit and no host timer to install, so a scheduler that
// dies with the container is the only kind there can be.

import { mkdirSync } from "node:fs";
import { createApp, resolveDeps } from "./app.ts";
import { devAuthEnabled } from "./auth.ts";
import { startBackupScheduler } from "./backupScheduler.ts";
import { loadConfig, sinotrackConfigured } from "./config.ts";
import { openDatabase } from "./db.ts";
import { startPoller } from "./poller.ts";
import { loadRules, loadSites } from "./siteConfig.ts";

const config = loadConfig(process.env);

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.backupDir, { recursive: true });

const db = openDatabase(config.dbPath);

if (devAuthEnabled(config)) {
  console.warn("[auth] ALLOW_DEV_AUTH=1 - X-Dev-Email replaces the Cloudflare Access JWT. Never set this in production.");
}

const poller = startPoller(db, { config, nowMs: () => Date.now() });
const backups = startBackupScheduler({ config, nowMs: () => Date.now() });

const app = createApp(db, {
  ...resolveDeps({
    config,
    sites: loadSites(),
    rules: loadRules(),
    pollerStatus: () => poller.status(),
  }),
});

const server = Bun.serve({
  port: config.port,
  idleTimeout: 60,
  fetch: (req) => app.handle(req) as Promise<Response>,
});

console.log(
  `linen-truck listening on http://localhost:${server.port} (${config.nodeEnv}) — poller ${
    sinotrackConfigured(config) ? "armed" : "dormant"
  }`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    poller.stop();
    backups.stop();
    server.stop();
    process.exit(0);
  });
}
