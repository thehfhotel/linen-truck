# linen-truck — CONTRACTS (rev 3, 2026-09-05 — HF Ville box, public repo)

The locked interface spec for the linen-truck audit service. Every implementer reads this first.
Style, stack and conventions mirror `~/HF/guest-feedback` (Bun 1.3 + Elysia + bun:sqlite, one container on
evergreen, estate-ci deploy). When this file and guest-feedback disagree, this file wins for THIS repo.

## 0. Identity & conventions (rev 2 — HFVILLE box, owner decision 2026-09-05)
- Repo `thehfhotel/linen-truck` (PUBLIC, branch `main`), local `~/HF/linen-truck`. App name **`truck`**.
- Runs on the **HF Ville box** (SSH target and addresses live in the PRIVATE ops note `hf-network/hf-hotel/linen-truck-ops.md` and in the secret `HFVILLE_SSH_TARGET`;
  docker is the only passwordless sudo, no /srv, no systemd units we can install). Same deploy shape as `~/HF/ev-charging-hotel`:
  GitHub Actions builds the image, then SSHes through the hfville Cloudflare tunnel (`cloudflared access ssh`, service token
  `truck-ci`) to a home-dir forced-command shim `~/deploy-truck/run-deploy.sh`. Deploy dir `~/deploy-truck/app`, SQLite on the host
  at `~/deploy-truck/app/data/truck.db` (bind mount `./data:/data`), logs `~/deploy-truck/logs/`.
- Image `ghcr.io/thehfhotel/linen-truck` (tags: full sha + latest + buildcache), container `truck`, port **4100** published on
  `0.0.0.0:4100` (the tunnel reaches it on loopback; hf-mcp on evergreen reaches it over the estate's site-to-site link; the exact URL is hf-mcp's `TRUCK_FEED_URL` env, recorded in the private ops note).
  Port 4100 was chosen because it is free on the box (the taken ports are listed in the private ops note).
- Hostname **`truck.thehfhotel.org`** on the HF Ville box's Cloudflare tunnel (tunnel id in the private hf-erp script), as-code in
  `hf-erp/infra/cloudflare/truck-ville.ts` (rooms-ville.ts pattern; NOT in hostnames.json): whole hostname behind one Access app
  "HF truck" whose policies mirror the LIVE `housekeeping.thehfhotel.org` root app (HF Managers + the two reception kiosks, Google silent),
  ingress `truck.thehfhotel.org → http://localhost:4100` with origin-side aud pin (defense in depth). `/healthz` is therefore NOT public;
  deploy verification uses the shim's loopback healthz loop, and verify-live.sh checks the edge redirect + the feed via evergreen.
- Everything else unchanged from rev 1: Bun 1.3 + Elysia + bun:sqlite, TypeScript strict with `.ts` imports, `elysia` the only dependency,
  Asia/Bangkok, config.ts the only process.env reader, no notifications in rev 1, /healthz database-free.

## 1. Environment variables (config.ts; empty means off)
| var | default | meaning |
|---|---|---|
| NODE_ENV | | `production` in the container; boot throws if not production while DATA_DIR === `/data` (same guard as feedback) |
| PORT | 4100 | |
| TZ | Asia/Bangkok | |
| DATA_DIR | /data | `truck.db`, `backups/` |
| PUBLIC_URL | https://truck.thehfhotel.org | origin for CSRF/links |
| GIT_SHA | unknown | echoed by /healthz |
| SINOTRACK_SERVER | https://242.sinotrack.com | cluster server that hosts the account |
| SINOTRACK_USER | | device login (the 10-digit device ID). Empty → poller dormant (logged once) |
| SINOTRACK_PASSWORD | | |
| SINOTRACK_TEID | = SINOTRACK_USER | device id queried |
| POLL_INTERVAL_SECONDS | 600 | |
| POLL_WINDOW_HOURS | 48 | Proc_GetTrack window per poll (device keeps ~1 day; 48 h covers outages) |
| CF_ACCESS_TEAM_DOMAIN | laikaexpress.cloudflareaccess.com | |
| CF_ACCESS_AUD | | Access app audience for truck.thehfhotel.org. Empty → every page/API answers 503 (fail-closed) |
| FEED_TOKEN | | bearer for `/feed/*`. Empty → `/feed/*` answers 404 |
| TRUSTED_PROXY_CIDRS | 127.0.0.1/32,172.16.0.0/12 | cloudflared runs on the box itself; same semantics as feedback |
| BACKUP_TIME | 02:35 | Bangkok wall-clock for the in-process nightly `VACUUM INTO DATA_DIR/backups/truck-<stamp>.db` (keep 14). Empty → off. No host timer on this box. |
| ALLOW_DEV_AUTH | | dev only, exactly the feedback rules (never with a configured audience, never in production) |

Production values arrive through the deploy payload `.env` rendered by CI from repo secrets (§11); nothing is baked into the image or the compose file. `SINOTRACK_SERVER` must be https (boot throws otherwise).

## 2. Checked-in config (`config/`, shipped in the image)
`config/sites.json`
```json
[
  { "id": "hf",      "name": { "th": "โรงแรม HF",  "en": "HF Hotel" }, "lat": 9.1442868, "lon": 99.3245632, "radiusM": 600 },
  { "id": "hfville", "name": { "th": "HF Ville",   "en": "HF Ville" }, "lat": 9.1213396, "lon": 99.3516676, "radiusM": 600 }
]
```
`config/rules.json`
```json
{ "stopRadiusM": 120, "minStopS": 180, "mergeHopM": 300, "unknownStopMinS": 180,
  "movingKmh": 5, "schedule": { "start": "12:00", "end": "16:00" },
  "detourRatio": 1.25, "referenceKm": { "hf|hfville": 4.9 },
  "engineOnVolts": 13.2, "engineHoldS": 300, "jitterRadiusM": 600 }
```
`referenceKm` keys are the two site ids sorted and joined with `|`. Owner tunes these files; no UI.

## 3. Domain (`src/domain/`, pure, no IO, no Date.now, unit-tested against `test/fixtures/2026-09-05.raw.json`)
```ts
// src/domain/types.ts
export interface Point { t: number; lat: number; lon: number; speed: number; voltage: number | null } // t = epoch seconds
export interface Site { id: string; name: { th: string; en: string }; lat: number; lon: number; radiusM: number }
export interface Rules { stopRadiusM: number; minStopS: number; mergeHopM: number; unknownStopMinS: number; movingKmh: number;
  schedule: { start: string; end: string }; detourRatio: number; referenceKm: Record<string, number>; engineOnVolts: number;
  engineHoldS: number; jitterRadiusM: number }
export interface Stop { arrive: number; depart: number; lat: number; lon: number; siteId: string | null;
  engineOnS: number; virtual?: 'track-start' | 'track-end' }
export interface Trip { n: number; start: number; end: number; from: { lat: number; lon: number; siteId: string | null };
  to: { lat: number; lon: number; siteId: string | null }; km: number; maxKmh: number; pointCount: number; path: Point[] }
export interface Leg { tripNs: number[]; fromSiteId: string; toSiteId: string; start: number; end: number; km: number; viaUnknownStops: number }
export type Finding =
  | { kind: 'unknown-stop'; arrive: number; depart: number; lat: number; lon: number; durationS: number }
  | { kind: 'detour'; leg: Leg; referenceKm: number; ratio: number }
  | { kind: 'outside-hours'; start: number; end: number; km: number }
export interface DaySummary { ymd: string; pointCount: number; firstPointAt: number | null; lastPointAt: number | null;
  km: number; tripCount: number; roundTrips: number; firstDeparture: number | null; lastArrival: number | null;
  timeAtSiteS: Record<string, number>; stops: Stop[]; trips: Trip[]; legs: Leg[]; findings: Finding[] }
```
```ts
// src/domain/geo.ts
export function haversineM(a: {lat:number;lon:number}, b: {lat:number;lon:number}): number
export function siteAt(p: {lat:number;lon:number}, sites: Site[]): Site | null   // nearest site within its radiusM
export function mapUrl(lat: number, lon: number): string  // https://www.google.com/maps?q=<lat5>,<lon5>
// src/domain/engine.ts
export function engineOnMask(points: Point[], rules: Rules): boolean[]   // one flag per point, in order
// src/domain/segment.ts
export function cleanPoints(raw: Point[]): Point[]      // sort by t, drop duplicate t (keep first), drop lat==0||lon==0
export function segment(points: Point[], sites: Site[], rules: Rules): { stops: Stop[]; trips: Trip[]; legs: Leg[] }
// src/domain/audit.ts
export function audit(ymd: string, seg: ReturnType<typeof segment>, points: Point[], sites: Site[], rules: Rules): Finding[]
// src/domain/summary.ts
export function summarizeDay(ymd: string, points: Point[], sites: Site[], rules: Rules): DaySummary
// src/domain/sinotrackRow.ts
export function pointFromRow(row: Record<string, string>): Point | null  // raw platform row → Point (parses Voltages= from strOther)
```
Rules (proven in the Python prototype, 2026-09-05):
1. ENGINE STATE (`engineOnMask`): a point is ENGINE-ON iff some point of the day carries voltage ≥ `engineOnVolts`
   within ±`engineHoldS` seconds of it — a SYMMETRIC hold (the domain is an offline batch over a finished day, so
   non-causal is fine, and the charging line dips for a single fix under load). A day with no non-null voltage
   anywhere is entirely ENGINE-ON: null is unknown, never "off", so a point source without voltage is never declared
   parked all day (its settled points still take the wide radius — see the CONSEQUENCE below).
   A point is MOVING iff ENGINE-ON AND `speed > movingKmh`; otherwise it is SETTLED. Neither signal is usable alone:
   a parked tracker invents 5–107 km/h, and a truck warming up idles at a driving voltage without moving.
   STOP = run of consecutive points all within `stopRadiusM` of the run's first point, lasting ≥ `minStopS` — widened
   for scatter between two SETTLED points, because a parked tracker scatters its fixes (HF Ville 2026-09-06: p50 138 m,
   p90 333 m, p95 496 m, max 571 m from the CENTRE) and reports those bogus speeds with them.
   Precisely: extend the run to point j+1 while
   `(MOVING(anchor) || MOVING(j+1)) ? haversine(anchor, j+1) ≤ stopRadiusM
   : (haversine(anchor, j+1) ≤ jitterRadiusM || (!engineOn(j+1) && siteAt(j+1) !== null && siteAt(j+1).id === siteAt(anchor)?.id))`.
   The tight bound binds as soon as EITHER end of the comparison is MOVING, for two different reasons.
   A MOVING CANDIDATE: the tight bound exists for exactly one failure — a slow crawl through the sois reading as one
   long stop — and a point that reports no speed under a live engine cannot be that crawl, while a truck warming up
   scatters ~180 m with the engine already running (the fixture restarts at 13:32:44 and 13:34:15 read 0 km/h at 177 m
   and 120 m from the arrival anchor, and the truck only pulls away at 13:35:15 at 37 km/h). Holding those to
   `stopRadiusM` ended the HF Ville stop eleven minutes before the truck left, so a settled pair gets `jitterRadiusM`.
   A MOVING ANCHOR: the anchor is not merely a bound, it IS the stop — `lat`/`lon` are the arrival pin and, through
   `siteAt`, the site label. A run opened on a fix taken at 30 km/h on the approach road would otherwise reach 600 m
   forwards and swallow the parking place it was driving towards, reporting the arrival a cadence early with the pin
   out on the road; a truck parked 540 m from the HF centre (measured 2026-09-06) anchored 500 m further out reads
   1 040 m from the centre, outside the fence, and the day reports an unknown stop — the exact mislabel the 600 m fence
   exists to remove. CONSEQUENCE: a run anchored on a MOVING point can only hold points within `stopRadiusM`, so it
   either dies under `minStopS` or ends at the first parked point beyond `stopRadiusM`, and the parked cluster then
   anchors on its OWN first point with the wide bound. Where such a tight run does last ≥ `minStopS`, rule 2 merges it
   into the following wide run exactly as it always did.
   The same-fence half is for ENGINE-OFF candidates only, and the engine-off arm needs BOTH halves: the scatter is
   measured from the site centre, so two engine-off fixes can be ~1 140 m apart (+571 and −520) and an anchor-relative
   bound alone would hold the evening together only when the first fix of the run happened to land near the centre —
   rotate which fix leads and the same twenty places split into up to five stops, four trips and ~2.3 km nobody drove.
   The same-fence half is centre-relative and fixes that. A settled ENGINE-ON point gets the anchor-relative
   `jitterRadiusM` and not the fence: it is a truck about to move, not a truck that has been sitting there all evening.
   Every arm is a bound, not a licence (`jitterRadiusM` 600 m, the fence 600 m), so a km-scale relocation between two
   engine-off fixes stays two stops and a trip.
   CONSEQUENCE, deliberate: on a day with NO voltage at all every point is ENGINE-ON (see above), so MOVING collapses to
   `speed > movingKmh` and the speed signal alone decides; a pair of points that both report no speed takes
   `jitterRadiusM`, where the tight bound used to apply throughout. Such a day is not left byte-identical to the
   pre-rule-1 behaviour. That is an improvement, not a regression: a voltage-less day loses the engine signal, not the
   speed signal, and a settled point 300 m from a settled anchor is parked scatter there for the same reason it is here.
   `siteId` = `siteAt(anchor)`. `engineOnS` = sample-and-hold: the sum of the gaps between consecutive fixes of the run whose EARLIER fix has voltage ≥ `engineOnVolts` (a null voltage never counts; 0 if no voltage data).
2. Merge consecutive stops with the same `siteId` (not null) when the hop between their anchors < `mergeHopM` AND the haversine travel over the points between them is also < `mergeHopM` (yard shuffle only — an out-and-back run with no far-end stop is never swallowed).
3. Virtual stop at the first point (`track-start`) if the day does not begin inside a stop; virtual `track-end` at the last point if
   the day does not end inside a stop (still moving).
4. TRIP n = points from stop[i].depart index to stop[i+1].arrive index; km = haversine sum; maxKmh = max speed.
5. LEG = consecutive trips merged through stops whose `siteId` is null, so each leg runs known site → known site.
   Trips that begin or end at a virtual stop or never reach a known site form no leg.
6. Findings: `unknown-stop` for a non-virtual stop with `siteId === null` and duration ≥ `unknownStopMinS`;
   `detour` for a leg whose `referenceKm[sorted pair]` exists and `km / referenceKm > detourRatio`;
   `outside-hours` for maximal runs of MOVING points — speed > `movingKmh` AND ENGINE-ON, because a parked tracker's
   speed is jitter, not a journey — with Bangkok wall-clock outside [schedule.start, schedule.end); runs split when the
   gap between moving points > 600 s; km = haversine within the run. `maxKmh` on a trip is unaffected (trips are
   between stops, so a trip already means the truck went somewhere).
   KNOWN BLIND SPOT, accepted deliberately: this is the only unauthorised-use detector and it now depends entirely on the
   charging line. A tracker running on its internal battery (failed charging line, feed pulled) reads 12.x V all day, so
   every point is ENGINE-OFF and NO outside-hours finding is raised, while trips and km are still reported. The
   all-null inertness escape hatch does not cover it — a partial voltage outage is ENGINE-OFF, not unknown. A
   displacement-based compensator was considered and rejected for now: parked scatter spans up to ~1 140 m, so any
   threshold small enough to catch a short night errand also re-fires on a parked evening. The signal to watch is a day
   whose voltage never reaches `engineOnVolts` yet still reports kilometres; treat that as a tracker fault, not a quiet
   day.
7. `roundTrips` = min(#legs hf→hfville, #legs hfville→hf). `firstDeparture` = the first trip's start (equivalently the first stop's
   departure, virtual book-end included), null on a day with no trip; `lastArrival` = arrive of the last non-virtual stop. `timeAtSiteS` sums non-virtual stop durations per site.
8. Day window = Bangkok [00:00, 24:00) of `ymd`; points outside are ignored by `summarizeDay`.
Expected on the fixture (rules above, sites above): 82 points after cleaning; 5 stops — a `track-start` book-end, then
hfville 12:24–13:34, hf 13:48–14:06, hfville 14:18–14:22 and hfville 14:26–15:11; 4 trips totalling 15.35 km; legs:
[hfville→hf (trip 2, 4.76 km), hf→hfville (trip 3, 6.74 km), hfville→hfville (trip 4, 0.37 km), all viaUnknownStops 0];
findings = 1 × detour (leg hf→hfville, ratio ≈ 1.38), 0 × unknown-stop — the 14:18–14:22 stop sits 368 m from the HF Ville
centre, inside the 600 m fence, and its 381 m hop to the 14:26 stop is ≥ `mergeHopM`, so the two stay separate — and
0 × outside-hours. Trip 1 (unlabelled start → hfville, 3.48 km) forms no leg. `roundTrips` 1, `timeAtSiteS`
{ hfville 7110, hf 1080 }. The morning stop ends at 13:34:15, the last fix before the truck reports movement: the
13:32:44 and 13:34:15 engine restarts are SETTLED (speed 0), so rule 1 holds them as scatter, not as a departure.

## 4. SinoTrack client (`src/server/sinotrack.ts`) — port of the proven Python client
- `POST {server}/APP/AppJson.asp` form-urlencoded fields `strAppID, strUser, nTimeStamp, strRandom, strSign, strToken`; no cookies.
- `strAppID = base64(host lowercased, http(s):// stripped, '/'-padded until length % 3 == 0)`
- `strToken = base64(cmd + '\x11' + data + '\x11' + field + '\x11' + '\x1b', padded with pad digits until length % 3 == 0)`
- `strSign = md5(String(nTimeStamp) + strRandom + strUser + strAppID + strToken)` (hex lowercase; `Bun.CryptoHasher('md5')`)
- `data = args.map(a => "N'" + String(a).replace(/'/g, "''") + "'").join(',')`
- Response JSON `{ m_isResultOk: 0|1, m_arrField: string[], m_arrRecord: string[][] }` → `records()` zips to objects.
- Inject `{ now(): number, random(): string, pad(): string }` so `test/fixtures/sign-vector.json` reproduces exactly.
- Exposed calls: `getLoginType(user, pwd)`, `getCarInfo(user)`, `getLastPosition(user)`, `getTrack(teid, fromS, toS, limit=1e6)`,
  `getMileageEveryDay(teid, fromS, toS)`, `getObd(teid, fromS, toS)` (`Proc_GetOBD` args `[0, teid, from, to, 1e6]`, fields `strOBD`).
- 20 s timeout per call; errors thrown as `SinotrackError` with the proc name; never log the password.

## 5. Storage (`src/server/db.ts`, bun:sqlite, WAL, PRAGMA user_version migrations like feedback)
```sql
CREATE TABLE points (teid TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, speed INTEGER NOT NULL,
  direction INTEGER, mileage_m INTEGER, car_state INTEGER, te_state INTEGER, alarm_state INTEGER, voltage REAL, other TEXT,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, t)) WITHOUT ROWID;
CREATE TABLE device_status (teid TEXT PRIMARY KEY, t INTEGER, lat REAL, lon REAL, speed INTEGER, mileage_m INTEGER,
  voltage REAL, park_since INTEGER, run_since INTEGER, fetched_at INTEGER NOT NULL);
CREATE TABLE daily_mileage (teid TEXT NOT NULL, ymd TEXT NOT NULL, mileage_m INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, ymd));
CREATE TABLE obd_rows (teid TEXT NOT NULL, t INTEGER NOT NULL, obd TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (teid, t));
CREATE TABLE poll_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, points_seen INTEGER, points_new INTEGER, error TEXT);
```
Points are `INSERT OR IGNORE` (first observation wins). Raw rows are kept forever (~300/day). `poll_log` keeps the newest 2000 rows.
Repository functions: `insertPoints(rows)`, `pointsForDay(teid, ymd)` (Bangkok day), `pointsBetween(teid, fromS, toS)`,
`upsertDeviceStatus`, `upsertDailyMileage`, `insertObdRows`, `logPoll`, `latestPoll()`.

## 6. Poller (`src/server/poller.ts`)
- Starts 5 s after boot when SINOTRACK_USER/PASSWORD are set; every `POLL_INTERVAL_SECONDS`; never overlaps (in-flight flag); never throws.
- Each cycle: `getTrack(now - POLL_WINDOW_HOURS*3600, now)` → insertPoints; `getLastPosition` → device_status; `getObd(window)` → obd_rows;
  once per hour also `getMileageEveryDay(now - 60 d, now)` → daily_mileage. Logs one line per cycle: `poll ok seen=<n> new=<n> ms=<n>` or `poll fail <proc>: <msg>`.
- Status object (in memory) for /healthz: `{ configured, lastAt, lastOk, lastError, lastSeen, lastNew }`.

## 7. HTTP surface (`src/server/app.ts` → `createApp(db, deps)`; `src/server/server.ts` = Bun.serve entry, same split as feedback)
Auth: every route except `/healthz` and `/feed/*` requires a valid `Cf-Access-Jwt-Assertion` (auth.ts copied from feedback with
`CF_ACCESS_AUD`; empty audience → 503). `/feed/*`: answer 404 when the request carries `Cf-Ray` or `CF-Connecting-IP`
(internal only, never via Cloudflare), else require `Authorization: Bearer <FEED_TOKEN>` (constant-time compare), 401 otherwise.
| route | response |
|---|---|
| GET /healthz | `{ ok:true, commit, time, staffAuth:'configured'|'missing', feed:'on'|'off', poller:{configured,lastAt,lastOk,lastError,lastSeen,lastNew} }` |
| GET / | 302 → `/day/<today ymd>` |
| GET /day/:ymd | HTML day report (see §8) |
| GET /week/:ymd | HTML 7-day table ending at ymd |
| GET /api/day/:ymd | DayReport JSON (§9) — used by the page's map script |
| GET /api/week/:ymd | `{ days: DayReport[] }` 7 days ending at ymd (summary fields only, no trips/stops/path) |
| GET /feed/daily?date=YYYY-MM-DD | DayReport JSON (§9), bearer-gated, internal only |
| GET /feed/range?from=&to= | `{ days: DayReport[] }` inclusive, max 62 days, summary fields only |
| GET /robots.txt | `Disallow: /` |
Invalid ymd → 400 JSON `{error:'bad-date'}`. Unknown route → 404.

## 8. Pages (server-rendered HTML strings in `src/server/pages/*.ts`, no framework, Thai primary with English secondary text)
Day page: header (date, prev/next day, week link), device line (last seen, voltage, moving/parked), summary tiles
(km, trips, round trips HF↔HF Ville, first departure, last arrival, time at HF, time at HF Ville), **findings** list first
(unknown stops with Google Maps link + duration; detours with leg, km vs reference; outside-hours ranges), trips table
(n, start→end, minutes, km, max km/h, from → to), stops table (arrive–depart, minutes, site or map link, engine-on minutes),
a Leaflet map (CDN, integrity-pinned) drawing the day's path + site circles + stop markers, fed by `/api/day/:ymd`.
Week page: one row per day (date link, km, trips, round trips, first departure, last arrival, findings by kind, points).
Labels live in `src/shared/labels.ts` as `{ th, en }` pairs (`L`), rendered as "ไทย · English".
Branding: HF One staff burgundy like feedback's /staff (not the crimson guest palette). Mobile-first, works on a phone.

## 9. DayReport JSON (shared by /api/day, /feed/daily; times as Bangkok `HH:MM`, epochs as `*At` seconds)
```json
{ "date": "2026-09-05", "tz": "Asia/Bangkok", "generatedAt": 1788600000,
  "device": { "teid": "1000000001", "lastSeenAt": 1788595367, "voltage": 12.7, "moving": false, "online": true },
  "summary": { "km": 15.4, "tripCount": 4, "roundTrips": 1, "firstDeparture": "12:11", "lastArrival": "14:26",
               "timeAtSiteMin": { "hf": 18, "hfville": 118 }, "pointCount": 82, "findingCount": { "unknown-stop": 0, "detour": 1, "outside-hours": 0 } },
  "trips": [ { "n": 1, "start": "12:11", "end": "12:24", "minutes": 13, "km": 3.5, "maxKmh": 44, "from": null, "to": "hfville",
               "fromMapUrl": "…", "toMapUrl": "…" } ],
  "stops": [ { "arrive": "12:24", "depart": "13:34", "minutes": 70, "site": "hfville", "lat": 9.12223, "lon": 99.35179, "mapUrl": "…", "engineOnMin": 5 } ],
  "legs":  [ { "trips": [3], "from": "hf", "to": "hfville", "km": 6.7, "referenceKm": 4.9, "ratio": 1.38 } ],
  "findings": [ { "kind": "unknown-stop", "text": { "th": "จอดที่ไม่รู้จัก 4 นาที (14:18–14:22)", "en": "Unknown stop 4 min (14:18–14:22)" }, "mapUrl": "…", "minutes": 4, "start": "14:18", "end": "14:22" },
                { "kind": "detour", "text": { "th": "…", "en": "…" }, "trips": [3], "from": "hf", "to": "hfville", "km": 6.7, "referenceKm": 4.9, "ratio": 1.38 },
                { "kind": "outside-hours", "text": { "th": "…", "en": "…" }, "start": "…", "end": "…", "km": 0 } ],
  "path": [ [9.14791, 99.33564, 1788585074], … ],
  "dataQuality": { "lastPollAt": 1788599000, "lastPollOk": true, "note": null } }
```
The three finding entries above are a SHAPE catalogue: the 2026-09-05 fixture itself raises only the detour (see §3).
`/api/week` and `/feed/range` return the same objects without `trips`, `stops`, `legs`, `path` (findings kept).
Additive since 2026-09-05 (map filtering): trips also carry `startAt`/`endAt` (epoch s), stops `arriveAt`/`departAt`,
unknown-stop findings `stopIndex` (index into `stops`), outside-hours findings `startAt`/`endAt`. Day page selection is
mirrored in the URL hash (`#all`, `#trip-N`, `#trip-N-M` for a detour leg, `#stop-I`) and applied on load.
Rounding happens only in the report layer: km to 1 dp, ratio to 2 dp of the unrounded quotient, minutes floored.

## 10. Scripts (rev 2)
- `scripts/import.ts`, `scripts/backup.ts` unchanged (backup.ts is also what the in-process scheduler calls; `docker exec truck bun scripts/backup.ts` works ad hoc).
- `scripts/deploy/run-deploy.sh` — copy of the evcharge home-dir shim (`~nut/deploy-evcharge/run-deploy.sh` on the box, quoted in docs/runbooks): flock, 4 MB payload cap,
  payload `{commit_sha, deploy_payload_b64, ghcr:{user,token}, env:{…}}`, extract compose into `~/deploy-truck/app`, write `.env` (0600) from `env`, `docker compose pull` (5 retries),
  `docker compose up -d --remove-orphans`, then poll `http://127.0.0.1:4100/healthz` until `.commit == commit_sha` (30 × 2 s) else exit 1. Installed by the owner as
  `~/deploy-truck/run-deploy.sh` with authorized_keys line `command="$HOME/deploy-truck/run-deploy.sh",restrict <pubkey> truck-ci-deploy`.
- `scripts/evergreen/*` REMOVED (no systemd on hfville). `scripts/hfville/install.sh` — run BY THE OWNER over ssh to the box (alias in the private ops note): creates `~/deploy-truck/{app,logs}`,
  installs run-deploy.sh, appends the forced-command key line (idempotent), prints the box host key rewritten to the hostname carried by `HFVILLE_SSH_TARGET` for the `HFVILLE_HOST_KEY` secret.
- `scripts/owner/go-live.sh` — owner recipe, in order: (1) `gh repo create thehfhotel/linen-truck --public --source ~/HF/linen-truck --push` (from a single scrubbed root commit);
  (2) in `~/HF/hf-erp`: `bun infra/cloudflare/truck-ville.ts --apply` → creates the service token `truck-ci` (prints client id/secret ONCE), the reusable non_identity policy,
  attaches it to the box's SSH Access app (id in the private hf-erp script), creates Access app "HF truck" on truck.thehfhotel.org (prints aud), proxied CNAME, tunnel ingress rule;
  (3) `ssh-keygen -t ed25519 -f ~/.ssh/truck-ci-deploy -N '' -C truck-ci-deploy`; `scripts/hfville/install.sh` via ssh; (4) `gh secret set` for
  `TRUCK_DEPLOY_SSH_KEY`, `HFVILLE_HOST_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `TRUCK_CF_ACCESS_AUD`, `TRUCK_FEED_TOKEN` (openssl rand -hex 32),
  `TRUCK_SINOTRACK_USER`, `TRUCK_SINOTRACK_PASSWORD`; (5) commit hf-erp files with explicit pathspecs (`infra/cloudflare/truck-ville.ts src/modules.ts public/shell/hf-bar.js`) and push;
  (6) on evergreen append `TRUCK_FEED_URL=<site-to-site URL from the private ops note>` and `TRUCK_FEED_TOKEN=<same>` to hf-mcp's host-managed .env, recreate hf-mcp with its shim's compose file set, then
  `docker exec hf-mcp` a fetch of `/feed/daily` to prove cross-site reachability; (7) `gh variable set TRUCK_DEPLOY_ENABLED --body 1`, `gh workflow run deploy.yml`, `gh run watch`,
  `scripts/verify-live.sh <sha>`; (8) `bun scripts/import.ts` the Mac archive JSONs into the box DB (scp them to `~/deploy-truck/app/data/import/` first, run inside the container).
- `scripts/verify-live.sh [sha]` — from the Mac: `https://truck.thehfhotel.org/` and `/day/<today>` and `/healthz` must all redirect to cloudflareaccess.com (never 200 unauthenticated);
  `ssh <box> 'curl -s http://127.0.0.1:4100/healthz'` (alias from the private ops note) must show `ok:true`, `commit == sha`, `poller.configured true`, `staffAuth configured`, `feed on`;
  on evergreen `curl -s -o /dev/null -w %{http_code} $TRUCK_FEED_URL/healthz` must be 200; `/feed/daily` from evergreen without a bearer must be 401.

## 11. CI/CD (rev 2 — evcharge shape, not estate-ci)
`.github/workflows/ci.yml`: unchanged (setup-bun SHA-pinned, `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`) on push + PR.
`.github/workflows/deploy.yml`: on push to main + workflow_dispatch; job `ci` (same steps); job `deploy-hfville` needs ci, `if: vars.TRUCK_DEPLOY_ENABLED == '1'`,
concurrency `deploy-hfville-linen-truck`, steps copied from `~/HF/ev-charging-hotel/.github/workflows/deploy.yml` with the SAME action SHA pins: buildx, ghcr login,
metadata (sha long + latest), build-push (`platforms: linux/amd64`, build-arg `GIT_SHA`, registry buildcache), render `deploy.env` from secrets
`TRUCK_CF_ACCESS_AUD→CF_ACCESS_AUD`, `TRUCK_FEED_TOKEN→FEED_TOKEN`, `TRUCK_SINOTRACK_USER→SINOTRACK_USER`, `TRUCK_SINOTRACK_PASSWORD→SINOTRACK_PASSWORD`,
plus constants `SINOTRACK_SERVER=https://242.sinotrack.com`, `PUBLIC_URL=https://truck.thehfhotel.org`, `TRUCK_SHA=${GITHUB_SHA}`; gate step refusing `ALLOW_DEV_AUTH` in the payload;
pinned cloudflared install (same version + sha256 as evcharge); SSH key + known_hosts from `TRUCK_DEPLOY_SSH_KEY` / `HFVILLE_HOST_KEY`; payload = tar of `docker-compose.hfville.yml`
renamed `docker-compose.yml` + env JSON, piped to `${{ secrets.HFVILLE_SSH_TARGET }}` through `cloudflared access ssh --service-token-id ${{ secrets.CF_ACCESS_CLIENT_ID }} --service-token-secret ${{ secrets.CF_ACCESS_CLIENT_SECRET }}`.
`Dockerfile`: `ARG GIT_SHA` baked as `ENV GIT_SHA` (evcharge style) so /healthz reports the built commit without the compose env; otherwise as rev 1 (no build step).
`docker-compose.hfville.yml` (shipped as the box's docker-compose.yml): service `truck`, `image: ghcr.io/thehfhotel/linen-truck:${TRUCK_SHA:-latest}`, `container_name: truck`,
`restart: unless-stopped`, `ports: ["4100:4100"]`, environment NODE_ENV=production, TZ, PORT=4100, DATA_DIR=/data, PUBLIC_URL, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, FEED_TOKEN,
SINOTRACK_SERVER/USER/PASSWORD/TEID, POLL_INTERVAL_SECONDS, BACKUP_TIME; volume `./data:/data`; json-file logging 10m×3; limits memory 256M cpus 0.5.
The plain `docker-compose.yml` stays for local runs (build from Dockerfile, `image: truck:local`).

## 12. Consumers outside this repo (rev 2)
- **hf-erp**: `infra/cloudflare/truck-ville.ts` (new, rooms-ville/ev-ville pattern + service-token creation and SSH-app policy attach, idempotent, never deletes);
  tool card in `src/modules.ts` + `public/shell/hf-bar.js` (url `https://truck.thehfhotel.org/`, internal address as the ev entry records it).
  NOT hostnames.json (foreign tunnel; `apply.ts --import` would wipe it).
- **hf-mcp**: as rev 1 but `TRUCK_FEED_URL` has NO default that names an address: unset → dormant. The value (site-to-site path, chosen for resilience after the 2026-08-22 incident) lives in hf-mcp's host .env and the private ops note.

## 13. Public repository hygiene (rev 3 — the repo is PUBLIC, owner decision 2026-09-05)
Workflow logs, code, history, issues and Actions summaries are world-readable. Rules, enforced by CI where possible:
- **Never in the repo or history:** the device ID (login), the SinoTrack password, ICCID/IMEI, any real Access app aud, tunnel IDs,
  Access app / service-token IDs, box hostnames/users for SSH, LAN/WireGuard/Tailscale IPs, the portal notify token, the feed token.
  Fixtures use the synthetic device id `1000000001` (test/fixtures/*). Hotel coordinates in config/sites.json are public business locations and stay.
- **Secrets (GitHub Actions, masked in logs):** `TRUCK_DEPLOY_SSH_KEY`, `HFVILLE_HOST_KEY`, `HFVILLE_SSH_TARGET` (user@host for the tunnel SSH hop),
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `TRUCK_CF_ACCESS_AUD`, `TRUCK_FEED_TOKEN`, `TRUCK_SINOTRACK_USER`, `TRUCK_SINOTRACK_PASSWORD`,
  `TRUCK_SINOTRACK_SERVER`, `TRUCK_PUBLIC_URL`. Repo variable (not secret, still never echoed): `TRUCK_DEPLOY_ENABLED`.
  Workflows must never `echo`/`cat`/`set -x` any rendered env; only counts (`wc -l`) may be printed. The SSH ProxyCommand line must reference secrets, never literals.
- **CI secret gates:** (a) `scripts/check-no-secrets.sh` — greps tracked files for the forbidden classes (10-digit numbers other than the synthetic id
  and epoch timestamps, `password=`/`token=` with a value, `192.168.`, `10.10.10.`, `100.64.`, `.cfargotunnel.com` with a real id, hex aud-like 64-char strings outside lockfiles)
  and exits 1 with the matching lines; runs in ci.yml before typecheck. (b) `.github/workflows/security.yml` — Trivy `fs` scan with `scanners: vuln,secret`
  and `config` scan, SHA-pinned exactly as `~/HF/ev-charging-hotel/.github/workflows/security.yml`, on push/PR/weekly, `permissions: contents: read`.
- **.gitignore** keeps `.env`, `.env.*` (except `.env.example`), `data/`, `*.db*`, `deploy.env`, `payload/`, `*.pem`, `*.key`.
  `.env.example` contains placeholders only (`SINOTRACK_USER=<10-digit device id>`).
- **Docs:** operational specifics (box IPs, tunnel IDs, Access IDs, the hfville SSH app) live in the PRIVATE `~/HF/hf-network` and `~/HF/hf-erp`
  repos; public docs refer to "the HF Ville box" and name the secret that carries each value. The owner recipe (`scripts/owner/go-live.sh`) reads
  everything from the environment or from `gh secret` prompts and never has values inlined.
- **History:** the repo is published from a single fresh root commit made after the scrub (no scaffolding history with real ids).
- **Workflow permissions:** least privilege per job (`contents: read`, `packages: write` only on the build job); no `pull_request_target`; third-party actions SHA-pinned.
- **Fork PRs:** secrets are unavailable to fork PRs by default — the deploy job runs only on `push` to `main` (never on `pull_request`).
