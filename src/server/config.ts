// linen-truck — the environment, read exactly once (docs/CONTRACTS.md §1).
//
// Rule from §0: "Only `src/server/config.ts` reads `process.env`. Handlers read
// `deps.config`." That is what makes the whole HTTP surface testable without
// touching the real environment: every test builds a Config literal.
//
// Three things throw at BOOT rather than misbehaving later:
//
//   * NODE_ENV !== "production" while DATA_DIR === "/data" (the same guard as
//     guest-feedback). That combination only happens on the box with a broken
//     compose file, and it is exactly the combination that would let
//     ALLOW_DEV_AUTH through on the real volume.
//   * PUBLIC_URL that is not a URL.
//   * SINOTRACK_SERVER that is not an https URL. The device password is posted
//     to that host in a form body on every poll, so a stray `http://` — a typo,
//     a copy-paste from the vendor's own docs — would put the credential on the
//     wire in clear. A dead container is the correct answer to that.
//
// Empty and unset mean the same thing everywhere: docker-compose's `${VAR:-}`
// passes a variable through SET BUT EMPTY, so `??` defaults never fire for it.
// Every read below trims and treats "" as absent.

import { join } from "node:path";

/** Shipped app version. Echoed by /healthz next to the commit sha. */
export const APP_VERSION = "0.1.0";

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  /** IANA zone name; the app is Bangkok everywhere (§0). */
  tz: string;
  dataDir: string;
  /** `${DATA_DIR}/truck.db` */
  dbPath: string;
  /** `${DATA_DIR}/backups` */
  backupDir: string;
  /** PUBLIC_URL with any trailing slash removed. */
  publicUrl: string;
  /** The origin of `publicUrl` — the CSRF comparison value. */
  publicOrigin: string;
  gitSha: string;
  version: string;
  /** Cluster server hosting the account, no trailing slash. */
  sinotrackServer: string;
  /** Empty → the poller stays dormant (logged once). */
  sinotrackUser: string;
  /** NEVER logged, never echoed by a route. */
  sinotrackPassword: string;
  /** Defaults to `sinotrackUser` (§1). */
  sinotrackTeid: string;
  pollIntervalSeconds: number;
  pollWindowHours: number;
  cfAccessTeamDomain: string;
  /** Empty list = every page/API answers 503 (fail closed, §1). */
  cfAccessAud: string[];
  /** Empty = `/feed/*` answers 404 (§7). */
  feedToken: string;
  trustedProxyCidrs: string[];
  /** Bangkok `HH:MM` for the nightly backup, or `""` for no backups at all (§1). */
  backupTime: string;
  allowDevAuth: boolean;
}

export type Env = Record<string, string | undefined>;

const text = (env: Env, key: string, fallback = ""): string => {
  const raw = env[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" ? fallback : value;
};

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** A positive integer, or the fallback for anything else (0, "", "abc", -1). */
const positiveInt = (env: Env, key: string, fallback: number): number => {
  const value = Number(text(env, key, String(fallback)));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

/**
 * cloudflared runs ON the box and reaches the container over loopback, so the
 * only peers that may set `CF-Connecting-IP` are localhost and the Docker bridge
 * range. No LAN address belongs here (§13: this repo is public).
 */
const DEFAULT_TRUSTED_PROXY_CIDRS = "127.0.0.1/32,172.16.0.0/12";
export const DEFAULT_PUBLIC_URL = "https://truck.thehfhotel.org";
/** §1 BACKUP_TIME — Bangkok wall clock, deep in the quiet hours. */
export const DEFAULT_BACKUP_TIME = "02:35";
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_SINOTRACK_SERVER = "https://242.sinotrack.com";

/**
 * Reads the whole environment into one frozen object. Throws only for the
 * misconfiguration that must never reach a running container.
 */
export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = text(env, "NODE_ENV", "development");
  const isProduction = nodeEnv === "production";
  const dataDir = text(env, "DATA_DIR", "/data");

  if (!isProduction && dataDir === "/data") {
    throw new Error(
      "config: DATA_DIR=/data with NODE_ENV=" +
        nodeEnv +
        " — the production volume must never be opened outside production (docs/CONTRACTS.md §1)",
    );
  }

  const rawPublicUrl = text(env, "PUBLIC_URL", DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  let publicOrigin: string;
  try {
    publicOrigin = new URL(rawPublicUrl).origin;
  } catch {
    throw new Error(`config: PUBLIC_URL is not a URL: ${rawPublicUrl}`);
  }

  // §1: the nightly backup defaults to 02:35 Bangkok, and an EXPLICITLY EMPTY
  // value turns it off. This is the ONE variable where empty and unset differ —
  // everywhere else "" means "fall back to the default", but a default of 02:35
  // would leave no way to say "no backups here" (a developer's laptop, a second
  // replica that must not fight the first for the same file). A malformed value
  // is a boot failure rather than silent silence: nobody notices a backup that
  // never runs until the day they need it.
  const rawBackupTime = env.BACKUP_TIME === undefined ? DEFAULT_BACKUP_TIME : env.BACKUP_TIME.trim();
  if (rawBackupTime !== "" && !HHMM_RE.test(rawBackupTime)) {
    throw new Error(`config: BACKUP_TIME must be Bangkok HH:MM, or empty for no backups: ${rawBackupTime}`);
  }
  const backupTime = rawBackupTime;

  const sinotrackServer = text(env, "SINOTRACK_SERVER", DEFAULT_SINOTRACK_SERVER).replace(/\/+$/, "");
  let sinotrackProtocol: string;
  try {
    sinotrackProtocol = new URL(sinotrackServer).protocol;
  } catch {
    throw new Error(`config: SINOTRACK_SERVER is not a URL: ${sinotrackServer}`);
  }
  if (sinotrackProtocol !== "https:") {
    throw new Error(
      `config: SINOTRACK_SERVER must be https (the device password is posted to it): ${sinotrackServer}`,
    );
  }

  const sinotrackUser = text(env, "SINOTRACK_USER");

  const config: Config = {
    nodeEnv,
    isProduction,
    port: positiveInt(env, "PORT", 4100),
    tz: text(env, "TZ", "Asia/Bangkok"),
    dataDir,
    dbPath: join(dataDir, "truck.db"),
    backupDir: join(dataDir, "backups"),
    publicUrl: rawPublicUrl,
    publicOrigin,
    gitSha: text(env, "GIT_SHA", "unknown"),
    version: APP_VERSION,
    sinotrackServer,
    sinotrackUser,
    sinotrackPassword: text(env, "SINOTRACK_PASSWORD"),
    // §1: "SINOTRACK_TEID | = SINOTRACK_USER". The device id and the login are the
    // same 10 digits on this account, but the platform allows an account with
    // several devices, so the override stays.
    sinotrackTeid: text(env, "SINOTRACK_TEID", sinotrackUser),
    pollIntervalSeconds: positiveInt(env, "POLL_INTERVAL_SECONDS", 600),
    pollWindowHours: positiveInt(env, "POLL_WINDOW_HOURS", 48),
    cfAccessTeamDomain: text(env, "CF_ACCESS_TEAM_DOMAIN", "laikaexpress.cloudflareaccess.com"),
    cfAccessAud: list(text(env, "CF_ACCESS_AUD")),
    feedToken: text(env, "FEED_TOKEN"),
    trustedProxyCidrs: list(text(env, "TRUSTED_PROXY_CIDRS", DEFAULT_TRUSTED_PROXY_CIDRS)),
    backupTime,
    allowDevAuth: text(env, "ALLOW_DEV_AUTH") === "1",
  };

  return Object.freeze(config);
}

/** True when the poller has everything it needs to talk to the platform (§6). */
export const sinotrackConfigured = (config: Config): boolean =>
  config.sinotrackUser !== "" && config.sinotrackPassword !== "" && config.sinotrackTeid !== "";

