// The signature must reproduce test/fixtures/sign-vector.json exactly (§4).
//
// That vector was produced by the Python client that logged in for real on
// 2026-09-05, so it pins the three values the platform actually accepted. The
// clock, the random string and the pad character are injected, which is the whole
// reason the check is possible.

import { describe, expect, test } from "bun:test";
import vector from "../fixtures/sign-vector.json";
import {
  appIdFor,
  createSinotrackClient,
  dataFor,
  records,
  signedForm,
  SinotrackError,
  tokenFor,
  type SinotrackClock,
} from "../../src/server/sinotrack.ts";

const clock: SinotrackClock = {
  now: () => vector.nTimeStamp,
  random: () => vector.strRandom,
  pad: () => vector.padChar,
};

describe("the sign vector", () => {
  test("data is N'…' per argument, comma joined", () => {
    expect(dataFor(vector.args)).toBe(vector.data);
  });

  test("strAppID is the '/'-padded host in base64", () => {
    expect(appIdFor(vector.server)).toBe(vector.strAppID);
    // The scheme and any path are stripped, and the host is lowercased.
    expect(appIdFor("HTTPS://242.SinoTrack.com/APP/AppJson.asp")).toBe(vector.strAppID);
  });

  test("strToken is cmd \\x11 data \\x11 field \\x11 \\x1b in base64", () => {
    expect(tokenFor(vector.cmd, vector.data, "", clock.pad)).toBe(vector.strToken);
  });

  test("the whole form reproduces the vector", () => {
    const form = signedForm({ server: vector.server, user: vector.user, cmd: vector.cmd, args: vector.args, clock });
    expect(form.strAppID).toBe(vector.strAppID);
    expect(form.strToken).toBe(vector.strToken);
    expect(form.strSign).toBe(vector.strSign);
    expect(form.strUser).toBe(vector.user);
    expect(form.nTimeStamp).toBe(String(vector.nTimeStamp));
    expect(form.strRandom).toBe(vector.strRandom);
  });

  test("a single quote in an argument is doubled, not dropped", () => {
    expect(dataFor(["o'brien"])).toBe("N'o''brien'");
  });
});

describe("records()", () => {
  test("zips m_arrField with each row of m_arrRecord", () => {
    expect(
      records({ m_isResultOk: 1, m_arrField: ["nTime", "dbLat"], m_arrRecord: [["1", "9.1"], ["2", "9.2"]] }),
    ).toEqual([
      { nTime: "1", dbLat: "9.1" },
      { nTime: "2", dbLat: "9.2" },
    ]);
  });

  test("a short row reads back as empty strings, never undefined", () => {
    expect(records({ m_isResultOk: 1, m_arrField: ["a", "b"], m_arrRecord: [["1"]] })).toEqual([{ a: "1", b: "" }]);
  });
});

describe("the client", () => {
  /** A fetch that captures the request instead of making one. */
  const capture = () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ m_isResultOk: 1, m_arrField: ["nType"], m_arrRecord: [["2"]] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fake };
  };

  test("posts the six form fields to /APP/AppJson.asp", async () => {
    const { calls, fake } = capture();
    const client = createSinotrackClient({ server: vector.server, user: vector.user, password: "x", fetch: fake, clock });
    const rows = await client.getTrack(vector.user, 1788508600, 1788595000, 1000000);

    expect(rows).toEqual([{ nType: "2" }]);
    expect(calls[0]?.url).toBe("https://242.sinotrack.com/APP/AppJson.asp");
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect([...form.keys()].sort()).toEqual([
      "nTimeStamp",
      "strAppID",
      "strRandom",
      "strSign",
      "strToken",
      "strUser",
    ]);
    expect(form.get("strToken")).toBe(vector.strToken);
    expect(form.get("strSign")).toBe(vector.strSign);
  });

  test("getObd sends the strOBD field selector and the leading 0 argument", async () => {
    const { calls, fake } = capture();
    const client = createSinotrackClient({ server: vector.server, user: vector.user, password: "x", fetch: fake, clock });
    await client.getObd("1000000001", 1, 2);
    const token = new URLSearchParams(calls[0]?.body ?? "").get("strToken") ?? "";
    const decoded = Buffer.from(token, "base64").toString("binary");
    expect(decoded.startsWith("Proc_GetOBD\x11N'0',N'1000000001',N'1',N'2',N'1000000'\x11strOBD\x11")).toBe(true);
  });

  test("m_isResultOk 0 throws a SinotrackError naming the proc, never the body", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ m_isResultOk: 0 }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = createSinotrackClient({ server: vector.server, user: vector.user, password: "hunter2", fetch: fake, clock });
    const err = await client.getLoginType(vector.user, "hunter2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinotrackError);
    expect((err as SinotrackError).proc).toBe("Proc_GetLoginType");
    // The password rides inside `data`/`strToken`; it must never reach a log line.
    expect((err as SinotrackError).message).not.toContain("hunter2");
  });

  test("a non-200 is an error, not an empty result set", async () => {
    const fake = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const client = createSinotrackClient({ server: vector.server, user: vector.user, password: "x", fetch: fake, clock });
    await expect(client.getCarInfo(vector.user)).rejects.toThrow(/HTTP 502/);
  });
});
