# ADR 0001 — Bun/Elysia/SQLite on the HF Ville box, whole hostname gated, no build step

Date: 2026-09-05. Status: accepted. Supersedes the evergreen/estate-ci draft of
the same number (see "Revision" at the end).

## Context

The estate runs several small standalone hotel apps in one shape: Bun +
Elysia, `bun:sqlite` on a `/data` volume, one container, a GHCR image, and a
Cloudflare hostname managed as code in `hf-erp/infra/cloudflare`. HF One's
"designing a new HF system" section names this as the default stack.
`linen-truck` is smaller than any of them: one background poller, a handful of
read-only report pages, no guest-facing surface at all.

Two things were open when the repo was scaffolded: **which box** it runs on,
and **whether the repository is private**. Both were decided by the owner on
2026-09-05, after the scaffolding was already written against evergreen.

## Decision

- **Bun 1.3 + Elysia + `bun:sqlite`**, one container `truck`, host port 4100,
  hostname `truck.thehfhotel.org`.

- **It runs on the HF Ville box, not evergreen.** The truck's tracker is a
  HF Ville concern, the box already hosts the estate's other HF Ville app, and
  it had a free port. The cost is that this box is not an estate-ci host: we
  have passwordless sudo for `docker` and nothing else — no `/srv` we may
  write, no systemd unit we may install, no `deploy` user. Everything
  therefore lives under the deploying user's home directory.

- **Deploy is the evcharge shape, not estate-ci.** GitHub Actions builds and
  pushes the image, then opens ONE SSH session to the box through its
  Cloudflare tunnel — `cloudflared access ssh` authenticated by a service
  token — and pipes a JSON payload to a forced-command shim at
  `~/deploy-truck/run-deploy.sh`. The key on that box can run the shim and
  nothing else. This is copied from `~/HF/ev-charging-hotel`, the other app on
  the same box, down to the pinned action SHAs and the pinned cloudflared
  checksum: two apps sharing one transport means one thing to understand and
  one thing to fix.

  *Why not Tailscale, which the estate also uses?* The tailnet OAuth secrets
  that would authorise a runner are per-repo elsewhere and not recoverable,
  while the box's tunnel already publishes an SSH Access app. Reusing it costs
  one service token and no new trust.

- **Backups are in-process.** Everywhere else the nightly `VACUUM INTO` is
  driven by a systemd timer on the host. This box will not let us install one,
  so the app schedules its own at `BACKUP_TIME` (02:35 Bangkok) and writes into
  the same bind-mounted `data/` directory. One fewer moving part; the cost is
  that a wedged container also means a missed backup, which `/healthz` and the
  poller status make visible.

- **No build step.** Unlike `guest-feedback` (which bundles a guest client and
  a React staff SPA) this app has no client bundle at all: day and week pages
  are server-rendered HTML strings, and the one piece of richer UI — the
  Leaflet map — loads Leaflet from a CDN in the page rather than through a
  bundler. There is nothing for a build script to build, so none exists, and
  neither the Dockerfile nor CI runs one.

- **Whole hostname gated, one tree, not two.** `guest-feedback` and
  `housekeeping` split a hostname into a public guest tree and an
  Access-gated staff tree because they have a public audience. This app has
  none — a linen truck's GPS history is not guest-facing — so the entire
  hostname sits behind Cloudflare Access, mirroring the live
  `housekeeping.thehfhotel.org` root policy set (HF Managers plus the two
  reception kiosks). Only `/healthz` (database-free, for the box-side deploy
  poll on loopback) and `/feed/*` (bearer-gated, refusing anything that shows
  signs of having come through Cloudflare) skip the JWT check — and because
  the edge gates the hostname, neither is reachable from the internet either.

- **The repository is public.** The owner's decision: this is generic, boring
  infrastructure — a GPS poller and a geometry library — with no guest data
  and no commercial secret in it. Publishing it costs nothing as long as the
  identifiers stay out, and it makes the code readable without a login. The
  price is a hygiene regime (docs/CONTRACTS.md §13): every device id,
  credential, Cloudflare identifier, box hostname and private address lives in
  a GitHub secret or in the private `hf-network` / `hf-erp` repos, and
  `scripts/check-no-secrets.sh` fails CI on any of them appearing in a tracked
  file. Fixtures use the synthetic device id `1000000001`, and the repo is
  published from a single fresh root commit made after the scrub.

- **Pure domain layer.** Segmentation and findings live in `src/domain/` with
  no IO, so the rules proven in the throwaway Python prototype can be
  unit-tested against a real archived day (`test/fixtures/2026-09-05.raw.json`)
  without a database or a network.

## Consequences

- Deploy authority is one key pinned to one forced command, and the payload
  carries a short-lived `GITHUB_TOKEN` for the GHCR pull — no long-lived
  registry credential is left on the box.
- The public repo means the Actions log is a publication channel. Workflows
  print counts, never values; the box shim prints shas and health outcomes,
  never the `.env` it writes. This is the single easiest way to leak, so it is
  called out in `CLAUDE.md`, in the workflow header, and in the shim's header.
- `/healthz` not being publicly reachable means "is it live?" cannot be
  answered with one `curl`. Verification is therefore three-sided
  (`scripts/verify-live.sh`): the edge must redirect, the box must report the
  deployed sha on loopback, and evergreen must be able to reach the feed.
- No client bundle means no bundler, no `dist/`, one fewer moving part — at
  the cost of a plainer UI than a React SPA would give. Acceptable for a small
  internal report a handful of managers open a few times a week.
- SQLite means one process; the poller's in-flight flag and the `/healthz`
  status object are in memory, which is fine at ~300 points/day from one
  device.
- A misconfigured `CF_ACCESS_AUD` fails closed (503) rather than exposing
  anything, because the whole tree is gated.

## Revision

Rev 1 of this ADR put the app on evergreen behind the asgard tunnel, deployed
through the shared `thehfhotel/estate-ci` reusable workflows, with a systemd
backup timer and a private repository. The owner changed both the box and the
visibility on 2026-09-05, before first deploy. Nothing had shipped, so this
file was rewritten rather than superseded by a second ADR; the estate-ci
workflows, the `/srv` shim and `scripts/evergreen/` were deleted in the same
change.
