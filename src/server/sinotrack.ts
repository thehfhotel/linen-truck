// linen-truck — the SinoTrack platform client (docs/CONTRACTS.md §4).
//
// A port of the Python client that logged in for real on 2026-09-05. The whole
// protocol is ONE endpoint — `POST {server}/APP/AppJson.asp`, form-urlencoded,
// NO cookies and no session: every call carries its own signature, so there is
// nothing to keep alive and nothing to refresh.
//
// The six form fields (§4):
//
//   strAppID     base64 of the host, lowercased, scheme stripped, '/'-padded to
//                a length divisible by 3 (the platform's own quirk: it pads the
//                PLAINTEXT so the base64 never carries '=').
//   strToken     base64 of `cmd \x11 data \x11 field \x11 \x1b`, padded the same
//                way but with digits.
//   strSign      md5(nTimeStamp + strRandom + strUser + strAppID + strToken).
//   strUser, nTimeStamp (ms), strRandom (14 digits).
//
// `test/fixtures/sign-vector.json` pins all three against the working Python
// client, which is why `now`/`random`/`pad` are INJECTED rather than read from
// the global clock — see `SinotrackClock`.
//
// SECRECY: the account password is not a form field of its own. It travels as an
// argument of `Proc_GetLoginType`, which means it is inside `data` and therefore
// inside `strToken`. So nothing in this file ever logs or throws with `data`, the
// token, the form body or the response body — only the proc name and a short
// reason. `SinotrackError.message` is safe to print.

const ENDPOINT_PATH = "/APP/AppJson.asp";

/** Per-call timeout (§4). The platform answers a 2-day track in well under this. */
export const CALL_TIMEOUT_MS = 20_000;

/** The three non-deterministic inputs of a signature, injected so tests can pin them. */
export interface SinotrackClock {
  /** Epoch MILLISECONDS — `nTimeStamp` is in ms even though the args are seconds. */
  now(): number;
  /** `strRandom`: 14 digits in the reference client. */
  random(): string;
  /** One filler character for the base64 pre-padding. */
  pad(): string;
}

const digits = (n: number): string => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join("");
};

export const REAL_CLOCK: SinotrackClock = {
  now: () => Date.now(),
  random: () => digits(14),
  pad: () => digits(1),
};

/** Every failure of a platform call, tagged with the proc that produced it. */
export class SinotrackError extends Error {
  readonly proc: string;
  /** The message WITHOUT the `proc: ` prefix, so a log line can add its own. */
  readonly reason: string;
  constructor(proc: string, reason: string) {
    super(`${proc}: ${reason}`);
    this.name = "SinotrackError";
    this.proc = proc;
    this.reason = reason;
  }
}

/** One platform record: field name → the string the platform sent. */
export type SinotrackRow = Record<string, string>;

export interface RawResponse {
  m_isResultOk: number;
  m_arrField: string[];
  m_arrRecord: string[][];
}

// ── the signature (§4) ──────────────────────────────────────────────────────

/** base64 of a byte string; the inputs here are all latin-1 by construction. */
const b64 = (s: string): string => Buffer.from(s, "binary").toString("base64");

/**
 * `strAppID` — base64 of the bare host, lowercased, '/'-padded until the
 * PLAINTEXT length divides by 3 (so the base64 is padding-free).
 */
export function appIdFor(server: string): string {
  let host = server
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (host === "") throw new SinotrackError("appId", "empty server host");
  while (host.length % 3 !== 0) host += "/";
  return b64(host);
}

/** `data` — `N'…'` per argument, single quotes doubled, comma joined. */
export const dataFor = (args: readonly (string | number)[]): string =>
  args.map((a) => `N'${String(a).replace(/'/g, "''")}'`).join(",");

/**
 * `strToken` — base64 of `cmd \x11 data \x11 field \x11 \x1b`, plaintext padded
 * with `pad()` characters until its length divides by 3.
 */
export function tokenFor(cmd: string, data: string, field: string, pad: () => string): string {
  let raw = `${cmd}\x11${data}\x11${field}\x11\x1b`;
  while (raw.length % 3 !== 0) raw += pad();
  return b64(raw);
}

/** `strSign` — lowercase hex md5 of the five values concatenated in this order. */
export const signFor = (timestampMs: number, random: string, user: string, appId: string, token: string): string =>
  new Bun.CryptoHasher("md5").update(`${String(timestampMs)}${random}${user}${appId}${token}`).digest("hex");

export interface SignedForm {
  strAppID: string;
  strUser: string;
  nTimeStamp: string;
  strRandom: string;
  strSign: string;
  strToken: string;
}

/** The six form fields for one call — the unit `test/server/sinotrack.test.ts` pins. */
export function signedForm(opts: {
  server: string;
  user: string;
  cmd: string;
  args: readonly (string | number)[];
  field?: string;
  clock: SinotrackClock;
}): SignedForm {
  const appId = appIdFor(opts.server);
  const token = tokenFor(opts.cmd, dataFor(opts.args), opts.field ?? "", opts.clock.pad);
  const timestampMs = opts.clock.now();
  const random = opts.clock.random();
  return {
    strAppID: appId,
    strUser: opts.user,
    nTimeStamp: String(timestampMs),
    strRandom: random,
    strSign: signFor(timestampMs, random, opts.user, appId, token),
    strToken: token,
  };
}

/** Zips `m_arrField` with each row of `m_arrRecord` (§4). */
export function records(res: RawResponse): SinotrackRow[] {
  const fields = Array.isArray(res.m_arrField) ? res.m_arrField : [];
  const rows = Array.isArray(res.m_arrRecord) ? res.m_arrRecord : [];
  return rows.map((values) => {
    const row: SinotrackRow = {};
    for (let i = 0; i < fields.length; i++) row[String(fields[i])] = String(values[i] ?? "");
    return row;
  });
}

// ── the client ──────────────────────────────────────────────────────────────

export interface SinotrackClient {
  /** One signed call. Throws `SinotrackError` for transport, shape and platform failures. */
  call(cmd: string, args: readonly (string | number)[], field?: string): Promise<SinotrackRow[]>;
  /** `nType` "2" means the login is a DEVICE id rather than a user account. */
  getLoginType(user: string, password: string): Promise<SinotrackRow[]>;
  getCarInfo(user: string): Promise<SinotrackRow[]>;
  getLastPosition(user: string): Promise<SinotrackRow[]>;
  getTrack(teid: string, fromS: number, toS: number, limit?: number): Promise<SinotrackRow[]>;
  getMileageEveryDay(teid: string, fromS: number, toS: number): Promise<SinotrackRow[]>;
  getObd(teid: string, fromS: number, toS: number): Promise<SinotrackRow[]>;
}

export interface SinotrackOptions {
  server: string;
  user: string;
  password: string;
  fetch?: typeof fetch;
  clock?: SinotrackClock;
  timeoutMs?: number;
}

/** The row cap the platform is asked for; §4's `limit` default. */
export const TRACK_LIMIT = 1_000_000;

export function createSinotrackClient(opts: SinotrackOptions): SinotrackClient {
  const server = opts.server.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const clock = opts.clock ?? REAL_CLOCK;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;

  async function call(cmd: string, args: readonly (string | number)[], field = ""): Promise<SinotrackRow[]> {
    const form = new URLSearchParams(
      signedForm({ server, user: opts.user, cmd, args, field, clock }) as unknown as Record<string, string>,
    );

    let res: Response;
    try {
      res = await doFetch(`${server}${ENDPOINT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Deliberately only the reason — never the body, which carries the token.
      throw new SinotrackError(cmd, err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw new SinotrackError(cmd, `platform answered HTTP ${res.status}`);

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new SinotrackError(cmd, "platform answered a body that is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null) throw new SinotrackError(cmd, "platform answered a non-object");
    const body = parsed as Partial<RawResponse>;
    if (body.m_isResultOk !== 1) throw new SinotrackError(cmd, `m_isResultOk=${String(body.m_isResultOk)}`);
    return records({
      m_isResultOk: 1,
      m_arrField: body.m_arrField ?? [],
      m_arrRecord: body.m_arrRecord ?? [],
    });
  }

  return {
    call,
    getLoginType: (user, password) => call("Proc_GetLoginType", [user, password]),
    getCarInfo: (user) => call("Proc_GetCarInfo", [user]),
    getLastPosition: (user) => call("Proc_GetLastPosition", [user]),
    getTrack: (teid, fromS, toS, limit = TRACK_LIMIT) =>
      call("Proc_GetTrack", [teid, Math.floor(fromS), Math.floor(toS), limit]),
    getMileageEveryDay: (teid, fromS, toS) =>
      call("Proc_GetMileageEveryDay", [teid, Math.floor(fromS), Math.floor(toS)]),
    // §4 spells this one out: a leading 0 and the `strOBD` field selector.
    getObd: (teid, fromS, toS) =>
      call("Proc_GetOBD", [0, teid, Math.floor(fromS), Math.floor(toS), TRACK_LIMIT], "strOBD"),
  };
}
