// The two checked-in config files and the defaults behind them (docs/CONTRACTS.md §2).
//
// Two things are worth a test here and neither is exercised anywhere else: the
// shipped `config/*.json` must still BE the §2 values baked into this module (the
// domain tests read the JSON through a bare `as Rules` cast, which cannot notice
// drift), and a file written before a key existed must still boot on the §2
// default rather than on a silently-off guard — `engineHoldS` and `jitterRadiusM`
// were both added after the first deploy, and `radiusM` changed 250 → 600.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_RULES, DEFAULT_SITES, loadRules, loadSites } from "../../src/server/siteConfig.ts";
import type { Rules, Site } from "../../src/domain/types.ts";
import sitesJson from "../../config/sites.json";
import rulesJson from "../../config/rules.json";

const made: string[] = [];

/** A throwaway config dir holding exactly the files the case is about. */
function configDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "truck-config-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("the shipped config is the contract's config", () => {
  test("config/sites.json and DEFAULT_SITES are the same two sites", () => {
    expect(sitesJson as Site[]).toEqual(DEFAULT_SITES as Site[]);
    expect(loadSites(join(process.cwd(), "config"))).toEqual(DEFAULT_SITES as Site[]);
    // §2: both fences are 600 m and the centres are ~4 km apart, so they cannot overlap.
    expect((sitesJson as Site[]).map((s) => s.radiusM)).toEqual([600, 600]);
  });

  test("config/rules.json and DEFAULT_RULES are the same rules", () => {
    expect(rulesJson as Rules).toEqual(DEFAULT_RULES);
    expect(loadRules(join(process.cwd(), "config"))).toEqual(DEFAULT_RULES);
  });
});

describe("loadRules — a file written before a key existed", () => {
  test("a pre-jitter-guard rules.json keeps the §2 engineHoldS and jitterRadiusM", () => {
    // Exactly the file that shipped with the first deploy: it ends at engineOnVolts.
    const dir = configDir({
      "rules.json": JSON.stringify({
        stopRadiusM: 120,
        minStopS: 180,
        mergeHopM: 300,
        unknownStopMinS: 180,
        movingKmh: 5,
        schedule: { start: "12:00", end: "16:00" },
        detourRatio: 1.25,
        referenceKm: { "hf|hfville": 4.9 },
        engineOnVolts: 13.2,
      }),
    });
    const rules = loadRules(dir);
    expect(rules.engineHoldS).toBe(300);
    expect(rules.jitterRadiusM).toBe(600);
    // The owner's own values are still theirs, not the defaults.
    expect(rules.stopRadiusM).toBe(120);
    expect(rules.engineOnVolts).toBe(13.2);
  });

  test("an owner value wins, and a nonsense one falls back rather than throwing", () => {
    const dir = configDir({ "rules.json": '{ "engineHoldS": 120, "jitterRadiusM": "wide" }' });
    const rules = loadRules(dir);
    expect(rules.engineHoldS).toBe(120);
    expect(rules.jitterRadiusM).toBe(600);
  });

  test("a missing file is the §2 defaults, not a crash", () => {
    expect(loadRules(configDir({}))).toEqual(DEFAULT_RULES);
  });
});

describe("loadSites — a file written before the fence widened", () => {
  test("a site with no radiusM lands on the 600 m fence", () => {
    const dir = configDir({
      "sites.json": JSON.stringify([{ id: "hfville", lat: 9.1213396, lon: 99.3516676 }]),
    });
    const [site] = loadSites(dir);
    expect(site!.radiusM).toBe(600);
    // No `name` either: the id stands in for both languages rather than blanking the page.
    expect(site!.name).toEqual({ th: "hfville", en: "hfville" });
  });

  test("a file with no usable site is the §2 defaults, not an empty map", () => {
    expect(loadSites(configDir({ "sites.json": '[{ "id": "hf" }]' }))).toEqual(DEFAULT_SITES as Site[]);
  });
});
