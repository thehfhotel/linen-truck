# Linen Truck — CONTEXT

Status: design locked 2026-09-05, build in progress. This file plus
`docs/CONTRACTS.md` are the authority for the first release. ADRs in
`docs/adr/` record why.

## What this is

An audit tool for the truck that shuttles linen (and staff) between The
Harbour Front Hotel (`hf`) and HF Ville (`hfville`). The truck carries a
SinoTrack GPS tracker; this app polls the SinoTrack platform, reconstructs
the day into stops/trips/legs against the two known sites, and flags what a
manager actually cares about:

- **unknown stops** — the truck parked somewhere that isn't HF or HF Ville
  for more than a few minutes,
- **detours** — a leg between the two sites came in far longer than the
  known road distance,
- **outside-hours runs** — the truck was moving outside the scheduled
  linen-run window.

There is no dispatch, no driver app, no manual data entry. The truck's own
tracker is the only input; everything else is computed.

## Why it looks like this

- The truck's job is narrow and repetitive (HF ↔ HF Ville, roughly midday),
  which makes "expected" easy to state precisely: two sites, one reference
  distance per direction, one schedule window. A rule-based audit against
  that shape catches drift (idling, wrong-turn detours, off-schedule runs)
  without needing a driver to self-report anything.
- The segmentation rules (stop → merge → trip → leg → finding) were proven
  against a real day of tracker data in a throwaway Python prototype before
  this repo existed (`test/fixtures/2026-09-05.raw.json` is that day,
  archived from the owner's Mac). The numbers in `docs/CONTRACTS.md` §3
  ("Expected on the fixture...") are the contract the TypeScript port must
  reproduce exactly.
- SinoTrack's own web platform has no useful reporting surface for this (no
  site-aware segmentation, no detour/schedule rules) — hence a bespoke
  poller against its raw `AppJson.asp` API rather than embedding their UI.
- The whole hostname is Cloudflare-Access gated rather than split into a
  public/staff tree like guest-feedback: there is no public audience for a
  linen truck's location and stop history, so there is no reason to carve
  out a public tree the way the guest-facing apps do. Only `/healthz` (for
  the box-side deploy poll on loopback) and `/feed/*` (for the internal
  hf-mcp report, never reachable through Cloudflare) skip the Access check.

## Product decisions (locked)

| Decision | Choice |
|---|---|
| Scope | Audit only — read the tracker, compute, report. No write-back to SinoTrack, no dispatch, no driver-facing surface. |
| Sites | Exactly two, checked in (`config/sites.json`): `hf` and `hfville`, each a lat/lon + radius. Adding a third site is a config change + redeploy, not a UI action. |
| Rules | Owner-tunable via `config/rules.json` (stop radius, minimum stop duration, merge hop, schedule window, detour ratio, per-pair reference distance, engine-on voltage threshold, engine-on hold window, settled-pair jitter radius). No settings UI — a wrong number gets fixed in a commit, not a form. |
| Findings, not alerts | Findings appear on the day/week pages and in the hf-mcp owner report. No LINE push, no SMS — see the `guest-feedback`/`hk` precedent for why LINE push is reserved for genuinely time-sensitive escalations, and a linen-truck detour is a review item, not an emergency. |
| Auth | Whole hostname behind Cloudflare Access, managers tier + the two reception kiosks (the live `housekeeping.thehfhotel.org` root policy set). No public tree. |
| Access to raw feed | `/feed/*` is for the internal hf-mcp owner-report job only — bearer-token gated and refuses any request that shows signs of having come through Cloudflare (`Cf-Ray`/`CF-Connecting-IP` present), so it can only be reached over the estate's internal link, never from the internet even with a leaked token. |
| Language | Thai primary with English secondary throughout, `{ th, en }` label pairs, no separate language switch (this is a small internal manager tool, not a guest-facing surface). |
| Data | SQLite on a host bind mount under the deploy directory, plus an **in-process** nightly `VACUUM INTO` (`BACKUP_TIME`, keep 14) — this box has no systemd unit we may install. Raw tracker points are kept forever (~300/day is nothing); `poll_log` is pruned to the newest 2000 rows. |

## Hosting and visibility (owner decisions, 2026-09-05 — ADR 0001)

Two decisions changed after the repo was scaffolded and before anything
shipped, so the scaffolding was rewritten rather than migrated:

- **The app runs on the HF Ville box, not evergreen.** The tracker is a HF
  Ville concern and the box already hosts the estate's other HF Ville app on
  a free neighbouring port. The cost is that this box is not an estate-ci
  host — passwordless sudo covers `docker` and nothing else, there is no
  `/srv` we may write and no systemd unit we may install. So the deploy path
  lives entirely in the deploying user's home directory
  (`~/deploy-truck/{app,logs}`), the backup schedule moved inside the app,
  and CI deploys the way `ev-charging-hotel` does: build → GHCR → one SSH
  session through the box's Cloudflare tunnel (`cloudflared access ssh`,
  service token `truck-ci`) → a forced-command shim. Two apps on one box
  sharing one transport means one thing to understand and one thing to fix.

- **The repository is public.** This is generic infrastructure — a GPS poller
  and a geometry library — with no guest data and no commercial secret in it.
  The price is a hygiene regime (`docs/CONTRACTS.md` §13, `CLAUDE.md`): the
  device id, the SinoTrack password, the feed token, every Cloudflare
  identifier, the box's SSH target and every private address live in GitHub
  Actions secrets and in the private `hf-network` / `hf-erp` repos — this repo
  names them and never carries them. `scripts/check-no-secrets.sh` fails CI on
  any of them appearing in a tracked file, fixtures use the synthetic device
  id `1000000001`, and the repo is published from one fresh root commit made
  after the scrub. GitHub Actions logs are the easiest way to leak, so
  workflows print counts and never values.

## Stack and hosting (ADR 0001)

Bun 1.3 + Elysia + `bun:sqlite`, one container `truck` on the HF Ville box,
host port **4100**, hostname **truck.thehfhotel.org** on that box's tunnel
(as code in `hf-erp/infra/cloudflare/truck-ville.ts`, not `hostnames.json` —
it is a foreign tunnel and the generic apply would wipe it). No build step —
server-rendered HTML strings, Leaflet loaded from a CDN in the page. Same
shape as `guest-feedback`'s server half (minus its client bundles and its
public/staff split), with `ev-charging-hotel`'s deploy transport.

## Repository layout

```
CLAUDE.md                 rules for anyone (human or agent) editing this repo
CONTEXT.md                this file
README.md                 what it is, how to run it, how deploys work
docs/CONTRACTS.md         locked interfaces: routes, schema, domain rules, env,
                          CI/CD, public-repo hygiene
docs/adr/                 decisions
docs/runbooks/            deploy-and-rollback
config/sites.json         the two known sites (lat/lon/radius)
config/rules.json         segmentation + finding thresholds, owner-tuned
Dockerfile                single stage, no build step, ARG GIT_SHA
docker-compose.yml        LOCAL smoke test only (the one place ALLOW_DEV_AUTH lives)
docker-compose.hfville.yml  production; CI ships it as the box's docker-compose.yml
.github/workflows/        ci.yml (gate), deploy.yml (build + SSH deploy),
                          security.yml (Trivy)
scripts/check-no-secrets.sh  the public-repo gate; runs first in CI
scripts/import.ts         one-off import of archived raw platform rows
scripts/backup.ts         VACUUM INTO /data/backups, keep 14
scripts/deploy/run-deploy.sh  the forced-command shim that runs ON the box
scripts/hfville/install.sh    one-time box-side install (owner, no sudo)
scripts/owner/go-live.sh      first-deploy recipe (repo, Cloudflare, secrets)
scripts/verify-live.sh        post-deploy assertions from three vantage points
src/shared/               time (Bangkok day math), labels (th/en)
src/domain/               types, geo, segment, audit, summary, sinotrackRow
                          — pure, no IO, unit-tested against the fixture
src/server/               server.ts, app.ts, db.ts, config.ts, auth.ts,
                          sinotrack.ts, poller.ts, pages/
```

## Roadmap after v1 (not in scope now)

- **OBD fuel.** `getObd`/`obd_rows` are already in the storage contract
  (§5/§6) because the SinoTrack device *can* report OBD data, but no finding
  or page currently reads `obd_rows`. If the device starts uploading useful
  OBD rows (fuel level, odometer, RPM), a later rev can add a fuel-burn
  finding (e.g. "refuel without a stop" or an unexplained fuel drop) without
  touching the poller or schema — the rows are already being captured.
- **Learned reference distances.** `config/rules.json`'s `referenceKm` is a
  single owner-typed number per site pair today. Once enough legs have
  accumulated, a later rev could suggest (never silently apply) an updated
  reference from the observed distribution of "normal" leg distances,
  surfaced as a diff for the owner to accept — the detour rule stays
  rule-based and auditable, it just gets a better baseline.
- **Dashboard ingest.** `/feed/daily` and `/feed/range` exist specifically so
  a future estate dashboard (or the hf-erp portal) can pull this data
  without another bespoke integration; the DayReport JSON shape in §9 is
  designed to be the one contract every future consumer reads, not something
  hf-mcp gets to itself.
- **Off-box backup.** The nightly `VACUUM INTO` survives a container or image
  change but not the box. Copying the newest snapshot somewhere else is an
  owner task today; if the estate grows a shared backup target, this app
  should push to it rather than grow a second scheduler.
- **A second vehicle.** Nothing in the schema is single-device — `points`,
  `device_status`, `daily_mileage` and `obd_rows` are all keyed by `teid`.
  The poller and the report layer assume one device (`SINOTRACK_TEID`); a
  second vehicle means a device list in config and a device selector on the
  pages, not a schema change.
