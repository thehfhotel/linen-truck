// linen-truck — Bangkok wall-clock helpers for the domain (docs/CONTRACTS.md §3).
//
// `src/shared/time.ts` (copied from guest-feedback) is the ONLY zone source in the
// repo and it speaks ISO strings; the domain speaks epoch seconds. This file is the
// thin, pure adapter between the two — it adds no second `Intl` formatter and no
// hard-coded +07:00, so a zone rule change still only has to be right in one place.

import { bangkokDateTime, bangkokDay, bangkokDayBounds } from "../shared/time.ts";

/** Epoch seconds → the 24-char ISO instant `src/shared/time.ts` takes. */
export const isoAt = (t: number): string => new Date(t * 1000).toISOString();

/** "YYYY-MM-DD" in Bangkok for an epoch-seconds instant. */
export const bangkokYmd = (t: number): string => bangkokDay(isoAt(t));

/** Minutes since Bangkok midnight, 0..1439 (seconds truncated). */
export function bangkokMinuteOfDay(t: number): number {
  const s = bangkokDateTime(isoAt(t)); // "YYYY-MM-DD HH:MM"
  return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
}

/** `"12:00"` → 720. Throws on anything else — a bad `config/rules.json` fails loudly. */
export function parseHhMm(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new RangeError(`not an HH:MM time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new RangeError(`not an HH:MM time: ${hhmm}`);
  return h * 60 + min;
}

/** The half-open Bangkok day `[00:00, 24:00)` of `ymd`, in epoch seconds. */
export function bangkokDayWindow(ymd: string): { startS: number; endS: number } {
  const { sinceIso, untilIso } = bangkokDayBounds(ymd);
  return { startS: Date.parse(sinceIso) / 1000, endS: Date.parse(untilIso) / 1000 };
}
