// Bangkok-day and shift maths (docs/CONTRACTS.md §0).
//
// Every timestamp in this app is `new Date().toISOString()` — 24 chars, UTC, with
// milliseconds. The hotel, however, thinks in Bangkok calendar days and in three
// shifts, so the digest, the retention job, the CSV and every insights bucket run
// through here. No library: `Intl.DateTimeFormat` with `timeZone: "Asia/Bangkok"`
// is the only zone source, and the UTC offset for a given instant is derived from
// it rather than hard-coded, so a future zone change cannot silently rot.

// Divergence from guest-feedback: this repo has no shifts, so feedback's `shiftOf`
// (and its `Shift` import from src/shared/types.ts) is dropped. Everything else is verbatim.

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;

function wallClock(atMs: number): WallClock {
  const parts = FMT.formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`not an ISO timestamp: ${iso}`);
  return ms;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Bangkok's UTC offset in ms at the given instant (+7 h today, derived not assumed). */
function offsetMsAt(atMs: number): number {
  const w = wallClock(atMs);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(atMs / 1000) * 1000;
}

/** "YYYY-MM-DD" in Asia/Bangkok. */
export function bangkokDay(iso: string): string {
  const w = wallClock(parseIso(iso));
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** 0..23 in Asia/Bangkok. */
export function bangkokHour(iso: string): number {
  return wallClock(parseIso(iso)).hour;
}

/**
 * `[00:00, 24:00)` of a Bangkok calendar day, as UTC instants — the half-open
 * range every range query in db.ts takes (`>= since AND < until`).
 */
export function bangkokDayBounds(day: string): { sinceIso: string; untilIso: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const midnightAsUtc = Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
  // Two passes: guess with the offset that applies to the naive instant, then
  // re-read the offset at that guess. Converges for any sane zone rule.
  let sinceMs = midnightAsUtc - offsetMsAt(midnightAsUtc);
  sinceMs = midnightAsUtc - offsetMsAt(sinceMs);
  const untilMidnightAsUtc = midnightAsUtc + DAY_MS;
  let untilMs = untilMidnightAsUtc - offsetMsAt(untilMidnightAsUtc);
  untilMs = untilMidnightAsUtc - offsetMsAt(untilMs);
  return { sinceIso: new Date(sinceMs).toISOString(), untilIso: new Date(untilMs).toISOString() };
}

/** ISO-8601 week of the Bangkok calendar date, e.g. "2026-W36". */
export function isoWeekId(iso: string): string {
  const w = wallClock(parseIso(iso));
  const target = new Date(Date.UTC(w.year, w.month - 1, w.day));
  // Shift to the Thursday of this ISO week; its calendar year is the ISO year.
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${pad2(week)}`;
}

/** The Bangkok day `n` days before `day` (used for zero-filled insight series). */
export function addBangkokDays(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * DAY_MS;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "YYYY-MM-DD HH:MM" in Bangkok — the CSV's `createdAtBangkok` column (§6.6). */
export function bangkokDateTime(iso: string): string {
  const w = wallClock(parseIso(iso));
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}`;
}
