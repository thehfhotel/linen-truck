// linen-truck — the page shell (docs/CONTRACTS.md §8).
//
// Server-rendered HTML strings, no framework and no build step: the whole client
// is one <style> block and, on the day page, ~60 lines of Leaflet wiring. The
// audience is the owner and two reception desks on phones, and a React bundle
// would be more machinery than the entire feature.
//
// Two things this file is strict about:
//
//   1. EVERY interpolated value goes through `escapeHtml`. Site names come from a
//      file the owner edits and finding text is assembled from platform numbers;
//      neither is trusted markup.
//   2. NO 'unsafe-inline'. The inline <style> and the inline map script carry a
//      per-response nonce, and the two CDN files carry SRI hashes pinned below.
//      Leaflet mutates `element.style` from JavaScript, which CSP does not police,
//      so the markup here never uses a `style="…"` attribute.
//
// Palette: HF One staff BURGUNDY (feedback's /staff), not the crimson guest
// palette — this is an internal audit tool and it should not look like a guest
// surface.

/** Leaflet 1.9.4 on cdnjs, with the SRI hashes computed from the served files. */
export const LEAFLET_CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
export const LEAFLET_CSS_SRI =
  "sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w==";
export const LEAFLET_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
export const LEAFLET_JS_SRI =
  "sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==";

const AMP = /[&<>"']/g;
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The one escaper. Every `${}` in every template in `pages/` goes through it. */
export function escapeHtml(value: string): string {
  return value.replace(AMP, (c) => ENTITIES[c] as string);
}

/** 16 random bytes as hex — one per response, never reused. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `no-store` on every page: a day report changes every ten minutes and a stale
 * one that says "nothing unusual" is worse than a slow one.
 */
export function pageHeaders(nonce: string, extra?: Record<string, string>): Headers {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "same-origin",
    "content-security-policy": [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
      `style-src 'nonce-${nonce}' https://cdnjs.cloudflare.com https://fonts.googleapis.com`,
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://*.tile.openstreetmap.org",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

/** HF One staff burgundy, mobile-first. Kept in one string so there is one source. */
export const STYLE = `
:root {
  --brand-500: #8b0000; --brand-600: #7a0000; --brand-700: #6b1212; --brand-900: #3b0a0a;
  --brand-50: #fbeaea; --brand-100: #f5c9c9;
  --gold-500: #d9a441; --gold-700: #93691f;
  --shell: #faf9f7; --panel: #ffffff; --tint: #f4f1ed;
  --line: #e8e4df; --line-strong: #cfc9c1;
  --ink: #26221e; --ink-muted: #7a7268;
  --ok: #2f855a; --warn: #b7791f; --bad: #c53030;
  --font: "Sarabun", "Noto Sans Thai", ui-sans-serif, system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--shell); color: var(--ink); font-family: var(--font); font-size: 15px; line-height: 1.5; }
a { color: var(--brand-600); }
.wrap { max-width: 880px; margin: 0 auto; padding: 0 12px 48px; }
header.bar { background: var(--brand-700); color: #fff; padding: 12px; }
header.bar .inner { max-width: 880px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; }
header.bar h1 { font-size: 17px; margin: 0; font-weight: 700; }
header.bar .date { font-size: 15px; color: var(--brand-100); }
nav.days { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
nav.days a, nav.days span { display: inline-block; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--panel); color: var(--brand-700); text-decoration: none; font-size: 13px; }
nav.days span { color: var(--ink-muted); border-style: dashed; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 12px 0; }
section > h2 { font-size: 14px; margin: 0 0 8px; color: var(--brand-700); text-transform: none; letter-spacing: .01em; }
.device { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-muted); }
.device b { color: var(--ink); font-weight: 600; }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
@media (min-width: 620px) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.tile { background: var(--tint); border-radius: 8px; padding: 10px; }
.tile .k { font-size: 11px; color: var(--ink-muted); display: block; }
.tile .v { font-size: 20px; font-weight: 700; color: var(--brand-700); }
.tile .u { font-size: 12px; font-weight: 400; color: var(--ink-muted); }
ul.findings { list-style: none; margin: 0; padding: 0; }
ul.findings li { border-left: 4px solid var(--warn); background: var(--brand-50); border-radius: 0 8px 8px 0; padding: 8px 10px; margin-bottom: 8px; }
ul.findings li.detour { border-left-color: var(--bad); }
ul.findings li .th { display: block; font-weight: 600; }
ul.findings li .en { display: block; font-size: 12px; color: var(--ink-muted); }
ul.findings li a { font-size: 12px; }
p.none { margin: 0; color: var(--ok); font-weight: 600; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: 13px; min-width: 520px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--ink-muted); font-weight: 600; font-size: 11px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.virtual td { color: var(--ink-muted); font-style: italic; }
.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--tint); color: var(--ink-muted); white-space: nowrap; }
.badge.engine-running { border-color: var(--warn); color: var(--warn); background: #fff; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.chip { font: inherit; font-size: 12px; cursor: pointer; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--panel); color: var(--brand-700); }
.chip.active { background: var(--brand-600); border-color: var(--brand-600); color: #fff; font-weight: 600; }
button.rowlink { font: inherit; font-size: inherit; cursor: pointer; background: none; border: 0; padding: 0; margin: 0; color: var(--brand-600); text-decoration: underline; text-underline-offset: 2px; }
tr[data-trip], tr[data-stop] { cursor: pointer; }
tr[data-trip]:hover, tr[data-stop]:hover { background: var(--tint); }
ul.findings li button.rowlink { display: block; margin-top: 4px; font-size: 12px; }
#map { height: 320px; border-radius: 8px; background: var(--tint); }
@media (min-width: 620px) { #map { height: 420px; } }
.quality { font-size: 12px; color: var(--ink-muted); margin: 12px 0 0; }
.quality.bad { color: var(--bad); font-weight: 600; }
.pair-en { color: var(--ink-muted); font-weight: 400; }
`;

export interface LayoutArgs {
  /** Plain text; escaped here. */
  title: string;
  nonce: string;
  /** The `ไทย · English` app heading line. */
  heading: string;
  /** Right-hand side of the header bar (already-escaped HTML, usually a date). */
  headingAside?: string;
  /** Extra <head> markup (already-safe: only the Leaflet link/script). */
  head?: string;
  /** The page body (already-escaped HTML). */
  body: string;
  /** Markup placed just before </body> (already-safe: the nonce'd map script). */
  bodyEnd?: string;
}

export function renderPage(a: LayoutArgs): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(a.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap">
<style nonce="${a.nonce}">${STYLE}</style>${a.head ?? ""}
</head>
<body>
<header class="bar"><div class="inner"><h1>${escapeHtml(a.heading)}</h1><div class="date">${a.headingAside ?? ""}</div></div></header>
<div class="wrap">
${a.body}
</div>${a.bodyEnd ?? ""}
</body>
</html>
`;
}
