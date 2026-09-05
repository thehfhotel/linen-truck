// linen-truck — the two sites and the audit rules (docs/CONTRACTS.md §2).
//
// `config/sites.json` and `config/rules.json` are CHECKED IN and shipped in the
// image; the owner tunes them by editing the files and redeploying, and there is
// deliberately no UI. This module is the only reader.
//
// The §2 values are also baked in here as `DEFAULT_SITES` / `DEFAULT_RULES`, for
// two reasons: a unit test needs the real geometry without reaching for disk, and
// a container whose `config/` failed to copy must still answer — with the
// contract's own numbers and a loud warning — rather than crash on boot.
//
// A malformed or partial file is a WARNING plus the defaults, never a throw: the
// day report degrading to the shipped rules beats the whole service refusing to
// start because someone left a trailing comma in a tuning file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rules, Site } from "../domain/types.ts";

/** §2 `config/sites.json`, verbatim. */
export const DEFAULT_SITES: readonly Site[] = Object.freeze([
  { id: "hf", name: { th: "โรงแรม HF", en: "HF Hotel" }, lat: 9.1442868, lon: 99.3245632, radiusM: 250 },
  { id: "hfville", name: { th: "HF Ville", en: "HF Ville" }, lat: 9.1213396, lon: 99.3516676, radiusM: 250 },
]);

/** §2 `config/rules.json`, verbatim. */
export const DEFAULT_RULES: Rules = Object.freeze({
  stopRadiusM: 120,
  minStopS: 180,
  mergeHopM: 300,
  unknownStopMinS: 180,
  movingKmh: 5,
  schedule: { start: "12:00", end: "16:00" },
  detourRatio: 1.25,
  referenceKm: { "hf|hfville": 4.9 },
  engineOnVolts: 13.2,
});

/** Where the shipped files live inside the image (`WORKDIR/config`). */
export const configDir = (): string => join(process.cwd(), "config");

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    console.warn(`[config] ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — using the built-in defaults`);
    return null;
  }
}

/** One entry of `sites.json`; anything missing a usable id/lat/lon is dropped. */
function toSite(raw: unknown): Site | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, "");
  if (id === "") return null;
  if (typeof r.lat !== "number" || typeof r.lon !== "number") return null;
  const name = typeof r.name === "object" && r.name !== null ? (r.name as Record<string, unknown>) : {};
  return {
    id,
    name: { th: str(name.th, id), en: str(name.en, id) },
    lat: r.lat,
    lon: r.lon,
    radiusM: num(r.radiusM, 250),
  };
}

/** `config/sites.json`, or the §2 defaults. Never throws. */
export function loadSites(dir: string = configDir()): Site[] {
  const raw = readJson(join(dir, "sites.json"));
  if (!Array.isArray(raw)) return DEFAULT_SITES.map((s) => ({ ...s, name: { ...s.name } }));
  const sites = raw.map(toSite).filter((s): s is Site => s !== null);
  if (sites.length === 0) {
    console.warn("[config] sites.json held no usable site — using the built-in defaults");
    return DEFAULT_SITES.map((s) => ({ ...s, name: { ...s.name } }));
  }
  return sites;
}

/** `config/rules.json` merged over the §2 defaults, field by field. Never throws. */
export function loadRules(dir: string = configDir()): Rules {
  const raw = readJson(join(dir, "rules.json"));
  const base: Rules = {
    ...DEFAULT_RULES,
    schedule: { ...DEFAULT_RULES.schedule },
    referenceKm: { ...DEFAULT_RULES.referenceKm },
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;

  base.stopRadiusM = num(r.stopRadiusM, base.stopRadiusM);
  base.minStopS = num(r.minStopS, base.minStopS);
  base.mergeHopM = num(r.mergeHopM, base.mergeHopM);
  base.unknownStopMinS = num(r.unknownStopMinS, base.unknownStopMinS);
  base.movingKmh = num(r.movingKmh, base.movingKmh);
  base.detourRatio = num(r.detourRatio, base.detourRatio);
  base.engineOnVolts = num(r.engineOnVolts, base.engineOnVolts);

  if (typeof r.schedule === "object" && r.schedule !== null) {
    const s = r.schedule as Record<string, unknown>;
    base.schedule = { start: str(s.start, base.schedule.start), end: str(s.end, base.schedule.end) };
  }
  // Replaced wholesale, not merged: the owner deleting a pair from the file must
  // actually delete the detour reference, not leave the shipped one behind.
  if (typeof r.referenceKm === "object" && r.referenceKm !== null && !Array.isArray(r.referenceKm)) {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(r.referenceKm as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    base.referenceKm = out;
  }
  return base;
}
