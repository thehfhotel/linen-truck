# ADR 0002 — Google basemap through a server-side tile proxy, dormant until a key exists

Date: 2026-09-30. Status: accepted (owner decision, 2026-09-30).
Research: `docs/research/google-map-tiles.md` (primary sources, fetched 2026-09-30).

## Context

The day page draws the route on OpenStreetMap tiles loaded straight from the
browser. The owner wants Google's basemap instead, inside Google's free tier:
**100 000 billable 2D tile requests a month**, where one billable event is one
tile request that returns a tile (session and viewport calls are not billed),
and wants a cache so usage stays low. The audience is three staff on phones and
two reception desks, so the expected volume is far below the free tier; the
budget exists to survive a runaway client, not normal use.

The Map Tiles API is a "Core Service" under the Google Maps Platform Terms,
which constrain how the tiles may be fetched, stored and combined.

## Decision

**1. A server-side proxy, not a browser tile layer.** Leaflet stays. The
browser loads `/tiles/{z}/{x}/{y}` from OUR origin (Access-gated like every
other route); the server calls the Map Tiles API with a server-held key and a
session token. Reasons:

- **The key never leaves the server.** A browser layer would put it in every
  page and every tile URL, and the box's egress address is not fixed, so an IP
  restriction on the key is impractical (the research note, Q6). The proxy is
  the "secure your app using a proxy server" arrangement Google's own key guide
  names for that case.
- **A hard cap we control.** Every upstream tile request is counted per Bangkok
  day before it is made; at `TILE_DAILY_CAP` (default 2 500) the route answers
  503 `tile-budget`. A browser-side layer has no such stop.
- **A cache we control**, below.

**2. No OpenStreetMap anywhere in Google mode, not even as a fallback.** Terms
3.2.3(e): the customer "will not use the Google Maps Core Services with or near
a non-Google Map in a Customer Application". Whether swapping the whole
basemap to OSM when Google is unavailable would pass is unresolvable from the
text, so we do not ask the question: in Google mode the page has no OSM layer,
its CSP does not even permit the OSM tile host, and its script does not contain
the OSM URL. Over the cap, or on an upstream error, the route and stops stay
drawn on a blank basemap and a note ("Basemap paused …") shows. The route is the
product; the basemap is decoration.

**3. Cache only as Google's `Cache-Control` allows.** Terms 3.2.3(b) forbid
caching except as expressly permitted, and the Service Specific Terms have no
Map Tiles clause; the only permission is the Map Tiles policies' "your client
must respect the max-age value, the stale-while-revalidate value, the
must-revalidate directive, and the private directive". So a 200 is stored on
disk only when it is not `no-store`, not `private`, has `max-age > 0` and (our
own extra strictness) is not `no-cache`; it is served again only while
`now < expires_at`; **a stale tile is never served**. A stale tile with an ETag
is revalidated with `If-None-Match` (a 304 refreshes it); without one it is
refetched. Nothing is pre-fetched or bulk-downloaded (3.2.3(a)(ii)): tiles are
cached lazily, on demand, only. Bytes live on disk under `DATA_DIR/tiles`, never
in SQLite, so the nightly `VACUUM INTO` backups stay small; the disk is bounded
at 200 MiB, oldest first. Google's real Cache-Control values are not documented
anywhere we could reach, so `GET /api/map/status` reports the last upstream
response's headers: the first real answer tells us whether the cache buys
anything (if Google sends `private`, it buys nothing and the cap is the only
saving).

**4. Dormant without a key.** `GOOGLE_MAPS_KEY` empty means Google is off and the
day page behaves exactly as it did before: the same OSM layer, the same CSP,
byte for byte. The change deploys with the secret unset; the owner adds
`TRUCK_GOOGLE_MAPS_KEY` later and the next deploy turns it on. The CI payload
step already drops empty values.

**5. Attribution and Terms notices are part of the feature.** The Google Maps
logo (the official asset, unmodified, embedded as a data URI) sits bottom-left,
18 px high with the required clear space, never overlapping Leaflet's
attribution; the viewport `copyright` string is fetched (debounced) on every
move and shown in the attribution control; and a footer line links Google's
Terms and Privacy Policy (3.2.2(a)(i)).

## Consequences

- **The owner sets the outer cap in Google Cloud**, not in this repo: a quota
  override on the Map Tiles API's "2D Tiles requests per day per project" of
  **3 000/day** (about 93 000 a month, under the 100 000 free tier). Google's
  default is now 100 000 a day (release note of 21 May 2026), which is the whole
  monthly free tier in one day and protects nothing. Budgets alert but do not
  cap. The in-app cap (2 500) sits below that override on purpose, so the app
  stops first and Google's cap is the backstop. Billing must be enabled on the
  project; a budget alert and quota alerts are recommended.
- The key should be restricted to the Map Tiles API. The box's egress address is
  not fixed, so no application (IP) restriction is set.
- A 304 may count as a billable request; Google does not say. The app counts a
  conditional request like any other (it is an upstream request), which is the
  safe direction.
- One more thing to keep true: the `AIza…` key class is in
  `scripts/check-no-secrets.sh`, and the value lives only in the
  `TRUCK_GOOGLE_MAPS_KEY` secret and the box's `.env`.
- Open items only a real key can settle are listed at the end of the research
  note (real Cache-Control, 304 billing, Thai labels at Surat Thani, the quota's
  machine name and reset time). Record what `/api/map/status` shows in the
  research note once the key exists.
