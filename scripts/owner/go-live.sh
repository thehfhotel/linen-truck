#!/usr/bin/env bash
#
# linen-truck — first deploy, owner recipe (docs/CONTRACTS.md §10).
#
# OWNER-RUN, INTERACTIVELY. An agent may not run this: it creates a GitHub
# repository, applies Cloudflare changes, mints an SSH key, installs a
# forced-command on a box and sets repository secrets. Run it yourself:
#
#     bash ~/HF/linen-truck/scripts/owner/go-live.sh
#
# NOT ONE REAL VALUE IS WRITTEN IN THIS FILE. Everything comes from the
# environment, from an interactive prompt, or from the stdout of the hf-erp
# Cloudflare script — and the credentials it captures are never echoed.
#
# Required in the environment before you start:
#   CF_API_TOKEN         Cloudflare API token, for the hf-erp apply (step 2)
#   HFVILLE_SSH_ALIAS    your local ssh alias for the HF Ville box (step 3)
# Prompted if absent:
#   HFVILLE_SSH_TARGET   user@host CI dials through the tunnel (step 3/4)
#   TRUCK_FEED_URL       the address hf-mcp will use for the feed (step 6)
# Optional:
#   FROM_STEP=<n>        resume at step n (the script is re-runnable)
#   REPO, HF_ERP_DIR
set -euo pipefail

REPO="${REPO:-thehfhotel/linen-truck}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ERP_DIR="${HF_ERP_DIR:-$HOME/HF/hf-erp}"
KEY="$HOME/.ssh/truck-ci-deploy"
FROM_STEP="${FROM_STEP:-0}"

# Captured, never printed. Pre-seeded from the environment so a re-run after a
# failed later step does not need Cloudflare's one-shot secrets again.
CI_CLIENT_ID="${TRUCK_CI_CLIENT_ID:-}"
CI_CLIENT_SECRET="${TRUCK_CI_CLIENT_SECRET:-}"
ACCESS_AUD="${TRUCK_ACCESS_AUD:-}"
FEED_TOKEN_VALUE=""
HOST_KEY_LINE=""

step() {
  local n="$1"; shift
  if [ "$FROM_STEP" -gt "$n" ]; then
    printf '\n\033[2m── step %s skipped (FROM_STEP=%s): %s\033[0m\n' "$n" "$FROM_STEP" "$*"
    return 1
  fi
  printf '\n\033[1m══ step %s — %s\033[0m\n' "$n" "$*"
  return 0
}
run()  { printf '   $ %s\n' "$*"; "$@"; }
ask()  { local __v="$1" __p="$2" __d="${3:-}" __in; read -r -p "   $__p${__d:+ [$__d]}: " __in || true;
         printf -v "$__v" '%s' "${__in:-$__d}"; }
asks() { local __v="$1" __p="$2" __in; read -r -s -p "   $__p (not echoed): " __in || true; echo;
         printf -v "$__v" '%s' "$__in"; }
pause(){ read -r -p "   ⏎ when done (or Ctrl-C to stop): " _ || true; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }

need gh; need git; need ssh; need ssh-keygen; need scp; need openssl

# ── 0. the working tree must be clean ───────────────────────────────────────
# Whatever is committed here is what gets published to a PUBLIC repository.
# A dirty tree means the thing you are about to push is not the thing you read.
if step 0 "refuse a dirty working tree"; then
  cd "$APP_DIR"
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    echo
    echo "   The linen-truck working tree is dirty. Commit or stash first —" >&2
    echo "   step 1 publishes this tree to a PUBLIC GitHub repository." >&2
    exit 1
  fi
  echo "   clean: $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"
  run bash scripts/check-no-secrets.sh
fi

# ── 1. publish the repository ───────────────────────────────────────────────
if step 1 "create $REPO (public) and push"; then
  cd "$APP_DIR"
  if gh repo view "$REPO" >/dev/null 2>&1; then
    echo "   $REPO already exists — skipping create"
  else
    # The secret gate scans the TREE. History is published too, so the first
    # push must be ONE fresh root commit made after the scrub (CONTRACTS §13).
    if [ "$(git rev-list --count HEAD)" -ne 1 ]; then
      echo "   HEAD has $(git rev-list --count HEAD) commits. A public repo must start from a" >&2
      echo "   single scrubbed root: git checkout --orphan publish && git add -A &&" >&2
      echo "   git commit -m 'linen-truck: initial public release' && git branch -M main" >&2
      exit 1
    fi
    echo "   PUBLIC repository. Anyone can read the code, the history and every"
    echo "   Actions log. scripts/check-no-secrets.sh passed above; continue?"
    pause
    run gh repo create "$REPO" --public --source . --push
  fi
  run gh repo view "$REPO" --json nameWithOwner,visibility --jq '.nameWithOwner + " (" + .visibility + ")"'
fi

# ── 2. Cloudflare: hostname, Access app, service token ──────────────────────
# hf-erp/infra/cloudflare/truck-ville.ts is idempotent and never deletes. It
# prints three marker lines ONCE — the service-token secret can never be read
# back from Cloudflare, so if this step succeeds and a later one fails, re-run
# with those three values exported instead of applying again.
if step 2 "apply hf-erp/infra/cloudflare/truck-ville.ts"; then
  if [ -n "$CI_CLIENT_ID" ] && [ -n "$CI_CLIENT_SECRET" ] && [ -n "$ACCESS_AUD" ]; then
    echo "   all three values already in the environment — skipping the apply"
  else
    [ -n "${CF_API_TOKEN:-}" ] || { echo "   export CF_API_TOKEN first (Cloudflare API token)" >&2; exit 1; }
    [ -d "$ERP_DIR" ] || { echo "   no hf-erp checkout at $ERP_DIR" >&2; exit 1; }
    out="$(mktemp)"; chmod 600 "$out"
    trap 'rm -f "$out"' EXIT
    echo "   running the apply; marker lines are captured, not shown:"
    ( cd "$ERP_DIR" && bun infra/cloudflare/truck-ville.ts --apply ) | tee "$out" \
      | sed -E 's/^(TRUCK_CI_CLIENT_ID|TRUCK_CI_CLIENT_SECRET|TRUCK_ACCESS_AUD)=.*/\1=<captured>/' \
      | sed 's/^/   | /'
    CI_CLIENT_ID="$(sed -n 's/^TRUCK_CI_CLIENT_ID=//p'     "$out" | tail -1)"
    CI_CLIENT_SECRET="$(sed -n 's/^TRUCK_CI_CLIENT_SECRET=//p' "$out" | tail -1)" # secret-scan-ok: reads a marker line, carries no value
    ACCESS_AUD="$(sed -n 's/^TRUCK_ACCESS_AUD=//p'          "$out" | tail -1)"
    rm -f "$out"; trap - EXIT
  fi
  for v in CI_CLIENT_ID CI_CLIENT_SECRET ACCESS_AUD; do
    val="${!v}"
    [ -n "$val" ] || { echo "   $v was not captured — the apply must print its marker line" >&2; exit 1; }
    echo "   $v captured (${#val} chars)"
  done
  unset val
fi

# ── 3. deploy key + box-side install ────────────────────────────────────────
if step 3 "mint the deploy key and install the shim on the box"; then
  if [ -f "$KEY" ]; then
    echo "   $KEY already exists — reusing it"
  else
    run ssh-keygen -t ed25519 -f "$KEY" -N '' -C truck-ci-deploy
  fi
  : "${HFVILLE_SSH_ALIAS:=}"
  [ -n "$HFVILLE_SSH_ALIAS" ] || ask HFVILLE_SSH_ALIAS "ssh alias for the HF Ville box"
  : "${HFVILLE_SSH_TARGET:=}"
  [ -n "$HFVILLE_SSH_TARGET" ] || ask HFVILLE_SSH_TARGET "user@host CI dials through the tunnel"
  PUBLIC_HOST="${HFVILLE_SSH_TARGET#*@}"

  run ssh "$HFVILLE_SSH_ALIAS" 'mkdir -p ~/.truck-install'
  run scp "$APP_DIR/scripts/deploy/run-deploy.sh" "$APP_DIR/scripts/hfville/install.sh" \
          "$HFVILLE_SSH_ALIAS:.truck-install/"
  echo "   running install.sh on the box (deploy public key on stdin)"
  install_out="$(ssh "$HFVILLE_SSH_ALIAS" "bash ~/.truck-install/install.sh '$PUBLIC_HOST'" < "$KEY.pub")"
  printf '%s\n' "$install_out" | sed 's/^/   | /'
  HOST_KEY_LINE="$(printf '%s\n' "$install_out" \
    | sed -n '/^BEGIN_HFVILLE_HOST_KEY$/,/^END_HFVILLE_HOST_KEY$/p' \
    | sed '1d;$d' | head -1)"
  [ -n "$HOST_KEY_LINE" ] || { echo "   install.sh printed no host key" >&2; exit 1; }
  echo "   host key captured (${#HOST_KEY_LINE} chars)"
fi

# ── 4. repository secrets ───────────────────────────────────────────────────
# `gh secret set` reads the value from stdin, so no value ever appears in a
# command line (and therefore never in `ps`, a shell history file or a log).
if step 4 "set the GitHub Actions secrets on $REPO"; then
  set_secret() { printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null && echo "   set $1 (${#2} chars)"; }

  [ -f "$KEY" ] || { echo "   $KEY missing — run step 3" >&2; exit 1; }
  set_secret TRUCK_DEPLOY_SSH_KEY "$(cat "$KEY")"

  if [ -z "$HOST_KEY_LINE" ]; then
    ask HOST_KEY_LINE "HFVILLE_HOST_KEY line printed by install.sh"
  fi
  set_secret HFVILLE_HOST_KEY "$HOST_KEY_LINE"

  : "${HFVILLE_SSH_TARGET:=}"
  [ -n "$HFVILLE_SSH_TARGET" ] || ask HFVILLE_SSH_TARGET "user@host CI dials through the tunnel"
  set_secret HFVILLE_SSH_TARGET "$HFVILLE_SSH_TARGET"

  [ -n "$CI_CLIENT_ID" ]     || asks CI_CLIENT_ID     "Access service token client id"
  [ -n "$CI_CLIENT_SECRET" ] || asks CI_CLIENT_SECRET "Access service token client secret"
  [ -n "$ACCESS_AUD" ]       || asks ACCESS_AUD       "Access application aud for the truck hostname"
  set_secret CF_ACCESS_CLIENT_ID     "$CI_CLIENT_ID"
  set_secret CF_ACCESS_CLIENT_SECRET "$CI_CLIENT_SECRET"
  set_secret TRUCK_CF_ACCESS_AUD     "$ACCESS_AUD"

  # 32 bytes of hex. Kept in this shell only long enough for step 6 to show you
  # the two lines hf-mcp needs; it is never written to a file here.
  FEED_TOKEN_VALUE="$(openssl rand -hex 32)"
  set_secret TRUCK_FEED_TOKEN "$FEED_TOKEN_VALUE"

  asks SINO_USER "SinoTrack login (the device id)"
  asks SINO_PASS "SinoTrack password"
  [ -n "$SINO_USER" ] && [ -n "$SINO_PASS" ] || { echo "   both SinoTrack values are required" >&2; exit 1; }
  set_secret TRUCK_SINOTRACK_USER     "$SINO_USER"
  set_secret TRUCK_SINOTRACK_PASSWORD "$SINO_PASS"
  unset SINO_USER SINO_PASS

  ask SINO_SERVER "SinoTrack cluster server" "https://242.sinotrack.com"
  set_secret TRUCK_SINOTRACK_SERVER "$SINO_SERVER"
  ask PUBLIC_URL_VALUE "public origin" "https://truck.thehfhotel.org"
  set_secret TRUCK_PUBLIC_URL "$PUBLIC_URL_VALUE"

  run gh secret list --repo "$REPO"
fi

# ── 5. commit the hf-erp side ───────────────────────────────────────────────
# EXPLICIT PATHSPECS ONLY. Other sessions share this checkout's git index, and
# a bare `git commit -a` there has swallowed a peer's staged work before.
if step 5 "commit and push the hf-erp changes"; then
  cd "$ERP_DIR"
  PATHS=(infra/cloudflare/truck-ville.ts src/modules.ts public/shell/hf-bar.js infra/cloudflare/sso.ts)
  present=()
  for p in "${PATHS[@]}"; do [ -e "$p" ] && present+=("$p"); done
  [ "${#present[@]}" -gt 0 ] || { echo "   none of the expected files exist in $ERP_DIR" >&2; exit 1; }
  run git add -- "${present[@]}"
  echo "   staged diff:"
  git --no-pager diff --cached --stat -- "${present[@]}" | sed 's/^/   | /'
  git --no-pager diff --cached -- "${present[@]}" | sed 's/^/   | /'
  echo "   commit and push these files?"
  pause
  run git commit -m "linen-truck: truck.thehfhotel.org Access app + portal card" -- "${present[@]}"
  # Push ONLY this commit: another session may have left unpushed commits on
  # this branch, and a bare `git push` would publish them too.
  ahead="$(git rev-list --count '@{u}..HEAD')"
  if [ "$ahead" -ne 1 ]; then
    echo "   $ahead commits are ahead of the upstream — not just ours:"
    git --no-pager log --oneline '@{u}..HEAD' | sed 's/^/   | /'
    echo "   push them all?"
    pause
  fi
  run git push origin HEAD
  cd "$APP_DIR"
fi

# ── 6. wire hf-mcp on evergreen ─────────────────────────────────────────────
# Manual: it needs the deploy user on evergreen, and hf-mcp must be recreated
# with its shim's FULL compose-file set — a partial `up -d` on that host
# recreates the container wrong.
if step 6 "hand hf-mcp its feed credentials (manual, on evergreen)"; then
  : "${TRUCK_FEED_URL:=}"
  [ -n "$TRUCK_FEED_URL" ] || ask TRUCK_FEED_URL "TRUCK_FEED_URL hf-mcp should use"
  if [ -z "$FEED_TOKEN_VALUE" ]; then
    echo "   step 4 did not run in this shell, so the feed token is not in memory."
    echo "   Rotate it: re-run with FROM_STEP=4, or set TRUCK_FEED_TOKEN by hand on"
    echo "   both sides (gh secret set TRUCK_FEED_TOKEN, and hf-mcp's .env)."
    asks FEED_TOKEN_VALUE "feed token to write into hf-mcp's .env"
  fi
  cat <<MSG

   ⚠  The next two lines contain a live token. They are for your terminal and
      hf-mcp's .env on evergreen only — never a file in this repo, never a chat.

   Append to hf-mcp's host-managed .env (path in the private ops note):

TRUCK_FEED_URL=$TRUCK_FEED_URL
TRUCK_FEED_TOKEN=$FEED_TOKEN_VALUE

   Then recreate hf-mcp with its shim's full compose-file set and prove the
   cross-site path works:

     docker exec hf-mcp sh -lc 'curl -s -o /dev/null -w "%{http_code}\\n" \\
       -H "Authorization: Bearer \$TRUCK_FEED_TOKEN" "\$TRUCK_FEED_URL/feed/daily?date=\$(date +%F)"'
     # expect 200 (and 401 without the header)

MSG
  pause
  clear || true
  echo "   (screen cleared — the token is no longer on it)"
fi

# ── 7. enable the deploy and run it ─────────────────────────────────────────
if step 7 "enable deploys and run the workflow"; then
  cd "$APP_DIR"
  run gh variable set TRUCK_DEPLOY_ENABLED --repo "$REPO" --body 1
  dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run gh workflow run deploy.yml --repo "$REPO"
  echo "   waiting for the dispatched run to appear…"
  RUN_ID=""
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --repo "$REPO" --workflow deploy.yml --event workflow_dispatch --limit 5 \
      --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$dispatched_at\")][0].databaseId // empty")"
    [ -n "$RUN_ID" ] && break
    sleep 3
  done
  [ -n "$RUN_ID" ] || { echo "   the dispatched run never appeared — check gh run list" >&2; exit 1; }
  run gh run watch "$RUN_ID" --repo "$REPO" --exit-status
fi

# ── 8. verify it is actually live ───────────────────────────────────────────
if step 8 "verify live"; then
  cd "$APP_DIR"
  SHA="$(git rev-parse HEAD)"
  : "${HFVILLE_SSH_ALIAS:=}"; : "${TRUCK_FEED_URL:=}"
  [ -n "$HFVILLE_SSH_ALIAS" ] || ask HFVILLE_SSH_ALIAS "ssh alias for the HF Ville box"
  [ -n "$TRUCK_FEED_URL" ]    || ask TRUCK_FEED_URL "TRUCK_FEED_URL hf-mcp uses"
  export HFVILLE_SSH_ALIAS TRUCK_FEED_URL
  run bash scripts/verify-live.sh "$SHA"
fi

# ── 9. seed the archive ─────────────────────────────────────────────────────
if step 9 "import the archived tracker days (manual)"; then
  cat <<'MSG'

   The box starts with an empty database. To load the days archived on the Mac:

     ssh "$HFVILLE_SSH_ALIAS" 'mkdir -p ~/deploy-truck/app/data/import'
     scp <archive>/*.json "$HFVILLE_SSH_ALIAS:deploy-truck/app/data/import/"
     ssh "$HFVILLE_SSH_ALIAS" 'docker exec truck sh -lc "bun scripts/import.ts /data/import/*.json"'

   Then open the day page for one of those dates and check the numbers against
   docs/CONTRACTS.md §3 ("Expected on the fixture").

MSG
fi

echo
echo "go-live: done."
