# Is "supply voltage < 10 V" a sound "possibly unplugged" rule for the truck's tracker?

Prepared 2026-09-30. Public-safe: no device id, no login, no password, no IMEI/ICCID/phone number,
no estate hostname or address. The unit is called "the linen truck's tracker" throughout. Read-only
research: no command was sent to the device, and nothing was changed on any box. Two read-only
vendor-cloud calls (one car-info, one last-position) were made once, and only a whitelist of
non-identifying fields was printed. The vendor's public web client (a static JavaScript file and a
language file) was downloaded and read.

Builds on [`self-hosted-tracker-server.md`](self-hosted-tracker-server.md) (H02 wire format, Traccar,
flespi, the ST-902 manual). It does not repeat that file.

Every claim carries its source. Sources are ranked: manufacturer manuals, product pages and the
vendor's own web client are primary; Traccar's source is primary for the H02 wire format; forum
posts are used **only as first-hand reports of real tests and are labelled "forum, first-hand"**;
manuals.plus and similar AI-summarised sites are not cited. Anything the research could not
confirm is marked **UNVERIFIED**.

---

## (a) Short answers

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | What does the tracker do when external power is cut? | The wired units (ST-901 / 901L / 906 / 906L / 907L, and the 901M/A/AL variants) carry a small built-in lithium cell; the manufacturer sells the "main power off / power failure alarm" on that cell. **No published runtime.** The one capacity figure on a manufacturer page is 3.7 V / 150 mAh (ST-907L). Nothing published says the unit keeps sending positions on the cell. | Cell exists: HIGH. Keeps reporting, and for how long: UNVERIFIED (about 2 h is an estimate, section c1). |
| 2 | What does `Voltages=` show on backup? | **Unknown, never observed and not documented.** It is the external supply on the wired unit (our own data: 13.2-14.4 V running, 12.2-12.8 V parked). The H02 "battery" field is a **level**, not a volt reading. Four outcomes are possible (0 / cell 3.7-4.2 V / frozen last value / field omitted); the evidence cannot pick one. | External supply: HIGH. Backup value: UNVERIFIED. |
| 3 | Is there a power-cut alarm? | Yes on paper. H02 status word **bit 19, active-low** (Traccar `processStatus`, lines 88-89). The **vendor's own web client** decodes `nAlarmState & 8` as "Main power cut off alarm" and `& 0x8000` as "Low voltage alarm". Three caveats: SMS and platform alarm are documented only for the ST-901M/A/AL manuals; new TQ-firmware units list `POWER ALARM:OFF` **by default** (three forum, first-hand reports); and one forum, first-hand report says the ST-901 never sent one. Our `nAlarmState` was 0 in every one of 5,878 rows. | Mapping: HIGH. That our unit raises it: LOW. |
| 4 | Silent or slower after power loss? | No document describes power-loss behaviour. A configurable **sleep mode** (default off) stops GPRS while parked. **Our unit already goes silent for hours with power connected** (15 gaps of 2 h or more in 25 days, longest 29.6 h, 12.2-12.8 V on both sides of every gap), so silence cannot mean unplugged. | Silence is not a signal: HIGH. Behaviour on backup: UNVERIFIED. |
| 5 | Is "supply voltage < 10 V" sound? | **Safe but nearly blind.** No false positives (lowest reading in 25 days: 11.5 V; the units are specified from 9-10 V up). It fires only if the platform keeps reporting a *real, falling* supply reading after unplug, which nobody has demonstrated. Use it as one leg of a multi-signal rule, and read the vendor's own **battery-level byte in `nTEState`**, which nothing in the app reads today. | Safe: HIGH. Sufficient alone: LOW. |

**Our unit (section b):** the vendor's car-info carries no model text. Its device-type code decodes,
through the vendor's own table, to the **"Tianqin" family, which matches the "TQ" firmware of the newer
ST-906 / ST-906L class**. Which exact ST-90x it is remains **UNVERIFIED**.

---

## (b) Which unit is ours

Read-only calls to the vendor cloud's car-info and last-position procs (one each). Only whitelisted
fields were printed.

| Field | Value | Meaning |
|---|---|---|
| `strDeviceModel`, `strModelID`, `strFactoryID` | empty | No model text is stored for this account. |
| `nTEType` | `12546` (0x3102) | High byte 0x31 = 49. The vendor's web client maps `(nTEType & 0xFF00) >> 8` through a type table (function `_x07cb`, table `_x069f`), and type 49 is `"Tianqin"`. Types 1 and 2 are `"Autoleaders"`, the classic H02 ST-901/902 generation. The low byte (0x02) is unexplained. |
| `nTEState` (car-info and last-position) | `6569992` (0x644008) | Same encoding as the track rows (section d2). |
| `nAlarmState` (last position) | `0` | |
| `strOther` (last position) | `Voltages=12.5;RecvTime=...` | |

**Inference (UNVERIFIED):** the firmware strings of the newer wired units in Traccar's test file and
forum threads look like `ST906(70ELASCD)_TQ_V_2.0 2024/08/12`, and "TQ" is plausibly "Tianqin".
That would make ours a TQ-generation ST-906 / ST-906L / ST-901L class device, whose SMS status
command `CXZT` reports `VOLT:` and whose `RCONF` lists `POWER ALARM:` (section c3). What settles it
is an `RCONF` / `CXZT` SMS to the unit, which needs the SIM number and is out of scope here (it is
already an owner decision in `self-hosted-tracker-server.md` (e)).

Two side facts from our own rows (5,878 rows, 2026-09-05 to 2026-09-30, read from the app's database):

- `nCarState` only ever holds 0, 0x4000 or 0x8000. The vendor client labels bit 128 as "Engine on"
  (`isEngineOpen`, char offset 417582 of its script; car-state table `_x069e`, offset 47240) and
  leaves 0x4000 / 0x8000 unlabelled. So the ACC input is **not** being reported as ignition, and **voltage is our only engine
  signal**.
- `nAlarmState` is 0 in all 5,878 rows.

---

## (c) Evidence

### c1. Backup battery: which models, how big, how long

| Model | Backup cell | Source |
|---|---|---|
| ST-907L | "Built-in lithium battery 3.7V 150mAh", operating voltage "10-50V input" | Manufacturer product page, https://www.sinotrackgps.com/-sinotrack-relay-gps-tracker-4g-st-907l-motorcycle-gps-system-car-small-gps-tracking-device |
| ST-906L | "Built-in backup battery to realize power failure alarm"; "Main Power off alarm"; input "9-75V" | Manufacturer product page, https://www.sinotrackgps.com/product-2024-st-906l-sino-track-gsm-lte-vehicle-tracking-device-smart-tracker-gps-for-motorcycle-4g ; FCC filing manual, https://fccid.io/2BA3V-ST-906L/User-Manual/User-Manual-6568898.pdf (section 1.2) |
| ST-901 / ST-901L | "Main power off alarm (With battery only)" (the parenthesis suggests the alarm needs a unit that has the cell) | Manufacturer product pages, https://www.sinotrackgps.com/product-sinotrack-st-901-small-gps-tracker-motorcycle-gps-system-vehicle-tracking-device-for-car and https://www.sinotrackgps.com/product-2024-free-app-sinotrack-pro-st-901l-motorcycle-gps-system-vehicle-tracking-device-car-4g-gps-tracker |
| ST-901 capacity | 150 mAh Li-ion | Only a platform vendor's device page states it (https://gps-trace.com/en/devices/sinotrack-st-901), **secondary, not the manufacturer** |
| ST-901M / 901A / 901AL | Cut power alarm sent "to server and SMS to the first number" when "the battery is disconnected" | Manufacturer manuals, e.g. https://shopcdnalpha.grainajz.com/category/365208/2174/60b9b0630ea1078b0ac8fa59367ba7de/ST-901A%20User%20Manual%20246.pdf (page 9), linked from https://www.sinotrackgps.com/manual-download |
| ST-902 (OBD plug-in) | Has a battery gauge and low-battery SMS ("Bat:5 = 100%, Bat:1 = 20%"); capacity not stated | ST-902 manual, https://www.softwarehousethailand.com/data/hardware/ST-902.pdf (function 12) |
| ST-906 / ST-907 (2G) | Manuals list only "Low battery alarm" ("Bat" 1-5 gauge); the manufacturer page for the 907 lists no backup cell and no power-off alarm; capacity not stated. flespi's integrator page says the ST-906 "features ... backup battery" (secondary, https://flespi.com/devices/sinotrack-st-906) | Manufacturer manuals from the same download page (function 11/12) |
| ST-903 / 904 / 905 / 915 / 925 | **Not wired trackers.** Portable units whose *only* power is a 3.7 V cell (1,050 mAh to 20,800 mAh). Irrelevant to an unplug rule | Manufacturer manuals ("SinoTrack GPS TRACKER USER MANUAL", ST-903/904 page 2 and ST-905/915/925 page 2), PDF copies hosted on GPS-Trace's content CDN and reachable from https://gps-trace.com/en/devices ; ST-903 product page https://www.sinotrackgps.com/product-remotely-control-sinotrack-st-903-device-coin-size-pet-tracker-gps737 |

**Models with no cell at all:** no primary source names one. The "(With battery only)" parenthesis on
the ST-901 page implies some units ship without it. **UNVERIFIED which.**

**Rated runtime on the cell: not published by the manufacturer** (searched the manuals, the product
pages and the FCC manual). Third-party listings quote "1-2 h" and "2-4 h", but those come through
AI-summarised search results and are not cited. The only first-hand runtime on record is a forum,
first-hand report of a *different* unit: an ST-904L (1,200 mAh) "battery life lasted about 16 hours
with Always ON mode ... tested 3 times"
(https://www.traccar.org/forums/topic/tracker-with-battery-for-car/page/2/). Scaling that
(about 75 mA average) to a 150 mAh cell gives **about 2 hours, my own arithmetic, UNVERIFIED**, and
it would shrink further with a 4G modem.

Does the unit *keep reporting* on the cell? The manuals never say. The evidence for "yes, for a
while" is design intent only: a cell, a level gauge and a low-battery alarm. One forum commenter
says the ST-902 "doesn't have standby" (https://www.traccar.org/forums/topic/st-902-vehicle-data/,
forum, unverified).

### c2. Which H02 field is voltage, and what is on the wire

| Item | Finding | Source |
|---|---|---|
| Position-message battery field | Non-capturing in Traccar's main pattern, so **discarded** | H02ProtocolDecoder.java line 204 (`.number("(?:d+,)?") // battery`) |
| Binary `$` message | One byte decoded by `decodeBattery` to a **percentage** (1-3 -> 0/10/20 %, 4-6 -> 60/80/100 %, up to 100 as-is, 0xF1-0xF6 -> 1-6) | lines 97-111, used at line 144 |
| `V3`, `LINK`, `HTBT` messages | Battery captured, but as level or an unscaled 4-hex value; these carry no fix | lines 272/531, 254/488, 306/628 |
| Trailing "data" group | Everything after the status word is stored as `io1`, `io2`, ... | lines 220-222, 416-421 |
| flespi | `battery.level` = "Internal battery level" (%), `battery.voltage` = "Internal battery voltage" (V), both from `*V1`, `*V4`-`*V8`; `power.cut.alarm` = "External power cut-off alarm event" from **message IDs 0x0200 / 0x0704 only** (the binary/JT808-style messages), **not** from the text sentences | https://flespi.com/protocols/sinotrack |
| First-hand ST-901 sample | Trailing group `..,472,01,60,60144,3643272`: cell fields; forum users found the battery level as `io5` "1 or 2 digits", and on one ST-901 "a long string" | forum, first-hand, https://www.traccar.org/forums/topic/sinotrack-st-901-battery-status-is-not-available/ |

**So the H02 "battery" number is the internal cell's level, and the vendor's `Voltages` value is
something else.** Evidence for that: (1) our `Voltages` swings 12.2-14.4 V with engine state, which
no 3.7 V cell can do; (2) the vendor's web client reads `Voltages` (fallback key `B_V`) for the
"Voltage" line, and reads a **separate** battery percentage from `nTEState` (section d2).

**Where a supply voltage does appear on the wire.** Two places, both from newer units:

1. The SMS/GPRS status reply of TQ-firmware units: `ST906(70SACD)_TQ_V_2.0 2024/06/07 ... UT:30,30,300 VOLT:12.9V ...`. Traccar's test file carries it as a GPRS `SMS` frame,
   H02ProtocolDecoderTest.java lines 351-353 (permalink below). First-hand `CXZT` replies on vehicle
   supply read `VOLT:12.1V`, `12.2V`, `13.1V`
   (https://www.traccar.org/forums/topic/secrets-revealed-sinotrack-st906l-4g-new-latest-firmware-release-st90670elascdtqv10-20231213-via-cxzt-command/,
   https://www.traccar.org/forums/topic/sinotrack-st906l4g-unknown-command-code-for-utxxxx300-upload-timer-300-value-in-cxzt/,
   forum, first-hand). One brand-new bench unit reported `VOLT:1.5V` (same thread; the power state
   during that read is not stated, **UNVERIFIED context**). That single reading hints the supply
   channel reads near zero, not 3.7-4.2 V, when there is no vehicle supply, but it is one
   uncontrolled data point.
2. The ST-901L 4G `V8` position sentence ends `..,<lac>,<cid>,<a>,<b>,<c>,0#` and `<c>` reads
   `126, 125, 132, 126, 126, 126` across successive fixes of a moving car
   (https://github.com/traccar/traccar/issues/6007, forum-style bug report with a raw log, also the
   two `V8` samples at H02ProtocolDecoderTest.java lines 15 and 18). **Inference, UNVERIFIED:** `<c>`
   is the supply in tenths of a volt. Traccar stores it as an anonymous `ioN` and never decodes it.

### c3. The power-cut alarm on the wire and in the vendor's client

**Traccar's decoder** (permalink
https://github.com/traccar/traccar/blob/dfb8c127957ae22bb05ae04ebbfa0be392978954/src/main/java/org/traccar/protocol/H02ProtocolDecoder.java#L80-L95):

| Lines | Code | Meaning |
|---|---|---|
| 82-83 | `if (!BitUtil.check(status, 0))` -> `ALARM_VIBRATION` | bit 0 low = vibration |
| 84-85 | `!check(status,1) \|\| !check(status,18)` -> `ALARM_SOS` | bits 1 / 18 low |
| 86-87 | `!check(status,2)` -> `ALARM_OVERSPEED` | bit 2 low |
| **88-89** | **`!BitUtil.check(status, 19)` -> `ALARM_POWER_CUT`** | **bit 19 low = power cut** |
| 92 | `position.set(KEY_IGNITION, BitUtil.check(status, 10))` | bit 10 high = ignition on |

Two properties matter: the flags are **active-low** (a normal word is `FFFFFBFF`, ignition off), and
the branches are an `else if` chain, so **power-cut is reported only if no vibration, SOS or
overspeed bit is also low.** `processStatus` runs for every text sentence that carries the 8-hex
status word (line 402) and for `NBR`, `LINK`, `V3` (lines 463, 496, 537).

**The bit table is not uniform across devices.** Traccar's author collected three vendors' meanings
in https://github.com/traccar/traccar/issues/2920. For bit 19 they read "Use backup battery" /
"GPS tracker is powered via built in battery" / "Terminal by backup battery power supply", and
bit 20 "Battery remove alarm" / "Main Power disconnect" / "Battery removed", bit 28 "Battery
demolition" / "Main power off Alarm". He answered: "The bit seems to mean different things for
different devices." **So bit 19 reads as "running on the backup cell", which coincides with a
power cut, and a device may instead use bit 20 or 28.**

**A first-hand capture of the transition** (forum, first-hand:
https://www.traccar.org/forums/topic/poweron-notification/; an H02 tracker, model not stated, same
`V1` layout as the ST-90x). Decoding the hex logs, the status word went `FFFFFBFF` (22:45:39) to
`EFF7FBFF` (22:45:49): **bit 19 and bit 28 cleared**, and Traccar raised a "power cut" event. Traccar's
author added "Alarms are always coming from devices directly. We don't have any logic on the server to
generate those." **This proves the wire mechanism exists on some H02 firmware. It does not prove ours
sends it.**

**Counter-evidence, forum, first-hand:**

- An ST-901 owner: "Power Cut alarm and ignition detection not working ... device just sends position
  data normally" (roughly 2017, https://www.traccar.org/forums/topic/sinotrack-st-901-config-issues/
  and its page 2).
- Another user pulled power on an H02 tracker: no data reached Traccar's debug log, but the tracker
  **sent an SMS** (https://github.com/traccar/traccar/issues/2920, comments of 2017-02-18). So on that
  device the alarm reached the phone by SMS and nothing arrived on the GPRS channel at that moment.
- An ST-902W owner unplugged it from the OBD port and got "a power off alarm and not the power cut
  notification" (https://www.traccar.org/forums/topic/sinotrack-st902w-does-not-send-power-cut-alarm/,
  no answer on the page).

**The manuals' SMS.** The ST-901M/A/AL manuals show the cut-power SMS as `STATE: LOW POWER ALARM ...
Bat:5`, the **same label as the low-battery alarm** (page 9 or 10, in the image). So a phone alert
cannot distinguish "unplugged" from "cell nearly flat".

**Default off on the newer firmware.** Three first-hand `RCONF` dumps from new ST-906L/4G units
(firmware 1.0 of 2023-12-13 and 2.0 of 2024-08-12) all read `POWER ALARM:OFF,ACCSMS:OFF,ACCCALL:OFF`
(same three threads as above, plus
https://www.traccar.org/forums/topic/sinotrack-st-906l-commands-missing-in-manual/, where the owner
asks for the missing "power alarm on/off" command and gets no answer). **No manual in the
manufacturer's download list documents the enable command. UNVERIFIED for our unit.**

**What the vendor's own client decodes** (its public web client,
https://www.sinotrack.com/gps-go.pc.min.v7.5_260828.js, served with a last-modified of 2026-09-01;
`Language/en.js` from the same site supplies the words; see "How to re-check" at the end):

`nAlarmState` (function `_x0743`, char offset 48986; label lines in `en.js` in brackets):

| Value | Label | `en.js` line |
|---|---|---|
| 1 | Bump alarm | |
| 2 | Cut off circuit | |
| 4 | Fuel cut off | |
| **8** | **"Main power cut off alarm"** | **192** |
| 16 / 32 | out of / into fence | |
| 64 | over speed | |
| 128 | urgent (SOS) | |
| 16384 / 134217728 | steal | |
| **32768** | **"Low voltage alarm"** (`isLowPowerAlarm`, offset 414446) | **455** |
| 131072 | shock | |

The client turns every set bit into text, and `GetImageURL` / `GetColor` switch the position icon
to the alarm style when that text is non-empty. So a device that reports a cut makes it to the
vendor's own map. **Nothing in any source maps H02 bit 19 to `nAlarmState` value 8. UNVERIFIED
that the cloud does it for the TQ family.**

### c4. Sleep, reporting interval, and silence

| Fact | Source |
|---|---|
| ACC-on interval default 20 s. ACC-off default 300 s (ST-906/906L), 180 s (ST-901M/A/AL), 20 s single interval (ST-902/907). Minimum 10 s. RCONF shows a second value ("GPRS UPLOAD TIME:20,120" in the ST-906 sample) | manufacturer manuals (function 16/17) |
| **Sleep mode**: `SLEEP<password> <N>`; "The tracker will sleep when the vehicle stopped for N minutes"; `RCONF` default `SLEEP:OFF` | manufacturer manuals (ST-906: function 17; ST-902: function 18); ST-902 manual function 14 |
| While asleep the device sends no GPRS, wakes on vibration, SMS or a call | forum, first-hand, https://www.traccar.org/forums/topic/sinotrack-st-901-config-issues/page/2/ ("no sending any data via GPRS") |
| `UT:a,b,c` on TQ firmware = ACC-on, ACC-off, **heartbeat 300 s** ("Tech support replied the 300 refers to the heart beat interval of 5 minutes") | forum, first-hand, https://www.traccar.org/forums/topic/sinotrack-st-906l4g-unknown-command-code-for-utxxxx300-upload-timer-300-value-in-cxzt/ |
| New TQ units can report in a 30 s on / 30 s off cycle and accept SMS only in the on window | forum, first-hand, "Secrets Revealed" thread above |
| Nothing anywhere describes a longer interval or a different mode **because power was lost** | searched every manual listed above |

**Our own unit** (25.4 days, 5,878 rows):

- Parked spacing between fixes: median 495 s, p90 511 s, p99 540 s; moving: median 49 s. That is the
  normal ACC-off cadence of this unit.
- **15 silences of 2 h or more**, longest 29.6 h. In every one the last row before and the first row
  after read **12.2-12.8 V**, and in 14 of the 15 the truck had not moved (0.00-0.38 km; the first
  gap spans 3.4 km). Power was therefore connected throughout.
- In 9 of the 15, the first row back is a stored-data row (`nTEState` bit 3) that reached us
  **4.6-6.2 hours after its own fix time** (`RecvTime` minus fix time 16,593-22,464 s). In the other
  6 the difference is under 3 minutes. So the unit is not "sleeping until a truck moves": it re-appears
  on its own, often delivering one late row.

---

## (d) The observed `nTEState` and `strOther`, decoded with the vendor's own tables

### d1. `strOther` and voltage

| Fact (5,878 rows) | Value |
|---|---|
| Rows with `Voltages=` | 5,825 |
| Range | 11.5-14.4 V. Engine-running 13.2-14.4, parked 12.2-12.8. Only 4 rows at 11.9 V or below (11.5, 11.8, 11.8, 11.9) |
| Rows with `RecvTime=` | 1,848, **all and only** the rows with `nTEState` bit 3 set |
| Rows with **no** `Voltages` | 53, all `nTEState` = 0x8 exactly |

### d2. `nTEState` (function `GetStrTEState`, offset 381997, and table `_x06d2`, offset 48140)

| Bit / field | Vendor label (`en.js` line) | Our data |
|---|---|---|
| **bits 16-23** (`(nTEState & 0xFF0000) >> 16`, capped at 100) | **"Power N%"**, drives the battery gauge (`GetPowerHtml`, offset 425636) | **0x64 = 100 on every row except the 53 0x8-only rows, where it is 0 and the client treats 0 as "unknown"** |
| 0x8 | "Send stored data2" (`FadezoneMakeup` + "2"; "Send stored data", `en.js` line 409) | 1,848 rows (store-and-forward, matches our reading) |
| 0x40 | "Send stored data" | never |
| 0x80 | "Invalid" (position invalid, line 132) | 14 rows, all parked at speed 0 with 12.3-14.0 V |
| 0x4 | "GPS fault" | never |
| 0x10 | "Battery fault" | never |
| 0x2000 / 0x1000 / 0x800 / 0x200 | LBS / Wifi / "Online" power saving / Bluetooth mode | never |
| **0x20000000** | **"Battery power"** (line 1213) | **never** |
| **0x40000000** | **"Shutdown"** (line 362) | **never** |
| **0x80000000** | **"Sleep"** (line 476) | **never** |
| 0x4000 (bit 14) | not in the client's table | on every non-0x8-only row (meaning UNVERIFIED) |

So `0x644000` = "100 % power, 0x4000 unknown", `0x644008` = plus "send stored data", `0x644080` = plus
"invalid position", `0x8` = a stored row with no context at all. **The bit-3-marks-stored-rows reading
in the app is confirmed by the vendor's own client.**

The 53 rows without voltage are **not** power events. Each is a stored row usually 1-2 s (at most 58 s) after
an ordinary row, with 12.1-14.0 V before and after, in 45 clusters. They fall mostly in a
once-a-day burst around 13:14 local from 2026-09-11 to 2026-09-24, plus one evening block on
2026-09-23. **Absent voltage on a stored
row is normal, and in our data has never appeared on a non-stored row.**

---

## (e) Is `supply < 10 V` a sound rule?

What each possible backup-mode behaviour would do to the rule:

| If the platform shows, on cell power ... | Rule `< 10 V` fires? | Evidence for it |
|---|---|---|
| a falling / near-zero supply reading | **yes** | one bench `VOLT:1.5V` (context unknown); a resistor-divider supply channel is the natural design; UNVERIFIED |
| the internal cell, 3.7-4.2 V | **yes** (incidentally) | flespi labels the H02 field as internal battery voltage; contradicted by `Voltages` behaving as the supply; UNVERIFIED |
| the last external value, frozen | **no** | nothing in any source; UNVERIFIED |
| nothing (field omitted) | **no**, and a null must stay null (`sinotrackRow.ts` comment) | 53 omitted rows exist but are stored rows; UNVERIFIED for cell power |

Half the outcomes defeat it. It also cannot separate "unplugged" from "car battery flat". The two
cases the rule was meant to cover look identical. On the other side it is very safe: the lowest
reading in 25 days is 11.5 V, and the units are specified for inputs from 9 V (ST-906L, FCC manual)
and 10 V (ST-907L, product page), so a real reading under 10 V means the vehicle supply has collapsed
or the wiring is loose.

**Would the alarm field plausibly fire?** Possibly, on the ST-901M/A/AL manuals' wording; less likely
on our TQ-generation unit, where three first-hand reports show the power alarm switched off out of the
box. Unproven either way. It costs nothing to read.

---

## (f) Recommendation

Do **not** make `< 10 V` the rule. Make "possibly unplugged" a small OR of independent signals, each
labelled with what it proves. It stays advisory ("possibly"), because none has been seen firing on
a real unplug.

| # | Signal (per fix) | Means | Fires falsely? | Fires on a real unplug? |
|---|---|---|---|---|
| **A** | `nAlarmState & 0x8` ("Main power cut off") or `& 0x8000` ("Low voltage") | the unit or platform says so | never in 5,878 rows. **HIGH** confidence it is correct when it fires | **LOW-MEDIUM**: needs POWER ALARM on and the mapping to hold |
| **B** | `nTEState` bit 29, 30 or 31 (`& 0x20000000`, `0x40000000`, `0x80000000`) | "Battery power", "Shutdown", "Sleep" per the vendor's client | never. **HIGH** | **LOW-MEDIUM**, same reasons |
| **C** | battery byte `(nTEState >> 16) & 0xFF` in **1-99** on a row with bit 3 clear (treat **0 as unknown** and ignore stored rows) | cell is not full: running on it, or recovering from it. Uses the vendor's own "Power N %" field | never (it is 100 on all 5,825 rows that carry it). **HIGH** | **MEDIUM**: the manuals describe a 5-step gauge (100/80/60/40/20 %), so after some minutes on a 150 mAh cell it should step down. Whether this unit feeds the byte from the cell is UNVERIFIED |
| **D** | `Voltages` present and `< 10 V` | supply collapsed, flat battery or a loose lead. **Word it "supply collapsed", not "unplugged"** | never. **HIGH** | **LOW**: only in the first two outcomes above |
| **E** | a **non-stored** row (bit 3 clear) with **no** `Voltages` | possible omission on cell power | never happened. Log only, do not page | **LOW**: pure speculation on the omit outcome |

**Do not use silence or a long gap.** It is the most obvious signal and the worst one: 15 gaps in 25
days, longest 29.6 h, all with power connected, most ending with one late stored row.

**Order of trust:** C first (cheapest, uses a field already stored and already correct), then A and
B (free), D as the fallback the finding text already knows, E logged only.

**One test settles the guessing, and it is reversible.** Owner-run, truck parked, engine off:
disconnect the tracker's supply lead for 30-60 minutes (a fuse pull is enough), watch the poller and
the vendor's own map, then restore it. Record, per fix, `strOther`, `nTEState`, `nAlarmState`. That
answers questions 2, 3 and 4 for *this* unit in one hour and tells which of A-E to keep. Two cautions:
if the power alarm is on, an SMS goes to the admin number, and a `LOW POWER ALARM` text (section c3)
will not say which cause. Reading `RCONF` / `CXZT` first (needs the SIM number, an owner decision in
`self-hosted-tracker-server.md`) would also show the model, `POWER ALARM:`, `SLEEP:` and `VOLT:`.

**Not decided here:** whether to use the H02 status word directly if the app ever runs Option A/B of
`self-hosted-tracker-server.md`. In that case signal A above becomes "bit 19 clear (and possibly bits
20 or 28)" from the raw sentence, and bit 19 clear should be read as "on backup cell", not only "power
cut".

---

## How to re-check the vendor-client claims

The web client is one minified line (no line numbers), so citations are function names and 0-based
character offsets into the script as served on 2026-09-30. Its `sha256` starts `a9056d92d6742bf8` and
the language file's starts `dc888b49c2c333e8`. Fetch the script, then search for the function name
(`GetStrTEState`, `GetStrAlarmState`, `_x06d2`, `_x0743`, `GetVoltageHtml`, `GetPowerHtml`,
`isLowPowerAlarm`, `_x07cb`, `_x069f`). The vendor ships new versions, so offsets will drift.

## Sources

Manufacturer and vendor (primary):
https://www.sinotrackgps.com/manual-download (links the ST-901M/A/AL, 902, 906, 906L, 907 manuals) ·
https://www.sinotrackgps.com/-sinotrack-relay-gps-tracker-4g-st-907l-motorcycle-gps-system-car-small-gps-tracking-device ·
https://www.sinotrackgps.com/product-2024-st-906l-sino-track-gsm-lte-vehicle-tracking-device-smart-tracker-gps-for-motorcycle-4g ·
https://www.sinotrackgps.com/product-sinotrack-st-901-small-gps-tracker-motorcycle-gps-system-vehicle-tracking-device-for-car ·
https://www.sinotrackgps.com/product-2024-free-app-sinotrack-pro-st-901l-motorcycle-gps-system-vehicle-tracking-device-car-4g-gps-tracker ·
https://www.sinotrackgps.com/product-remotely-control-sinotrack-st-903-device-coin-size-pet-tracker-gps737 ·
https://fccid.io/2BA3V-ST-906L/User-Manual/User-Manual-6568898.pdf ·
https://www.softwarehousethailand.com/data/hardware/ST-902.pdf ·
https://shopcdnalpha.grainajz.com/category/365208/2174/91927b90917e061cc6d702eb08cd45f0/ST-901M%20User%20Manual%20246.pdf ·
https://shopcdnalpha.grainajz.com/category/365208/2174/252ac82386e7b5251c1779ded0840b25/ST-906%20User%20Manual%20246.pdf ·
https://shopcdnalpha.grainajz.com/category/365208/2174/63ca66e875be7ae1ff2865bc8c7a92e7/ST-907%20User%20Manual%20246.pdf ·
https://www.sinotrack.com/gps-go.pc.min.v7.5_260828.js · https://www.sinotrack.com/Language/en.js

Protocol source (primary):
https://github.com/traccar/traccar/blob/dfb8c127957ae22bb05ae04ebbfa0be392978954/src/main/java/org/traccar/protocol/H02ProtocolDecoder.java ·
https://github.com/traccar/traccar/blob/cfa8933e4cea80e84cf99602f651055099470ce4/src/test/java/org/traccar/protocol/H02ProtocolDecoderTest.java ·
https://github.com/traccar/traccar/issues/2920 · https://github.com/traccar/traccar/issues/6007 ·
https://flespi.com/protocols/sinotrack · https://flespi.com/devices/sinotrack-st-906

Secondary, used only as leads or platform-vendor descriptions: https://gps-trace.com/en/devices/sinotrack-st-901

Forum, first-hand reports of real tests (labelled where used):
https://www.traccar.org/forums/topic/poweron-notification/ ·
https://www.traccar.org/forums/topic/sinotrack-st-901-config-issues/ (and /page/2/) ·
https://www.traccar.org/forums/topic/sinotrack-st902w-does-not-send-power-cut-alarm/ ·
https://www.traccar.org/forums/topic/secrets-revealed-sinotrack-st906l-4g-new-latest-firmware-release-st90670elascdtqv10-20231213-via-cxzt-command/ ·
https://www.traccar.org/forums/topic/sinotrack-st906l4g-unknown-command-code-for-utxxxx300-upload-timer-300-value-in-cxzt/ ·
https://www.traccar.org/forums/topic/sinotrack-st-906l-commands-missing-in-manual/ ·
https://www.traccar.org/forums/topic/st-901-sinotrack-to-traccar/ ·
https://www.traccar.org/forums/topic/sinotrack-st-901-battery-status-is-not-available/ ·
https://www.traccar.org/forums/topic/tracker-with-battery-for-car/page/2/ ·
https://www.traccar.org/forums/topic/st-902-vehicle-data/

Our own data: the app's `points` table (5,878 rows, 2026-09-05 to 2026-09-30), read-only, and one
car-info + one last-position call, 2026-09-30. Not published.
