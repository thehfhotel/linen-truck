#!/usr/bin/env bash
# Post-deploy assertions (docs/CONTRACTS.md §10). Green CI is not live; this is.
#
#   bash scripts/verify-live.sh [expected-sha] [base-url]
#
# Environment:
#   HFVILLE_SSH_ALIAS   ssh alias for the HF Ville box. Unset/empty → that
#                       section is skipped and the manual commands are printed.
#   EVERGREEN_SSH       ssh alias for evergreen (default "evergreen"); empty
#                       skips the cross-site feed section.
#   TRUCK_FEED_URL      the address hf-mcp uses for the feed. Optional — when
#                       unset it is read on evergreen from hf-mcp's own .env,
#                       whose path you pass as HF_MCP_ENV (it is in the private
#                       ops note; no default here) so the URL never has to
#                       exist on this Mac.
#
# When an expected sha is given, a SKIPPED section is a FAILURE: "LIVE OK" must
# never be printed for a deploy nobody looked at from inside the gate.
#   TRUCK_BASE_URL      public origin (default https://truck.thehfhotel.org).
#
# Three sections, because no single vantage point can prove the whole thing:
#   public   — from the internet, through Cloudflare. Proves the gate is UP:
#              every route must redirect to Access, never answer 200.
#   box      — on the HF Ville box, on loopback, INSIDE the gate. Proves the
#              app is healthy and running the sha we deployed.
#   evergreen— from the other site. Proves /feed/* is reachable across the
#              site-to-site link and still refuses an unauthenticated caller.
#
# Nothing here prints a token, an address or a host key — only status codes and
# healthz fields. Safe to paste into an issue.
set -uo pipefail

SHA="${1:-}"
BASE="${2:-${TRUCK_BASE_URL:-https://truck.thehfhotel.org}}"
BOX_SSH="${HFVILLE_SSH_ALIAS-}"
EVG_SSH="${EVERGREEN_SSH-evergreen}"
HF_MCP_ENV="${HF_MCP_ENV:-}"
TODAY="$(TZ=Asia/Bangkok date +%F)"

fail=0
say()   { printf '%-58s %s\n' "$1" "$2"; }
check() { if [[ "$3" =~ $2 ]]; then say "$1" "ok ($3)"; else say "$1" "FAIL (got: $3, want: $2)"; fail=1; fi; }
code()  { curl -s -o /dev/null --max-time 15 -w '%{http_code}' "$@"; }

# ── public: the Access gate, from the internet ──────────────────────────────
echo "== public (through Cloudflare, no Access session)"
GATED='^(301|302|401|403)$'
check "GET /            → Access, never 200"  "$GATED" "$(code "$BASE/")"
check "GET /day/$TODAY  → Access, never 200"  "$GATED" "$(code "$BASE/day/$TODAY")"
check "GET /healthz     → Access, never 200"  "$GATED" "$(code "$BASE/healthz")"
check "GET /feed/daily  → Access, never 200"  "$GATED" "$(code "$BASE/feed/daily")"
check "redirect target is cloudflareaccess.com" 'cloudflareaccess\.com' \
      "$(curl -s -o /dev/null --max-time 15 -w '%{redirect_url}' "$BASE/")"

# ── box: the app itself, on loopback, inside the gate ───────────────────────
box_cmds='
H=$(curl -fsS --max-time 10 http://127.0.0.1:4100/healthz 2>/dev/null || echo "{}")
echo "HZ=$H"
'
echo
if [ -n "$BOX_SSH" ] && ssh -o BatchMode=yes -o ConnectTimeout=10 "$BOX_SSH" true 2>/dev/null; then
  echo "== on the HF Ville box (ssh \$HFVILLE_SSH_ALIAS, loopback :4100)"
  out=$(ssh -o BatchMode=yes "$BOX_SSH" "$box_cmds" 2>/dev/null)
  hz=$(printf '%s\n' "$out" | sed -n 's/^HZ=//p')
  field()  { printf '%s' "$hz" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
  flag()   { printf '%s' "$hz" | grep -o "\"$1\":\(true\|false\)" | head -1 | sed 's/.*://'; }
  check "healthz ok"                    '"ok":true'   "$hz"
  # The image bakes GIT_SHA at build time, so this field IS the deployed commit.
  # Compare on the 7-char prefix so a short sha on the command line works too.
  if [ -n "$SHA" ]; then
    check "healthz commit == deployed sha" "^${SHA:0:7}" "$(field commit)"
  else
    say  "healthz commit" "$(field commit)  (no sha given to compare)"
  fi
  check "healthz staffAuth configured"  '^configured$' "$(field staffAuth)"
  check "healthz feed on"               '^on$'         "$(field feed)"
  check "healthz poller.configured"     '^true$'       "$(flag configured)"
else
  echo "== box checks skipped (no ssh — set HFVILLE_SSH_ALIAS). On the box run:"
  echo "   curl -s http://127.0.0.1:4100/healthz   # ok:true, commit=${SHA:0:7}, staffAuth configured, feed on, poller.configured true"
  if [ -n "$SHA" ]; then say "box section" "NOT VERIFIED (sha given, section skipped)"; fail=1; fi
fi

# ── evergreen: the cross-site feed hf-mcp consumes ──────────────────────────
echo
if [ -n "$EVG_SSH" ] && ssh -o BatchMode=yes -o ConnectTimeout=10 "$EVG_SSH" true 2>/dev/null; then
  echo "== from evergreen (the estate's site-to-site link, hf-mcp's vantage point)"
  # The feed URL is private: prefer the local env var, otherwise read it on the
  # box from hf-mcp's own .env. Either way only status codes come back.
  evg_cmds='
U="'"${TRUCK_FEED_URL:-}"'"
if [ -z "$U" ] && [ -n "'"$HF_MCP_ENV"'" ] && [ -r "'"$HF_MCP_ENV"'" ]; then
  U=$(sed -n "s/^TRUCK_FEED_URL=//p" "'"$HF_MCP_ENV"'" | tail -1)
fi
if [ -z "$U" ]; then echo "URL=missing"; exit 0; fi
echo "URL=set"
echo "HEALTH=$(curl -s -o /dev/null --max-time 10 -w "%{http_code}" "$U/healthz")"
echo "FEED=$(curl -s -o /dev/null --max-time 10 -w "%{http_code}" "$U/feed/daily")"
'
  evg=$(ssh -o BatchMode=yes "$EVG_SSH" "$evg_cmds" 2>/dev/null)
  got() { printf '%s\n' "$evg" | sed -n "s/^$1=//p"; }
  if [ "$(got URL)" = "set" ]; then
    check "feed host reachable: GET /healthz → 200" '^200$' "$(got HEALTH)"
    check "GET /feed/daily without a bearer → 401" '^401$' "$(got FEED)"
  else
    say "TRUCK_FEED_URL" "FAIL (set TRUCK_FEED_URL, or HF_MCP_ENV to hf-mcp's .env path on evergreen)"
    fail=1
  fi
else
  echo "== evergreen checks skipped (no ssh — set EVERGREEN_SSH). On evergreen run:"
  echo '   curl -s -o /dev/null -w "%{http_code}\n" "$TRUCK_FEED_URL/healthz"     # 200'
  echo '   curl -s -o /dev/null -w "%{http_code}\n" "$TRUCK_FEED_URL/feed/daily"  # 401 (no bearer)'
  if [ -n "$SHA" ]; then say "evergreen section" "NOT VERIFIED (sha given, section skipped)"; fail=1; fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "LIVE OK — open $BASE/ (Google sign-in) and check today's report."
else
  echo "NOT LIVE / NOT VERIFIED — fix before announcing it. See docs/runbooks/deploy-and-rollback.md."
  exit 1
fi
