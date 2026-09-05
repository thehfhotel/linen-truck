// linen-truck — the DayReport (docs/CONTRACTS.md §9).
//
// ONE builder, THREE consumers: the day page's map script (`/api/day/:ymd`), the
// week table (`/api/week/:ymd`) and hf-mcp's owner report (`/feed/daily`). They
// must not drift, so nothing downstream re-derives a number: every rounding, every
// `HH:MM` and every finding sentence is decided exactly once, here.
//
// The domain layer speaks epoch seconds, metres and raw floats because that is
// what the maths needs. This file is the boundary where that becomes something a
// person reads:
//
//   * times → Bangkok `HH:MM` (the `*At` fields stay epoch seconds, per §9),
//   * distances → km to one decimal, ratios to two,
//   * durations → whole minutes,
//   * findings → a `{th, en}` sentence from src/shared/labels.ts.
//
// `summaryOnly()` is the week/range shape: the SAME object with `trips`, `stops`,
// `legs` and `path` dropped and the findings kept (§9). Dropping rather than
// re-building is deliberate — a summary row can never disagree with the day it
// summarises.

import type { DaySummary, Finding, Leg, Point, Rules, Site, Stop, Trip } from "../domain/types.ts";
import { mapUrl } from "../domain/geo.ts";
import { cleanPoints } from "../domain/segment.ts";
import {
  detourText,
  outsideHoursText,
  unknownStopText,
  type FindingKind,
  type L,
} from "../shared/labels.ts";
import type { DeviceStatus, PollLogEntry } from "./db.ts";

export const TZ = "Asia/Bangkok";

/** A device that has not reported for this long reads as offline (§9 `online`). */
export const ONLINE_WINDOW_S = 30 * 60;

// ── formatting ──────────────────────────────────────────────────────────────

const HHMM = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Epoch seconds → Bangkok `HH:MM`. The one clock the whole report reads. */
export const hhmm = (epochS: number): string => HHMM.format(new Date(epochS * 1000));

const STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Epoch seconds → Bangkok `YYYY-MM-DD HH:MM` — the device line's "last seen". */
export const bangkokStamp = (epochS: number): string =>
  STAMP.format(new Date(epochS * 1000)).replace(",", "");

const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export const km1 = (value: number): number => round(value, 1);
export const ratio2 = (value: number): number => round(value, 2);
export const coord5 = (value: number): number => round(value, 5);
/**
 * Whole minutes, FLOORED — elapsed time is reported as time completed, the way a
 * stopwatch reads. §9's own numbers for the 2026-09-05 fixture depend on it:
 * 510 s at HF is `8`, not `9`, and 6870 s at HF Ville is `114`, not `115`.
 */
export const minutesOf = (seconds: number): number => Math.floor(seconds / 60);

// ── the wire shapes (§9) ────────────────────────────────────────────────────

export interface ReportDevice {
  teid: string;
  lastSeenAt: number | null;
  voltage: number | null;
  moving: boolean;
  online: boolean;
}

export interface ReportSummary {
  km: number;
  tripCount: number;
  roundTrips: number;
  firstDeparture: string | null;
  lastArrival: string | null;
  timeAtSiteMin: Record<string, number>;
  pointCount: number;
  findingCount: Record<FindingKind, number>;
}

export interface ReportTrip {
  n: number;
  start: string;
  end: string;
  /** Epoch seconds, additive (docs/CONTRACTS.md §9) — what the day-page map filters on. */
  startAt: number;
  endAt: number;
  minutes: number;
  km: number;
  maxKmh: number;
  from: string | null;
  to: string | null;
  fromMapUrl: string;
  toMapUrl: string;
}

export interface ReportStop {
  arrive: string;
  depart: string;
  /** Epoch seconds, additive (docs/CONTRACTS.md §9) — what the day-page map filters on. */
  arriveAt: number;
  departAt: number;
  minutes: number;
  site: string | null;
  lat: number;
  lon: number;
  mapUrl: string;
  engineOnMin: number;
  /** Present only for the two synthetic day-edge stops (§3 rule 3). */
  virtual?: "track-start" | "track-end";
}

export interface ReportLeg {
  trips: number[];
  from: string;
  to: string;
  km: number;
  /** `null` when no reference distance is configured for this pair. */
  referenceKm: number | null;
  ratio: number | null;
}

export type ReportFinding =
  | {
      kind: "unknown-stop";
      text: L;
      mapUrl: string;
      minutes: number;
      start: string;
      end: string;
      /** Index into `DayReport.stops`, additive (§9) — what the day-page map selects. */
      stopIndex: number;
    }
  | {
      kind: "detour";
      text: L;
      trips: number[];
      from: string;
      to: string;
      km: number;
      referenceKm: number;
      ratio: number;
    }
  | {
      kind: "outside-hours";
      text: L;
      start: string;
      end: string;
      km: number;
      /** Epoch seconds, additive (§9). */
      startAt: number;
      endAt: number;
    };

export interface ReportDataQuality {
  lastPollAt: number | null;
  lastPollOk: boolean | null;
  /** A short machine-readable reason, or null when nothing is wrong. */
  note: string | null;
}

/** `[lat, lon, t]` triples, in time order — what the Leaflet script draws. */
export type PathPoint = [number, number, number];

export interface DayReport {
  date: string;
  tz: string;
  generatedAt: number;
  device: ReportDevice;
  summary: ReportSummary;
  /** Omitted by `summaryOnly()` (§9). */
  trips?: ReportTrip[];
  stops?: ReportStop[];
  legs?: ReportLeg[];
  findings: ReportFinding[];
  path?: PathPoint[];
  dataQuality: ReportDataQuality;
}

// ── the builder ─────────────────────────────────────────────────────────────

const EMPTY_COUNTS: Record<FindingKind, number> = { "unknown-stop": 0, detour: 0, "outside-hours": 0 };

/** The reference key for a pair of sites: the two ids sorted, joined with `|` (§2). */
export const referenceKey = (a: string, b: string): string => [a, b].sort().join("|");

const siteName = (sites: readonly Site[], id: string): L => {
  const site = sites.find((s) => s.id === id);
  return site ? site.name : { th: id, en: id };
};

function toTrip(trip: Trip): ReportTrip {
  return {
    n: trip.n,
    start: hhmm(trip.start),
    end: hhmm(trip.end),
    startAt: trip.start,
    endAt: trip.end,
    minutes: minutesOf(trip.end - trip.start),
    km: km1(trip.km),
    maxKmh: Math.round(trip.maxKmh),
    from: trip.from.siteId,
    to: trip.to.siteId,
    fromMapUrl: mapUrl(trip.from.lat, trip.from.lon),
    toMapUrl: mapUrl(trip.to.lat, trip.to.lon),
  };
}

function toStop(stop: Stop): ReportStop {
  const out: ReportStop = {
    arrive: hhmm(stop.arrive),
    depart: hhmm(stop.depart),
    arriveAt: stop.arrive,
    departAt: stop.depart,
    minutes: minutesOf(stop.depart - stop.arrive),
    site: stop.siteId,
    lat: coord5(stop.lat),
    lon: coord5(stop.lon),
    mapUrl: mapUrl(stop.lat, stop.lon),
    engineOnMin: minutesOf(stop.engineOnS),
  };
  if (stop.virtual !== undefined) out.virtual = stop.virtual;
  return out;
}

function toLeg(leg: Leg, rules: Rules): ReportLeg {
  const reference = rules.referenceKm[referenceKey(leg.fromSiteId, leg.toSiteId)];
  const km = km1(leg.km);
  return {
    trips: [...leg.tripNs],
    from: leg.fromSiteId,
    to: leg.toSiteId,
    km,
    referenceKm: reference === undefined ? null : reference,
    ratio: reference === undefined || reference === 0 ? null : ratio2(leg.km / reference),
  };
}

/**
 * The finding's stop, located back in `summary.stops` by (arrive, depart) — the
 * exact pair `unknownStops()` in `src/domain/audit.ts` copied off the stop it
 * fired on, and unique because stops are chronological and non-overlapping.
 * `-1` (never expected to fire) is friendlier to a JSON consumer than a throw.
 */
function findStopIndex(stops: readonly Stop[], arrive: number, depart: number): number {
  return stops.findIndex((s) => s.arrive === arrive && s.depart === depart);
}

function toFinding(finding: Finding, sites: readonly Site[], stops: readonly Stop[]): ReportFinding {
  if (finding.kind === "unknown-stop") {
    const minutes = minutesOf(finding.durationS);
    const start = hhmm(finding.arrive);
    const end = hhmm(finding.depart);
    return {
      kind: "unknown-stop",
      text: unknownStopText(minutes, start, end),
      mapUrl: mapUrl(finding.lat, finding.lon),
      minutes,
      start,
      end,
      stopIndex: findStopIndex(stops, finding.arrive, finding.depart),
    };
  }
  if (finding.kind === "detour") {
    const km = km1(finding.leg.km);
    const reference = km1(finding.referenceKm);
    const ratio = ratio2(finding.ratio);
    return {
      kind: "detour",
      text: detourText(
        siteName(sites, finding.leg.fromSiteId),
        siteName(sites, finding.leg.toSiteId),
        km,
        reference,
        ratio,
      ),
      trips: [...finding.leg.tripNs],
      from: finding.leg.fromSiteId,
      to: finding.leg.toSiteId,
      km,
      referenceKm: reference,
      ratio,
    };
  }
  const start = hhmm(finding.start);
  const end = hhmm(finding.end);
  const km = km1(finding.km);
  return {
    kind: "outside-hours",
    text: outsideHoursText(start, end, km),
    start,
    end,
    km,
    startAt: finding.start,
    endAt: finding.end,
  };
}

/**
 * The device line (§9). `device_status` is the platform's own "where is it right
 * now", so it is preferred; a day with no status row yet falls back to the last
 * point OF THAT DAY, which is the honest answer for a historic report.
 */
export function toDevice(args: {
  teid: string;
  status: DeviceStatus | null;
  summary: DaySummary;
  points: readonly Point[];
  rules: Rules;
  generatedAt: number;
}): ReportDevice {
  const { status, summary, points, rules, generatedAt } = args;
  if (status && status.t !== null && status.t > 0) {
    return {
      teid: args.teid,
      lastSeenAt: status.t,
      voltage: status.voltage,
      moving: (status.speed ?? 0) > rules.movingKmh,
      online: generatedAt - status.t <= ONLINE_WINDOW_S,
    };
  }
  const last = points.length > 0 ? points[points.length - 1] : undefined;
  if (!last) {
    return { teid: args.teid, lastSeenAt: summary.lastPointAt, voltage: null, moving: false, online: false };
  }
  return {
    teid: args.teid,
    lastSeenAt: last.t,
    voltage: last.voltage,
    moving: last.speed > rules.movingKmh,
    online: generatedAt - last.t <= ONLINE_WINDOW_S,
  };
}

/**
 * Data quality (§9). `note` is a short machine-readable reason so hf-mcp can say
 * "data unavailable" without parsing prose; `null` means nothing is wrong.
 */
export function toDataQuality(poll: PollLogEntry | null, summary: DaySummary, pollerConfigured: boolean): ReportDataQuality {
  if (!pollerConfigured) return { lastPollAt: poll?.at ?? null, lastPollOk: poll?.ok ?? null, note: "poller-not-configured" };
  if (poll === null) return { lastPollAt: null, lastPollOk: null, note: "no-poll-yet" };
  if (!poll.ok) return { lastPollAt: poll.at, lastPollOk: false, note: "last-poll-failed" };
  if (summary.pointCount === 0) return { lastPollAt: poll.at, lastPollOk: true, note: "no-points-for-day" };
  return { lastPollAt: poll.at, lastPollOk: true, note: null };
}

export interface BuildArgs {
  teid: string;
  summary: DaySummary;
  points: readonly Point[];
  sites: readonly Site[];
  rules: Rules;
  status: DeviceStatus | null;
  poll: PollLogEntry | null;
  pollerConfigured: boolean;
  /** Epoch seconds; the caller's clock, never `Date.now()` here. */
  generatedAt: number;
}

export function buildDayReport(args: BuildArgs): DayReport {
  const { summary, sites, rules } = args;

  // THE SAME ARRAY THE SUMMARY COUNTED. `summarizeDay` runs its points through
  // `cleanPoints` (§3: sort, drop duplicate timestamps, drop null-island fixes)
  // before it segments, so a report that drew `args.points` raw would put a
  // (0, 0) fix on the map — a polyline from Surat Thani to the Gulf of Guinea —
  // and publish a `path` longer than `summary.pointCount`. One cleaning, one
  // array, for both the map and the device fallback.
  const points = cleanPoints(args.points);

  const findingCount: Record<FindingKind, number> = { ...EMPTY_COUNTS };
  for (const f of summary.findings) findingCount[f.kind] += 1;

  const timeAtSiteMin: Record<string, number> = {};
  for (const [siteId, seconds] of Object.entries(summary.timeAtSiteS)) {
    timeAtSiteMin[siteId] = minutesOf(seconds);
  }

  return {
    date: summary.ymd,
    tz: TZ,
    generatedAt: args.generatedAt,
    device: toDevice({
      teid: args.teid,
      status: args.status,
      summary,
      points,
      rules,
      generatedAt: args.generatedAt,
    }),
    summary: {
      km: km1(summary.km),
      tripCount: summary.tripCount,
      roundTrips: summary.roundTrips,
      firstDeparture: summary.firstDeparture === null ? null : hhmm(summary.firstDeparture),
      lastArrival: summary.lastArrival === null ? null : hhmm(summary.lastArrival),
      timeAtSiteMin,
      pointCount: summary.pointCount,
      findingCount,
    },
    trips: summary.trips.map(toTrip),
    stops: summary.stops.map(toStop),
    legs: summary.legs.map((leg) => toLeg(leg, rules)),
    findings: summary.findings.map((f) => toFinding(f, sites, summary.stops)),
    path: points.map((p): PathPoint => [coord5(p.lat), coord5(p.lon), p.t]),
    dataQuality: toDataQuality(args.poll, summary, args.pollerConfigured),
  };
}

/** The `/api/week` and `/feed/range` shape: no `trips`, `stops`, `legs`, `path` (§9). */
export function summaryOnly(report: DayReport): DayReport {
  const { trips, stops, legs, path, ...rest } = report;
  void trips;
  void stops;
  void legs;
  void path;
  return rest;
}
