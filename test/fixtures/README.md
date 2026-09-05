# test/fixtures

Checked-in, frozen inputs. Nothing here is generated at test time and nothing here
reaches the network.

## `2026-09-05.raw.json`

84 raw `Proc_GetTrack` rows for the linen truck (device id replaced by the synthetic `1000000001`), pulled from
the SinoTrack platform on 2026-09-05 and archived before the device rolled its
~1-day history off. Rows are exactly as the platform returns them — every field is
a **string**, and the interesting extras hide in `strOther`
(`"Voltages=13.2;RecvTime=1788585018"`; one row carries no voltage at all).

Two rows are duplicate timestamps (`1788585075`, `1788592695`), which is why
`cleanPoints` turns 84 rows into **82 points**. There are no `(0, 0)` fixes in this
file, but the platform does emit them while the GPS is cold, so `cleanPoints` drops
those too.

This is the day `docs/CONTRACTS.md` §3 pins the whole segmentation against — 82
points, 4 trips, 2 legs (hfville→hf, then hf→hfville through one unknown stop),
1 unknown stop, 1 detour, 0 outside-hours runs, ~15.7 km. `test/domain/summary.test.ts`
asserts all of it. **Do not regenerate or re-sort this file**: it is the only
recorded day of real truck movement, and the numbers in §3 were reviewed by the
owner against it.

## `sign-vector.json`

The recorded request signature vector for `src/server/sinotrack.ts` (§4) — lets the
client's `strAppID` / `strToken` / `strSign` construction be reproduced exactly with
injected `now()`, `random()` and `pad()`. Contains no password.
