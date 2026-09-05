# linen-truck

An audit of the linen truck that shuttles between The Harbour Front Hotel and
HF Ville: it polls the truck's SinoTrack GPS tracker, reconstructs each day
into stops / trips / legs, and flags unknown stops, detours, and runs outside
the scheduled window. Managers read the day and week report; there is no
dispatch surface and nothing driver-facing.

- **Live at** `https://truck.thehfhotel.org`, behind Cloudflare Access — the
  whole hostname is gated, there is no public page.
- **Runs on** the HF Ville box, one container (`truck`) on port 4100.
- **Stack** Bun 1.3 + Elysia + `bun:sqlite`. One dependency, no build step.

## Running it locally

```bash
bun install
cp .env.example .env   # ALLOW_DEV_AUTH=1 is already in there
bun run dev            # http://localhost:4100 — day report at /day/<ymd>
bun test               # whole suite: no network, no ports, in-memory SQLite
bun run typecheck      # tsc --noEmit
```

With `ALLOW_DEV_AUTH=1` a plain `X-Dev-Email:` header stands in for the
Cloudflare Access JWT. That switch is refused under `NODE_ENV=production` and
appears in exactly one file (`docker-compose.yml`, the local smoke test) —
never in the production compose file and never in a deploy payload.

There is no `bun run build`: the pages are server-rendered HTML strings and
Leaflet (the day-page map) loads from a CDN in the page itself.

`docker compose up --build` builds and runs the same image CI publishes, on
`http://127.0.0.1:4100`, with the poller dormant.

## How deploys work

Push to `main` → `.github/workflows/deploy.yml`:

1. **ci** — secret scan, shell parse, typecheck, tests. Nothing reaches the box
   without this passing.
2. **deploy-hfville** — builds `linux/amd64`, pushes to
   `ghcr.io/thehfhotel/linen-truck` (tagged with the full sha and `latest`),
   renders the production env from repository secrets, then opens one SSH
   session to the HF Ville box through its Cloudflare tunnel
   (`cloudflared access ssh` with a service token) and pipes a JSON payload to
   a forced-command shim, `~/deploy-truck/run-deploy.sh`.
3. The shim writes the compose file and a `0600` `.env`, pulls, brings the
   container up, and then **polls `/healthz` on loopback until it reports the
   deployed commit** — that assertion, not a green build, is what makes the
   run mean something.

The job is gated on the `TRUCK_DEPLOY_ENABLED` repository variable, so it stays
skipped (not red) until the box-side setup exists.

Afterwards, from your own machine:

```bash
bash scripts/verify-live.sh <sha>
```

which checks the public routes really do redirect to Cloudflare Access, that
the box reports the deployed sha and a configured poller, and that the internal
feed is reachable from evergreen but refuses an unauthenticated caller.

**Rollback** is a `workflow_dispatch` with a `rollback_sha` input — the build
is skipped and the box is told to run an image that already exists. See
`docs/runbooks/deploy-and-rollback.md`.

First deploy: `scripts/owner/go-live.sh` (owner-run, interactive).

## This repository is public

Code, history, issues and every Actions log are world-readable. Device ids,
credentials, Cloudflare identifiers, box hostnames and private addresses must
never appear in a file here — the repo names the **secret or config variable**
that carries each value instead.

`scripts/check-no-secrets.sh` enforces that on every tracked file and runs
first in CI. Run it before you push.

The real operational detail — the box's SSH target and addresses, the tunnel
and Access identifiers, the port map, the feed URL hf-mcp uses — lives in the
private `~/HF/hf-network` ops note and in `~/HF/hf-erp`, plus the GitHub
Actions secrets listed in `docs/CONTRACTS.md` §13.

## Where the design lives

`CONTEXT.md` is the product design; `docs/CONTRACTS.md` is the locked interface
(routes, schema, domain rules, env, CI/CD, hygiene); `docs/adr/` records why;
`docs/runbooks/` is what to do when it breaks. Read the contract before
changing routes, schema, domain rules, or env.
