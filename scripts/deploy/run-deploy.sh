#!/usr/bin/env bash
#
# ~/deploy-truck/run-deploy.sh — the deploy shim on the HF Ville box.
#
# Installed by scripts/hfville/install.sh as the FORCED COMMAND on the truck-ci
# deploy key, so an SSH session opened with that key can run this and nothing
# else — no shell, no arbitrary command (docs/CONTRACTS.md §10). GitHub Actions
# pipes one JSON payload over stdin:
#
#   { "commit_sha": "<40 hex>",
#     "deploy_payload_b64": "<base64 tar.gz containing docker-compose.yml>",
#     "ghcr": { "user": "...", "token": "..." },
#     "env":  { "CF_ACCESS_AUD": "...", ... } }
#
# This box has no /srv we can write and no systemd unit we can install (docker
# is the only passwordless sudo), so everything lives under the deploying
# user's home directory.
#
# THE CALLER'S LOG IS A PUBLIC GITHUB ACTIONS LOG. Everything this script
# prints ends up world-readable, so it prints commit shas, counts and health
# outcomes — never an env key's value, never the .env, never the payload.
set -euo pipefail

ROOT="$HOME/deploy-truck"
DEPLOY_DIR="$ROOT/app"
LOG_DIR="$ROOT/logs"
LOCK_FILE="$ROOT/.run-deploy.lock"
HEALTH_URL="http://127.0.0.1:4100/healthz"
CONTAINER="truck"

mkdir -p "$DEPLOY_DIR/data" "$LOG_DIR"

LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

# One deploy at a time. A queued second push waits for nothing — it fails fast
# and can be re-run, which is safer than two `compose up` racing on one dir.
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "::error::another truck deploy is already running (lock: $LOCK_FILE)"; exit 1; }

echo "[deploy] start $(date -Iseconds)"

# 4 MB ceiling: the real payload is a two-file tarball plus a small env map
# (tens of KB). Anything larger is a mistake or an attack, and reading it
# unbounded from stdin would be a memory hazard on a small box.
MAX_BYTES=$((4 * 1024 * 1024))
PAYLOAD=$(head -c $((MAX_BYTES + 1)))
if [ "${#PAYLOAD}" -gt "$MAX_BYTES" ]; then
  echo "::error::payload exceeds ${MAX_BYTES} bytes — refusing"
  exit 1
fi

printf '%s' "$PAYLOAD" | jq -e 'has("commit_sha") and has("deploy_payload_b64") and has("ghcr")' >/dev/null \
  || { echo "::error::malformed payload (missing fields)"; exit 1; }

COMMIT_SHA=$(printf '%s' "$PAYLOAD" | jq -r '.commit_sha')
case "$COMMIT_SHA" in
  *[!0-9a-f]*|"") echo "::error::commit_sha is not lowercase hex"; exit 1 ;;
esac
[ "${#COMMIT_SHA}" -eq 40 ] || { echo "::error::commit_sha is not 40 characters"; exit 1; }
echo "[deploy] commit: $COMMIT_SHA"

GHCR_USER=$(printf '%s' "$PAYLOAD" | jq -r '.ghcr.user')
GHCR_TOKEN=$(printf '%s' "$PAYLOAD" | jq -r '.ghcr.token')
[ -n "$GHCR_USER" ] && [ -n "$GHCR_TOKEN" ] || { echo "::error::missing ghcr.user / ghcr.token"; exit 1; }

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null \
  || { echo "::error::docker login ghcr.io failed"; exit 1; }
echo "[deploy] ghcr authenticated as $GHCR_USER"

# ── compose file ────────────────────────────────────────────────────────────
printf '%s' "$PAYLOAD" | jq -r '.deploy_payload_b64' | base64 -d | tar -xz -C "$DEPLOY_DIR"
[ -f "$DEPLOY_DIR/docker-compose.yml" ] || { echo "::error::tar extract incomplete (no docker-compose.yml)"; exit 1; }

# ── .env ────────────────────────────────────────────────────────────────────
# Written 0600 before a single value lands in it, and never echoed. Keys are
# validated: a key outside [A-Z0-9_] would let a crafted payload inject compose
# syntax, and ALLOW_DEV_AUTH would disable Cloudflare Access on a live box —
# CI gates that too, this is the second lock on the same door.
BAD_KEYS=$(printf '%s' "$PAYLOAD" | jq -r '.env // {} | keys[]' | grep -vE '^[A-Z][A-Z0-9_]*$' || true)
if [ -n "$BAD_KEYS" ]; then
  echo "::error::env payload has malformed keys:"
  printf '%s\n' "$BAD_KEYS"
  exit 1
fi
if printf '%s' "$PAYLOAD" | jq -e '.env // {} | has("ALLOW_DEV_AUTH")' >/dev/null; then
  echo "::error::ALLOW_DEV_AUTH in the deploy payload — refusing to disable Access on a live box"
  exit 1
fi

ENV_FILE="$DEPLOY_DIR/.env"
( umask 077; : > "$ENV_FILE" )
chmod 600 "$ENV_FILE"
# Compose interpolates `$` inside .env values; a password containing `$` would
# reach the container mangled. Escape it as `$$` (the dotenv spec's literal $).
printf '%s' "$PAYLOAD" | jq -r '.env // {} | to_entries[] | "\(.key)=\(.value | gsub("\\$"; "$$"))"' >> "$ENV_FILE"
echo "[deploy] wrote .env ($(wc -l < "$ENV_FILE" | tr -d ' ') keys, mode $(stat -c %a "$ENV_FILE" 2>/dev/null || echo 600))"

cd "$DEPLOY_DIR"

# ── image + container ───────────────────────────────────────────────────────
retry_compose() {
  local attempt sleep_s
  for attempt in 1 2 3 4 5; do
    if docker compose "$@"; then
      return 0
    fi
    sleep_s=$((attempt * 5))
    echo "::warning::compose $* attempt $attempt failed, retrying in ${sleep_s}s"
    sleep "$sleep_s"
  done
  echo "::error::compose $* failed after 5 attempts"
  return 1
}

retry_compose pull
docker compose up -d --remove-orphans

# ── the only definition of "deployed" ───────────────────────────────────────
# /healthz is database-free and echoes the GIT_SHA baked into the image. Polling
# until it equals the sha we were asked to deploy is what makes a green Actions
# run mean something: a container that came up on the PREVIOUS image (failed
# pull, stale tag) fails here instead of passing quietly. 30 x 2 s = 60 s.
echo "[deploy] waiting for $HEALTH_URL to report commit $COMMIT_SHA"
live=""
for i in $(seq 1 30); do
  body=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)
  live=$(printf '%s' "$body" | jq -r '.commit // ""' 2>/dev/null || true)
  if [ "$live" = "$COMMIT_SHA" ]; then
    echo "[deploy] healthz reports $COMMIT_SHA after ${i} attempt(s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "::error::healthz never reported $COMMIT_SHA (last seen: '${live:-<no response>}')"
    docker logs "$CONTAINER" --tail 50 || true
    exit 1
  fi
  sleep 2
done

echo "[deploy] complete"
docker compose ps
docker image prune -f >/dev/null 2>&1 || true
