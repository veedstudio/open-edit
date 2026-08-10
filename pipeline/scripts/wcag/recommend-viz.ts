// WCAG recommendation STUDIO — visualization. Pure, deterministic HTML string
// builders (no DOM, no clock, no randomness). `renderPage` frames an AGGREGATE
// document: the run's rendered video, then two level sections (AA then AAA), each
// a handful of option rows over per-GROUP Gaussian-splat background strips, plus a
// per-element appendix table.
//
// Each strip is a soft-splat reconstruction of the group's pooled cluster
// mixture: one radial-gradient ellipse per cluster, radii ∝ the covariance's
// principal/secondary sigmas and opacity ∝ cluster weight, layered over the
// weighted-mean fill — so the corpus's real spread (light wall down to dark
// moments) reads as overlapping blobs, not one flat gray. Clusters live in COLOUR
// space, so splat PLACEMENT is a synthetic deterministic layout, not spatial
// truth (see splatSvg). Eigen math is local; colour math is composed from policy.ts.

import { relativeLuminance, type Srgb8 } from "./policy.ts";
import { DEFAULT_SHADOW_RECIPE } from "./wcag-choice.ts";
import type {
  AggregateDoc,
  AppendixEntry,
  GroupBlock,
  LevelSection,
  OptionRow,
  PooledClusterStat,
  VideoRef,
} from "./recommend.ts";

// ---------------------------------------------------------------------------
// Covariance geometry (also exercised directly by the tests).
// ---------------------------------------------------------------------------

const matVec = (m: number[][], v: number[]): number[] => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const norm3 = (v: number[]): number => Math.hypot(v[0], v[1], v[2]);

// Dominant eigenvector/eigenvalue of a symmetric 3x3 (covariance) via power
// iteration: 20 fixed iterations from the deterministic start [1,1,1]/√3;
// eigenvalue via the Rayleigh quotient. PSD input => non-negative eigenvalue,
// sign-stable direction.
export function dominantEigen(cov: number[][]): { vec: number[]; value: number } {
  let v = [1, 1, 1];
  const n0 = norm3(v);
  v = v.map((x) => x / n0);
  for (let i = 0; i < 20; i++) {
    const w = matVec(cov, v);
    const wn = norm3(w);
    if (wn === 0) break; // all-zero covariance (single-member cluster)
    v = w.map((x) => x / wn);
  }
  const cv = matVec(cov, v);
  const value = v[0] * cv[0] + v[1] * cv[1] + v[2] * cv[2];
  return { vec: v, value };
}

// Principal + secondary axis sigmas of a covariance, and the principal axis's
// rotation in the OKLAB (a,b) chroma plane. Second axis via deflation: remove the
// dominant component (C - λ1·v1·v1ᵀ), then power-iterate again.
export function eigenAxes(cov: number[][]): { s1: number; s2: number; angleDeg: number } {
  const { vec: v1, value: l1 } = dominantEigen(cov);
  const deflated = cov.map((row, i) => row.map((x, j) => x - l1 * v1[i] * v1[j]));
  const { value: l2 } = dominantEigen(deflated);
  return {
    s1: Math.sqrt(Math.max(l1, 0)),
    s2: Math.sqrt(Math.max(l2, 0)),
    angleDeg: (Math.atan2(v1[2], v1[1]) * 180) / Math.PI, // (a,b) chroma projection
  };
}

// ---------------------------------------------------------------------------
// HTML helpers.
// ---------------------------------------------------------------------------

const hex2 = (v: number) => v.toString(16).padStart(2, "0");
const toHex = (c: Srgb8) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ratioStr = (x: number) => `${x.toFixed(2)}:1`;

// Deterministic FNV-1a string hash — seeds the synthetic splat y-jitter.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SPLAT_W = 400;
const SPLAT_H = 60;
const N_STRIP = 48; // target total splats per strip; per-cluster count ∝ weight
const DOT_BASE_R = 5; // small splat radius floor
const DOT_SIGMA_R = 12; // px of splat radius per unit OKLAB principal sigma
const SCATTER_PX = 180; // px of positional scatter per unit OKLAB sigma (covariance -> spread)
const DOT_OPACITY = 0.55; // near-constant: weight is encoded as COUNT, not opacity
// R2 low-discrepancy sequence (Roberts' plastic constant) — thematically the same
// blue-noise point picker family the sampler uses.
const R2_G = 1.324717957244746;
const R2_A1 = 1 / R2_G;
const R2_A2 = 1 / (R2_G * R2_G);
const frac = (x: number) => x - Math.floor(x);

// A group's pooled cluster mixture as MANY small splats — blue-noise-scattered,
// count ∝ weight (mass = number of dots, not opacity). IMPORTANT: clusters live
// in COLOUR space, not screen space — so placement is a SYNTHETIC deterministic
// layout, NOT spatial truth: each cluster has a synthetic centre (x by WCAG
// luminance, y hash-jittered from key+index), and its N_i = round(weight·N_STRIP)
// splats scatter around it via the R2 low-discrepancy sequence (seeded per
// key+cluster), offset scaled by the covariance eigen-axes sigmas (principal +
// secondary, rotated) — so covariance shows as positional SPREAD. Each splat is a
// small radial gradient (opaque mean centre -> transparent edge) at constant
// opacity; heaviest cluster's splats draw last. Gradient defs are shared PER
// CLUSTER (not per splat) to keep the page small. Upstream pooling caps clusters
// at bandCap(); a truncated tail is not shown. `key` must be unique per strip.
export function splatSvg(bands: PooledClusterStat[], key: string): string {
  if (bands.length === 0) {
    return `<div class="splat splat--empty" aria-hidden="true"></div>`;
  }
  const wSum = bands.reduce((s, b) => s + b.weight, 0) || 1;
  const mean = { r: 0, g: 0, b: 0 };
  for (const b of bands) {
    mean.r += b.color.r * b.weight;
    mean.g += b.color.g * b.weight;
    mean.b += b.color.b * b.weight;
  }
  const baseHex = toHex({ r: Math.round(mean.r / wSum), g: Math.round(mean.g / wSum), b: Math.round(mean.b / wSum) });
  const xFor = (lum: number) => 30 + lum * (SPLAT_W - 60); // luminance 0..1 -> [30, W-30]
  const yFor = (i: number) => 14 + ((hashStr(`${key}:${i}`) % 1000) / 1000) * (SPLAT_H - 28);

  const defs: string[] = [
    `<filter id="b-${key}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/></filter>`,
  ];
  const dots: string[] = [];
  // Ascending weight => the heaviest cluster's splats render last (on top).
  const order = bands.map((_, i) => i).sort((a, c) => bands[a].weight - bands[c].weight || a - c);
  for (const i of order) {
    const cl = bands[i];
    const n = Math.max(1, Math.round((cl.weight / wSum) * N_STRIP));
    const { s1, s2, angleDeg } = eigenAxes(cl.covariance);
    const theta = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const cx0 = xFor(relativeLuminance(cl.color));
    const cy0 = yFor(i);
    const r = (DOT_BASE_R + DOT_SIGMA_R * s1).toFixed(2);
    const gid = `g-${key}-${i}`;
    defs.push(
      `<radialGradient id="${gid}"><stop offset="0%" stop-color="${toHex(cl.color)}" stop-opacity="1"/><stop offset="100%" stop-color="${toHex(cl.color)}" stop-opacity="0"/></radialGradient>`,
    );
    const seedX = (hashStr(`${key}:${i}:x`) % 1_000_000) / 1_000_000;
    const seedY = (hashStr(`${key}:${i}:y`) % 1_000_000) / 1_000_000;
    for (let j = 0; j < n; j++) {
      // Blue-noise offset in the cluster's local eigen-frame, scaled by sigma.
      const lx = (frac(seedX + j * R2_A1) - 0.5) * 2 * SCATTER_PX * s1;
      const ly = (frac(seedY + j * R2_A2) - 0.5) * 2 * SCATTER_PX * s2;
      const x = (cx0 + lx * cos - ly * sin).toFixed(2);
      const y = (cy0 + lx * sin + ly * cos).toFixed(2);
      dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${gid})" opacity="${DOT_OPACITY}"/>`);
    }
  }
  return `<svg class="splat" viewBox="0 0 ${SPLAT_W} ${SPLAT_H}" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><defs>${defs.join("")}</defs><rect width="${SPLAT_W}" height="${SPLAT_H}" fill="${baseHex}"/><g filter="url(#b-${key})">${dots.join("")}</g></svg>`;
}

// Pill vocabulary follows the shipped preview's semantics (style.css .pill):
// ink-filled = attention (a failing / above-bar verdict), outlined = pass — and
// the pass pill carries the --lime-text accent, since lime is reserved for
// positive state exactly as the preview reserves it for the current-position marker.
type PillKind = "pass" | "attention" | "neutral" | "auto";
const pill = (kind: PillKind, text: string) => `<span class="pill ${kind}">${esc(text)}</span>`;
const verdictPill = (pass: boolean, text: string) => pill(pass ? "pass" : "attention", text);

function ratingHtml(row: OptionRow): string {
  const badges: string[] = [];
  if (!row.available) {
    badges.push(pill("attention", "unavailable"));
    return `<div class="rating">${badges.join("")}</div>`;
  }
  if (row.kind === "colour") {
    // A recolor's verdict is the policy acceptance (within bar), NOT the worst
    // cluster — a within-bar colour still leaves the low-mass dark moments below
    // the ratio, so the worst ratio is shown as context, never as the verdict.
    if (row.withinBar !== undefined) badges.push(verdictPill(row.withinBar, row.withinBar ? "within bar" : "above bar"));
    if (row.ratio !== undefined) badges.push(pill("neutral", `worst ${ratioStr(row.ratio)}`));
    if (row.failingMass !== undefined) badges.push(pill("neutral", `mass ${(row.failingMass * 100).toFixed(1)}%`));
    if (row.autoChoice) badges.push(pill("auto", "auto choice"));
  } else {
    // Halo / background are guaranteed: the composited ratio IS the verdict.
    if (row.ratio !== undefined) badges.push(verdictPill(row.passes, `${ratioStr(row.ratio)} ${row.passes ? "✓" : "✗"}`));
  }
  return `<div class="rating">${badges.join("")}</div>`;
}

function specimenStyle(row: OptionRow): string {
  let s = `font-size:${row.fontSize}px;font-weight:${row.fontWeight};`;
  if (row.textHex) s += `color:${row.textHex};`; // omitted on unavailable rows (F8)
  if (row.kind === "shadow" && row.shadowHex) {
    s += `text-shadow:${shadowStackCss(row.shadowHex, row.recipe)};`;
  }
  if (row.kind === "outline" && row.shadowHex) {
    s += `-webkit-text-stroke:1.5px ${row.shadowHex};`;
  }
  if (row.kind === "background" && row.backingHex) {
    s += `background:${row.backingHex};padding:2px 12px;border-radius:7px;`;
  }
  return s;
}

// The solved shadow recipe as a CSS text-shadow value: `layers` centered
// `0 0 {blur}px HEXd9` shadows (matching the applier + the falloff rating).
function shadowStackCss(hex: string, recipe?: { layers: number; blur: number }): string {
  const { layers, blur } = recipe ?? DEFAULT_SHADOW_RECIPE;
  return Array.from({ length: layers }, () => `0 0 ${blur}px ${hex}d9`).join(",");
}

// Compact id list — the outlier members, or the corpus colour's within-class
// leftovers. Capped so the row stays short; the appendix has the full table.
function idListHtml(row: OptionRow): string {
  const ids = row.exceptionIds;
  if (!ids || ids.length === 0) return "";
  const shown = ids.slice(0, 10).map((i) => `<code>${esc(i)}</code>`).join(" ");
  const more = ids.length > 10 ? ` +${ids.length - 10} more` : "";
  const lead =
    row.scope === "outliers"
      ? `${ids.length} element${ids.length === 1 ? "" : "s"}:`
      : `leaves ${ids.length} above bar:`;
  return `<p class="idlist">${lead} ${shown}${esc(more)} <span class="idlist-ref">(appendix)</span></p>`;
}

// The `data-group`/`data-choice`/`data-word` attributes for an available option —
// the full choice entry + chat phrase. Shared by the studio rows AND the variants
// tiles so both carry an identical, contract-valid payload.
function choiceDataAttrs(row: OptionRow, level: string): string {
  const hex = (row.kind === "shadow" || row.kind === "outline" ? row.shadowHex : row.textHex)!;
  const entry: Record<string, unknown> = { level, group: row.scope, kind: row.kind, hex };
  if (row.kind === "background" && row.backingHex) entry.backingHex = row.backingHex;
  entry.selector = row.selector;
  if (row.split) entry.split = row.split; // per-selector split for a heterogeneous group
  if (row.kind === "shadow" && row.recipe) entry.recipe = { layers: row.recipe.layers, blur: row.recipe.blur };
  const recipeWord = row.recipe ? ` (${row.recipe.layers}× ${row.recipe.blur}px)` : "";
  const word = row.splitLabel
    ? `apply ${level} ${row.scope} ${row.kind}${recipeWord} — ${row.splitLabel}`
    : `apply ${level} ${row.scope} ${row.kind} ${hex}${recipeWord}` +
      (row.kind === "background" && row.backingHex ? ` on ${row.backingHex}` : "");
  return `data-group="${esc(row.scope)}" data-choice="${esc(JSON.stringify(entry))}" data-word="${esc(word)}"`;
}

// The WHOLE row is the click target for an available option — clicking (or
// Enter/Space) IS the approval. The row carries the full choice entry + the chat
// phrase as data-* so the inline script needs no per-row logic; unavailable rows
// (e.g. AAA with no feasible colour) are NOT interactive and stay muted.
function rowHtml(row: OptionRow, level: string): string {
  const chip = `<span class="chip" style="background:${row.kind === "background" && row.backingHex ? row.backingHex : row.textHex}"></span>`;
  const splatKey = `${level}-${row.scope}-${row.kind}`; // unique per strip (gradient ids)

  let attrs = `class="row row--na"`;
  let chosenTag = "";
  if (row.available) {
    attrs =
      `class="row row--choose" role="button" tabindex="0"` +
      ` aria-label="${esc(`Choose ${level} ${row.scope} ${row.kind}`)}"` +
      ` ${choiceDataAttrs(row, level)}`;
    chosenTag = `<span class="chosen-tag">✓ chosen</span>`;
  }

  return `<div ${attrs}>
  <div class="strip">${splatSvg(row.bands, splatKey)}<span class="specimen" style="${specimenStyle(row)}">${esc(`${row.specimenLabel} · Sample Aa 123`)}</span></div>
  <div class="rowmeta"><span class="rowlabel">${chip}${esc(row.label)}</span><div class="row-right">${ratingHtml(row)}${chosenTag}</div></div>
  ${row.splitLabel ? `<p class="splitlabel">${esc(row.splitLabel)}</p>` : ""}
  ${row.note ? `<p class="rownote">${esc(row.note)}</p>` : ""}
  ${idListHtml(row)}
</div>`;
}

function groupBlockHtml(block: GroupBlock, level: string): string {
  return `<div class="group-block">
  <h3 class="group-head">${esc(block.title)}</h3>
  <div class="level-rows">
  ${block.rows.map((r) => rowHtml(r, level)).join("\n  ")}
  </div>
</div>`;
}

function levelHtml(section: LevelSection): string {
  return `<section class="level">
  <h2 class="level-head">${esc(section.level)} <span class="level-req">needs ${ratioStr(section.corpusRequiredRatio)} · ${section.largeText ? "large" : "normal"} text</span></h2>
  ${section.groups.map((g) => groupBlockHtml(g, section.level)).join("\n  ")}
</section>`;
}

function appendixHtml(entries: AppendixEntry[]): string {
  const rows = entries
    .map(
      (e) =>
        `<tr><td><code>${esc(e.id)}</code></td><td><code>${esc(e.className)}</code></td><td>${e.group}</td><td class="num">${e.indeterminate ? "—" : ratioStr(e.currentRatio)}</td><td>${verdictCell(e.aa)}</td><td>${verdictCell(e.aaa)}</td></tr>`,
    )
    .join("\n");
  return `<details class="appendix">
<summary>Per-element detail — ${entries.length} failing element${entries.length === 1 ? "" : "s"}</summary>
<div class="table-wrap"><table>
<thead><tr><th>id</th><th>class</th><th>group</th><th class="num">current</th><th>AA</th><th>AAA</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</details>`;
}
const verdictCell = (pass: boolean) => (pass ? '<span class="tick ok">pass</span>' : '<span class="tick bad">fail</span>');

// The ORIGINAL (pre-remediation) render, referenced relatively (the page lives in
// final/ next to it). controls + preload metadata, no autoplay. When the original
// is unavailable (post-apply, no draft render) an honest inline note stands in.
function videoBlockHtml(video: VideoRef | null): string {
  if (!video) return "";
  if (video.src === null) return `<p class="video-missing">${esc(video.reason)}</p>`;
  return `<div class="video-card">
  <video controls preload="metadata" src="${esc(video.src)}"></video>
  <p class="video-cap">original (before changes)</p>
</div>`;
}

// One lean line framing the auto-choice as PROSPECTIVE ("what apply would do"),
// plus a past measurement only when a remediated report was found.
function applyLineHtml(doc: AggregateDoc): string {
  const base = `The <span class="pill auto">auto choice</span> pill marks what applying would pick — nothing here is applied.`;
  const meas = doc.measured
    ? ` Past measurement: a prior apply took ${doc.measured.beforeFailing} → ${doc.measured.afterFailing} failing runs.`
    : "";
  return `<p class="apply-line">${base}${meas}</p>`;
}

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--base);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5}
.strip-top{display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px;padding:0 20px;min-height:56px;background:var(--raised);border-bottom:1px solid var(--border-subtle);position:sticky;top:0;z-index:5}
.wordmark{font-family:var(--heading);font-weight:500;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink)}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 72px}
.page-title{font-family:var(--heading);font-weight:500;font-size:24px;letter-spacing:-.02em;margin:0 0 4px;color:var(--ink)}
.lede{color:var(--sub);margin:0 0 24px;font-size:14px;max-width:74ch}
.summary{display:flex;gap:24px;flex-wrap:wrap;margin:0 0 28px;padding:16px 18px;background:var(--raised);border:1px solid var(--border-subtle);border-radius:14px;box-shadow:var(--shadow)}
.summary b{font-family:var(--heading);font-weight:500;font-size:22px;display:block;color:var(--ink);font-variant-numeric:tabular-nums}
.summary code{font-family:var(--sans);font-size:15px}
.summary span{color:var(--sub);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.level{margin:0 0 26px}
.level-head{font-family:var(--heading);font-weight:500;font-size:19px;letter-spacing:-.01em;margin:0 0 12px;display:flex;align-items:baseline;gap:10px}
.level-req{font-family:var(--sans);font-weight:400;font-size:12.5px;color:var(--sub);text-transform:none;letter-spacing:0}
.level-rows{display:flex;flex-direction:column;gap:10px}
.group-block{margin:0 0 16px}
.group-head{font-family:var(--sans);font-weight:500;font-size:13px;color:var(--sub);margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border-subtle);text-transform:uppercase;letter-spacing:.05em}
.splitlabel{font-size:12px;color:var(--ink);margin:0;padding:0 12px 10px;font-weight:500}
.row{background:var(--raised);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
.strip{position:relative;height:60px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.splat{position:absolute;inset:0;width:100%;height:100%;display:block}
.splat--empty{position:absolute;inset:0;background:repeating-linear-gradient(45deg,var(--sunken) 0 8px,var(--border-subtle) 8px 16px)}
.specimen{position:relative;z-index:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:94%;font-family:sans-serif}
.video-card{max-width:420px;margin:0 0 26px;background:var(--raised);border:1px solid var(--border-subtle);border-radius:14px;box-shadow:var(--shadow);padding:12px;text-align:center}
.video-card video{width:100%;height:auto;border-radius:10px;background:#000;display:block}
.video-cap{margin:8px 0 2px;font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:.06em}
.video-missing{margin:0 0 22px;padding:10px 12px;font-size:12.5px;color:var(--sub);background:var(--sunken);border:1px solid var(--border-subtle);border-radius:10px}
.apply-line{margin:0 0 24px;font-size:12.5px;color:var(--sub);line-height:1.6}
.apply-line .pill{font-size:10.5px;padding:1px 8px}
.rowmeta{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-top:1px solid var(--border-subtle);flex-wrap:wrap}
.rowlabel{font-size:13px;color:var(--ink);font-weight:500;display:flex;align-items:center;gap:8px}
.chip{width:14px;height:14px;border-radius:4px;border:1px solid var(--border);display:inline-block;flex:none}
.rating{display:flex;gap:6px;flex-wrap:wrap}
.pill{font-size:11px;font-variant-numeric:tabular-nums;padding:3px 11px;border-radius:999px;display:inline-flex;align-items:center;gap:6px;font-weight:500;white-space:nowrap;border:1px solid transparent}
.pill.attention{background:var(--ink);color:var(--base)}
.pill.pass{background:var(--raised);color:var(--lime-text);border-color:var(--lime-text)}
.pill.neutral{background:var(--sunken);color:var(--sub);border-color:var(--border-subtle)}
.pill.auto{background:var(--violet-fill);color:var(--violet);border-color:var(--violet-mid)}
.row-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.row--choose{cursor:pointer;transition:border-color .1s,box-shadow .1s}
.row--choose:hover{border-color:var(--ink);box-shadow:0 2px 10px rgba(12,10,9,.10)}
.row--choose:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.row.chosen{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
.row--na{opacity:.72}
.chosen-tag{display:none;font-size:11px;font-weight:500;padding:3px 11px;border-radius:999px;background:var(--raised);color:var(--lime-text);border:1px solid var(--lime-text);white-space:nowrap}
.row.chosen .chosen-tag{display:inline-flex;align-items:center}
.choose-hint{display:block;font-size:12px;color:var(--sub);padding:0 12px 10px;font-variant-numeric:tabular-nums}
.choose-hint code{background:var(--sunken);padding:1px 6px;border-radius:5px;color:var(--ink)}
.rownote{font-size:12.5px;color:var(--sub);margin:0;padding:0 12px 10px}
.idlist{font-size:12px;color:var(--sub);margin:0;padding:0 12px 10px;line-height:1.9}
.idlist code{background:var(--sunken);padding:1px 6px;border-radius:5px;color:var(--ink)}
.idlist-ref{color:var(--xsub)}
.appendix{margin-top:8px;background:var(--raised);border:1px solid var(--border-subtle);border-radius:12px;padding:4px 14px}
.appendix summary{font-size:13px;font-weight:500;cursor:pointer;padding:10px 0;color:var(--ink)}
.table-wrap{overflow-x:auto}
.appendix table{border-collapse:collapse;width:100%;font-size:12.5px;margin:4px 0 12px}
.appendix th{text-align:left;color:var(--sub);font-weight:500;padding:6px 10px;border-bottom:1px solid var(--border-subtle);position:sticky;top:0;background:var(--raised)}
.appendix td{padding:6px 10px;border-bottom:1px solid var(--border-subtle)}
.appendix td.num,.appendix th.num{text-align:right;font-variant-numeric:tabular-nums}
.appendix code{background:var(--sunken);padding:1px 5px;border-radius:4px;color:var(--ink)}
.tick.ok{color:var(--lime-text);font-weight:500}
.tick.bad{color:var(--ink)}
.foot{margin-top:26px;font-size:12px;color:var(--sub);border-top:1px solid var(--border-subtle);padding-top:14px;line-height:1.6}
`;

// Inline, CSP-friendly (addEventListener, no eval, no inline handlers) choice
// script. The WHOLE available row is the target: a click or Enter/Space POSTs to
// /wcag/choice over http and flips the row to a "chosen" state (unmarking the
// group's other rows); over file:// it degrades to the exact chat-word fallback
// shown inline, so activation is never dead. All text goes through textContent —
// no HTML injection from data-*.
const CHOICE_SCRIPT = `<script>
(function(){
  var served = location.protocol === 'http:' || location.protocol === 'https:';
  function hint(row, prefix, code){
    var h = row.querySelector('.choose-hint');
    if(!h){ h = document.createElement('span'); h.className = 'choose-hint'; row.appendChild(h); }
    h.textContent = prefix + (code ? ' ' : '');
    if(code){ var c = document.createElement('code'); c.textContent = code; h.appendChild(c); }
  }
  function unmark(group){
    var all = document.querySelectorAll('[data-choice][data-group="' + group + '"]');
    for(var i=0;i<all.length;i++){ all[i].classList.remove('chosen'); }
  }
  function activate(row){
    var raw = row.getAttribute('data-choice'), entry = JSON.parse(raw);
    if(served){
      fetch('/wcag/choice', { method:'POST', headers:{'content-type':'application/json'}, body: raw })
        .then(function(r){ if(!r.ok){ return r.text().then(function(t){ throw new Error(t || ('HTTP ' + r.status)); }); }
          unmark(entry.group); row.classList.add('chosen'); })
        .catch(function(e){ hint(row, 'could not save: ' + e.message); });
    } else {
      hint(row, 'say:', row.getAttribute('data-word'));
    }
  }
  var rows = document.querySelectorAll('[data-choice]');
  for(var i=0;i<rows.length;i++){
    rows[i].addEventListener('click', function(ev){ activate(ev.currentTarget); });
    rows[i].addEventListener('keydown', function(ev){
      if(ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar'){ ev.preventDefault(); activate(ev.currentTarget); }
    });
  }
})();
</script>`;

// VEED light ONLY (coherence with the shipped preview beats dual-theme). The
// design tokens are inlined from preview/page/tokens.css (the SSOT); this sheet
// only consumes them via var(). `tokensCss` is verbatim tokens.css content and
// is part of the studio's deterministic input.
export function renderPage(doc: AggregateDoc, tokensCss: string): string {
  const status = doc.passed
    ? pill("pass", "AA/AAA clean")
    : pill("attention", `${doc.failingCount} failing`);
  // Studio adopts Variant A: a tall large-splat Gaussian field per group block +
  // a compact interactive tile grid (the tiles POST to /wcag/choice).
  const body = doc.levels
    .map(
      (lv) => `<section class="level">
  <h2 class="level-head">${esc(lv.level)} <span class="level-req">needs ${ratioStr(lv.corpusRequiredRatio)} · ${lv.largeText ? "large" : "normal"} text</span></h2>
  ${lv.groups.map((g) => variantAGroup(g, lv.level)).join("\n")}
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WCAG recommendation studio · VEED</title>
<style>
/* Design tokens inlined from preview/page/tokens.css (SSOT) at generation time. */
${tokensCss}
${STYLE}
${VARIANTS_STYLE}
</style>
</head>
<body>
<div class="strip-top">
  <span class="wordmark">VEED · WCAG Studio</span>
  ${status}
</div>
<div class="wrap">
<h1 class="page-title">Contrast recommendations</h1>
<p class="lede">This is a pre-decision view — pick the fix you want here before anything is applied. The failing text is rolled up into a corpus and its outliers, with a few options per group at AA then AAA, rated against the same pooled-cluster policy the gate uses.</p>
${videoBlockHtml(doc.video)}
<div class="summary">
  <div><b>${doc.failingCount}</b><span>failing elements</span></div>
  <div><b>${doc.corpusMemberCount}</b><span>corpus <code>${esc(doc.corpusClassKey)}</code></span></div>
  <div><b>${doc.outlierMemberCount}</b><span>outliers</span></div>
  <div><b>${ratioStr(doc.floor)}</b><span>lead floor</span></div>
  <div><b>${(doc.bar * 100).toFixed(0)}%</b><span>mass bar</span></div>
</div>
${applyLineHtml(doc)}
${body}
${appendixHtml(doc.appendix)}
${CHOICE_SCRIPT}
<p class="foot">Each group's backdrop is a Gaussian field of large overlapping radial-gradient splats (one per pooled cluster, radius from the covariance) — the true background range, not one flat gray. Click a tile (or Enter/Space) to choose it; over http that POSTs to /wcag/choice, over file:// it shows the exact chat-word. RATINGS differ by treatment: a recolor is rated over the pooled clusters; a soft SHADOW is rated per cluster (the translucent shadow blended over each sampled background); an OUTLINE is background-independent (fg vs the outline colour only); the background plate is the guaranteed anchor. Specimens use the browser's generic sans-serif; page fonts are Inter/SwissNow from the VEED tokens.</p>
</div>
</body>
</html>
`;
}

// ===========================================================================
// DESIGN VARIANTS PAGE (wcag-design-variants.html) — a STATIC design chooser:
// the SAME data (AA level, corpus + outliers blocks) rendered in three complete
// treatments A/B/C stacked for the user to pick. Deterministic; tiles carry the
// clickable choice payload in markup but the page has NO live POST script.
// Direction: tiles small (2-3 per grid row), Gaussians LARGE and actually visible.
// ===========================================================================

const FIELD_W = 400;
const FIELD_H = 150;
const FIELD_BASE_R = 74; // ~6x the studio dot base — a big, visible blob
const FIELD_GAIN = 420; // px of radius per unit OKLAB sigma
const MESH_FLOOR = 130; // px radius floor so every CSS-mesh cluster stays visible
const MESH_GAIN = 560;

// VARIANT A field: ONE large radial-gradient splat per cluster (not many dots),
// heavily blurred and overlapping -> a continuous cloud. rx >= FIELD_BASE_R.
export function gaussianFieldSvg(bands: PooledClusterStat[], key: string): string {
  if (bands.length === 0) return `<div class="gfield gfield--empty" aria-hidden="true"></div>`;
  const wMax = bands.reduce((m, b) => Math.max(m, b.weight), 0) || 1;
  const wSum = bands.reduce((s, b) => s + b.weight, 0) || 1;
  const mean = { r: 0, g: 0, b: 0 };
  for (const b of bands) { mean.r += b.color.r * b.weight; mean.g += b.color.g * b.weight; mean.b += b.color.b * b.weight; }
  const baseHex = toHex({ r: Math.round(mean.r / wSum), g: Math.round(mean.g / wSum), b: Math.round(mean.b / wSum) });
  const defs = [`<filter id="f-${key}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>`];
  const order = bands.map((_, i) => i).sort((a, c) => bands[a].weight - bands[c].weight || a - c);
  const ell: string[] = [];
  for (const i of order) {
    const cl = bands[i];
    const { s1, s2, angleDeg } = eigenAxes(cl.covariance);
    const rx = (FIELD_BASE_R + FIELD_GAIN * s1).toFixed(1);
    const ry = (FIELD_BASE_R * 0.8 + FIELD_GAIN * s2).toFixed(1);
    const cx = ((0.1 + relativeLuminance(cl.color) * 0.8) * FIELD_W).toFixed(1);
    const cy = ((0.15 + ((hashStr(`${key}:${i}`) % 1000) / 1000) * 0.7) * FIELD_H).toFixed(1);
    const op = (0.32 + 0.4 * (cl.weight / wMax)).toFixed(3);
    const gid = `fg-${key}-${i}`;
    defs.push(`<radialGradient id="${gid}"><stop offset="0%" stop-color="${toHex(cl.color)}" stop-opacity="0.95"/><stop offset="100%" stop-color="${toHex(cl.color)}" stop-opacity="0"/></radialGradient>`);
    ell.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${angleDeg.toFixed(1)} ${cx} ${cy})" fill="url(#${gid})" opacity="${op}"/>`);
  }
  return `<svg class="gfield" viewBox="0 0 ${FIELD_W} ${FIELD_H}" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><defs>${defs.join("")}</defs><rect width="${FIELD_W}" height="${FIELD_H}" fill="${baseHex}"/><g filter="url(#f-${key})">${ell.join("")}</g></svg>`;
}

// VARIANT B/C mesh: a CSS background stacking one LARGE radial-gradient per
// cluster (weight -> 8-digit-hex opacity, x by luminance, big sigma-scaled radii
// with a floor) over the weighted-mean base — a smooth blended mesh, no SVG.
export function meshGradientStyle(bands: PooledClusterStat[]): string {
  if (bands.length === 0) return "var(--sunken)";
  const wMax = bands.reduce((m, b) => Math.max(m, b.weight), 0) || 1;
  const wSum = bands.reduce((s, b) => s + b.weight, 0) || 1;
  const mean = { r: 0, g: 0, b: 0 };
  for (const b of bands) { mean.r += b.color.r * b.weight; mean.g += b.color.g * b.weight; mean.b += b.color.b * b.weight; }
  const baseHex = toHex({ r: Math.round(mean.r / wSum), g: Math.round(mean.g / wSum), b: Math.round(mean.b / wSum) });
  const layers = bands.map((cl, i) => {
    const { s1, s2 } = eigenAxes(cl.covariance);
    const rx = Math.round(MESH_FLOOR + MESH_GAIN * s1);
    const ry = Math.round(MESH_FLOOR + MESH_GAIN * s2);
    const x = (relativeLuminance(cl.color) * 100).toFixed(1);
    const y = (((hashStr(`${toHex(cl.color)}:${i}`) % 1000) / 1000) * 100).toFixed(1);
    const a = Math.round((0.4 + 0.5 * (cl.weight / wMax)) * 255).toString(16).padStart(2, "0");
    return `radial-gradient(ellipse ${rx}px ${ry}px at ${x}% ${y}%, ${toHex(cl.color)}${a} 0%, transparent 70%)`;
  });
  return `${layers.join(", ")}, ${baseHex}`;
}

const kindLabel = (row: OptionRow): string =>
  row.kind === "colour" ? "Recolor" : row.kind === "shadow" ? "Shadow" : row.kind === "outline" ? "Outline" : "Backing";

// Compact specimen (fixed small size) for a variant tile/card.
function tileSpecimenStyle(row: OptionRow): string {
  let s = `font-size:20px;font-weight:600;`;
  if (row.textHex) s += `color:${row.textHex};`; // omitted on unavailable rows (F8)
  if (row.kind === "shadow" && row.shadowHex) s += `text-shadow:${shadowStackCss(row.shadowHex, row.recipe)};`;
  if (row.kind === "outline" && row.shadowHex) s += `-webkit-text-stroke:1.2px ${row.shadowHex};`;
  if (row.kind === "background" && row.backingHex) s += `background:${row.backingHex};padding:1px 9px;border-radius:5px;`;
  return s;
}

// Condensed pills (verdict only) + full details as a title attr — metadata is
// squeezed per the brief.
function tilePills(row: OptionRow): string {
  if (!row.available) return pill("attention", "n/a");
  if (row.kind === "colour") return row.withinBar !== undefined ? verdictPill(row.withinBar, row.withinBar ? "within bar" : "above bar") : "";
  return row.ratio !== undefined ? verdictPill(row.passes, ratioStr(row.ratio)) : "";
}
function tileDetails(row: OptionRow, level: string): string {
  const parts = [`${level} ${row.scope} ${row.kind}`];
  if (row.ratio !== undefined) parts.push(`ratio ${ratioStr(row.ratio)}`);
  if (row.failingMass !== undefined) parts.push(`mass ${(row.failingMass * 100).toFixed(1)}%`);
  if (row.withinBar !== undefined) parts.push(row.withinBar ? "within bar" : "above bar");
  if (row.splitLabel) parts.push(row.splitLabel);
  if (row.note) parts.push(row.note);
  return parts.join(" · ");
}
function tileAttrs(row: OptionRow, level: string): string {
  return row.available ? ` role="button" tabindex="0" ${choiceDataAttrs(row, level)}` : "";
}
// The shadow tile shows its solved recipe (e.g. "Shadow 2×8px"); others just the kind.
const tileLabel = (row: OptionRow): string =>
  row.kind === "shadow" && row.recipe ? `Shadow ${row.recipe.layers}×${row.recipe.blur}px` : kindLabel(row);

// A/B share the compact grid tile (mesh mini-strip behind the specimen). The
// chosen-tag stays hidden until the (studio-only) choice script marks it .chosen;
// on the static variants page it never appears.
function variantTile(row: OptionRow, level: string, tileBg: string): string {
  return `<div class="vtile${row.available ? "" : " vtile--na"}"${tileAttrs(row, level)} title="${esc(tileDetails(row, level))}">
    <div class="vstrip" style="background:${tileBg}"><span class="vspec" style="${tileSpecimenStyle(row)}">${esc(kindLabel(row))} Aa</span></div>
    <div class="vmeta"><span class="vlabel">${esc(tileLabel(row))}</span>${tilePills(row)}${row.autoChoice ? pill("auto", "auto") : ""}<span class="chosen-tag">✓ chosen</span></div>
  </div>`;
}

function variantAGroup(block: GroupBlock, level: string): string {
  const bands = block.rows[0].bands;
  const mesh = meshGradientStyle(bands);
  return `<div class="vgroup">
    <h4 class="vgroup-head">${esc(block.title)}</h4>
    <div class="gfield-band">${gaussianFieldSvg(bands, `A-${level}-${block.scope}`)}</div>
    <div class="vtiles">${block.rows.map((r) => variantTile(r, level, mesh)).join("")}</div>
  </div>`;
}

function variantBGroup(block: GroupBlock, level: string): string {
  const bands = block.rows[0].bands;
  const mesh = meshGradientStyle(bands);
  return `<div class="vgroup">
    <h4 class="vgroup-head">${esc(block.title)}</h4>
    <div class="mesh-band" style="background:${mesh}"></div>
    <div class="vtiles">${block.rows.map((r) => variantTile(r, level, mesh)).join("")}</div>
  </div>`;
}

function variantCGroup(block: GroupBlock, level: string): string {
  const bands = block.rows[0].bands;
  const mesh = meshGradientStyle(bands);
  const cards = block.rows
    .map(
      (r) => `<div class="vcard${r.available ? "" : " vtile--na"}"${tileAttrs(r, level)} title="${esc(tileDetails(r, level))}">
      <span class="vspec" style="${tileSpecimenStyle(r)}">${esc(kindLabel(r))} Aa</span>
      <span class="vcard-meta">${tilePills(r)}</span>
    </div>`,
    )
    .join("");
  return `<div class="vgroup">
    <h4 class="vgroup-head">${esc(block.title)}</h4>
    <div class="vcards" style="background:${mesh}">${cards}</div>
  </div>`;
}

const VARIANTS_STYLE = `
.variant{margin:0 0 40px;padding:0 0 16px;border-bottom:1px solid var(--border-subtle)}
.vhead{font-family:var(--heading);font-weight:500;font-size:22px;margin:0 0 4px;display:flex;align-items:center;gap:12px;color:var(--ink)}
.vbadge{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--ink);color:var(--base);font-size:18px;font-weight:600}
.vdesc{color:var(--sub);font-size:13.5px;margin:0 0 18px;max-width:76ch}
.vgroup{margin:0 0 22px}
.vgroup-head{font-size:12px;font-weight:500;color:var(--sub);text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px}
.gfield-band{height:150px;border-radius:12px;overflow:hidden;border:1px solid var(--border-subtle);margin:0 0 12px}
.gfield{display:block;width:100%;height:100%}
.mesh-band{height:150px;border-radius:12px;border:1px solid var(--border-subtle);margin:0 0 12px}
.vtiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.vtile{border:1px solid var(--border-subtle);border-radius:10px;overflow:hidden;background:var(--raised);transition:border-color .1s}
.vtile[role=button]{cursor:pointer}
.vtile[role=button]:hover{border-color:var(--ink)}
.vtile:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.vtile.chosen{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
.vtile.chosen .chosen-tag{display:inline-flex;align-items:center}
.vtile .choose-hint{padding:0 9px 8px}
.vtile--na{opacity:.6}
.vstrip{height:52px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.vspec{white-space:nowrap;font-family:sans-serif}
.vmeta{display:flex;align-items:center;gap:6px;padding:7px 9px;border-top:1px solid var(--border-subtle);flex-wrap:wrap}
.vlabel{font-size:12px;font-weight:500;color:var(--ink)}
.vcards{display:flex;gap:10px;overflow-x:auto;padding:12px;border-radius:12px;border:1px solid var(--border-subtle)}
.vcard{flex:0 0 auto;min-width:150px;background:rgba(255,255,255,.82);border:1px solid var(--border-subtle);border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.vcard[role=button]{cursor:pointer}
.vcard[role=button]:hover{border-color:var(--ink)}
.vcard:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.vcard-meta{display:flex;gap:5px;flex-wrap:wrap}
.variant .pill{font-size:10px;padding:2px 8px}
`;

// Assemble the static three-variant chooser (AA level only). No CHOICE_SCRIPT.
export function renderVariantsPage(doc: AggregateDoc, tokensCss: string): string {
  const aa = doc.levels[0];
  const variants: { id: string; title: string; desc: string; render: (b: GroupBlock, l: string) => string }[] = [
    { id: "A", title: "Compact grid + Gaussian field", desc: "Small tiles in a responsive grid; each group's backdrop is a tall SVG field of large overlapping Gaussian splats — a visible continuous cloud.", render: variantAGroup },
    { id: "B", title: "CSS mesh-gradient", desc: "No SVG — each group strip is a single element stacking large CSS radial-gradients (one per cluster) into a smooth blended mesh.", render: variantBGroup },
    { id: "C", title: "Horizontal strip cards", desc: "Each option a small card in one horizontal row per group, over the group's mesh backdrop; most compact vertically.", render: variantCGroup },
  ];
  const sections = variants
    .map(
      (v) => `<section class="variant" id="variant-${v.id.toLowerCase()}">
  <h2 class="vhead"><span class="vbadge">${v.id}</span>${esc(v.title)}</h2>
  <p class="vdesc">${esc(v.desc)}</p>
  ${aa.groups.map((g) => v.render(g, aa.level)).join("\n")}
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WCAG design variants · VEED</title>
<style>
/* Design tokens inlined from preview/page/tokens.css (SSOT) at generation time. */
${tokensCss}
${STYLE}
${VARIANTS_STYLE}
</style>
</head>
<body>
<div class="strip-top">
  <span class="wordmark">VEED · WCAG Studio</span>
  <span class="pill neutral">design variants</span>
</div>
<div class="wrap">
<h1 class="page-title">Design variants</h1>
<p class="lede">Three complete treatments of the AA recommendations (corpus + outliers) — pick the one you want. This is a static chooser: tiles carry their choice payload but nothing is applied here.</p>
${sections}
<p class="foot">Same data, three designs. A renders each group's background as an SVG field of large overlapping Gaussian splats; B and C stack large CSS radial-gradients (one per cluster, sized from the covariance with a visibility floor, opacity from weight) into a mesh. Tiles are condensed — verdict pills only, full details on hover. Specimens are the browser's generic sans-serif; page fonts are Inter/SwissNow from the VEED tokens.</p>
</div>
</body>
</html>
`;
}
