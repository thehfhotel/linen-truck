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
  /**
   * Seconds either side of a fix in which a fix at or above `engineOnVolts`
   * still means "the engine is running" — a symmetric sample-and-hold. The
   * charging line dips for a single fix under load (2026-09-05 13:40:45 read
   * 12.2 V at 40 km/h between two 13.8 V fixes 90 s away), and one dip must not
   * read as an engine stop.
   */
  engineHoldS: number;
  /**
   * The anchored stop radius between two SETTLED fixes — a fix is MOVING only
   * when the engine is on AND it reports `speed > movingKmh`, and both ends of
   * the comparison must be settled for this radius to apply. A parked tracker
   * scatters its fixes (measured at HF Ville on 2026-09-06: p50 138 m, p90
   * 333 m, max 571 m from the truck) and reports speeds of 5–107 km/h with it,
   * and a truck warming up scatters ~180 m before it pulls away. Wider than
   * `stopRadiusM` so that scatter stays one stop, but still a BOUND: a km-scale
   * relocation between two settled fixes is a real journey.
   */
  jitterRadiusM: number;
}

/**
 * What the ignition did inside one stop (§3 rule 1, "engine events").
 *
 * Read from the RAW voltage of the stop's own fixes, never from the held mask:
 * the hold exists so a dip under load does not read as an engine stop while the
 * truck is MOVING, and this is the opposite question — did the driver switch
 * off and wait here, or is the truck merely halted with the engine running?
 * `kind` is `unknown` only when no fix of the stop carries a voltage at all;
 * null is unknown, never "off", exactly as in `engineOnMask`.
 */
export interface StopEngine {
  /** `parked` if any reading is off, `running` if every reading is on, `unknown` with no voltage. */
  kind: "parked" | "running" | "unknown";
  /** First fix reading off — the arrival fix itself when the truck came in already off. */
  offAt: number | null;
  /** First ON reading after the LAST off-run; null if the engine was still off at the last fix. */
  onAt: number | null;
  /** Seconds in the off state, sample-and-hold like `engineOnS`. */
  offS: number;
}

/**
 * A run of points parked inside `stopRadiusM` of the run's first point —
 * `jitterRadiusM` where both that anchor and the fix are SETTLED (§3 rule 1).
 * `lat`/`lon` are that anchor, which is also the arrival pin and the site label,
 * so a run is never opened on a moving fix that then swallows a parking place. `virtual` marks the two book-ends the day gets
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
  /**
   * The stop's ignition events. The two virtual book-ends are not parked time,
   * so they carry the inert `{ kind: "unknown", offAt: null, onAt: null, offS: 0 }`.
   */
  engine: StopEngine;
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
  | {
      kind: "unknown-stop";
      arrive: number;
      depart: number;
      lat: number;
      lon: number;
      durationS: number;
      /** The stop's engine state — reported, never a trigger: the rule is unchanged (§3 rule 6). */
      engine: StopEngine["kind"];
      engineOffS: number;
    }
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
