# Claude Code Instructions — `linen-truck`

**Read `docs/CONTRACTS.md` first, all of it.** It is the locked interface —
env vars, routes, schema, domain rules, deploy shape, public-repo hygiene.
`CONTEXT.md` is the design and `docs/adr/` records why. Where this file and
`docs/CONTRACTS.md` disagree, the contract wins.

## What this is

An audit of the linen truck that shuttles between The Harbour Front Hotel
(`hf`) and HF Ville (`hfville`). It polls the truck's SinoTrack GPS tracker,
turns raw points into stops/trips/legs, and surfaces a day/week report for
managers: unknown stops, detours, and trips outside the scheduled window. Bun
+ Elysia + `bun:sqlite` on a `/data` volume, one container (`truck`, host port
**4100**) on the **HF Ville box**, gated at `truck.thehfhotel.org`.

## THIS REPOSITORY IS PUBLIC

`thehfhotel/linen-truck` is public. Its code, its history, its issues and every
GitHub Actions log are world-readable. That is a deliberate choice
(docs/CONTRACTS.md §13) and it constrains what may be written here.

**Never write into any file in this repo:**

- the truck's device id (which is also the SinoTrack login), the SinoTrack
  password, the ICCID or IMEI;
- any Cloudflare Access audience, Access application id, service-token id,
  or tunnel id;
- the feed token or the portal notify token;
- a box hostname, SSH user, or `user@host` deploy target;
- a LAN, WireGuard or Tailscale address of any estate machine.

**Instead** name the thing that carries the value: "the `HFVILLE_SSH_TARGET`
secret", "the address recorded in the private ops note", "the tunnel id in the
private hf-erp script". The real values live in the private `~/HF/hf-network`
and `~/HF/hf-erp` repos and in GitHub Actions secrets.

`scripts/check-no-secrets.sh` enforces this over every tracked file and runs
first in CI — before typecheck, because a leaked identifier is a worse failure
than a type error. If it fires, fix the line; never loosen a pattern to make it
pass. Fixtures and tests use the synthetic device id `1000000001`.

In workflows: never `echo`, `cat` or `set -x` anything derived from a secret —
only counts (`wc -l`). No `pull_request_target`. All third-party actions
SHA-pinned. Secrets reach a step through `env:`, never interpolated into a
`run:` body.

## Commands

```bash
bun install
bun run dev        # http://localhost:4100 — day report at /day/<ymd>
bun test           # whole suite: no network, no ports, in-memory SQLite
bun run typecheck  # tsc --noEmit
bash scripts/check-no-secrets.sh   # the public-repo gate, run it before pushing
```

There is **no build step**. No `scripts/build.ts`, no client bundle, no
Tailwind. The server renders plain HTML strings; the only browser dependency
(Leaflet, for the map) loads from a CDN in the page itself. Never add a `bun
run build` script, never make the Dockerfile or CI run one.

Local staff auth: `ALLOW_DEV_AUTH=1` in `.env` and send `X-Dev-Email:
you@example.com` — same rule as guest-feedback.

## Hard rules

- **`/healthz` is database-free** and answers with no auth — the box-side
  health poll hits it on loopback during every deploy. Every other route needs
  a valid `Cf-Access-Jwt-Assertion` except `/feed/*`. (The hostname is
  Access-gated at the edge too, so `/healthz` is not reachable publicly.)
- **Auth fails closed.** Empty `CF_ACCESS_AUD` answers 503 on every gated
  route. `ALLOW_DEV_AUTH` is refused under `NODE_ENV=production`.
- **`ALLOW_DEV_AUTH` belongs in `docker-compose.yml` (local) and nowhere
  else.** Not in `docker-compose.hfville.yml`, not in a deploy payload, not in
  any `.env` that reaches a box. Three layers enforce it: the server refuses it
  in production, CI fails the deploy if it appears in the rendered payload, and
  the box shim refuses a payload carrying it.
- **`/feed/*` is internal-only.** It 404s on any request carrying
  `Cf-Ray`/`CF-Connecting-IP` (i.e. anything that came through Cloudflare),
  and otherwise needs `Authorization: Bearer <FEED_TOKEN>` compared in
  constant time. Empty `FEED_TOKEN` means the feed answers 404 for everyone.
- **Never log the SinoTrack password.** `SinotrackError` carries the proc
  name only.
- **The domain layer (`src/domain/`) is pure.** No IO, no `Date.now()`, no
  `process.env`. Every rule in `docs/CONTRACTS.md` §3 is proven against
  `test/fixtures/2026-09-05.raw.json` — don't hand-tune a rule until the
  fixture's expected numbers change with it.
- **Only `src/server/config.ts` reads `process.env`.** Handlers and the
  domain layer read `deps.config`.
- **Points are append-only.** `INSERT OR IGNORE` on `(teid, t)` — never
  UPDATE or DELETE a raw point. Raw rows are kept forever.
- **No LINE, no push notifications.** The owner report in hf-mcp carries the
  digest; this app has no notification path of its own.
- **No `bun add`.** Dependencies are frozen in `docs/CONTRACTS.md` §0
  (`elysia` only; Leaflet is CDN-loaded in the browser, never a dependency).
- **Bangkok time everywhere.** Use `src/shared/time.ts` for day math; never
  do wall-clock arithmetic by hand.
- **Backups are in-process.** The HF Ville box gives us passwordless sudo for
  docker only — no systemd unit we may install, no `/srv` we may write. The
  nightly `VACUUM INTO` is scheduled inside the app (`BACKUP_TIME`), and the
  whole deploy path lives under the deploying user's home directory.

## Architecture

- `src/domain/` — types, geo, segment, audit, summary, sinotrackRow. Pure,
  unit-tested, no IO.
- `src/server/sinotrack.ts` — the platform client (login, track, mileage,
  OBD), signed requests, 20 s timeout.
- `src/server/db.ts` — schema, `PRAGMA user_version` migrations, every query.
- `src/server/poller.ts` — the background fetch loop; never overlaps, never
  throws, exposes a status object for `/healthz`.
- `src/server/app.ts` — `createApp(db, deps)`, both the gated HTML/API tree
  and the internal-only `/feed/*` tree.
- `src/server/pages/` — server-rendered HTML strings, no framework, Thai
  primary with English secondary via `src/shared/labels.ts`.
- `config/sites.json`, `config/rules.json` — owner-tuned, checked in, no UI.

## Deploy plumbing (who owns what)

- `Dockerfile` — single stage, no build step, `ARG GIT_SHA` → `ENV GIT_SHA`.
- `docker-compose.hfville.yml` — production. CI ships it inside the deploy
  tarball, renamed `docker-compose.yml`.
- `docker-compose.yml` — local smoke test only; never reaches a box.
- `.github/workflows/ci.yml` — the gate on every push and PR.
- `.github/workflows/deploy.yml` — build → GHCR → `cloudflared access ssh` →
  the box shim. `workflow_dispatch` takes a `rollback_sha` input.
- `.github/workflows/security.yml` — Trivy vuln/secret/config scans.
- `scripts/deploy/run-deploy.sh` — the forced-command shim that runs ON the box.
- `scripts/hfville/install.sh` — one-time box-side install (owner, no sudo).
- `scripts/owner/go-live.sh` — the first-deploy recipe (owner-run only).
- `scripts/verify-live.sh` — post-deploy assertions. Green CI is not live.
