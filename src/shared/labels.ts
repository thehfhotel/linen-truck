// linen-truck — every user-facing string in the app (docs/CONTRACTS.md §8).
//
// House rule (mirrored from ~/HF/guest-feedback): "Every user-facing string comes
// from src/shared/labels.ts (Thai and English side by side). No literals in
// components or HTML strings."
//
// The audience is the owner and the two reception desks, so there is no language
// switch: every line renders as "ไทย · English" through `pair()`, exactly like
// feedback's staff SPA. Thai is always primary.
//
// Keys are lowerCamelCase and screen-prefixed — never the English text, so a
// wording change is a one-line edit rather than a rename across three files.
//
// This file is deliberately dependency-free: it is pure data plus the four
// formatters at the bottom, so a page, the JSON report and a test can all pull
// the same sentence.

/** A Thai/English pair. Thai is always primary. */
export interface L {
  th: string;
  en: string;
}

export type Lang = "th" | "en";

export const pick = (l: L, lang: Lang): string => (lang === "en" ? l.en : l.th);

/** The one rendering the pages use: `ไทย · English`. */
export const pair = (l: L): string => `${l.th} · ${l.en}`;

/** The three finding kinds, spelled here so this file needs no domain import. */
export type FindingKind = "unknown-stop" | "detour" | "outside-hours";

// ── chrome ──────────────────────────────────────────────────────────────────

export const LABELS = {
  appName: { th: "รถขนผ้า", en: "Linen truck" },
  dayTitle: { th: "รายงานรายวัน", en: "Daily report" },
  weekTitle: { th: "รายงาน 7 วัน", en: "7-day report" },
  prevDay: { th: "วันก่อน", en: "Previous day" },
  nextDay: { th: "วันถัดไป", en: "Next day" },
  today: { th: "วันนี้", en: "Today" },
  weekLink: { th: "ดู 7 วัน", en: "7-day view" },
  dayLink: { th: "ดูรายวัน", en: "Day view" },

  // ── device line ───────────────────────────────────────────────────────────
  deviceHeading: { th: "อุปกรณ์", en: "Device" },
  lastSeen: { th: "สัญญาณล่าสุด", en: "Last seen" },
  voltage: { th: "แรงดันไฟ", en: "Voltage" },
  moving: { th: "กำลังวิ่ง", en: "Moving" },
  parked: { th: "จอดอยู่", en: "Parked" },
  online: { th: "ออนไลน์", en: "Online" },
  offline: { th: "ออฟไลน์", en: "Offline" },
  noSignal: { th: "ไม่มีสัญญาณ", en: "No signal" },

  // ── summary tiles ─────────────────────────────────────────────────────────
  summaryHeading: { th: "สรุป", en: "Summary" },
  km: { th: "ระยะทาง", en: "Distance" },
  trips: { th: "เที่ยววิ่ง", en: "Trips" },
  roundTrips: { th: "ไป-กลับ HF ↔ HF Ville", en: "Round trips HF ↔ HF Ville" },
  firstDeparture: { th: "ออกครั้งแรก", en: "First departure" },
  lastArrival: { th: "ถึงครั้งสุดท้าย", en: "Last arrival" },
  timeAtSite: { th: "เวลาที่จุด", en: "Time at site" },
  points: { th: "จุดสัญญาณ", en: "GPS points" },
  unitKm: { th: "กม.", en: "km" },
  unitMin: { th: "นาที", en: "min" },
  unitVolt: { th: "โวลต์", en: "V" },

  // ── findings ──────────────────────────────────────────────────────────────
  findingsHeading: { th: "สิ่งที่ต้องดู", en: "Things to look at" },
  noFindings: { th: "ไม่พบสิ่งผิดปกติ", en: "Nothing unusual" },
  openInMaps: { th: "เปิดแผนที่", en: "Open in Maps" },

  // ── trips table ───────────────────────────────────────────────────────────
  tripsHeading: { th: "เที่ยววิ่ง", en: "Trips" },
  colTrip: { th: "เที่ยว", en: "Trip" },
  colStart: { th: "ออก", en: "Start" },
  colEnd: { th: "ถึง", en: "End" },
  colMinutes: { th: "นาที", en: "Minutes" },
  colKm: { th: "กม.", en: "km" },
  colMaxKmh: { th: "เร็วสุด", en: "Max km/h" },
  colFrom: { th: "จาก", en: "From" },
  colTo: { th: "ไป", en: "To" },

  // ── stops table ───────────────────────────────────────────────────────────
  stopsHeading: { th: "จุดจอด", en: "Stops" },
  colArrive: { th: "ถึง", en: "Arrive" },
  colDepart: { th: "ออก", en: "Depart" },
  colPlace: { th: "สถานที่", en: "Place" },
  colEngineOn: { th: "ติดเครื่อง (นาที)", en: "Engine on (min)" },
  unknownPlace: { th: "ไม่รู้จัก", en: "Unknown" },
  trackStart: { th: "เริ่มบันทึก", en: "Track start" },
  trackEnd: { th: "จบบันทึก", en: "Track end" },

  // ── map ───────────────────────────────────────────────────────────────────
  mapHeading: { th: "เส้นทาง", en: "Route" },
  mapUnavailable: { th: "ไม่มีข้อมูลเส้นทางของวันนี้", en: "No route data for this day" },

  // ── week table ────────────────────────────────────────────────────────────
  colDate: { th: "วันที่", en: "Date" },
  colFindings: { th: "สิ่งที่ต้องดู", en: "Findings" },

  // ── empty / data quality ──────────────────────────────────────────────────
  noData: { th: "ยังไม่มีข้อมูลของวันนี้", en: "No data for this day yet" },
  dataQuality: { th: "คุณภาพข้อมูล", en: "Data quality" },
  lastPoll: { th: "ดึงข้อมูลล่าสุด", en: "Last poll" },
  pollNever: { th: "ยังไม่เคยดึงข้อมูล", en: "The poller has never run" },
  pollFailing: { th: "การดึงข้อมูลล่าสุดล้มเหลว", en: "The last poll failed" },
  pollerDormant: { th: "ยังไม่ได้ตั้งค่าการดึงข้อมูล", en: "The poller is not configured" },
} as const satisfies Record<string, L>;

/** The heading each finding kind gets in a list. */
export const FINDING_KIND: Record<FindingKind, L> = {
  "unknown-stop": { th: "จอดที่ไม่รู้จัก", en: "Unknown stop" },
  detour: { th: "อ้อมทาง", en: "Detour" },
  "outside-hours": { th: "วิ่งนอกเวลางาน", en: "Outside working hours" },
};

// ── the finding sentences (§9 `text`) ───────────────────────────────────────
//
// Numbers arrive already rounded and already formatted as Bangkok `HH:MM`, so
// these are pure string assembly and a test can pin them character for character.

/** `จอดที่ไม่รู้จัก 4 นาที (14:18–14:22)` · `Unknown stop 4 min (14:18–14:22)` */
export const unknownStopText = (minutes: number, start: string, end: string): L => ({
  th: `จอดที่ไม่รู้จัก ${minutes} นาที (${start}–${end})`,
  en: `Unknown stop ${minutes} min (${start}–${end})`,
});

/** `อ้อมทาง HF Ville → โรงแรม HF 7.4 กม. (ปกติ 4.9 กม., 1.51 เท่า)` */
export const detourText = (from: L, to: L, km: number, referenceKm: number, ratio: number): L => ({
  th: `อ้อมทาง ${from.th} → ${to.th} ${km} กม. (ปกติ ${referenceKm} กม., ${ratio} เท่า)`,
  en: `Detour ${from.en} → ${to.en} ${km} km (normally ${referenceKm} km, ${ratio}×)`,
});

/** `วิ่งนอกเวลางาน 08:12–08:40 ระยะ 3.1 กม.` */
export const outsideHoursText = (start: string, end: string, km: number): L => ({
  th: `วิ่งนอกเวลางาน ${start}–${end} ระยะ ${km} กม.`,
  en: `Driving outside working hours ${start}–${end}, ${km} km`,
});

/** `4 นาที` · `4 min` — the duration suffix every table cell shares. */
export const minutesText = (minutes: number): L => ({ th: `${minutes} นาที`, en: `${minutes} min` });
