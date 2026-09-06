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
points, 4 trips, 3 legs (hfville→hf, hf→hfville, then the short hfville→hfville
hop), 0 unknown stops, 1 detour, 0 outside-hours runs, ~15.4 km.
`test/domain/summary.test.ts` asserts all of it. (Until the geofences widened to
600 m on 2026-09-06 the 14:18–14:22 stop, 368 m from the HF Ville centre, read as
an unknown stop and the two legs after it were one. The morning HF Ville stop
ends 13:34:15, the last fix before the truck reports movement — the two engine
restarts before it are settled (speed 0), and §3 rule 1 reads a settled fix
against a settled anchor as scatter whatever the engine is doing.)

**Do not regenerate or re-sort this file**: it is the only recorded day of real
truck movement, and the numbers in §3 were reviewed by the owner against it.

## `sign-vector.json`

The recorded request signature vector for `src/server/sinotrack.ts` (§4) — lets the
client's `strAppID` / `strToken` / `strSign` construction be reproduced exactly with
injected `now()`, `random()` and `pad()`. Contains no password.
