# Google Map Tiles API (2D roadmap) behind a Bun tile proxy for Leaflet — research

Date: 2026-09-30. All quotes fetched live today from primary pages (raw text kept in `scratchpad/raw/`).
UNCONFIRMED = not stated on any primary page I could reach. "Inference" = my reading, not a Google statement.

Source URL keys:
- [SESS] https://developers.google.com/maps/documentation/tile/session_tokens
- [ROAD] https://developers.google.com/maps/documentation/tile/roadmap
- [2D] https://developers.google.com/maps/documentation/tile/2d-tiles-overview
- [POL] https://developers.google.com/maps/documentation/tile/policies
- [USE] https://developers.google.com/maps/documentation/tile/usage-and-billing
- [ERR] https://developers.google.com/maps/documentation/tile/error_handling
- [REL] https://developers.google.com/maps/documentation/tile/release-notes
- [SKU] https://developers.google.com/maps/billing-and-pricing/sku-details
- [PRICE] https://developers.google.com/maps/billing-and-pricing/pricing
- [BILL] https://developers.google.com/maps/billing-and-pricing/overview
- [COST] https://developers.google.com/maps/billing-and-pricing/manage-costs
- [START] https://developers.google.com/maps/get-started
- [SEC] https://developers.google.com/maps/api-security-best-practices
- [TOS] https://cloud.google.com/maps-platform/terms  (Google Maps Platform Terms of Service)
- [SST] https://cloud.google.com/maps-platform/terms/maps-service-terms
- [CORE] https://cloud.google.com/maps-platform/terms/maps-services/

## Headline findings (read these first)

1. **Default daily quota is now 100,000 tiles/day/project, not 15,000.** [REL] 21 May 2026: "Old Default: 15,000 queries per day (QPD) / New Default: 100,000 QPD". The [USE] page still says 15,000/day and a "$200 credit until Feb 28, 2025" — that page is stale. Consequence: the default cap equals the entire monthly free tier (100,000) in ONE day, so it protects nothing. A consumer override (quota override) is required, e.g. ~3,000/day (3,000 x 31 = 93,000 < 100,000).
2. **Cache legality is thin.** The Terms forbid caching except as the Service Specific Terms allow; the [SST] has NO Map Tiles section at all. The only permission is the [POL] Cache-Control language ("your client must respect the max-age value ..."). Actual `Cache-Control` values are not documented anywhere (UNCONFIRMED). If Google sends `private`, a server-side shared cache should not store it (HTTP semantics, inference). If it sends short/zero max-age, the cache buys little.
3. **Proxy + OSM fallback are grey areas, not clearly allowed** (Q5). The riskiest bits: [TOS] 3.2.3(a) "...store, reshare, or rehost Google Maps Content outside the services" and 3.2.3(e) "No Use With Non-Google Maps ... with or near a non-Google Map in a Customer Application".
4. **Billing must be enabled on the project** ("you must enable billing on each of your projects"). Free usage: 100,000 2D tile events/month, then $0.60/1,000.
5. At our traffic (3 viewers, ~30 views/day) even NO cache is ~30–90k tiles/month; the cache mostly guards against runaway loops. See Q8.

## Q1. Session (createSession)

| Item | Finding | Source |
|---|---|---|
| Endpoint | `POST https://tile.googleapis.com/v1/createSession?key=YOUR_API_KEY`, header `Content-Type: application/json`: "You must send the request with a `Content-Type: application/json` header." | [SESS] |
| Required fields | `mapType` (`roadmap`), `language`, `region`. Doc's roadmap example body: `{"mapType":"roadmap","language":"en-US","region":"US"}` | [ROAD], [SESS] |
| language | "An IETF language tag that specifies the language used to display information on the tiles. For example, en-US specifies the English language as spoken in the United States." `th` / `th-TH` is syntactically valid; that Thai labels actually render for Surat Thani = UNCONFIRMED (test once) | [SESS] |
| region | "A Common Locale Data Repository region identifier (two uppercase letters) that represents the physical location of the user. For example, US." -> `TH` | [SESS] |
| scale | optional: `scaleFactor1x` (default), `scaleFactor2x`, `scaleFactor4x`. "Scales-up the size of map elements (such as road labels), while retaining the tile size and coverage area of the default tile." | [SESS] |
| highDpi | optional. "If true, then the number of pixels in each of the x and y dimensions is multiplied by the scale factor (that is , 2x or 4x). The coverage area of the tile remains unchanged. This parameter works only with scale values of 2x or 4x. It has no effect on 1x scale tiles." | [SESS] |
| imageFormat | optional `jpeg`/`png`; "If you don't specify an imageFormat, then the best format for the tile is chosen automatically." | [SESS] |
| Tile size | Response example: `"tileWidth": 256, "tileHeight": 256, "imageFormat": "png"`. Size with highDpi 2x: implied 512 px (coverage unchanged), exact response value UNCONFIRMED | [SESS] |
| Response | `{session, expiry, tileWidth, tileHeight, imageFormat}`; `expiry` = "time (in seconds since the epoch)" | [SESS] |
| Lifetime | "A session token is valid for two weeks from its creation time, but this policy might change without notice." Also: "You can use the same session token across multiple clients." Expired -> error `expired`: "you must get a new session token" | [SESS], [ERR] |
| Billable? | createSession is not a billable trigger: the 2D SKU's "Billable event" is "Request that returns a 2D map tile" [SKU]; and "Session token requests, viewport information requests, Street View Metadata requests ... don't impact your daily quota." [USE]. (Explicit "createSession is free" sentence on the billing pages: UNCONFIRMED; the SKU definition implies it.) Limit: 6,000 session/viewport/metadata requests per project per minute [USE]. | [SKU], [USE] |

## Q2. Tile request

| Item | Finding | Source |
|---|---|---|
| URL | `GET https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=SESSION&key=API_KEY&orientation=0` | [ROAD] |
| Params | `session` (required; "You include it as the value of a session parameter appended to all request URLs"), `key`, optional `orientation` (0/90/180/270, "degrees of counter-clockwise rotation"). z: "ranging from 0 to 22". x,y are standard tile coords ("Map and tile coordinates in the Maps JavaScript API"), x in [0, 2^z-1] | [ROAD], [ERR] |
| Content-Type | Not documented as a header; the session `imageFormat` is `png` or `jpeg`; the example saves `example_tile.png`. Read the actual `Content-Type` and pass through. | [SESS], [ROAD] |
| Cache-Control | "Map Tiles API responses may include Cache-Control headers which should be implemented according to the HTTP protocol documentation. As an example, your client must respect the max-age value, the stale-while-revalidate value, the must-revalidate directive, and the private directive when they are passed in the response." **No actual max-age numbers documented** (UNCONFIRMED; we cannot probe without a key) | [POL] |
| ETag | "Map Tiles API responses may also include an ETag header which should also be implemented according to the HTTP protocol documentation when requesting with revalidation." Implies If-None-Match is intended to work. | [POL] |
| 304 billing | UNCONFIRMED. [USE]/[COST] say "Successful requests" and "Requests that cause server errors" count against quota and "Requests that fail authentication" don't; a 304 is not discussed. Assume a 304 counts as a request/event until measured (check Cloud console usage after a test). | [COST] |
| Errors | `notFound/invalid` (bad x/y/z), `forbidden`, `expired`, `quotaExceeded`, `rateLimitExceeded` (use exponential backoff) | [ERR] |
| Zoom availability | Viewport call gives per-area `maxZoomRects`; "not all regions support the maximum zoom level of 22" | [2D] |

## Q3. What is one billable event (2D Map Tiles SKU)

- [SKU]: SKU "Map Tiles API: 2D Map Tiles", SKU ID 0164-F76D-680A, Essentials. "Billable event: Request that returns a 2D map tile". Triggers: 2D map tile - Roadmap / Satellite / Terrain.
- So: one billable event = one tile HTTP request that returns a tile. Not per session, not per viewport call. [USE] separately lists session/viewport calls as not counting toward quota.
- Price: free cap 100,000/month, then $0.60 per 1,000 (1,000,001–5,000,000 tier $0.48, ...) [PRICE]. "This free usage resets on the first day of each month, at midnight Pacific US time." [BILL] Tier aggregation is across all projects on the billing account [PRICE].
- Whether a highDpi/2x tile (512 px) is still one event: not stated; SKU wording says per request, so yes (inference).

## Q4. Attribution

Viewport-info endpoint [2D]:
`GET https://tile.googleapis.com/tile/v1/viewport?session=TOKEN&key=KEY&zoom=Z&north=N&south=S&east=E&west=W` — "All parameters are required." (Note path is `/tile/v1/viewport`, unlike `/v1/2dtiles`.) Response: `{"copyright":"Map data ©2023","maxZoomRects":[{maxZoom,north,south,east,west},...]}`. `copyright` = "an attribution string that you must display on your map when you display roadmap and satellite tiles."

| Item | Finding | Source |
|---|---|---|
| Billable? | No: not in the SKU triggers [SKU]; "viewport information requests ... don't impact your daily quota" [USE]. Limit 6,000/min/project shared with session calls. | [SKU], [USE] |
| How often | No required frequency documented (UNCONFIRMED). What is said: "the attribution strings are variable, depending on the map data requested by the renderer's viewport." -> call on viewport change (debounced, e.g. Leaflet `moveend`) with current zoom/bounds; caching the answer briefly per (zoom,bbox) is our own choice. | [POL] |
| Where shown | "You should display this information, in full as provided in the appropriate location, usually the bottom right corner of the displayed set of tiles". If space-constrained: "consider adding a hover-over or clickable UI element labeled 'Data sources'". | [POL] |
| Logo | "You must include clear Google Maps attribution ... Attribution should take the form of the Google Maps logo whenever possible. In cases where space is limited, the text Google Maps is acceptable." Asset: https://developers.google.com/static/maps/documentation/images/Google_Maps_Attribution_Assets.zip . Size "Minimum logo height: 16dp / Maximum logo height: 19dp"; clear space "10dp on left, right and top, 5dp on the bottom"; "Don't modify the logo... Maintain the aspect ratio"; "Use the outlined logo on a busy background, like a map or image"; contrast + "accessibility label with the text Google Maps". | [POL] |
| Third-party renderer (Leaflet) | "When you use the Map Tiles API to display Google Maps using a third-party renderer, you must not overlap or obscure the Google logo with any other logo, such as the renderer's logo. Maintain a reasonable buffer distance ... No logo may overlap or obscure the data attribution provided by the API response." -> Leaflet has no built-in Google logo; add a custom control (e.g. bottom-left) and put `copyright` into the attribution control; keep Leaflet's own prefix visibly separate. | [POL] |
| Own overlay data | "When you use Google Maps data as a basemap while overlaying your own map data, you must ensure your audience fully understands which portion of the map visualization is attributed to Google and which portions are attributed to your own map data." Third-party data attribution "must clearly be disassociated from Google's data attributions." | [POL] |
| Prohibited uses | "You may not use Map Tiles API for any non-visualization use cases, such as: Image analysis, Machine interpretation, Object detection or identification, Geodata extraction or resale, Offline uses" | [POL] |

## Q5. Terms: proxy, cache, OSM fallback, overlays

Map Tiles API is a Google Maps Platform "Core Service" [CORE], so [TOS] section 3 applies.

| Question | Relevant text | Verdict |
|---|---|---|
| Own server-side proxy to own authenticated users | No sentence prohibits a proxy by name. Doc [SEC]: for dynamic-IP setups "secure your apps using a proxy server" (about key security, Map Tiles API is on that list). But [TOS] 3.2.1(b): Customer will not "sell, resell, sublicense, transfer, or distribute the Services"; 3.2.3(a): "pre-fetch, index, store, reshare, or rehost Google Maps Content outside the services"; 3.2.3(d): "re-distribute the Google Maps Core Services or pass them off as if they were Customer's services". Our case is a private page for 3 staff, not redistribution. | ALLOWED-ish, not explicit. Keep: authenticated, internal, Google logo + copyright shown, no public/unauthenticated tile endpoint. Risk: low-moderate. |
| Disk cache of tiles | [TOS] 3.2.3(b): "Customer will not cache Google Maps Content except as expressly permitted under the Maps Service Specific Terms." [SST] has no Map Tiles clause (only Google-ID caching, A.3, and other APIs). [POL]: "you must not pre-fetch, index, store, or cache any Content except under the limited conditions stated in the terms" and then describes honoring Cache-Control/ETag. | PERMITTED ONLY as the Cache-Control headers allow (must honor max-age, must-revalidate, stale-while-revalidate, `private`). No pre-warming/pre-fetching, no bulk download ("bulk download Google Maps tiles" is banned in 3.2.3(a)(ii)). Cache lazily on demand only. |
| Combining with non-Google maps / OSM fallback | [TOS] 3.2.3(e): "To avoid quality issues and/or brand confusion, Customer will not use the Google Maps Core Services with or near a non-Google Map in a Customer Application. For example, Customer will not (i) display or use Places content on a non-Google Map, (ii) display Street View imagery and non-Google Maps on the same screen, or (iii) link a Google Map to non-Google Maps Content or a non-Google Map." | RISK. Mixing Google and OSM tiles in the same view is clearly out. Swapping the WHOLE basemap to OSM (Google layer removed, Google logo/attribution removed, OSM attribution shown) is arguably a different map, but "in a Customer Application" is broad. Unresolvable from the text; UNCONFIRMED how Google enforces. Safest alternatives: fallback = a plain "over budget" placeholder/no basemap (polylines only), or a separate page/toggle the user chooses. |
| Own polylines/markers over Google tiles | [POL] "Display logo and data attributions in hybrid visualizations: When you use Google Maps data as a basemap while overlaying your own map data ..." and "When you use the Map Tiles API to display Google Maps data as a basemap and overlay third-party (non-Google) geospatial data" — explicitly contemplated. The 3D-only "Geodata overlays" clause concerns Photorealistic tiles. | ALLOWED, with attribution kept separate/unobscured. |
| Don't derive data | [TOS] 3.2.3(c): "No Creating Content From Google Maps Content" (tracing etc.) | We don't. (Snap-to-road / geofence from tiles would violate.) |
| App terms notice | [TOS] 3.2.2(a)(i): "The Customer Application's terms of service will (A) notify users that the Customer Application includes Google Maps features and content; and (B) state that use ... is subject to ... Google Maps End User Additional Terms of Service (https://maps.google.com/help/terms_maps/) and ... Google Privacy Policy". Add a footer line to the truck page. | Technically required. |
| Avoid fees | [TOS] 3.2.1(c)(ii): may not use the Services "in a manner intended to avoid incurring Fees". Caching within Cache-Control is the documented behavior, so fine; do NOT rotate keys/projects to dodge caps. | Note. |
| Review right | 3.2.2(c): "At Google's request, Customer will submit Customer Application(s) and Project(s) to Google for review." | Note. |
| EEA | Not relevant to a Thai billing address (EEA has separate terms and no 2D satellite). | n/a |

## Q6. Account setup, key restriction, hard daily cap

| Step | Detail | Source |
|---|---|---|
| Billing | "To use the Map Tiles API, you must enable billing on each of your projects and include an API key or OAuth token with all API or SDK requests." "make sure that billing is enabled for your Cloud project." Whether a card is strictly needed to create the billing account in Thailand: UNCONFIRMED on Maps pages (Cloud Billing normally requires a payment method). New accounts may get a $300 / 90-day trial [START]; the Maps monthly $200 credit was replaced by per-SKU free caps in Mar 2025 [BILL]. | [USE], [START], [BILL] |
| Enable API | Cloud console > Maps API Library > Map Tiles API > ENABLE; or `gcloud services enable tile.googleapis.com` (service id `tile.googleapis.com` per the console URL console.cloud.google.com/apis/library/tile.googleapis.com; not stated in the Maps docs' gcloud list) | [START] |
| Create key | Google Maps Platform > Credentials > Create credentials > API key | [START] |
| Restrict key | "Best practice is to always restrict your API keys with one type of application restrictions and one or more API restrictions." API restriction = Map Tiles API only. Application restriction for server keys = IP addresses ("must match the source address the Google Maps Platform servers observe... If you use NAT, this address typically corresponds to your machine's public IP"). Dynamic IP: "IP restrictions might be impractical in ... cloud environments that rely on dynamic IP addresses. When using Maps web service in these scenarios, secure your apps using a proxy server." So with a dynamic egress IP: API restriction only + hard quota cap + key never sent to browser (our proxy design does exactly this). "You are financially responsible for charges caused by abuse of unrestricted API keys." | [SEC] |
| HARD daily cap | Budgets do NOT cap: "Setting a budget does not automatically cap Google Cloud or Google Maps Platform usage or spending." Quotas DO: "When the number of requests in your project reaches the quota limit, your service stops responding to requests." Steps: "In the Cloud console, navigate to Google Maps Platform > Quotas. Select the API ... select [the quota value] using the checkbox. Click Edit, enter a new quota value, and click Submit request." [REL] 21 May 2026: "If you wish to cap your usage at a lower level ... you can set a quota override (also known as a consumer override) ... on the Quotas & System Limits page." | [COST], [USE], [REL] |
| Quota name | Buckets split 10 Feb / 16 Mar 2026: "2D Tiles: For all roadmap, satellite, and terrain tile requests" (separate from "Street View Tiles"); display name "2D Tiles requests per day per project" [REL]. Exact machine metric ID (e.g. `tile.googleapis.com/...`): UNCONFIRMED — read it off the Quotas & System Limits page. Also a per-minute quota exists (6,000/min default) [USE]. | [REL], [USE] |
| Cap value | Free tier 100,000/month; a per-day override of 3,000 = ~93k/month. Google warns "Because of the technical separation between the quota and billing systems, discrepancies may exist ... consider ... quota limits slightly lower than your absolute maximum." Quota counts "Successful requests" and "Requests that cause server errors"; auth failures don't count. Quota page is real-time, Billing dashboard lags up to 48 h. Daily-quota reset time: UNCONFIRMED (Cloud quotas normally reset at midnight Pacific). | [COST] |
| Our own counter | Keep the proxy's own per-day hard stop slightly under the Google override (e.g. proxy 2,500, Google 3,000) so the proxy falls back first and Google's cap is the backstop. Proxy should treat 403/429 `quotaExceeded` as "stop for the day" (backoff, no retry loop) [ERR]. | design |
| Alerts | Also add quota alerts and a budget alert (alerts only, not caps). | [COST] |

## Q7. Leaflet specifics

Google publishes nothing Leaflet-specific; Leaflet appears only as "a third-party renderer" in [POL]. Practical points (inference from the documented facts):
- Tiles are standard XYZ Web Mercator, z 0–22, y from top ([2D] shows the JS conversion with y increasing downward), so `urlTemplate '/tiles/{z}/{x}/{y}'` maps 1:1. Set `noWrap: true` and `bounds` (Surat Thani) so Leaflet never asks for x outside [0, 2^z-1] (would return notFound/invalid [ERR]).
- Default tile is 256x256 [SESS], so Leaflet's default `tileSize: 256` is right. Do NOT apply the Mapbox 512px trick (`tileSize:512, zoomOffset:-1`) unless a tile covers double the area; Google's highDpi tile "coverage area ... remains unchanged", i.e. a 2x/highDpi 512 px image covers the same area as a 256 px tile -> keep `tileSize: 256` and let the browser downscale for retina crispness. Each is still one request.
- `detectRetina` will NOT help: there is no @2x URL. `highDpi` "has no effect on 1x scale tiles" and scaleFactor2x "Doubles label size and removes minor feature labels". So sharp retina = 2x scale + highDpi with larger labels/fewer labels; or accept 1x 256 px tiles (soft on retina, fine for old Android phones). Phone loads 4x pixels with highDpi (bandwidth).
- `maxZoom`: Google supports up to 22, but coverage varies by area ([2D] maxZoomRects); Thai city centers should be fine, but cap `maxZoom` around 18-19 to keep tile counts and bytes down (own choice).
- Cache/ETag: pass Google's Cache-Control/ETag through to the browser (or set a conservative one not exceeding Google's), so the browser HTTP cache also honors it.
- Attribution: Leaflet's built-in control is bottom-right; place the Google logo on the left, and use `L.control.attribution` text = Google `copyright` string. Listen to `moveend` to refresh it.
- Old Android WebViews: nothing tile-specific documented; the proxy returns plain PNG/JPEG over same-origin, which is the lowest-risk setup (no `crossOrigin` needed).

## Q8. Usage estimate (arithmetic + assumptions)

Tiles per view: Leaflet loads only tiles intersecting the viewport (plus none extra initially; `keepBuffer` is for retention). For a viewport W x H CSS px and 256 px tiles, expected tile count ~ (1 + W/256) x (1 + H/256) for random alignment.
- Phone 360 x 300: (1+1.41) x (1+1.17) = 2.41 x 2.17 = ~5.2 tiles (range 4–9) per fresh view at a fixed zoom.
- Real phone use adds a zoom or two and some panning: assume ~3 zoom levels x ~5 = 15, plus ~5–10 for panning -> ~20–25 tiles/session.
- Reception desktop, e.g. 1400 x 700: (1+5.5) x (1+2.7) = 6.5 x 3.7 = ~24 tiles per fresh view; with a zoom or pan -> ~40–50/session.

Scenarios (30 page views/day, ~30 days):

| Scenario | Per day | Per month | Note |
|---|---|---|---|
| A. No cache, browser cache also cold, mix 10 phone x 22 + 20 desktop x 45 | 220 + 900 = 1,120 | ~34k | inside free tier |
| B. No cache, pessimistic: all 30 views x 60 tiles | 1,800 | ~54k | inside free tier |
| C. No cache, heavy pan/zoom: 30 x 100 | 3,000 | ~90k | just inside |
| D. Disk cache, working set. Route region ~20 km x 20 km (z13 tile ~4.8 km wide at 9 N: 40,075 km x cos 9deg / 2^13 = 4.83 km): z12 ~4, z13 ~16, z14 ~64, z15 ~256 tiles; with edge misalignment ~ 500 unique tiles. First view fills cache, later views hit. | ~0–500 misses | ~500–1,000 if max-age >= ~30 days; up to ~15,000 (500 x 30) if effective max-age <= 1 day | Cache benefit depends entirely on Google's real max-age (UNCONFIRMED) |
| E. Cache but Google sends `private` / max-age=0 / no-store | same as no cache | 34–90k | cache must not store -> reverts to A–C |

Reading: at this traffic the free tier (100,000/month) is not threatened by normal use even with no cache; a disk cache respecting max-age plausibly cuts it by 1–2 orders of magnitude if max-age is days+, and does nothing if it is `private`/0. The real risks are runaway clients (retry loops, a tab left auto-refreshing, bots), which the proxy's daily hard stop + a Google-side override at ~3,000/day handle. First step for the build: measure the actual response headers once with a real key (one createSession + one tile request via curl -i) and record them here.

## Open items to confirm empirically with a real key (cannot be done from docs)
1. Real `Cache-Control` / `ETag` / `Content-Type` on `/v1/2dtiles/...`; does `private` appear?
2. Does `If-None-Match` return 304, and is a 304 counted in the console usage/quotas?
3. Do `language=th` / `region=TH` render Thai labels at Surat Thani?
4. Machine name of the "2D Tiles" quota in Quotas & System Limits; daily reset time.
5. Whether a payment method is mandatory when creating the billing account in Thailand.
6. Legal read of the OSM-fallback (TOS 3.2.3(e)) and of server-side caching (3.2.3(b)); if unsure, ask via https://cloud.google.com/contact-maps or use "no basemap" as the over-budget fallback.
