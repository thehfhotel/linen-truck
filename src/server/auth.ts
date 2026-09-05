// linen-truck — staff identity (docs/CONTRACTS.md §7).
//
// Copied from ~/HF/guest-feedback/src/server/auth.ts, with the audience env
// renamed to CF_ACCESS_AUD, the CSRF app header value changed to `truck`, and the
// kiosk-branch claim dropped (this repo has no per-branch identity).
//
// Unlike feedback, the WHOLE hostname sits behind one Cloudflare Access
// application — there is no public tree here. The aud check still lives in the
// app rather than only at the edge, because an ingress rule can be edited in the
// dashboard and this file cannot; it is the second lock on the same door.
//
// Fail closed, in precedence order:
//
//   1. the dev bypass, possible only OUTSIDE production, only when
//      ALLOW_DEV_AUTH=1, and only while CF_ACCESS_AUD is still empty. The last
//      condition is what stops it ever shadowing a configured audience.
//   2. no audience configured -> 503 on every route. Never "allow because
//      unconfigured": that is how a half-finished deploy becomes an open door.
//   3. the RS256 JWT, verified against the team domain's JWKS.
//
// A JWKS fetch failure is a 503, not a 401: the caller's token may be perfectly
// good and we simply cannot check it, and answering 401 would train a browser to
// bounce a manager through a login that would not have helped.

import type { Config } from "./config.ts";
import type { Deps } from "./app.ts";

type Json = Record<string, any>;

export interface Identity {
  email: string;
  name: string | null;
}

export type StaffAuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: 401 | 503; error: "unauthorized" | "unavailable" };

/** Dev/test only, and impossible under NODE_ENV=production even when set (§7). */
export function devAuthEnabled(config: Config): boolean {
  return config.allowDevAuth && !config.isProduction;
}

// ── CSRF: DELIBERATELY ABSENT (§7) ────────────────────────────────────────
//
// The whole HTTP surface is GET, so there is nothing for a forged cross-site
// request to do here: no state changes, and Cloudflare Access already stands in
// front of every page. Feedback's `checkCsrf` was carried over with this file and
// then never called, and a security check nobody runs is worse than none — it
// reads as covered.
//
// THE FIRST MUTATING ROUTE MUST BRING IT BACK, in the same shape as
// guest-feedback: the Access cookie is sent cross-site and is therefore not a
// CSRF defence on its own, so a non-GET request must carry `X-HF-App: truck` (a
// header no cross-origin form can set) AND an Origin/Referer whose origin equals
// `config.publicOrigin` — which is what that config field is still computed for —
// and it must be checked BEFORE the JWT verification below.

// ── JWT verification (RS256, Web Crypto, JWKS cached 10 min) ────────────────

const JWKS_TTL_MS = 10 * 60_000;

let jwksCache: { at: number; team: string; keys: Json[] } | undefined;

/** Thrown when the JWKS itself could not be read — the caller turns it into 503. */
class JwksUnavailable extends Error {}

async function jwksKeys(deps: Deps): Promise<Json[]> {
  const team = deps.config.cfAccessTeamDomain;
  const at = deps.now().getTime();
  if (jwksCache && jwksCache.team === team && at - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;

  let data: Json;
  try {
    const res = await deps.fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`certs endpoint answered ${res.status}`);
    data = (await res.json()) as Json;
  } catch (err) {
    throw new JwksUnavailable(err instanceof Error ? err.message : String(err));
  }
  const keys = Array.isArray(data?.keys) ? (data.keys as Json[]) : [];
  jwksCache = { at, team, keys };
  return keys;
}

const b64urlJson = (s: string): Json => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/**
 * Verifies one Cloudflare Access JWT. Returns the payload, or null for ANY
 * verification failure (shape, algorithm, unknown kid, signature, issuer,
 * audience, expiry). Throws only when the JWKS could not be fetched.
 */
export async function verifyAccessJwt(token: string, deps: Deps): Promise<Json | null> {
  const wantAud = deps.config.cfAccessAud;
  if (wantAud.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: Json;
  let payload: Json;
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  const key = (await jwksKeys(deps)).find((k) => k.kid === header.kid);
  if (!key) return null;

  let signatureOk = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    signatureOk = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      Uint8Array.from(Buffer.from(s, "base64url")),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    return null;
  }
  if (!signatureOk) return null;

  const nowSec = Math.floor(deps.now().getTime() / 1000);
  // Expiry is MANDATORY and must be a number. Every other check in this function
  // is mandatory; a token whose `exp` is missing or is the string "1756800000"
  // would otherwise be accepted forever by every replica, with JWKS rotation the
  // only thing that could ever invalidate it. This file fails closed.
  if (typeof payload.exp !== "number" || payload.exp < nowSec) return null;
  if (payload.nbf !== undefined && payload.nbf !== null) {
    if (typeof payload.nbf !== "number" || payload.nbf > nowSec + 60) return null;
  }
  if (payload.iss !== `https://${deps.config.cfAccessTeamDomain}`) return null;
  const got = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!got.some((a: unknown) => typeof a === "string" && wantAud.includes(a))) return null;
  return payload;
}

const warned = { unconfigured: false };

function identityFor(email: string, nameClaim: unknown, config: Config): Identity {
  const address = email.trim().toLowerCase();
  const claimed = typeof nameClaim === "string" && nameClaim.trim() !== "" ? nameClaim.trim() : null;
  void config;
  return { email: address, name: claimed };
}

/**
 * Resolves the caller of a `/*` request. Precedence is exactly §7 and
 * the order is load bearing — see the header comment.
 */
export async function authenticateStaff(req: Request, deps: Deps): Promise<StaffAuthResult> {
  const config = deps.config;

  // 1. dev bypass — only outside production, only while no audience is set.
  if (devAuthEnabled(config) && config.cfAccessAud.length === 0) {
    const devEmail = (req.headers.get("x-dev-email") ?? "").trim();
    if (devEmail !== "") return { ok: true, identity: identityFor(devEmail, null, config) };
  }

  // 2. fail closed when the audience is unset.
  if (config.cfAccessAud.length === 0) {
    if (!warned.unconfigured) {
      warned.unconfigured = true;
      console.error("auth: CF_ACCESS_AUD is unset - refusing every request until it is configured");
    }
    return { ok: false, status: 503, error: "unavailable" };
  }

  // 3. the Cloudflare Access JWT.
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, status: 401, error: "unauthorized" };

  let payload: Json | null;
  try {
    payload = await verifyAccessJwt(token, deps);
  } catch (err) {
    if (err instanceof JwksUnavailable) {
      console.error(`auth: JWKS unavailable: ${err.message}`);
      return { ok: false, status: 503, error: "unavailable" };
    }
    console.error(`auth: token verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (!payload || typeof payload.email !== "string" || payload.email.trim() === "") {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true, identity: identityFor(payload.email, payload.name, config) };
}

/** Test-only handles — same shape as every sibling module's `_internal`. */
export const _internal = {
  resetJwksCacheForTests(): void {
    jwksCache = undefined;
  },
  resetWarningsForTests(): void {
    warned.unconfigured = false;
  },
};
