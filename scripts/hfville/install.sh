#!/usr/bin/env bash
#
# One-time box-side install for the linen-truck deploy path (docs/CONTRACTS.md §10).
#
# RUN THIS ON THE HF VILLE BOX, as the deploying user. It needs NO sudo: this
# box gives us passwordless sudo for docker only, has no /srv we may write and
# no systemd unit we may install, so the whole deploy path lives in $HOME.
#
#   ssh <box-alias> 'mkdir -p ~/.truck-install'
#   scp scripts/deploy/run-deploy.sh scripts/hfville/install.sh <box-alias>:~/.truck-install/
#   ssh <box-alias> 'bash ~/.truck-install/install.sh <public-hostname>' < ~/.ssh/truck-ci-deploy.pub
#
#   $1     the hostname the CI job SSHes to (the host half of the
#          HFVILLE_SSH_TARGET secret). Only used to relabel the printed host
#          key — this script never stores it.
#   stdin  the PUBLIC half of the deploy keypair, one line.
#
# scripts/owner/go-live.sh does all of the above for you.
#
# What it creates:
#   ~/deploy-truck/run-deploy.sh   the forced-command shim (from this repo)
#   ~/deploy-truck/app/            compose file, .env (0600), data/
#   ~/deploy-truck/logs/           one log per deploy run
#   ~/.ssh/authorized_keys         one line, forced-command + restrict
#
# Idempotent: re-running replaces the shim and rewrites the single key line.
set -euo pipefail

HOSTNAME_FOR_KEY="${1:-}"
if [ -z "$HOSTNAME_FOR_KEY" ]; then
  echo "usage: install.sh <public-hostname>   (< deploy key on stdin)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Accept either layout: the two files copied side by side (what go-live.sh
# does), or a full checkout of the repo on the box.
SRC="${RUN_DEPLOY_SRC:-}"
if [ -z "$SRC" ]; then
  for candidate in "$HERE/run-deploy.sh" "$HERE/../deploy/run-deploy.sh"; do
    [ -f "$candidate" ] && { SRC="$candidate"; break; }
  done
fi
[ -n "$SRC" ] && [ -f "$SRC" ] || {
  echo "install.sh: cannot find run-deploy.sh next to this script or at ../deploy/ — set RUN_DEPLOY_SRC" >&2
  exit 1
}

ROOT="$HOME/deploy-truck"
SHIM="$ROOT/run-deploy.sh"
AUTH="$HOME/.ssh/authorized_keys"
TAG="truck-ci-deploy"

echo "==> directories"
mkdir -p "$ROOT/app/data" "$ROOT/logs"
chmod 700 "$ROOT"
echo "    $ROOT/{app/data,logs}"
# The container runs as uid 1000 (the `bun` user) and writes SQLite plus its
# nightly backups into the bind-mounted app/data. A deploying user with a
# different uid means the container cannot write and crash-loops at boot — the
# deploy would go red in the shim's healthz loop with no obvious cause, so say
# it here instead.
MY_UID="$(id -u)"
echo "    data dir owned by uid $MY_UID"
if [ "$MY_UID" != "1000" ]; then
  echo "    ⚠  the image runs as uid 1000; this user is $MY_UID."
  echo "       If the container cannot write $ROOT/app/data it will crash-loop:"
  echo "       chmod 777 $ROOT/app/data, or rebuild the image with a matching uid."
fi

echo "==> shim"
install -m 755 "$SRC" "$SHIM"
echo "    $SHIM  ($(wc -l < "$SHIM" | tr -d ' ') lines)"

echo "==> authorized_keys"
PUBKEY="$(cat)"
PUBKEY="${PUBKEY%%$'\n'*}"
case "$PUBKEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) : ;;
  *) echo "install.sh: stdin was not an SSH public key" >&2; exit 1 ;;
esac
# The key material, without the type prefix and trailing comment — the stable
# identity of this key across re-runs and comment changes.
KEY_BODY="$(printf '%s' "$PUBKEY" | awk '{print $2}')"
[ -n "$KEY_BODY" ] || { echo "install.sh: could not read the key body" >&2; exit 1; }

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$AUTH"
chmod 600 "$AUTH"

# Drop any previous line for this key OR this tag, then append exactly one.
# `restrict` disables agent/port/X11 forwarding and PTY allocation; the forced
# command means this key can start the shim and nothing else.
tmp="$(mktemp)"
grep -vF -e "$KEY_BODY" -e "$TAG" "$AUTH" > "$tmp" || true
printf 'command="%s",restrict %s %s\n' "$SHIM" "$PUBKEY" "$TAG" >> "$tmp"
cat "$tmp" > "$AUTH"
rm -f "$tmp"
chmod 600 "$AUTH"
echo "    1 forced-command line for $TAG (file now $(wc -l < "$AUTH" | tr -d ' ') lines)"

echo "==> host key for the HFVILLE_HOST_KEY secret"
HOST_PUB=""
for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
  [ -r "$f" ] && { HOST_PUB="$(awk '{print $1" "$2}' "$f")"; break; }
done
if [ -z "$HOST_PUB" ]; then
  HOST_PUB="$(ssh-keyscan -t ed25519 -T 10 127.0.0.1 2>/dev/null | awk 'NF==3 {print $2" "$3; exit}')"
fi
[ -n "$HOST_PUB" ] || { echo "install.sh: could not read a host key" >&2; exit 1; }

# Relabelled to the hostname CI dials, because that is the name ssh will compare
# against known_hosts. The value is public key material, not a credential, but
# it is stored as a secret so the hostname never lands in the public repo.
echo "BEGIN_HFVILLE_HOST_KEY"
printf '%s %s\n' "$HOSTNAME_FOR_KEY" "$HOST_PUB"
echo "END_HFVILLE_HOST_KEY"

echo "==> done. Deploys will land in $ROOT/app and log to $ROOT/logs."
