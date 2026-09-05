# Deploy and rollback — linen-truck

Everything here assumes `docs/CONTRACTS.md` §10/§11/§13. The box's SSH target,
addresses, tunnel and Access identifiers are **not** in this repo: they are the
GitHub secrets named below and the private `~/HF/hf-network` ops note.

## How CI deploys

`.github/workflows/deploy.yml`, on push to `main` and on `workflow_dispatch`:

1. **`ci`** — `bun install --frozen-lockfile`, `scripts/check-no-secrets.sh`,
   a `bash -n` parse of every shell script, `bun run typecheck`, `bun test`.
2. **`deploy-hfville`** — `needs: [ci]`, so broken code cannot reach the box.
   It builds `linux/amd64` with `--build-arg GIT_SHA=<sha>`, pushes to
   `ghcr.io/thehfhotel/linen-truck` (full sha + `latest` + a registry
   buildcache), renders `deploy.env` from secrets, refuses the payload if it
   carries `ALLOW_DEV_AUTH`, installs a pinned + checksum-verified
   `cloudflared`, writes the deploy key and `known_hosts`, and pipes one JSON
   payload over SSH:

   ```
   { commit_sha, deploy_payload_b64, ghcr: { user, token }, env: { … } }
   ```

   The SSH hop is `ssh -o ProxyCommand='cloudflared access ssh …'` to
   `HFVILLE_SSH_TARGET`, authenticated by the `truck-ci` Access service token
   (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) and the
   `TRUCK_DEPLOY_SSH_KEY` keypair. `StrictHostKeyChecking` stays on;
   `HFVILLE_HOST_KEY` is the only trust anchor.

3. **The shim** (`~/deploy-truck/run-deploy.sh`, from
   `scripts/deploy/run-deploy.sh`) takes the lock, caps the payload at 4 MB,
   logs in to GHCR, unpacks `docker-compose.yml` into `~/deploy-truck/app`,
   writes `.env` at mode 0600, `docker compose pull` (5 retries) and
   `up -d --remove-orphans`, then polls `http://127.0.0.1:4100/healthz` until
   `.commit` equals the deployed sha — 30 attempts, 2 s apart. If it never
   matches, it dumps the last 50 container log lines and exits 1.

**Staged rollout gate.** `deploy-hfville` carries
`if: vars.TRUCK_DEPLOY_ENABLED == '1'`. Until the box-side setup exists that
variable is unset, so `ci` runs green on every push and the deploy is *skipped*
rather than red. Flip it to `1` (Settings → Variables, or
`gh variable set TRUCK_DEPLOY_ENABLED --body 1`) once the shim, the
`authorized_keys` entry and the secrets are all in place.

**Public logs.** These Actions logs are world-readable. Workflows print counts
(`wc -l deploy.env`) and never a value; the shim prints shas, key counts and
health outcomes and never the `.env` it writes. Do not add an `echo` or a
`set -x` to either.

## Verify a deploy is live

```bash
bash scripts/verify-live.sh <sha>
```

Green CI is not live. The script asserts three things from three vantage
points, because no single one can see the whole path:

| where | assertion |
|---|---|
| public, through Cloudflare | `/`, `/day/<today>`, `/healthz`, `/feed/daily` all answer 301/302/401/403 with a `cloudflareaccess.com` redirect target — never 200 |
| on the box, loopback :4100 | `/healthz` → `ok:true`, `commit` == the deployed sha, `staffAuth: configured`, `feed: on`, `poller.configured: true` |
| from evergreen | `$TRUCK_FEED_URL/healthz` → 200, and `/feed/daily` without a bearer → 401 |

Set `HFVILLE_SSH_ALIAS` for the box section; either section is skipped (with
the manual commands printed) when its ssh alias is unset or unreachable. The
feed URL is read from `TRUCK_FEED_URL` locally, or from hf-mcp's own `.env` on
evergreen — it is never written down here.

`/healthz` is **not** publicly reachable (the whole hostname is Access-gated),
so `curl https://truck.thehfhotel.org/healthz` proving the gate is up is the
*expected* result, not a failure.

## Rollback

Every build is pushed to GHCR under its full commit sha, so a rollback is a
redeploy of an image that already exists — no rebuild, no revert race:

```bash
gh workflow run deploy.yml -f rollback_sha=<full 40-hex sha of a good commit>
gh run watch
bash scripts/verify-live.sh <that same sha>
```

With `rollback_sha` set, the build/push steps are skipped entirely; the box is
told to pull `ghcr.io/thehfhotel/linen-truck:<that sha>` and its `/healthz`
must report **that** sha (the image bakes its own `GIT_SHA`), so a rollback is
verified exactly like a forward deploy. Get the sha from `gh run list` or the
GHCR tag list.

Two notes:

- A bare `gh workflow run deploy.yml` with no input is **not** a rollback — it
  rebuilds the current `main`.
- A rollback does not revert the repository. Follow it with a `git revert` of
  the bad commit so `main` and production agree again; that is the safer
  default whenever the extra CI cycle is affordable.
- The database is on the host bind mount (`~/deploy-truck/app/data`), so an
  image rollback never touches data. A rollback across a schema migration is
  the one case that needs care — check `PRAGMA user_version` handling in
  `src/server/db.ts` before rolling back past one.

## Logs

- Container: `docker logs truck --tail 100` on the box. One line per poll cycle
  (`poll ok seen=<n> new=<n> ms=<n>` or `poll fail <proc>: <msg>`).
- Deploys: `~/deploy-truck/logs/deploy-<timestamp>.log`, one file per run.
- Poller status is also in `/healthz`:
  `poller: { configured, lastAt, lastOk, lastError, lastSeen, lastNew }`.

## Backups

The nightly `VACUUM INTO` runs **inside the app** at `BACKUP_TIME` (02:35
Bangkok), writing `data/backups/truck-<stamp>.db` and keeping the newest 14.
There is no host timer: this box gives us passwordless sudo for docker only
(ADR 0001). Ad hoc: `docker exec truck bun scripts/backup.ts`.

Backups live on the host bind mount, so they survive a container or image
change. They do **not** survive the box, so treat an occasional copy to another
machine as an owner task.

## Box-side one-time setup

Run by the owner; `scripts/owner/go-live.sh` does all of it. By hand:

1. Mint a key for this repo only:
   `ssh-keygen -t ed25519 -f ~/.ssh/truck-ci-deploy -N '' -C truck-ci-deploy`
2. Copy `scripts/deploy/run-deploy.sh` and `scripts/hfville/install.sh` to the
   box and run the installer with the **public** key on stdin and the hostname
   CI dials as its argument:
   `ssh <box-alias> 'bash ~/.truck-install/install.sh <public-hostname>' < ~/.ssh/truck-ci-deploy.pub`
   It creates `~/deploy-truck/{app/data,logs}`, installs the shim, writes one
   `command="…/run-deploy.sh",restrict` line into `authorized_keys`
   (idempotently), and prints the host key relabelled to that hostname. No
   sudo anywhere. It also prints the deploying user's uid: the image runs as
   uid 1000, so a different uid means the container cannot write the bind-mounted
   `app/data` and will crash-loop at boot (the shim's healthz loop then times
   out with no obvious cause).
3. Set the secrets on the repo (`gh secret set <name>`, value on stdin):
   `TRUCK_DEPLOY_SSH_KEY`, `HFVILLE_HOST_KEY`, `HFVILLE_SSH_TARGET`,
   `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `TRUCK_CF_ACCESS_AUD`,
   `TRUCK_FEED_TOKEN` (`openssl rand -hex 32`), `TRUCK_SINOTRACK_USER`,
   `TRUCK_SINOTRACK_PASSWORD`, `TRUCK_SINOTRACK_SERVER`, `TRUCK_PUBLIC_URL`.
4. Give hf-mcp on evergreen its `TRUCK_FEED_URL` and `TRUCK_FEED_TOKEN` in its
   host-managed `.env`, then recreate hf-mcp **with its shim's full compose
   file set** — a partial `docker compose up -d` on that host recreates the
   container wrong.
5. Flip `TRUCK_DEPLOY_ENABLED` to `1` and push, or dispatch the workflow.

Never write a secret value into this repo — reference the name only.

## Go-live (first deploy)

`bash ~/HF/linen-truck/scripts/owner/go-live.sh` — owner-run and interactive,
because it creates a public GitHub repository, applies Cloudflare changes,
mints an SSH key, installs a forced command on a box and sets repository
secrets. It refuses to start on a dirty working tree and re-runs
`check-no-secrets.sh` before publishing anything.

It walks steps 0–9: clean-tree gate → `gh repo create --public` → the hf-erp
Cloudflare apply (which prints the service-token id/secret and the Access
`aud` **once**, captured into shell variables and never echoed) → deploy key +
box install → `gh secret set` for every secret → the hf-erp commit with
explicit pathspecs → the hf-mcp wiring on evergreen → enable and dispatch the
deploy → `verify-live.sh` → the archive import command.

Each step is independently re-runnable with `FROM_STEP=<n>`. If step 2 has
already run, export `TRUCK_CI_CLIENT_ID`, `TRUCK_CI_CLIENT_SECRET` and
`TRUCK_ACCESS_AUD` before re-running — Cloudflare will not print a service
token twice.

Once live, seed the archived tracker days:

```bash
ssh "$HFVILLE_SSH_ALIAS" 'mkdir -p ~/deploy-truck/app/data/import'
scp <archive>/*.json "$HFVILLE_SSH_ALIAS:deploy-truck/app/data/import/"
ssh "$HFVILLE_SSH_ALIAS" 'docker exec truck sh -lc "bun scripts/import.ts /data/import/*.json"'
```
