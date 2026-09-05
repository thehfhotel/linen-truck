// linen-truck — raw platform row → `Point` (docs/CONTRACTS.md §3).
//
// Every field the SinoTrack JSON API returns is a STRING, including the numbers
// ("nTime": "1788585074", "dbLat": "9.1479117"), and the interesting extras are
// hidden in a semicolon-separated `strOther` blob:
//
//     "strOther": "Voltages=13.2;RecvTime=1788585018"
//     "strOther": "RecvTime=1788585019"          ← no voltage on this fix
//
// Missing voltage is normal (roughly one fix in a hundred) and must stay `null`
// rather than becoming 0, or the engine-on minutes would read as "engine off".

import type { Point } from "./types.ts";

/** A finite number from a platform string field, or null (empty string is not 0). */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `Voltages=` out of a `strOther` blob; null when absent or unparseable. */
export function parseVoltage(strOther: string | undefined): number | null {
  if (!strOther) return null;
  for (const part of strOther.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== "Voltages") continue;
    return num(part.slice(eq + 1));
  }
  return null;
}

/**
 * One platform row as a domain `Point`, or null when the row carries no usable
 * fix. A (0, 0) fix is NOT rejected here — it is a real row worth storing, and
 * `cleanPoints` is the one place that decides which fixes the maths may see.
 */
export function pointFromRow(row: Record<string, string>): Point | null {
  const t = num(row.nTime);
  const lat = num(row.dbLat);
  const lon = num(row.dbLon);
  if (t === null || lat === null || lon === null) return null;
  return { t, lat, lon, speed: num(row.nSpeed) ?? 0, voltage: parseVoltage(row.strOther) };
}
