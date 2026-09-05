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
import { LABELS, pair, type L } from "../../shared/labels.ts";
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

function tripRow(trip: ReportTrip, sites: readonly Site[]): string {
  return `<tr>
<td class="num">${trip.n}</td>
<td>${escapeHtml(trip.start)}</td>
<td>${escapeHtml(trip.end)}</td>
<td class="num">${trip.minutes}</td>
<td class="num">${trip.km}</td>
<td class="num">${trip.maxKmh}</td>
<td><a href="${escapeHtml(trip.fromMapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(siteLabel(sites, trip.from).th)}</a></td>
<td><a href="${escapeHtml(trip.toMapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(siteLabel(sites, trip.to).th)}</a></td>
</tr>`;
}

function stopRow(stop: ReportStop, sites: readonly Site[]): string {
  const virtualLabel =
    stop.virtual === "track-start" ? LABELS.trackStart : stop.virtual === "track-end" ? LABELS.trackEnd : null;
  const place = virtualLabel ?? siteLabel(sites, stop.site);
  return `<tr${stop.virtual ? ' class="virtual"' : ""}>
<td>${escapeHtml(stop.arrive)}</td>
<td>${escapeHtml(stop.depart)}</td>
<td class="num">${stop.minutes}</td>
<td><a href="${escapeHtml(stop.mapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(place.th)}</a></td>
<td class="num">${stop.engineOnMin}</td>
</tr>`;
}

function findingsHtml(report: DayReport): string {
  if (report.findings.length === 0) return `<p class="none">${escapeHtml(pair(LABELS.noFindings))}</p>`;
  const items = report.findings.map((f) => {
    const link =
      f.kind === "unknown-stop"
        ? ` <a href="${escapeHtml(f.mapUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(pair(LABELS.openInMaps))}</a>`
        : "";
    return `<li class="${escapeHtml(f.kind)}"><span class="th">${escapeHtml(f.text.th)}</span><span class="en">${escapeHtml(f.text.en)}</span>${link}</li>`;
  });
  return `<ul class="findings">${items.join("")}</ul>`;
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
<tbody>${stopRows.map((st) => stopRow(st, sites)).join("")}</tbody></table></div>`
}
</section>
<section>
<h2>${pairHtml(LABELS.mapHeading)}</h2>
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

    // Bounds are computed from plain lat/lon math (L.LatLng#toBounds), never by
    // asking an added layer for its own bounds: Leaflet 1.9 defers a layer's
    // actual add until the map has a view, so a circle's bounds getter throws on
    // an unprojected layer before that first view exists. Compute the view
    // first, THEN add layers.
    function siteBounds(list) {
      var b = L.latLngBounds([]);
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        b.extend(L.latLng(s.lat, s.lon).toBounds(2 * (s.radiusM || 0)));
      }
      return b;
    }

    var initialBounds = siteBounds(sites);
    if (initialBounds.isValid()) map.fitBounds(initialBounds.pad(0.25));
    else map.setView([9.13, 99.34], 12);

    var layers = [];
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var circle = L.circle([s.lat, s.lon], {
        radius: s.radiusM, color: '#7a0000', weight: 1, fillColor: '#8b0000', fillOpacity: 0.06
      }).addTo(map);
      circle.bindPopup(esc(s.name));
      layers.push(circle);
    }

    fetch('/api/day/' + encodeURIComponent(el.getAttribute('data-ymd')), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin'
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d) return;
      var finalBounds = siteBounds(sites);
      var raw = d.path || [];
      var line = [];
      for (var i = 0; i < raw.length; i++) {
        line.push([raw[i][0], raw[i][1]]);
        finalBounds.extend([raw[i][0], raw[i][1]]);
      }
      if (line.length > 1) {
        L.polyline(line, { color: '#8b0000', weight: 4, opacity: 0.85 }).addTo(map);
      }
      var stops = d.stops || [];
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
        finalBounds.extend([st.lat, st.lon]);
      }
      if (finalBounds.isValid()) map.fitBounds(finalBounds.pad(0.15));
    }).catch(function (e) { console.error('map:', e); });
  } catch (e) { console.error('map:', e); }
})();
`;
