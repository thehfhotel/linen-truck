// linen-truck — the 7-day table (docs/CONTRACTS.md §8).
//
// One row per day, ending at the requested ymd. Deliberately austere: this page
// exists to answer "which day should I look at?", and every cell is a link into
// the day page rather than a thing to study here.
//
// It renders the SAME `DayReport` objects the day page does — in the
// `summaryOnly()` shape (§9), so `trips`, `stops`, `legs` and `path` are absent
// and the findings survive. A summary row therefore cannot disagree with the day
// it summarises: they are the same numbers, not two derivations of them.

import type { Site } from "../../domain/types.ts";
import { FINDING_KIND, LABELS, pair, type FindingKind, type L } from "../../shared/labels.ts";
import type { DayReport } from "../report.ts";
import { escapeHtml, renderPage } from "./layout.ts";

const dash = "—";

const pairHtml = (l: L): string => `${escapeHtml(l.th)} <span class="pair-en">· ${escapeHtml(l.en)}</span>`;

const KINDS: readonly FindingKind[] = ["unknown-stop", "detour", "outside-hours"];

/** `จอดที่ไม่รู้จัก 1 · อ้อมทาง 1`, or a dash when the day is clean. */
function findingsCell(report: DayReport): string {
  const parts = KINDS.filter((kind) => (report.summary.findingCount[kind] ?? 0) > 0).map(
    (kind) => `${FINDING_KIND[kind].th} ${report.summary.findingCount[kind]}`,
  );
  return parts.length === 0 ? dash : escapeHtml(parts.join(" · "));
}

function row(report: DayReport, sites: readonly Site[]): string {
  const s = report.summary;
  const siteCells = sites
    .map((site) => `<td class="num">${s.timeAtSiteMin[site.id] ?? 0}</td>`)
    .join("");
  return `<tr>
<td><a href="/day/${escapeHtml(report.date)}">${escapeHtml(report.date)}</a></td>
<td class="num">${s.km}</td>
<td class="num">${s.tripCount}</td>
<td class="num">${s.roundTrips}</td>
<td>${escapeHtml(s.firstDeparture ?? dash)}</td>
<td>${escapeHtml(s.lastArrival ?? dash)}</td>
${siteCells}
<td>${findingsCell(report)}</td>
<td class="num">${s.pointCount}</td>
</tr>`;
}

export interface WeekPageArgs {
  /** Seven days, oldest first; the last one is the requested ymd. */
  days: readonly DayReport[];
  sites: readonly Site[];
  nonce: string;
  ymd: string;
  todayYmd: string;
}

export function renderWeekPage(args: WeekPageArgs): string {
  const { days, sites, nonce } = args;

  const nav = [
    `<a href="/day/${escapeHtml(args.ymd)}">${escapeHtml(pair(LABELS.dayLink))}</a>`,
    `<a href="/week/${escapeHtml(args.todayYmd)}">${escapeHtml(pair(LABELS.today))}</a>`,
  ].join("");

  const siteHeads = sites.map((site) => `<th class="num">${escapeHtml(site.name.th)}</th>`).join("");

  const body = `<nav class="days">${nav}</nav>
<section>
<h2>${pairHtml(LABELS.weekTitle)}</h2>
<div class="scroll"><table>
<thead><tr>
<th>${escapeHtml(LABELS.colDate.th)}</th>
<th class="num">${escapeHtml(LABELS.colKm.th)}</th>
<th class="num">${escapeHtml(LABELS.trips.th)}</th>
<th class="num">${escapeHtml(LABELS.roundTrips.th)}</th>
<th>${escapeHtml(LABELS.firstDeparture.th)}</th>
<th>${escapeHtml(LABELS.lastArrival.th)}</th>
${siteHeads}
<th>${escapeHtml(LABELS.colFindings.th)}</th>
<th class="num">${escapeHtml(LABELS.points.th)}</th>
</tr></thead>
<tbody>${days.map((d) => row(d, sites)).join("")}</tbody>
</table></div>
</section>`;

  return renderPage({
    title: `${LABELS.appName.th} ${LABELS.weekTitle.th} ${args.ymd}`,
    nonce,
    heading: pair(LABELS.appName),
    headingAside: escapeHtml(args.ymd),
    body,
  });
}
