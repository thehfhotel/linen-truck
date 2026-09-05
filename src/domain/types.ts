// linen-truck — the domain vocabulary (docs/CONTRACTS.md §3).
//
// Everything in `src/domain/` is pure: no IO, no `Date.now()`, no `process.env`.
// A day report is a function of (points, sites, rules) and nothing else, which is
// what lets the whole segmentation be argued with in `test/domain/` against the
// archived 2026-09-05 track rather than against production.
//
// Two conventions the rest of the repo depends on:
//   * every instant is EPOCH SECONDS (the platform's `nTime` unit), never ms and
//     never an ISO string — the ISO/Bangkok formatting lives in the report layer;
//   * a `siteId` of `null` means "not at a known site", which is a finding-worthy
//     fact (an unknown stop), not missing data.

/** One GPS fix. `t` = epoch seconds, `speed` = km/h, `voltage` = volts or null. */
export interface Point {
  t: number;
  lat: number;
  lon: number;
  speed: number;
  voltage: number | null;
}

/** A known place, from `config/sites.json`. `radiusM` is the geofence. */
export interface Site {
  id: string;
  name: { th: string; en: string };
  lat: number;
  lon: number;
  radiusM: number;
}

/** The owner-tuned thresholds, from `config/rules.json`. */
export interface Rules {
  stopRadiusM: number;
  minStopS: number;
  mergeHopM: number;
  unknownStopMinS: number;
  movingKmh: number;
  /** Bangkok wall-clock `HH:MM`, half-open `[start, end)`. */
  schedule: { start: string; end: string };
  detourRatio: number;
  /** Key = the two site ids sorted and joined with `|`, e.g. `hf|hfville`. */
  referenceKm: Record<string, number>;
  engineOnVolts: number;
}

/**
 * A run of points parked inside `stopRadiusM` of the run's first point.
 * `lat`/`lon` are that anchor. `virtual` marks the two book-ends the day gets
 * when the track starts or ends mid-move — they are NOT parked time and never
 * count towards `timeAtSiteS` or findings.
 */
export interface Stop {
  arrive: number;
  depart: number;
  lat: number;
  lon: number;
  siteId: string | null;
  engineOnS: number;
  virtual?: "track-start" | "track-end";
}

/** The movement between two consecutive stops. `path` is the slice of points. */
export interface Trip {
  n: number;
  start: number;
  end: number;
  from: { lat: number; lon: number; siteId: string | null };
  to: { lat: number; lon: number; siteId: string | null };
  km: number;
  maxKmh: number;
  pointCount: number;
  path: Point[];
}

/** One or more trips merged through unknown stops, known site → known site. */
export interface Leg {
  tripNs: number[];
  fromSiteId: string;
  toSiteId: string;
  start: number;
  end: number;
  km: number;
  viaUnknownStops: number;
}

/** Something the owner should look at. Rendered by the report layer (§9). */
export type Finding =
  | { kind: "unknown-stop"; arrive: number; depart: number; lat: number; lon: number; durationS: number }
  | { kind: "detour"; leg: Leg; referenceKm: number; ratio: number }
  | { kind: "outside-hours"; start: number; end: number; km: number };

/** The whole of one Bangkok day, unrounded — the report layer does the rounding. */
export interface DaySummary {
  ymd: string;
  pointCount: number;
  firstPointAt: number | null;
  lastPointAt: number | null;
  km: number;
  tripCount: number;
  roundTrips: number;
  firstDeparture: number | null;
  lastArrival: number | null;
  timeAtSiteS: Record<string, number>;
  stops: Stop[];
  trips: Trip[];
  legs: Leg[];
  findings: Finding[];
}
