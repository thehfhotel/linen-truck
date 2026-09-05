// config.ts invariants (docs/CONTRACTS.md §1).

import { describe, expect, test } from "bun:test";
import { loadConfig, sinotrackConfigured, type Env } from "../../src/server/config.ts";

/** Every test starts from a safe base: DATA_DIR must never be "/data" outside production. */
const env = (extra: Env = {}): Env => ({ DATA_DIR: "./data", ...extra });

describe("loadConfig", () => {
  test("the §1 defaults", () => {
    const config = loadConfig(env());
    expect(config.port).toBe(4100);
    expect(config.tz).toBe("Asia/Bangkok");
    expect(config.dbPath).toBe("data/truck.db");
    expect(config.backupDir).toBe("data/backups");
    expect(config.publicUrl).toBe("https://truck.thehfhotel.org");
    expect(config.publicOrigin).toBe("https://truck.thehfhotel.org");
    expect(config.gitSha).toBe("unknown");
    expect(config.sinotrackServer).toBe("https://242.sinotrack.com");
    expect(config.pollIntervalSeconds).toBe(600);
    expect(config.pollWindowHours).toBe(48);
    expect(config.cfAccessTeamDomain).toBe("laikaexpress.cloudflareaccess.com");
    // cloudflared runs on the box itself; no LAN address is baked in (§1, §13).
    expect(config.trustedProxyCidrs).toEqual(["127.0.0.1/32", "172.16.0.0/12"]);
    expect(config.backupTime).toBe("02:35");
  });

  test("SINOTRACK_SERVER must be an https URL — the password is posted to it", () => {
    expect(loadConfig(env({ SINOTRACK_SERVER: "https://242.example.com/" })).sinotrackServer).toBe(
      "https://242.example.com",
    );
    expect(() => loadConfig(env({ SINOTRACK_SERVER: "http://242.example.com" }))).toThrow(/must be https/);
    expect(() => loadConfig(env({ SINOTRACK_SERVER: "242.example.com" }))).toThrow(/SINOTRACK_SERVER/);
    expect(() => loadConfig(env({ SINOTRACK_SERVER: "ftp://242.example.com" }))).toThrow(/must be https/);
  });

  test("BACKUP_TIME: unset is the 02:35 default, set-but-empty is off, nonsense is a boot failure", () => {
    expect(loadConfig(env()).backupTime).toBe("02:35");
    expect(loadConfig(env({ BACKUP_TIME: "23:05" })).backupTime).toBe("23:05");
    expect(loadConfig(env({ BACKUP_TIME: " 04:00 " })).backupTime).toBe("04:00");
    // The one variable where empty and unset differ (§1: "Empty → off").
    expect(loadConfig(env({ BACKUP_TIME: "" })).backupTime).toBe("");
    expect(loadConfig(env({ BACKUP_TIME: "  " })).backupTime).toBe("");
    expect(() => loadConfig(env({ BACKUP_TIME: "2:35" }))).toThrow(/BACKUP_TIME/);
    expect(() => loadConfig(env({ BACKUP_TIME: "24:00" }))).toThrow(/BACKUP_TIME/);
    expect(() => loadConfig(env({ BACKUP_TIME: "02:60" }))).toThrow(/BACKUP_TIME/);
  });

  test("empty means off — the two fail-closed switches", () => {
    const config = loadConfig(env({ CF_ACCESS_AUD: "  ", FEED_TOKEN: "" }));
    expect(config.cfAccessAud).toEqual([]);
    expect(config.feedToken).toBe("");
  });

  test("CF_ACCESS_AUD is a comma list, trimmed", () => {
    expect(loadConfig(env({ CF_ACCESS_AUD: " a , b ,, c " })).cfAccessAud).toEqual(["a", "b", "c"]);
  });

  test("SINOTRACK_TEID defaults to SINOTRACK_USER and can be overridden", () => {
    expect(loadConfig(env({ SINOTRACK_USER: "1000000001" })).sinotrackTeid).toBe("1000000001");
    expect(loadConfig(env({ SINOTRACK_USER: "1000000001", SINOTRACK_TEID: "999" })).sinotrackTeid).toBe("999");
  });

  test("sinotrackConfigured needs user AND password", () => {
    expect(sinotrackConfigured(loadConfig(env({ SINOTRACK_USER: "1000000001" })))).toBe(false);
    expect(sinotrackConfigured(loadConfig(env({ SINOTRACK_PASSWORD: "x" })))).toBe(false);
    expect(sinotrackConfigured(loadConfig(env({ SINOTRACK_USER: "1000000001", SINOTRACK_PASSWORD: "x" })))).toBe(true);
  });

  test("PUBLIC_URL loses its trailing slash and yields the CSRF origin", () => {
    const config = loadConfig(env({ PUBLIC_URL: "https://truck.thehfhotel.org/" }));
    expect(config.publicUrl).toBe("https://truck.thehfhotel.org");
    expect(config.publicOrigin).toBe("https://truck.thehfhotel.org");
  });

  test("a non-URL PUBLIC_URL is a boot failure", () => {
    expect(() => loadConfig(env({ PUBLIC_URL: "not a url" }))).toThrow(/PUBLIC_URL/);
  });

  test("nonsense numbers fall back rather than becoming NaN", () => {
    const config = loadConfig(env({ PORT: "abc", POLL_INTERVAL_SECONDS: "0", POLL_WINDOW_HOURS: "-3" }));
    expect(config.port).toBe(4100);
    expect(config.pollIntervalSeconds).toBe(600);
    expect(config.pollWindowHours).toBe(48);
  });

  test("DATA_DIR=/data outside production is a boot failure", () => {
    expect(() => loadConfig({ DATA_DIR: "/data" })).toThrow(/production volume/);
    expect(() => loadConfig({ DATA_DIR: "/data", NODE_ENV: "production" })).not.toThrow();
  });

  test("ALLOW_DEV_AUTH is exactly the string 1", () => {
    expect(loadConfig(env({ ALLOW_DEV_AUTH: "1" })).allowDevAuth).toBe(true);
    expect(loadConfig(env({ ALLOW_DEV_AUTH: "true" })).allowDevAuth).toBe(false);
    expect(loadConfig(env()).allowDevAuth).toBe(false);
  });
});
