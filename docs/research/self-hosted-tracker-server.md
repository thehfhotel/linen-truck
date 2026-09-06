# Can we run our own tracker server? — options assessment

Prepared 2026-09-06. Public-safe: no device id, no passwords, no hostnames, no IP addresses,
no tunnel/app ids. Estate-specific facts and the exact revert parameters live in the private
companion note. Everything below is read-only research — nothing was changed on any device,
box or server, and no request was sent to the vendor's cloud during this assessment.

Every factual claim carries its source inline. Anything the research could not confirm is
marked **UNVERIFIED**.

---

## (a) Short answer

**Yes, technically — the device can be redirected to a server we run, with one SMS message.**
The tracker family in question accepts an SMS command of the form `804<password> <IP> <port>`
which permanently repoints it at any endpoint and port we choose; the password is the vendor's
published factory default (see the manual) and the device replies `SET OK`
(ST-902 manual §16, https://www.softwarehousethailand.com/data/hardware/ST-902.pdf — "Command:
804+password+Blank+IP+Blank+Port / Sample: `804<password> <ip> <port>` / Reply: SET OK";
independently
corroborated by flespi's integration guide, https://flespi.com/protocols/sinotrack, and by live
use against a self-hosted Traccar server,
https://www.traccar.org/forums/topic/sinotrack-st-906l-protocol-and-gprs-commands/.
manuals.plus is behind a bot-wall (HTTP 403) and is an AI-summarised secondary source — it is
not cited here.)
The device speaks the well-documented **H02** protocol, which Traccar decodes out of the box
(H02ProtocolDecoder.java, Apache-2.0, 678 lines,
https://raw.githubusercontent.com/traccar/traccar/master/src/main/java/org/traccar/protocol/H02ProtocolDecoder.java).
**But** three constraints shape everything below: (1) **A hostname works — the "IP only" belief
is a myth.** SinoTrack ST-90xL units accept a domain name in the `804` command:
`804<password> rodyeo.dyndns.org 5013` and `804<password> demo.traccar.org 5013` are both
reported working, and the user who first claimed "IP only" publicly retracted it — the real
obstacle was his mobile carrier stripping SMS containing URLs, not the firmware
(https://www.traccar.org/forums/topic/sinotrack-st-906l-protocol-and-gprs-commands/,
https://www.traccar.org/forums/topic/traccar-server-receive-data-from-gps-tracker-and-submit-data-to-sinotrack-server-too-for-tracking/).
Practical consequences: (a) a DDNS hostname is a viable endpoint, so a dynamic ISP address is
survivable and a static IP is a convenience, not a hard requirement; (b) some carriers block SMS
containing a domain — if the SMS with a hostname does not take, send the IP form first and switch
to the hostname afterwards; (c) **UNVERIFIED** for our exact (unknown) unit and firmware — test
with a hostname before designing around one. (2) **our estate has no usable inbound path
today** — every port tested on both on-prem sites was unreachable from ~40 external checks
across five continents, and Cloudflare Tunnel/Access cannot accept a raw TCP connection from a
third-party device (https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/),
Tailscale Funnel is TLS-only on three fixed ports (https://tailscale.com/kb/1223/funnel), and
Cloudflare Spectrum for a custom TCP port is Enterprise-plan-only
(https://developers.cloudflare.com/spectrum/get-started/); and (3) **the device reports to one
server at a time** — no dual-server mode was found in any manual or forum thread, so the moment
we redirect it, the vendor's own app stops seeing the truck until we send the command back.

---

## (b) What the device would send us vs. what the vendor API gives us today

The audit only *needs* five fields. From the repo's own domain type (`src/domain/types.ts:15-21`,
`Point { t, lat, lon, speed, voltage }`) and the contract doc, everything else the vendor
returns is stored but never read by any trip/stop/finding logic — and `daily_mileage`/`obd_rows`
have no reader at all in `src/` (`getDailyMileage` has zero callers), so they are write-only today.

| Field | Vendor cloud API today | What H02 gives us direct from the device | Effect on the audit |
|---|---|---|---|
| **timestamp** | `nTime` | Device UTC clock, in every H02 sentence (decoder `PATTERN*`) | **No change.** Required; drives day windows, stop/trip timing, the 600 s gap-split. |
| **lat / lon** | `dbLat` / `dbLon` | In every H02 sentence, with an A/V validity flag | **No change.** Required; drives distance, site matching, stop geometry. |
| **speed** | `nSpeed` | In every H02 sentence | **No change.** Drives the "moving" test (5 km/h threshold) and the device-status line. |
| **voltage** | parsed out of the `strOther` blob (`Voltages=`) | **Not available through Traccar's H02 decoder at all.** The battery field in the main position pattern is explicitly non-capturing (`.number("(?:d+,)?") // battery`, H02ProtocolDecoder.java:204) and `decodeText()` never sets a battery key; the sub-variants that DO capture a battery (`PATTERN_V3` → `KEY_BATTERY` line 531, `PATTERN_LINK`/`HTBT` → `KEY_BATTERY_LEVEL` lines 488/628) are cell-info and heartbeat messages that call `getLastLocation()` and carry no fix; and the binary `$` variant reports a 0–100 **percentage** via `decodeBattery()` (lines 96–110), not volts. | **CONFIRMED LOSS under Option A, not a risk to be tested away.** `engineOnS` (≥13.2 V, sample-and-hold) cannot be computed from Traccar-decoded H02, and the day page's device line loses its voltage reading too (`src/server/report.ts:337/349` → `src/server/pages/day.ts:117`). **The ignition fallback is therefore mandatory, not a contingency:** `processStatus()` sets `KEY_IGNITION` from status bit 10 (line 92) on every text position carrying the 8-hex status word, which every realistic SinoTrack sample in Traccar's own test file does. Redefine engine-on from the ignition bit as part of the Option A work, or keep a voltage path by parsing the raw sentence ourselves (Option B), where the battery field is present on the wire even though Traccar discards it. |
| **ignition / car state** | `nCarState` | H02 status bitfield includes an ignition bit (decoder `processStatus()`, bit 10) | **Gain, arguably.** Today `nCarState` is stored and *never read* by any logic — H02's ignition bit is a real, usable signal we do not have wired up. Semantics are not a 1:1 map to the vendor's enum (**UNVERIFIED**). |
| **heading** | `nDirection` | Course in every H02 sentence | No change — stored, never read today. |
| **odometer / mileage** | `nMileage` + a daily-mileage stored proc | Odometer is an *optional trailing group* in the H02 pattern | **Loss, but inert today.** Mileage is stored and never used in any shipped finding; the roadmap marks OBD/mileage findings out of scope. |
| **alarms** | `nAlarmState`, `nTEState` | H02 status bits yield vibration, SOS, overspeed, power-cut | Roughly equivalent; neither is consumed today. |
| **park/run timestamps** | a separate richer vendor call feeds `device_status` | No equivalent | Minor loss — the report layer already has a documented fallback that derives device status from the newest point. |
| **OBD rows** | a vendor-specific stored proc | None | Loss; not consumed by any shipped logic. |
| **retention** | vendor keeps ~1 day; an outage = permanent data loss | **We keep everything, forever, as it arrives** | **The whole point.** This is the gain that motivates the exercise. |
| **latency** | up to 10 min stale (our poll cadence) | Device pushes on a configurable interval — 20 s default on ST-902 (`809<password> <seconds>`, §17, range 0–18000); the interval command's meaning is model-dependent on newer ST-90xL firmware (805 = ACC-on, 809 = ACC-off) | Gain: near-real-time, and far denser tracks. |

**Net:** the audit's core (stops, trips, distances, findings) survives intact on H02.
The single genuine functional loss is **engine-on minutes**: Traccar's H02 decoder discards the
position battery field outright, so engine-on must be re-derived from the H02 ignition bit (or
the raw sentence parsed in-house). That is planned work, not a risk to be tested away.

---

## (c) The four options

### Option A — Traccar self-hosted, linen-truck consumes its API

Traccar is the production-grade choice: Apache-2.0, 7,697 stars, last pushed 2026-09-04, active
(https://api.github.com/repos/traccar/traccar), official Docker image
(https://hub.docker.com/r/traccar/traccar, https://www.traccar.org/docker/), documented H02
support on TCP port 5013 — the default is in the source itself, `put(H02Protocol.class, 5013);`
in src/main/java/org/traccar/config/PortConfigSuffix.java
(https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/config/PortConfigSuffix.java) — and a documented
REST API — `GET /api/positions` and `GET /api/reports/route` with Basic or Bearer auth
(https://raw.githubusercontent.com/traccar/traccar/master/openapi.yaml).

- **On the device:** one SMS, `804<password> <our-fixed-public-IP> 5013`.
- **On the server:** one Docker container plus a small database. Traccar is a JVM app —
  community guidance converges on **2 GB RAM** as the practical minimum — the older "1 GB is
  enough" advice is explicitly walked back in recent threads ("1GB hasn't been enough recently").
  Still **UNVERIFIED**: Traccar publishes no spec sheet, this is forum consensus. The on-prem box has ample
  headroom (see private note). Traccar's own Docker page warns against publishing the whole
  5000–5300 port range; publish only the one protocol port we need.
- **In linen-truck code:** small and clean. Replace the vendor `getTrack` call in the poller's
  archive branch with a `PointSource`-shaped interface (`pointsSince(from, to)`) that polls
  Traccar's `/api/reports/route`. **No schema change** — the existing `PointRow`/`insertPoints`
  path is already generic. Shrink the 48-hour re-fetch window (it exists only to paper over the
  vendor's 1-day retention; with our own server there is nothing to catch up on) but keep
  `INSERT OR IGNORE` dedupe as cheap insurance. The vendor-specific extras (`device_status`,
  `daily_mileage`, `obd_rows`) go dormant, which the app already tolerates gracefully.
- **Cost:** software free; the real cost is the public IP (see section d).
- **Failure modes:** Traccar container down = device connects to nothing and (depending on
  firmware) may buffer or may simply drop fixes; JVM memory pressure; a Traccar upgrade
  breaking the H02 decoder; and the ordinary risk of running one more service.
- **Revert:** re-send `804<password> <original vendor IP> <original port>` — the device is back
  on the vendor cloud in seconds. Keep the existing vendor poller code in place, unchanged,
  behind a config flag.

### Option B — a small H02 listener inside linen-truck itself (Bun TCP server)

Write ~200–400 lines of Bun TCP server inside the existing app that accepts the device's H02
connection, parses the sentences, and calls `insertPoints` directly. The wire format is fully
documented by Traccar's decoder (link above), and there is an MIT-licensed reference
implementation aimed at this device family, **bllaude/sinotrack-mqtt-bridge**
(https://github.com/bllaude/sinotrack-mqtt-bridge) — targets ST-901/901L/903/905/906/907, handles
H02 text variants V1/V5/V6/V8 plus binary. **Treat it as reading material, not a dependency:
0 stars, a single commit, never publicly reviewed — "working" is UNVERIFIED.** It also sends an
H02 ACK (`*HQ,<imei>,R12,<time>#`); note that **Traccar does not** — its `PROTOCOL_ACK`
(`<protocol>.ack`) defaults to `false` (Keys.java:125-128; H02ProtocolDecoder.java:318-329), so
the R12 ACK appears to be optional rather than necessary to prevent retransmission. Confirm
behaviour with our own unit before designing around it. A better-vetted comparison implementation
is eusonlito/GPS-Tracker (350 stars, MIT, active).

- **On the device:** identical single SMS, pointed at our port instead of 5013.
- **On the server:** nothing new to deploy — it is the same container that already runs. One
  extra listening port.
- **In linen-truck code:** more work than A, but simpler *runtime*. Architecturally this is a
  **push** source, unlike everything the app does today: no `cycle()`, no backoff, no
  `nextAttemptMs`. It needs its own receive-side bookkeeping (the `poll_log` table's columns
  still fit, but "poll" now means "did the last inbound packet parse", a documented semantic
  change), and `POLL_LOG_KEEP = 2000` rows would cover a far shorter wall-clock window at
  20-second push cadence than at 10-minute polling — switch that prune to time-based.
- **Cost:** free.
- **Failure modes:** we own the protocol bugs (a mis-parsed sub-variant silently drops fixes);
  no ACK or a wrong ACK causes the device to retransmit forever; no web UI to sanity-check
  against; **and this is new public inbound surface** — a raw TCP port a stranger can also
  connect to. Mitigation: **IMEI allow-list** — accept exactly one device id and drop every
  other connection immediately, plus a connection rate limit and a hard cap on bytes per
  connection. Note the app's contract docs today describe it as strictly outbound-polling with
  no internet-reachable inbound route; an inbound listener is a genuinely new exposure shape
  and deserves its own ADR and security review before it ships.
- **Revert:** same single SMS back to the vendor endpoint.

### Option C — stay on the vendor cloud, harden only

No device change at all. Improve what we do when the vendor breaks.

- **On the device:** nothing.
- **On the server:** nothing structural. Add alerting on consecutive poll failures (the current
  outage produced a clean signature — non-JSON bodies, then TLS 525, then connect-timeout 522,
  every 30 minutes, with zero 4xx, i.e. unambiguously vendor-side, not a ban or a rate-limit),
  and a fast manual-recovery path.
- **In linen-truck code:** an alert hook on N consecutive failures; a "backfill on return" pass
  that widens the re-fetch window once the vendor answers again (the existing 48-hour sliding
  window already does most of this automatically — it is precisely the mechanism that closes a
  multi-hour outage with no cursor state); optionally a probe of the *other* cluster servers so
  we notice if the vendor migrates our account.
- **Cost:** free.
- **Failure modes:** **it does not solve the stated problem.** The vendor keeps ~1 day of
  history, so any outage longer than ~24 hours is permanent data loss — as happened here: the
  truck's entire 12:00–16:00 run window fell inside the outage. Backfill only works if the
  vendor comes back within the retention window. We also remain dependent on a vendor whose
  cluster server has been unreachable for hours with no status page and no maintenance notice.
- **Revert:** n/a — this is the status quo.

### Option D — hybrid / forwarding (our server first, vendor still fed)

**Possible via Traccar's raw packet mirroring — untested against the vendor cloud, so treat as a
bonus, not a dependency.**

- The device reports to **one** server. No primary source documents a dual-server mode; the
  only "two servers" behavior found anywhere is a user manually re-sending the `804` command to
  flip between their own Traccar box and the vendor cloud at different times
  (https://www.traccar.org/forums/topic/sinotrack-st-906l-protocol-and-gprs-commands/).
  **UNVERIFIED** that no such firmware mode exists at all, but nothing was found across the
  manual, flespi's protocol reference and the Traccar forums.
- **Traccar CAN mirror the raw wire packets.** `server.forward` duplicates the raw TCP/UDP
  packets a device sends to Traccar onward to another listener, "using the same transport (TCP or
  UDP) as the original connection" (https://www.traccar.org/forward/, "Raw Data Forwarding");
  Traccar's author confirms this is the supported answer to "receive data from the tracker and
  submit it to the SinoTrack server too"
  (https://www.traccar.org/forums/topic/traccar-server-receive-data-from-gps-tracker-and-submit-data-to-sinotrack-server-too-for-tracking/),
  and a working config is published there (`forward.enable` + `server.forward`). This is a genuine
  hybrid candidate, not an impossibility.
- **What is still UNVERIFIED and must be tested:** whether the vendor's platform accepts a one-way
  mirrored stream arriving from our server's IP with no return path for its ACKs, and whether it
  needs a session the mirror cannot reproduce. Test it before promising the vendor app keeps
  working. (Traccar also forwards *decoded* positions — `forward.type` of `url`, `json`, `amqp`,
  `kafka`, `mqtt`, `redis`, `wialon` — but that is normalized data, not the vendor's protocol.)
- **The realistic hybrid is temporal, not simultaneous:** run our server in parallel and
  *verified working* first, flip the device, and keep the SMS revert command on a card in the
  office. See the rollout in (e).

---

## (d) The public-endpoint problem — this is the real decision

The device dials **out** to a fixed public IPv4. Our estate is built entirely on outbound
tunnels and has no inbound path. Measured, not assumed:

- Both on-prem sites sit behind NAT on Thai ISP connections. External TCP checks were run from
  many countries against six ports on both sites (~40 node-checks total, via check-host.net).
  **Nothing was reachable anywhere.**
- One site is **silently dropped** on every port tested — consistent with a drop-all CPE
  firewall, upstream ISP filtering, or carrier NAT; the three cannot be distinguished from
  outside.
- The other site is more interesting: well-known ports (22/80/443) are silently dropped — the
  inbound blocking Thai consumer ISPs commonly apply — but **high ports return a TCP RST**
  ("connection refused") from nodes on five continents. An RST proves the SYN reaches a live,
  responsive device at that address and is not blackholed upstream. **UNVERIFIED and the single
  highest-value question to settle:** whether the device answering is *our own router* (in which
  case a port-forward there would work, and this becomes a free inbound path) or a *carrier NAT
  box* (in which case no port-forward is possible). Settling it needs someone to open the
  router's admin page and read its WAN address — a five-minute job, no purchase required.

| Path | Works? | Cost | Notes |
|---|---|---|---|
| **ISP port-forward on our own router** | **MAYBE — free, and worth 5 minutes to check** | ฿0 | Only viable at the site whose high ports return RST. Hinges on the router actually holding the public IP. A dynamic ISP address is survivable via a DDNS hostname, which the device accepts — see constraint (1). |
| **Small VPS relay with a real public IPv4** | **YES — the simplest confirmed paid path** (since a hostname is accepted, a DDNS name plus a port-forward is a live free alternative) | ~$4–6/mo (≈฿140–210/mo). Fetched live from https://www.digitalocean.com/pricing/droplets: $4.00 = 512 MiB, $6.00 = 1 GiB, "For Bundled Plans, a public IPv4 is included at no extra cost." Vultr's $3.50 (512 MB, with IPv4) and $5.00 (1 GB) tiers are search-sourced and remain **UNVERIFIED** — vultr.com/pricing refuses automated fetches. **Note the split: the 512 MB tiers only fit sub-shape (1), the socat/haproxy relay. Sub-shape (2), Traccar on the VPS, needs the $5–6 1 GB tier at minimum and realistically 2 GB.** | DigitalOcean Basic Droplet ~$4/mo or Vultr ~$3.50/mo, both with a Singapore region (nearest to Thailand among providers checked; no Bangkok-region VPS found). AWS Lightsail's $3.50 tier is IPv6-only, so its real floor is $5. Hetzner's cheap tiers are unavailable in Singapore. Two sub-shapes: (1) VPS runs a tiny TCP relay (`socat`/`haproxy`) forwarding the raw stream over the **existing WireGuard mesh** to a container on-prem — no new inbound port at either hotel site; or (2) VPS runs Traccar itself and linen-truck polls its API. |
| **Cloudflare Spectrum** | Technically yes, practically no | Spectrum is on all paid plans, but "Pro and Business support selected protocols only, whereas Enterprise supports all TCP and UDP based traffic" (https://developers.cloudflare.com/spectrum/get-started/) — an arbitrary tracker port is therefore Enterprise-only. Pricing not published. | Custom TCP ports are Enterprise-only (https://developers.cloudflare.com/spectrum/get-started/). A Tunnel *can* be the origin, but only via a Virtual-Network private-IP origin, TCP/UDP only, single IP, no port ranges (https://developers.cloudflare.com/spectrum/reference/configuration-options/, https://developers.cloudflare.com/spectrum/reference/limitations/). Ruled out on cost for a one-truck problem. |
| **Cloudflare Tunnel / Access (what we already run)** | **No** | — | Arbitrary-TCP access requires `cloudflared` or WARP **installed on the client** (https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/). A GPS tracker can install neither. |
| **Tailscale Funnel** | **No** | — | Ports 443/8443/10000 only, and **TLS-only** (https://tailscale.com/kb/1223/funnel). The tracker opens a plaintext socket. The open feature request for raw TCP is unresolved (https://github.com/tailscale/tailscale/issues/14240). |

Because a hostname is accepted, a DDNS name pointed at whichever endpoint we choose removes the
"address must never change" constraint and re-opens the free port-forward path. Confirm hostname
acceptance on our own unit before relying on it.

---

## (e) Recommendation and a rollout that cannot lose data

**Recommended: Option A (Traccar), reached by the cheapest endpoint that works — and settle the
endpoint question before buying anything.**

Traccar rather than a hand-written listener, because it is the difference between owning a
protocol bug and inheriting fixes from thousands of deployments. On the endpoint: the device
accepts a **hostname**, so the decision is no longer "static IP or nothing". Check the router
first (step 2): if the site whose high ports answer with RST holds its own public IP, a
port-forward plus a DDNS name is free and sufficient. A ~$5–6/mo Singapore VPS remains the clean
fallback, either running Traccar itself (1 GB minimum, 2 GB realistic) or relaying the raw stream
over the existing WireGuard mesh at the 512 MB tier. Option D is **not** dropped: once Traccar is
receiving, `server.forward` can mirror the raw packets to the vendor endpoint at no extra cost —
worth one test, because if the vendor cloud accepts it, nobody loses the phone app. Option C is
not an alternative; it is **table stakes under every option**. Note that under Option A engine-on
minutes must be re-derived from the H02 ignition bit — Traccar's H02 decoder discards the
position battery field, so this is planned work, not a risk to be tested away.

**Staged rollout — every stage is reversible and no stage risks the current feed:**

0. **Do Option C's alerting first, this week.** Alert on N consecutive poll failures. Costs
   nothing, helps under every option, and would have caught this outage at 01:15 instead of at
   17:45.
1. **Read the device's current configuration before touching anything.** Send the plain-text SMS
   `RCONF` to the device's SIM. It replies with its full config, including its current password
   and its current `IP:<address>:<port>` (ST-902 manual, "Other Functions" → RCONF). **That
   captured address is the true revert target — not any IP quoted in a manual**, because the
   vendor runs multiple cluster servers and our account is on a specific one. Write it on paper,
   store it privately, and never commit it to the public repo. This step is read-only: it
   changes nothing on the device. **If RCONF does not answer** — a documented failure on ST-90x
   units, where users report RCONF silently failing while every other command works, sometimes
   needing a `RESTART` first
   (https://www.traccar.org/forums/topic/sinotrack-st-906l-protocol-and-gprs-commands/) — do NOT
   proceed on a guessed revert target. Fall back to reading the current server from the vendor's
   own web console / app device-configuration page, or to `RESTART` then RCONF again. Only flip
   the device once the current `IP:port` is in hand.
2. **Check the free option in five minutes.** Open the router admin page at the site whose high
   ports return RST and read its WAN IP. If it matches the site's public egress address, a
   port-forward is viable and the VPS may be unnecessary. If it does not, the VPS is required.
3. **Stand up the server with the device still on the vendor cloud.** Deploy Traccar (VPS, or
   on-prem behind a VPS relay over the existing WireGuard mesh), configure the H02 listener,
   and register the device's IMEI. Nothing is connected yet; the vendor feed keeps running
   untouched; linen-truck is unchanged.
4. **Ten-minute live test.** Send the `804` SMS. Watch Traccar's UI for the device coming
   online. **Confirm the three must-haves:** timestamps, lat/lon, speed. Then confirm the
   **ignition bit** arrives (H02 status word, bit 10) and capture the **raw sentence** the unit
   emits — voltage is not recoverable through Traccar's decoder, so the test is about which
   fallback we build, not about hoping a voltage appears. If a hostname was used, this is also
   where hostname acceptance is confirmed.
5. **Immediately revert to the vendor for now**, using the address captured in step 1, and go
   build the code against the recorded sample data. Total exposure: minutes.
6. **Build the `PointSource` seam** in linen-truck behind a config flag, with the vendor poller
   left fully intact. Test against Traccar's API using the recorded points.
7. **Parallel run.** Flip the device to our server for real and let both paths write into the
   same points table — the vendor poller keeps running and keeps back-filling from whatever the
   vendor still holds, and `INSERT OR IGNORE` on `(device, timestamp)` means the two sources
   cannot corrupt each other. Compare a week of days: same stops, same trips, same findings?
8. **Cut over** by turning the vendor poller off, or simply leave it running — it costs almost
   nothing and becomes a free consistency check.

**Decisions only the owner can make:**

1. **The SIM's phone number and the device's current SMS password.** Every step above needs an
   SMS to the tracker's own SIM. If the number is unknown, or the SIM cannot receive SMS (some
   data-only M2M SIMs cannot), **the entire self-hosting plan is blocked** — nothing else in
   this document can proceed. If the password was ever changed from the vendor's published
   factory default (see the manual), RCONF will reveal it; if the SIM cannot be SMS'd at all, the device must be pulled from the truck
   and configured another way. **Confirm this first — it gates everything.**
2. **Budget.** Roughly ฿150–250/month for a VPS, forever, versus ฿0 today. Small, but it is a
   new recurring line item and it needs an owner.
3. **Willingness to give up the vendor's phone app.** Redirecting the device means the vendor's
   app and website go blank for this truck. If anyone actually uses that app to check the truck,
   they lose it — Traccar has its own web and mobile UI, but it is a different app, and someone
   has to be shown how to use it.
4. **Who owns the new server.** Traccar is one more thing that can break at 2 a.m., on a VPS
   that also needs patching. Option C is genuinely acceptable if the honest answer is "nobody
   has time" — it just means accepting that a multi-day vendor outage permanently erases those
   days.
5. **Which site, if a port-forward turns out to be possible** — that is an ISP/router change at
   a hotel site, not just a software change.

---

## (f) Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Wrong SMS bricks the device's config** | Low | High — truck goes dark until someone physically reaches it | The `804` command only sets an IP/port; it does not reformat anything, and `RESTART` reboots the unit (ST-902 manual). **But no reliable factory-reset command was confirmed** — a `FORMAT` command appears in one AI-summarized secondary source and is **UNVERIFIED, possibly hallucinated; do not use it.** The real safety net is step 1: capture the current `IP:port` via RCONF *before* changing anything, so revert is always one SMS away. Never send a command whose syntax was not read from the manual. |
| **Wrong APN kills connectivity** | Low if we don't touch it | High | **Do not send the APN command at all.** The APN only needs changing if the SIM changes. Keep the existing SIM and skip it entirely. (`803<password> <APN>` exists if ever needed.) |
| **Data gap while flipping** | Certain, but bounded | Low | Each flip costs the time between the SMS and the device's first successful connection. The vendor's own 1-day retention plus the existing 48-hour re-fetch window closes the gap automatically as long as we flip back within a day. Do flips outside the truck's 12:00–16:00 run window. |
| **Traccar's H02 decoder discards the position battery field → engine-on-by-voltage is unavailable** | **Certain under Option A** | Medium — one audit metric degrades quietly | Move `engineOnS` to the H02 ignition bit (a contained change to one domain rule), or parse the raw H02 sentence in-house (Option B) where the field exists on the wire. |
| **Public listener abuse** | Moderate — anything on a public IP gets scanned within hours | Medium — junk rows, resource exhaustion | **Authenticate by IMEI allow-list**: accept exactly the one known device id and drop every other connection at once. Add a per-IP connection rate limit, a byte cap per connection, and an idle timeout. Traccar has device registration built in (unknown devices are rejected); a hand-written listener must implement this explicitly. Use a non-obvious high port. Never expose the Traccar *web UI* publicly — keep it behind the estate's existing access controls, publish only the one protocol port. |
| **Our own server goes down** | Moderate | High — with no vendor fallback, that data is gone for good | This is the honest cost of self-hosting: we swap a vendor's reliability for our own. Mitigate with a restart policy, a health check, an alert on "no fix received in N minutes", and — because the vendor cloud is currently down anyway — no worse than today. |
| **The ISP address changes (port-forward path only)** | High on a consumer line | Medium — mitigable | Point the device at a **DDNS hostname** rather than the raw IP (the device accepts one — constraint (1)), so an address change resolves itself. A VPS's static IP is the simpler guarantee. Either way the "no fix in N minutes" alert is mandatory, not optional. |
| **Exact device model is unknown** | Certain | Medium | Every command and protocol fact above comes from the ST-901/ST-902 manuals as the closest documented match to the ST-9xx family — **the exact unit was never confirmed**. RCONF (step 1) returns the firmware version and settles it before anything is changed. |
| **Public-repo hygiene slip** | Moderate | High — the repo is public | The repo's existing secret-scanner covers private LAN / mesh / CGNAT addresses, ssh targets, estate hostnames, tunnel and app identifiers, UUIDs, 64-hex strings, the bare device id, ICCID/IMEI runs, password/token assignments carrying a literal value and private-key headers — but **it has no rule that matches an arbitrary public IPv4**, so a hard-coded VPS endpoint would pass silently. Extend the scanner or keep such an address purely in an env var / private ops note. Any provisioning doc that names a real endpoint, port, device id or password must live in the private notes, with the public repo naming only *which* private doc holds the value. |

---

## Sources

Device / protocol: https://www.softwarehousethailand.com/data/hardware/ST-902.pdf ·
https://flespi.com/protocols/sinotrack ·
https://www.traccar.org/forums/topic/sinotrack-st-906l-protocol-and-gprs-commands/ ·
https://www.traccar.org/forums/topic/traccar-server-receive-data-from-gps-tracker-and-submit-data-to-sinotrack-server-too-for-tracking/ ·
https://www.traccar.org/forums/topic/st-902-sinotrack/ · https://gps-trace.com/en/blog/sinotrack
(manuals.plus is behind a bot-wall — HTTP 403 — and is not cited.)

Servers: https://github.com/traccar/traccar ·
https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/config/PortConfigSuffix.java ·
https://raw.githubusercontent.com/traccar/traccar/master/src/main/java/org/traccar/protocol/H02ProtocolDecoder.java ·
https://raw.githubusercontent.com/traccar/traccar/master/openapi.yaml · https://www.traccar.org/docker/ ·
https://www.traccar.org/forward/ · https://hub.docker.com/r/traccar/traccar ·
https://github.com/bllaude/sinotrack-mqtt-bridge · https://github.com/eusonlito/GPS-Tracker ·
https://github.com/illja96/sinotrack-traccar-data-converter

Hosting: https://developers.cloudflare.com/spectrum/get-started/ ·
https://developers.cloudflare.com/spectrum/reference/limitations/ ·
https://developers.cloudflare.com/spectrum/reference/configuration-options/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/ ·
https://tailscale.com/kb/1223/funnel · https://github.com/tailscale/tailscale/issues/14240 ·
https://www.digitalocean.com/pricing/droplets · https://check-host.net
