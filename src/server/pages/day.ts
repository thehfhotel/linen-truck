// linen-truck — the day report page (docs/CONTRACTS.md §8).
//
// Order on the page is the order the owner cares about: FINDINGS FIRST, then the
// numbers, then the raw tables, then the map. A page that opens with a tidy
// summary and hides "the truck stopped for 20 minutes at an unknown place" three
// screens down is a page nobody scrolls.
//
// The map is fed by `/api/day/:ymd` rather than by an inlined blob, exactly as §7
// specifies: one JSON shape serves the page, hf-mcp and any future consumer, so
// there is no second serialisation to keep in step. The page ships only what the
// script cannot fetch — the site circles and the handful of label strings.

import type { Site } from "../../domain/types.ts";
import { LABELS, pair, tripLabel, type L } from "../../shared/labels.ts";
import { bangkokStamp, type DayReport, type ReportStop, type ReportTrip } from "../report.ts";
import {
  escapeHtml,
  LEAFLET_CSS_SRI,
  LEAFLET_CSS_URL,
  LEAFLET_JS_SRI,
  LEAFLET_JS_URL,
  renderPage,
} from "./layout.ts";

const dash = "—";

/** `ไทย · English` as escaped markup, with the English half muted. */
const pairHtml = (l: L): string => `${escapeHtml(l.th)} <span class="pair-en">· ${escapeHtml(l.en)}</span>`;

const tile = (label: L, value: string, unit?: L): string =>
  `<div class="tile"><span class="k">${escapeHtml(pair(label))}</span><span class="v">${escapeHtml(value)}` +
  (unit ? ` <span class="u">${escapeHtml(pair(unit))}</span>` : "") +
  `</span></div>`;

/** A JSON blob safe to sit inside a `<script>` element. */
const jsonBlock = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

function siteLabel(sites: readonly Site[], id: string | null): L {
  if (id === null) return LABELS.unknownPlace;
  const site = sites.find((s) => s.id === id);
  return site ? site.name : { th: id, en: id };
}

/** `เที่ยว 3 · Trip 3` — the trip chip / row-selector label. */
const tripSelectLabel = (n: number): string => pair(tripLabel(n));

function tripRow(trip: ReportTrip, sites: readonly Site[]): string {
  return `<tr data-trip="${trip.n}">
<td class="num"><button type="button" class="rowlink" data-select="trip-${trip.n}" title="${escapeHtml(tripSelectLabel(trip.n))}">${trip.n}</button></td>
<td>${escapeHtml(trip.start)}</td>
<td>${escapeHtml(trip.end)}</td>
<td class="num">${trip.minutes}</td>
<td class="num">${trip.km}</td>
<td class="num">${trip.maxKmh}</td>
<td><a href="${escapeHtml(trip.fromMapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(siteLabel(sites, trip.from).th)}</a></td>
<td><a href="${escapeHtml(trip.toMapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(siteLabel(sites, trip.to).th)}</a></td>
</tr>`;
}

function stopRow(stop: ReportStop, sites: readonly Site[], index: number): string {
  const virtualLabel =
    stop.virtual === "track-start" ? LABELS.trackStart : stop.virtual === "track-end" ? LABELS.trackEnd : null;
  const place = virtualLabel ?? siteLabel(sites, stop.site);
  return `<tr data-stop="${index}"${stop.virtual ? ' class="virtual"' : ""}>
<td><button type="button" class="rowlink" data-select="stop-${index}" title="${escapeHtml(pair(LABELS.showStopOnMap))}">${escapeHtml(stop.arrive)}</button></td>
<td>${escapeHtml(stop.depart)}</td>
<td class="num">${stop.minutes}</td>
<td><a href="${escapeHtml(stop.mapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(place.th)}</a></td>
<td class="num">${stop.engineOnMin}</td>
</tr>`;
}

function findingsHtml(report: DayReport): string {
  if (report.findings.length === 0) return `<p class="none">${escapeHtml(pair(LABELS.noFindings))}</p>`;
  const items = report.findings.map((f) => {
    const mapLink =
      f.kind === "unknown-stop"
        ? ` <a href="${escapeHtml(f.mapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(pair(LABELS.openInMaps))}</a>`
        : "";
    const selectAttr =
      f.kind === "unknown-stop" ? ` data-stop="${f.stopIndex}"` : f.kind === "detour" ? ` data-trips="${f.trips.join(",")}"` : "";
    const selectButton =
      f.kind === "unknown-stop"
        ? ` <button type="button" class="rowlink" data-select="stop-${f.stopIndex}">${escapeHtml(pair(LABELS.showStopOnMap))}</button>`
        : f.kind === "detour"
          ? ` <button type="button" class="rowlink" data-select="trip-${f.trips.join("-")}">${escapeHtml(pair(LABELS.showTripOnMap))}</button>`
          : "";
    return `<li class="${escapeHtml(f.kind)}"${selectAttr}><span class="th">${escapeHtml(f.text.th)}</span><span class="en">${escapeHtml(f.text.en)}</span>${mapLink}${selectButton}</li>`;
  });
  return `<ul class="findings">${items.join("")}</ul>`;
}

/**
 * The filter chip row (feature: filter the day map by trip or stop). One chip
 * per trip plus "All day" first and always present — even a day with zero
 * trips still renders the one chip, so the row is never empty.
 */
function chipsHtml(report: DayReport, sites: readonly Site[]): string {
  const trips = report.trips ?? [];
  const allChip = `<button type="button" class="chip active" data-select="all" aria-pressed="true">${escapeHtml(pair(LABELS.allDayChip))}</button>`;
  const tripChips = trips.map((trip) => {
    const from = siteLabel(sites, trip.from).th;
    const to = siteLabel(sites, trip.to).th;
    const label = `${tripSelectLabel(trip.n)} (${from} → ${to})`;
    return `<button type="button" class="chip" data-select="trip-${trip.n}" aria-pressed="false">${escapeHtml(label)}</button>`;
  });
  return `<div class="chips" id="trip-chips" role="group" aria-label="${escapeHtml(pair(LABELS.mapHeading))}">${[allChip, ...tripChips].join("")}</div>`;
}

function deviceHtml(report: DayReport): string {
  const d = report.device;
  const state = d.moving ? LABELS.moving : LABELS.parked;
  const reach = d.online ? LABELS.online : LABELS.offline;
  const seen = d.lastSeenAt === null ? pair(LABELS.noSignal) : bangkokStamp(d.lastSeenAt);
  return `<div class="device">
<span>${escapeHtml(pair(LABELS.lastSeen))}: <b data-epoch="${d.lastSeenAt ?? ""}">${escapeHtml(seen)}</b></span>
<span>${escapeHtml(pair(LABELS.voltage))}: <b>${d.voltage === null ? dash : escapeHtml(String(d.voltage))} ${escapeHtml(LABELS.unitVolt.en)}</b></span>
<span><b>${escapeHtml(pair(state))}</b></span>
<span><b>${escapeHtml(pair(reach))}</b></span>
</div>`;
}

function qualityHtml(report: DayReport): string {
  const note = report.dataQuality.note;
  if (note === null) return "";
  const label =
    note === "poller-not-configured"
      ? LABELS.pollerDormant
      : note === "no-poll-yet"
        ? LABELS.pollNever
        : note === "last-poll-failed"
          ? LABELS.pollFailing
          : LABELS.noData;
  return `<p class="quality bad">${escapeHtml(pair(label))}</p>`;
}

export interface DayPageArgs {
  report: DayReport;
  sites: readonly Site[];
  nonce: string;
  prevYmd: string;
  /** `null` hides the link — the day page never offers the future. */
  nextYmd: string | null;
  todayYmd: string;
}

export function renderDayPage(args: DayPageArgs): string {
  const { report, sites, nonce } = args;
  const s = report.summary;

  const nav = [
    `<a href="/day/${escapeHtml(args.prevYmd)}">← ${escapeHtml(pair(LABELS.prevDay))}</a>`,
    args.nextYmd === null
      ? `<span>${escapeHtml(pair(LABELS.nextDay))} →</span>`
      : `<a href="/day/${escapeHtml(args.nextYmd)}">${escapeHtml(pair(LABELS.nextDay))} →</a>`,
    `<a href="/day/${escapeHtml(args.todayYmd)}">${escapeHtml(pair(LABELS.today))}</a>`,
    `<a href="/week/${escapeHtml(report.date)}">${escapeHtml(pair(LABELS.weekLink))}</a>`,
  ].join("");

  const siteTiles = sites
    .map((site) => tile(site.name, String(s.timeAtSiteMin[site.id] ?? 0), LABELS.unitMin))
    .join("");

  const tripRows = report.trips ?? [];
  const stopRows = report.stops ?? [];

  const body = `<nav class="days">${nav}</nav>
<section>
<h2>${pairHtml(LABELS.deviceHeading)}</h2>
${deviceHtml(report)}
</section>
<section>
<h2>${pairHtml(LABELS.findingsHeading)}</h2>
${findingsHtml(report)}
</section>
<section>
<h2>${pairHtml(LABELS.summaryHeading)}</h2>
<div class="tiles">
${tile(LABELS.km, String(s.km), LABELS.unitKm)}
${tile(LABELS.trips, String(s.tripCount))}
${tile(LABELS.roundTrips, String(s.roundTrips))}
${tile(LABELS.points, String(s.pointCount))}
${tile(LABELS.firstDeparture, s.firstDeparture ?? dash)}
${tile(LABELS.lastArrival, s.lastArrival ?? dash)}
${siteTiles}
</div>
${qualityHtml(report)}
</section>
<section>
<h2>${pairHtml(LABELS.tripsHeading)}</h2>
${
  tripRows.length === 0
    ? `<p class="none">${escapeHtml(pair(LABELS.noData))}</p>`
    : `<div class="scroll"><table>
<thead><tr><th class="num">${escapeHtml(LABELS.colTrip.th)}</th><th>${escapeHtml(LABELS.colStart.th)}</th><th>${escapeHtml(LABELS.colEnd.th)}</th><th class="num">${escapeHtml(LABELS.colMinutes.th)}</th><th class="num">${escapeHtml(LABELS.colKm.th)}</th><th class="num">${escapeHtml(LABELS.colMaxKmh.th)}</th><th>${escapeHtml(LABELS.colFrom.th)}</th><th>${escapeHtml(LABELS.colTo.th)}</th></tr></thead>
<tbody>${tripRows.map((t) => tripRow(t, sites)).join("")}</tbody></table></div>`
}
</section>
<section>
<h2>${pairHtml(LABELS.stopsHeading)}</h2>
${
  stopRows.length === 0
    ? `<p class="none">${escapeHtml(pair(LABELS.noData))}</p>`
    : `<div class="scroll"><table>
<thead><tr><th>${escapeHtml(LABELS.colArrive.th)}</th><th>${escapeHtml(LABELS.colDepart.th)}</th><th class="num">${escapeHtml(LABELS.colMinutes.th)}</th><th>${escapeHtml(LABELS.colPlace.th)}</th><th class="num">${escapeHtml(LABELS.colEngineOn.th)}</th></tr></thead>
<tbody>${stopRows.map((st, i) => stopRow(st, sites, i)).join("")}</tbody></table></div>`
}
</section>
<section>
<h2>${pairHtml(LABELS.mapHeading)}</h2>
${chipsHtml(report, sites)}
<div id="map" data-ymd="${escapeHtml(report.date)}"></div>
</section>`;

  const head = `
<link rel="stylesheet" href="${LEAFLET_CSS_URL}" integrity="${LEAFLET_CSS_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer">`;

  const mapData = {
    sites: sites.map((site) => ({ id: site.id, name: site.name.th, lat: site.lat, lon: site.lon, radiusM: site.radiusM })),
    txt: { unknown: LABELS.unknownPlace.th, engineOn: LABELS.colEngineOn.th, minutes: LABELS.colMinutes.th },
  };

  const bodyEnd = `
<script type="application/json" id="map-data" nonce="${nonce}">${jsonBlock(mapData)}</script>
<script src="${LEAFLET_JS_URL}" integrity="${LEAFLET_JS_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script nonce="${nonce}">${MAP_SCRIPT}</script>`;

  return renderPage({
    title: `${LABELS.appName.th} ${report.date}`,
    nonce,
    heading: pair(LABELS.appName),
    headingAside: escapeHtml(report.date),
    head,
    body,
    bodyEnd,
  });
}

/**
 * The map popup escaper, shipped inside `MAP_SCRIPT`.
 *
 * `bindPopup` takes an HTML STRING, and what goes into it is server data —
 * `st.site` is a site id from `config/sites.json` and `txt.unknown` a label, so
 * neither is attacker-controlled today. That is not a reason to concatenate raw:
 * the day this popup shows a stop's address, a device-reported name or anything
 * else that arrived from outside, a stringify-only `esc` becomes stored XSS on a
 * staff page. It escapes the five characters that matter, exactly like
 * `escapeHtml` on the server side.
 *
 * Exported so the test suite can execute it (`new Function`) rather than assert
 * on the shape of a string.
 */
export const MAP_ESC_FN = `function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }`;

/**
 * The whole client. ES5-flavoured on purpose (reception runs old Android
 * WebViews), no template literals, and every failure is silent: a map that does
 * not draw must never blank the report above it.
 *
 * Feature: filter the day map by trip or stop. The day's path (`/api/day`'s
 * `path`) is sliced into one polyline per trip using the trip's own
 * `startAt`/`endAt` (§9, additive) plus one dim "rest of day" polyline per gap
 * between trips (parked time). Selecting a trip bolds its line(s) and dims the
 * rest; selecting "all" restores every trip to its base style. A stop selection
 * is independent of trip highlighting — it only flies the map to that marker and
 * opens its popup. The selection is mirrored to `location.hash` with
 * `history.replaceState` (never `pushState` — a filter click is not a new page),
 * and a hash present on load is applied once the fetch resolves.
 */
const MAP_SCRIPT = `
(function () {
  try {
    var el = document.getElementById('map');
    var dataEl = document.getElementById('map-data');
    if (!el || !dataEl || typeof L === 'undefined') return;
    var cfg;
    try { cfg = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
    var sites = cfg.sites || [];
    var txt = cfg.txt || {};

    var map = L.map(el, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    ${MAP_ESC_FN}

    // Bounds are computed from plain lat/lon math (L.LatLng#toBounds /
    // L.latLngBounds over raw coordinate arrays), never by asking an added layer
    // for its own bounds: Leaflet 1.9 defers a layer's actual add until the map
    // has a view, so a layer's bounds getter throws on an unprojected layer
    // before that first view exists. Compute the view first, THEN add layers —
    // and keep every selection's bounds built from the coordinate arrays this
    // script already holds, not from L.Polyline#getBounds().
    function siteBounds(list) {
      var b = L.latLngBounds([]);
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        b.extend(L.latLng(s.lat, s.lon).toBounds(2 * (s.radiusM || 0)));
      }
      return b;
    }

    function coordBounds(coords) {
      var b = L.latLngBounds([]);
      for (var i = 0; i < coords.length; i++) b.extend(coords[i]);
      return b;
    }

    function mergeStyle(base, over) {
      var out = {};
      var k;
      for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
      for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
      return out;
    }

    var initialBounds = siteBounds(sites);
    if (initialBounds.isValid()) map.fitBounds(initialBounds.pad(0.25));
    else map.setView([9.13, 99.34], 12);

    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var circle = L.circle([s.lat, s.lon], {
        radius: s.radiusM, color: '#7a0000', weight: 1, fillColor: '#8b0000', fillOpacity: 0.06
      }).addTo(map);
      circle.bindPopup(esc(s.name));
    }

    var TRIP_BASE = { color: '#8b0000', weight: 4, opacity: 0.85 };
    var TRIP_DIM = { opacity: 0.25, weight: 3 };
    var TRIP_ON = { opacity: 1, weight: 6 };
    var REST_STYLE = { color: '#8b0000', weight: 2, opacity: 0.3, dashArray: '2 6' };

    fetch('/api/day/' + encodeURIComponent(el.getAttribute('data-ymd')), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin'
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d) return;
      var path = d.path || [];
      var trips = d.trips || [];
      var stops = d.stops || [];

      function tripAt(t) {
        for (var i = 0; i < trips.length; i++) {
          if (t >= trips[i].startAt && t <= trips[i].endAt) return trips[i].n;
        }
        return null;
      }

      // One segment per contiguous run of points belonging to the same trip (or
      // to no trip at all — parked/rest time), in path order.
      var segments = [];
      var current = null;
      for (var i = 0; i < path.length; i++) {
        var p = path[i];
        var n = tripAt(p[2]);
        if (!current || current.n !== n) {
          current = { n: n, coords: [] };
          segments.push(current);
        }
        current.coords.push([p[0], p[1]]);
      }

      var tripLayers = {};
      var tripCoords = {};
      var dayCoords = [];
      for (var i = 0; i < path.length; i++) dayCoords.push([path[i][0], path[i][1]]);

      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (seg.coords.length < 2) continue;
        if (seg.n === null) {
          L.polyline(seg.coords, REST_STYLE).addTo(map);
        } else {
          var line = L.polyline(seg.coords, TRIP_BASE).addTo(map);
          if (!tripLayers[seg.n]) { tripLayers[seg.n] = []; tripCoords[seg.n] = []; }
          tripLayers[seg.n].push(line);
          tripCoords[seg.n] = tripCoords[seg.n].concat(seg.coords);
        }
      }

      var stopMarkers = [];
      var stopCoords = [];
      for (var j = 0; j < stops.length; j++) {
        var st = stops[j];
        var known = st.site != null;
        var marker = L.circleMarker([st.lat, st.lon], {
          radius: 7, weight: 2, color: '#3b0a0a',
          fillColor: known ? '#2f855a' : '#b7791f', fillOpacity: 1
        }).addTo(map);
        marker.bindPopup(
          '<b>' + esc(known ? st.site : txt.unknown) + '</b><br>' +
          esc(st.arrive) + '–' + esc(st.depart) + ' (' + esc(st.minutes) + ' ' + esc(txt.minutes) + ')'
        );
        stopMarkers.push(marker);
        stopCoords.push([st.lat, st.lon]);
      }

      var dayBounds = siteBounds(sites);
      dayBounds.extend(coordBounds(dayCoords));
      dayBounds.extend(coordBounds(stopCoords));
      if (dayBounds.isValid()) map.fitBounds(dayBounds.pad(0.15));

      // ── selection (chips, table rows, findings — filter the map by trip/stop) ──

      function setChipActive(token) {
        var chips = document.querySelectorAll('.chip');
        for (var i = 0; i < chips.length; i++) {
          var on = chips[i].getAttribute('data-select') === token;
          if (on) chips[i].className = 'chip active';
          else chips[i].className = 'chip';
          chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      }

      function showAllTrips() {
        for (var n in tripLayers) {
          if (!Object.prototype.hasOwnProperty.call(tripLayers, n)) continue;
          for (var k = 0; k < tripLayers[n].length; k++) tripLayers[n][k].setStyle(TRIP_BASE);
        }
        setChipActive('all');
        if (dayBounds.isValid()) map.fitBounds(dayBounds.pad(0.15));
      }

      function highlightTrips(ns) {
        var bounds = L.latLngBounds([]);
        for (var n in tripLayers) {
          if (!Object.prototype.hasOwnProperty.call(tripLayers, n)) continue;
          var on = ns.indexOf(Number(n)) >= 0;
          var style = mergeStyle(TRIP_BASE, on ? TRIP_ON : TRIP_DIM);
          for (var k = 0; k < tripLayers[n].length; k++) tripLayers[n][k].setStyle(style);
          if (on) bounds.extend(coordBounds(tripCoords[n] || []));
        }
        setChipActive('trip-' + ns.join('-'));
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.25));
      }

      function focusStop(index) {
        var marker = stopMarkers[index];
        if (!marker) return;
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
        marker.openPopup();
      }

      /** Applies a token ('all' | 'trip-N[-M...]' | 'stop-N'); returns the canonical form applied. */
      function applySelection(token) {
        if (!token || token === 'all') { showAllTrips(); return 'all'; }
        var stopMatch = /^stop-(\\d+)$/.exec(token);
        if (stopMatch) { focusStop(parseInt(stopMatch[1], 10)); return token; }
        var tripMatch = /^trip-([0-9-]+)$/.exec(token);
        if (tripMatch) {
          var parts = tripMatch[1].split('-');
          var ns = [];
          for (var i = 0; i < parts.length; i++) {
            var num = parseInt(parts[i], 10);
            if (!isNaN(num)) ns.push(num);
          }
          if (ns.length === 0) { showAllTrips(); return 'all'; }
          highlightTrips(ns);
          return 'trip-' + ns.join('-');
        }
        showAllTrips();
        return 'all';
      }

      function setHash(token) {
        var target = '#' + token;
        if (window.location.hash === target) return;
        try { history.replaceState(null, '', target); } catch (e) { /* ignore */ }
      }

      function selectAndMirror(token) {
        setHash(applySelection(token));
      }

      var selectors = document.querySelectorAll('[data-select]');
      for (var i = 0; i < selectors.length; i++) {
        (function (node) {
          node.addEventListener('click', function (e) {
            e.preventDefault();
            selectAndMirror(node.getAttribute('data-select'));
          });
        })(selectors[i]);
      }
      var tripRows = document.querySelectorAll('tr[data-trip]');
      for (var i = 0; i < tripRows.length; i++) {
        (function (row) {
          row.addEventListener('click', function () {
            selectAndMirror('trip-' + row.getAttribute('data-trip'));
          });
        })(tripRows[i]);
      }
      var stopRows = document.querySelectorAll('tr[data-stop]');
      for (var i = 0; i < stopRows.length; i++) {
        (function (row) {
          row.addEventListener('click', function () {
            selectAndMirror('stop-' + row.getAttribute('data-stop'));
          });
        })(stopRows[i]);
      }

      var initialToken = (window.location.hash || '').replace(/^#/, '');
      if (initialToken) applySelection(initialToken);
      else showAllTrips();

      window.addEventListener('hashchange', function () {
        applySelection((window.location.hash || '').replace(/^#/, ''));
      });
    }).catch(function (e) { console.error('map:', e); });
  } catch (e) { console.error('map:', e); }
})();
`;
