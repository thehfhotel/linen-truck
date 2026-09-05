#!/usr/bin/env bash
# Public-repo secret gate (docs/CONTRACTS.md §13).
#
# This repository is PUBLIC: its code, history, issues and Actions logs are
# world-readable. A handful of identifiers must never appear in it — the truck's
# device id (which is also the SinoTrack login), the SinoTrack password, the
# feed token, any Cloudflare Access audience / app id / tunnel id / service
# token, and every private address or SSH target belonging to the estate's
# boxes. Those live in the PRIVATE ~/HF/hf-network ops note and in GitHub
# secrets; this repo may name them, never carry them.
#
# Scans TRACKED files only (`git ls-files`) — an untracked scratch file is not
# published, and scanning the whole working tree would drown in node_modules.
#
# Usage: bash scripts/check-no-secrets.sh        # exits 1 with the offending lines
#
# Escape hatch: a line carrying the marker `secret-scan-ok:` followed by a
# reason is skipped. It exists for values that LOOK like credentials but are
# published upstream constants (the pinned cloudflared release checksum). Adding
# a marker is a reviewable act — never add one to silence a real finding.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "check-no-secrets: not a git checkout — nothing to scan" >&2
  exit 1
fi

# Read the file list with a plain read loop, NOT `mapfile`: mapfile is bash 4+
# and stock macOS ships bash 3.2, where it fails with "command not found". The
# old form then left FILES unset, every scan matched nothing, and the script
# printed "clean" and exited 0 — a secret gate that silently scans zero files
# is worse than no gate at all, and CLAUDE.md tells developers to run this by
# hand before pushing. Hence also the hard failure below: an empty file list is
# a broken gate, never a pass.
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "check-no-secrets: git ls-files returned no files — refusing to report clean" >&2
  exit 1
fi

findings=0
ALLOW_MARKER='secret-scan-ok:'

# Every "<file>:<line>:" whose source line carries the escape-hatch marker.
# Precomputed once so the match-only rules below can honour it too.
EXEMPT_PREFIXES=$(printf '%s\n' "${FILES[@]}" | tr '\n' '\0' \
  | xargs -0 grep -nF -- "$ALLOW_MARKER" /dev/null 2>/dev/null \
  | cut -d: -f1,2 | sed 's/$/:/' || true)

drop_exempt() {
  if [ -n "$EXEMPT_PREFIXES" ]; then
    grep -vF -- "$EXEMPT_PREFIXES" || true
  else
    cat
  fi
}

report() { # name, hits
  [ -n "$2" ] || return 0
  findings=$((findings + 1))
  echo "── FORBIDDEN: $1"
  printf '%s\n' "$2" | sed 's/^/   /'
  echo
}

# scan <name> <extended-regex> [file-exclusion-regex] [line-allow-regex]
#   Reports the whole offending LINE. Use for patterns that are readable in
#   context (addresses, assignments, key headers). A 4th argument drops hits
#   whose line matches it (an allowlist inside a broad pattern).
scan() {
  local name="$1" pattern="$2" skip="${3:-}" allow="${4:-}" hits
  hits=$(printf '%s\n' "${FILES[@]}" \
    | { if [ -n "$skip" ]; then grep -Ev "$skip"; else cat; fi; } \
    | tr '\n' '\0' \
    | xargs -0 grep -nE -- "$pattern" /dev/null 2>/dev/null \
    | drop_exempt \
    | { if [ -n "$allow" ]; then grep -Ev "$allow"; else cat; fi; } || true)
  report "$name" "$hits"
}

# scan_word <name> <extended-regex> <output-exclusion-regex>
#   Like scan_match but with grep -w: the pattern must be a whole word (letters,
#   digits, underscore). -w tests the boundary without CONSUMING it, so two
#   forbidden numbers separated by one comma are both reported, and a digit run
#   inside a hex pin (one word with letters) never matches.
scan_word() {
  local name="$1" pattern="$2" drop="$3" hits
  hits=$(printf '%s\n' "${FILES[@]}" | tr '\n' '\0' \
    | xargs -0 grep -nowE -- "$pattern" /dev/null 2>/dev/null \
    | drop_exempt \
    | { if [ -n "$drop" ]; then grep -Ev "$drop"; else cat; fi; } || true)
  report "$name" "$hits"
}

# scan_match <name> <extended-regex> <output-exclusion-regex>
#   Reports only the MATCHED TEXT (file:line:match). Use where a broad numeric
#   pattern needs exemptions the regex itself cannot express — matching on the
#   match rather than the line means one exempt number on a line does not
#   whitewash a forbidden one next to it.
scan_match() {
  local name="$1" pattern="$2" drop="$3" hits
  hits=$(printf '%s\n' "${FILES[@]}" | tr '\n' '\0' \
    | xargs -0 grep -noE -- "$pattern" /dev/null 2>/dev/null \
    | drop_exempt \
    | { if [ -n "$drop" ]; then grep -Ev "$drop"; else cat; fi; } || true)
  report "$name" "$hits"
}

echo "check-no-secrets: scanning ${#FILES[@]} tracked files"
echo

# ── addresses ───────────────────────────────────────────────────────────────
# Private LAN, WireGuard overlay and Tailscale CGNAT addresses of estate boxes.
# Each pattern requires a following digit so that this file, and §13's own list
# of the same prefixes in docs/CONTRACTS.md, do not match themselves.
scan "private LAN address (192.168.x)"        '192\.168\.[0-9]'
scan "WireGuard overlay address (10.10.10.x)" '10\.10\.10\.[0-9]'
scan "Tailscale CGNAT address (100.64/10)" \
     '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]'

# ── SSH targets and box hostnames ───────────────────────────────────────────
# Box user@host must never be written down; it is the HFVILLE_SSH_TARGET secret.
# Command-agnostic: ssh/scp/rsync/sftp anywhere on the line, plus the bare
# scp/rsync target form (name, at-sign, host, colon).
scan "SSH-style target on an ssh/scp/rsync/sftp line" '(ssh|scp|rsync|sftp)[^|;&]*[[:space:]][A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+'
scan "scp/rsync-style target (name, at-sign, host, colon)" '[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:'
scan "estate host in an @-address"              '[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+\.thehfhotel\.org'
# Estate hostnames: only the app hostnames behind Cloudflare may be named. A
# box's own hostname (the SSH hop, the host-key subject) is an ALLOWLIST miss —
# extend the list here for a new app, never for a box.
scan "estate hostname outside the app allowlist" \
     '\b(([A-Za-z0-9_-]+)\.)?[A-Za-z0-9_-]+\.thehfhotel\.org\b' \
     '' '(truck|housekeeping|works|feedback|summary|mcp|erp|rooms|rooms-ville|id|www)\.thehfhotel\.org'
scan "Cloudflare team domain other than the documented one" \
     '[A-Za-z0-9-]+\.cloudflareaccess\.com' '' 'laikaexpress\.cloudflareaccess\.com'

# ── Cloudflare identifiers ──────────────────────────────────────────────────
# Tunnel ids, Access app ids and service-token ids are all UUIDs; an Access
# audience is 64 hex characters.
scan "Cloudflare tunnel hostname with a real id" \
     '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.cfargotunnel\.com'
scan "UUID (tunnel / Access app / service-token id)" \
     '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b'
# bun.lock is excluded: lockfile integrity digests are long hex by nature.
scan "64-hex string (Access audience / token shaped)" \
     '\b[0-9a-f]{64}\b' '^bun\.lock$'

# ── device identity ─────────────────────────────────────────────────────────
# The truck's device id is a bare 10-digit number and is also the platform
# login. Two exemptions: the synthetic id used by every fixture and test, and
# 10-digit epoch seconds (17xxxxxxxx covers 2023-11 onward — the fixtures, the
# contract's JSON examples and any future test data). Word boundaries here are
# non-alphanumeric so a 40- or 64-character hex pin can never trip this.
scan_word "bare 10-digit id (device id / platform login)" \
  '[0-9]{10}' ':(1000000001|17[0-9]{8})$'
# ICCIDs are 19-20 digits, IMEIs 15. A digit run preceded by "." is the
# fractional part of a float (report rounding tests), never an identifier.
scan_match "ICCID / IMEI-length digit run (15-20 digits)" \
  '(^|[^0-9A-Za-z.])[0-9]{15,20}([^0-9A-Za-z]|$)' ''

# ── credentials with a value ────────────────────────────────────────────────
# A *_PASSWORD or *_TOKEN assignment whose next character is not a shell
# expansion ($), a placeholder (<) or whitespace. So FEED_TOKEN=${FEED_TOKEN},
# an empty SINOTRACK_PASSWORD= at end of line, and SINOTRACK_USER=<10-digit
# device id> all pass, while an assignment carrying a real hex token does not.
#
# The two patterns below are ASSEMBLED from a variable on purpose: written out
# in full, this file's own source lines would match its own rules.
# A value "starts" with a character that is not a shell expansion ($), a
# placeholder (<), whitespace, or a quote — OR with a quote followed by any
# character other than $ or a closing quote (so KEY="$VAR" and KEY="" pass,
# while KEY="hunter2" does not). Only the `=` form: YAML/TS `KEY: value` is
# covered by the value-shaped rules above (UUID, 64-hex, client id, digit runs).
VALUE_START="([^<\$[:space:]\"']|[\"'][^\$\"'])"
CRED_NAME='(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|CREDENTIAL)'
scan "credential assignment with a literal value" "${CRED_NAME}=$VALUE_START"
# A Cloudflare Access service-token client id is 32 hex followed by ".access".
scan "Cloudflare service-token client id"          '\b[0-9a-f]{32}\.access\b'
# An OpenSSH private key must never be committed, whatever the filename.
scan "private key material"           '-----BEGIN [A-Z ]*PRIVATE KEY'

if [ "$findings" -gt 0 ]; then
  cat >&2 <<'MSG'
check-no-secrets: FAILED.

Each block above is a class of identifier docs/CONTRACTS.md §13 forbids in this
PUBLIC repository. Fix by replacing the value with the NAME of the secret or
config var that carries it (e.g. "the HFVILLE_SSH_TARGET secret", "the address
in the private ops note"), never by loosening a pattern here.

If the line is genuinely a published upstream constant, append the marker
  secret-scan-ok: <why>
to that line — and expect a reviewer to ask.
MSG
  exit 1
fi

echo "check-no-secrets: clean"
