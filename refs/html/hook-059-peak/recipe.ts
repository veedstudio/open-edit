// Compiled recipe — hook-059-peak (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// A brutalist full-bleed poster: giant red Anton caps stretched tall by a static scaleY to span the
// frame. The beat SPLITS AT ITS ACCENT (digits first, else longest) into up to three rows — what is
// spoken before it, the accent alone, what follows — so the rows always run in the sentence's own
// order; the accent row is letter-spaced across the width. The LAST beat swaps to the prefab's
// peak composition (small lowercase Baloo counter line, monumental letter-spaced headline, red Hanken
// credits block fading in after the headline word). Words pop in on their verbatim delays; the cue
// gate hard-cuts each poster at the next beat's start.
// The condensed look is layout-font × scaleY (never the prefab's giant-font × scaleX squeeze): the
// engine clips glyphs whose PRE-transform layout position leaves the canvas, so the layout box must
// fit the canvas and the stretch happen in the transform.
// Only the sheet's bounds fix is automated via opts.demote (b{N}r1/r2/r3/c/h → that row's ladder steps
// down AND its width budget shrinks ×0.96 per step). Never-visible / occluded / exit-2 fixes are
// diagnostic checklists — report-only.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// Anton 400 advances (em/char, measured from an engine calibration render at letter-spacing 0).
export const ANTON_ADV: Record<string, number> = {
  A: 0.484, B: 0.475, C: 0.473, D: 0.489, E: 0.409, F: 0.396, G: 0.483, H: 0.495, I: 0.224,
  J: 0.464, K: 0.47, L: 0.395, M: 0.741, N: 0.494, O: 0.484, P: 0.469, Q: 0.491, R: 0.474,
  S: 0.459, T: 0.395, U: 0.471, V: 0.469, W: 0.71, X: 0.484, Y: 0.446, Z: 0.409,
  '0': 0.493, '1': 0.329, '2': 0.493, '3': 0.491, '4': 0.494, '5': 0.493, '6': 0.493, '7': 0.49,
  '8': 0.493, '9': 0.493, "'": 0.211, '?': 0.49, '!': 0.226, '£': 0.471, ',': 0.234, '.': 0.226,
  '-': 0.309, '&': 0.518, '%': 1.055, '$': 0.46, '+': 0.354, ':': 0.239, ';': 0.243, '"': 0.426,
};
// Baloo 2 700 advances (same calibration; the counter line renders lowercase).
export const BALOO_ADV: Record<string, number> = {
  a: 0.529, b: 0.574, c: 0.469, d: 0.571, e: 0.538, f: 0.411, g: 0.553, h: 0.57, i: 0.266,
  j: 0.273, k: 0.534, l: 0.269, m: 0.833, n: 0.568, o: 0.574, p: 0.57, q: 0.571, r: 0.391,
  s: 0.476, t: 0.38, u: 0.568, v: 0.538, w: 0.774, x: 0.51, y: 0.541, z: 0.474,
  '0': 0.595, '1': 0.384, '2': 0.514, '3': 0.516, '4': 0.606, '5': 0.518, '6': 0.551, '7': 0.498,
  '8': 0.558, '9': 0.553, "'": 0.198, '?': 0.486, '!': 0.279, '-': 0.358, ',': 0.224, '.': 0.218,
};

// Ink extents of the padded .w span construction (em from box top, engine calibration render):
// Anton caps 0.115..0.985, descenders (Q J , ;) reach 1.095; box height 1.2em (the 0.06/0.14
// padding), so the post-stretch ink center sits at boxTop + 0.6f + (0.55 − 0.6)·f·k.
const INK_MID = 0.55, BOX_MID = 0.6;
const BALOO_MID = 0.5925;
const DESC_RE = /[QJ,;]/;

export const W_REF = 1088; // displayed row width (the prefab fills ~85% of its canvas)
const CY1 = 181, CY2 = 537, CYH = 298, CYC = 81; // ink-band centers measured off the prefab render
const CREDITS_TOP = 506;
// scaleY stretches; layout-font caps give the prefab's visual cap sizes (366 / 356 / 321).
const K_TOP = 2.27, K_BOT = 2.17, K_HEAD = 1.56;
// Justification slack clamps (em). The MAX values are deliberately generous so a short word spreads
// across the frame instead of sitting small beside a long row — that stretch IS the poster idiom, and
// the slack is computed to fill, never to exceed. NOTE the solo-row form divides by `chars`, and
// letter-spacing trails the LAST glyph too, so a solo row fills `budget − ls·f` rather than the full
// budget; the row stays ink-centred on 640 (the `left: ls·f/2` re-centre). Dividing by `chars − 1`
// would make it reach both edges exactly — a deliberate design call, not an oversight.
const GAP_MIN = 0.18, GAP_MAX = 2.6, LS_MAX = 2.6;

// Ink bands by ROW COUNT. The beat splits at its accent — words before it, the accent, words after —
// so the rows always run in the sentence's own order top to bottom. A 3-row beat needs tighter bands,
// so its rows start further down the ladder (LADDER_START) to keep the stretched ink from colliding.
const BANDS: Record<number, number[]> = { 1: [360], 2: [CY1, CY2], 3: [140, 360, 580] };
const LADDER_START: Record<number, number> = { 1: 0, 2: 0, 3: 7 };

// Ordered layout-font ladders (×0.95 steps off each cap). The rung a row may take is filtered by its
// BAND at fit time (see fitAnton) — a descender tail must stay inside the 720 canvas.
export const TOP_FS = [161, 153, 145, 138, 131, 125, 118, 112, 107, 101, 96, 92, 87, 83, 79, 75, 71, 67, 64, 61, 58, 55, 52, 49, 47, 45, 42, 40, 38, 36];
export const BOT_FS = [164, 156, 148, 141, 134, 127, 121, 115, 109, 103, 98, 93, 89, 84, 80, 76, 72, 69, 65, 62, 59, 56, 53, 50, 48, 45, 43, 41, 39, 37];
export const HEAD_FS = [206, 196, 186, 177, 168, 159, 151, 144, 137, 130, 123, 117, 111, 106, 100, 95, 91, 86, 82, 78, 74, 70, 67, 63, 60, 57, 54, 52, 49, 47];
export const CFS = [58, 52, 47, 42, 38, 34, 31, 28, 25, 23, 21]; // Baloo counter-line ladder
const CANVAS_H = 720;

type RowKind = 'top' | 'bottom' | 'head';
const KIND = {
  top: { fs: TOP_FS, k: K_TOP, avg: 0.43, cy: CY1 },
  bottom: { fs: BOT_FS, k: K_BOT, avg: 0.46, cy: CY2 },
  head: { fs: HEAD_FS, k: K_HEAD, avg: 0.46, cy: CYH },
} as const;

export function ladderFor(fs: readonly number[], avg: number): LadderRow[] {
  return fs.map((f, i) => ({ cls: `${f}`, maxC: i < fs.length - 1 ? Math.floor(W_REF / (avg * f)) : Infinity }));
}

// Strip trailing . and , only; keep ? ! ' £ and internal punctuation.
export function stripWord(w: string): string {
  return w.replace(/[.,]+$/, '');
}
// Uppercased glued units (lib toUnits) over stripped tokens.
export function unitsFor(words: WordTiming[]): Unit[] {
  return toUnits(words.map((w) => ({ ...w, w: stripWord(w.w) })).filter((w) => w.w));
}

export function advEm(text: string, adv: Record<string, number>, fallback: number): number {
  return [...text].reduce((s, c) => s + (adv[c] ?? fallback), 0);
}
const unitAdv = (u: Unit) => advEm(u.spans.map((s) => s.text).join(''), ANTON_ADV, 0.55);

export interface RowFit { f: number; k: number; top: number; gapEm: number; lsEm: number }

// One fit for every Anton row: ladder pick by C (floored by the exact-advance fit), demotion steps
// the ladder down AND shrinks the width budget ×0.96 per step; the slack is justified into
// inter-word gaps (multi-unit rows) or letter-spacing (solo rows, prefab AMAZING/FRIDAY idiom).
export function fitAnton(units: Unit[], kind: RowKind, demote = 0, cy?: number, start = 0): RowFit {
  const cfg = KIND[kind];
  const band = cy ?? cfg.cy;
  // The tail budget comes from the BAND, never from the row's ROLE. The reading-order split can put
  // any role in any band — an accent spoken first leaves a 'top' row sitting in the low band — and a
  // role-keyed guard let that row take the full ladder with the guard permanently off, hanging its
  // Q/J/comma tails past the canvas (verify cannot see it: the stretch lives in scaleY and glyph ink
  // is measured PRE-transform). Ink below the band centre is 0.545·f·k with a tail, 0.435 without.
  const reach = units.some((u) => u.spans.some((s) => DESC_RE.test(s.text))) ? 0.545 : 0.435;
  const sizes = cfg.fs.slice(start).filter((f) => band + reach * f * cfg.k <= CANVAS_H);
  const ladder = ladderFor(sizes.length ? sizes : [cfg.fs[cfg.fs.length - 1]], cfg.avg);
  const budget = W_REF * 0.96 ** demote; // layout px — the row's displayed width
  const sumAdv = units.reduce((s, u) => s + unitAdv(u), 0);
  const minEm = sumAdv + (units.length > 1 ? GAP_MIN * (units.length - 1) : 0);
  let fitIdx = ladder.findIndex((r) => Number(r.cls) <= budget / minEm);
  if (fitIdx < 0) fitIdx = ladder.length - 1;
  const f = Number(pickRow(ladder.slice(fitIdx), charsOf(units), demote).cls);
  const slack = budget / f - sumAdv;
  const fit: RowFit = { f, k: cfg.k, top: band - BOX_MID * f + (BOX_MID - INK_MID) * f * cfg.k, gapEm: 0, lsEm: 0 };
  if (units.length > 1) {
    fit.gapEm = Math.min(GAP_MAX, Math.max(GAP_MIN, slack / (units.length - 1)));
  } else if (units[0].chars >= 2) {
    fit.lsEm = Math.min(LS_MAX, Math.max(0, slack / units[0].chars));
  }
  return fit;
}

export function fitCounter(units: Unit[], demote = 0): { f: number; top: number } {
  const ladder = ladderFor(CFS, 0.48);
  const budget = W_REF * 0.96 ** demote;
  const minEm = units.reduce((s, u) => s + advEm(u.spans.map((x) => x.text).join('').toLowerCase(), BALOO_ADV, 0.6), 0)
    + 0.25 * (units.length - 1);
  let fitIdx = ladder.findIndex((r) => Number(r.cls) <= budget / minEm);
  if (fitIdx < 0) fitIdx = ladder.length - 1;
  const f = Number(pickRow(ladder.slice(fitIdx), charsOf(units), demote).cls);
  return { f, top: CYC - BALOO_MID * f };
}

// Entrance closed forms — compressed so a late word still lands before its gate closes.
export function popMs(gateEndMs: number, delayMs: number): number {
  return Math.min(100, Math.max(40, gateEndMs - delayMs - 40));
}
export function counterInMs(gateEndMs: number, delayMs: number): number {
  return Math.min(350, Math.max(150, gateEndMs - delayMs - 80));
}
export function headInMs(gateEndMs: number, delayMs: number): number {
  return Math.min(400, Math.max(250, gateEndMs - delayMs - 80));
}
// Credits fade in 750ms after the headline word speaks (prefab: 3850→4600ms), pulled earlier if the
// clip is about to end, never before the beat's gate opens.
export function creditsDelayMs(cueDelayMs: number, headDelayMs: number, durEndMs: number): number {
  return Math.max(cueDelayMs, Math.min(headDelayMs + 750, durEndMs - 700));
}

function frac(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Emit { p: (n: number) => number; ph: (n: number) => number }

function spansHtml(
  units: Unit[], cls: string, gapPx: number, gateEnd: number, durFor: (g: number, d: number) => number,
  e: Emit, lower = false,
): string {
  const out: string[] = [];
  units.forEach((u, ui) => {
    u.spans.forEach((s, si) => {
      const glued = si < u.spans.length - 1;
      const last = ui === units.length - 1 && si === u.spans.length - 1;
      const gap = glued ? ';margin-right:0' : last ? '' : `;margin-right:${e.ph(gapPx)}px`;
      const style = `animation-delay:${s.delayMs}ms;animation-duration:${durFor(gateEnd, s.delayMs)}ms${gap}`;
      out.push(`<span class="${cls}" style="${style}">${escapeHtml(lower ? s.text.toLowerCase() : s.text)}</span>`);
    });
  });
  return out.join('');
}

function antonRowHtml(units: Unit[], id: string, fit: RowFit, gateEnd: number, e: Emit, wCls = 'w', durFor = popMs): string {
  // letter-spacing trails the last glyph too — the relative left re-centers by half of it
  const ls = fit.lsEm
    ? `;letter-spacing:${e.ph(frac(fit.lsEm * fit.f))}px;position:relative;left:${e.ph(frac((fit.lsEm * fit.f) / 2))}px`
    : '';
  const style = `font-size:${e.p(fit.f)}px;transform:scaleY(${fit.k})${ls}`;
  const spans = spansHtml(units, wCls, frac(fit.gapEm * fit.f), gateEnd, durFor, e);
  return `  <div class="col" style="top:${e.p(fit.top)}px"><div class="bigline" id="${id}" data-node-id="${id}" data-node-role="text" style="${style}">${spans}</div></div>`;
}

const CREDITS = [
  'WRITTEN, FILMED, DIRECTED AND PRODUCED BY YOURS TRULY',
  'FOR THIS VERY FEED, WITH LOVE',
  'MADE ON THE INTERNET',
];

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 1280, 720);
  const p = pxScaler(scale);
  const ph = (n: number) => Math.round(n * scale * 100) / 100;
  const e: Emit = { p, ph };
  const demote = opts.demote ?? {};
  const durEnd = Math.round(meta.durationSec * 1000);

  const cues = timings.beats
    .map((beat, idx) => {
      const units = unitsFor(beat.words);
      if (!units.length) return '';
      const N = beat.i;
      const winMs = winMsFor(timings.beats, idx, meta.durationSec);
      const gateEnd = beat.cueDelayMs + winMs;
      const acc = accentIndex(units);
      const rest = units.filter((_, i) => i !== acc);
      const rows: string[] = [];
      if (idx < timings.beats.length - 1) {
        // reading order: what is said before the accent sits ABOVE it, what follows sits BELOW.
        const before = units.slice(0, acc);
        const after = units.slice(acc + 1);
        const groups: Array<{ u: Unit[]; kind: RowKind; id: string }> = [];
        if (before.length) groups.push({ u: before, kind: 'top', id: `b${N}r1` });
        groups.push({ u: [units[acc]], kind: 'bottom', id: `b${N}r2` });
        if (after.length) groups.push({ u: after, kind: 'top', id: `b${N}r3` });
        const bands = BANDS[groups.length];
        const start = LADDER_START[groups.length];
        groups.forEach((g, gi) => {
          rows.push(antonRowHtml(g.u, g.id, fitAnton(g.u, g.kind, demotionFor(demote, g.id), bands[gi], start), gateEnd, e));
        });
      } else {
        if (rest.length) {
          const cf = fitCounter(rest, demotionFor(demote, `b${N}c`));
          rows.push(`  <div class="col" style="top:${p(cf.top)}px"><div class="from" id="b${N}c" data-node-id="b${N}c" data-node-role="text" style="font-size:${p(cf.f)}px">${spansHtml(rest, 'wc', frac(0.25 * cf.f), gateEnd, counterInMs, e, true)}</div></div>`);
        }
        rows.push(antonRowHtml([units[acc]], `b${N}h`, fitAnton([units[acc]], 'head', demotionFor(demote, `b${N}h`)), gateEnd, e, 'wh', headInMs));
        const crDelay = creditsDelayMs(beat.cueDelayMs, units[acc].spans[0].delayMs, durEnd);
        rows.push(`  <div class="col subblock" style="top:${p(CREDITS_TOP)}px;animation-delay:${crDelay}ms">
${CREDITS.map((t, kk) => `    <div class="cr" id="cr${kk + 1}" data-node-id="cr${kk + 1}" data-node-role="text">${escapeHtml(t)}</div>`).join('\n')}
  </div>`);
      }
      return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${winMs}ms">
${rows.join('\n')}
</div>`;
    })
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@700;900&family=Baloo+2:wght@700&family=Anton&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${p(1280)}px; height:${p(720)}px; overflow:hidden; background:#101010; }
  body { position:relative; font-family:'Hanken Grotesk', system-ui, sans-serif; }
  .vid { position:absolute; inset:0; width:${p(1280)}px; height:${p(720)}px; object-fit:cover; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }

  .col { position:absolute; left:0; width:${p(1280)}px; display:flex; flex-direction:column;
         align-items:center; color:#f50200; line-height:1; z-index:2; }

  /* giant stretched row — the scaleY is STATIC (inline, per row); word reveals ride the inner spans.
     The dark halo grounds the flat red on bright footage (the prefab's #101010 bg does it for free). */
  .bigline { font-family:'Anton', 'Archivo Black', sans-serif; font-weight:400; color:#f50200;
             white-space:nowrap; display:inline-block; transform-origin:center;
             text-shadow:0 0.02em 0.12em rgba(0,0,0,0.55); }

  /* word spans: vertical padding is shear headroom — an animating span rasterizes at its
     line-height:1 box and glyph bottoms clip without it. Ink extents are calibrated WITH it. */
  @keyframes popIn { 0%{opacity:0} 100%{opacity:1} }
  @keyframes wordIn { 0%{opacity:0; transform:translateY(0.1em)} 100%{opacity:1; transform:translateY(0)} }
  @keyframes fadeIn { 0%{opacity:0} 100%{opacity:1} }
  .w  { display:inline-block; position:relative; z-index:1; opacity:0; padding:0.06em 0 0.14em;
        animation-name:popIn; animation-timing-function:linear; animation-fill-mode:both; }
  .wc { display:inline-block; position:relative; z-index:1; opacity:0; padding:0.06em 0 0.14em;
        animation-name:wordIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  .wh { display:inline-block; position:relative; z-index:1; opacity:0; padding:0.06em 0 0.14em;
        animation-name:wordIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }

  /* peak counter line — the prefab's small lowercase Baloo word over the monumental headline */
  .from { font-family:'Baloo 2', system-ui, sans-serif; font-weight:700; color:#f50200;
          letter-spacing:-0.009em; white-space:nowrap;
          text-shadow:0 0.02em 0.1em rgba(0,0,0,0.6); }

  /* credits block — fixed dressing, fades in once with the last beat and rides its gate */
  .subblock { gap:${p(1)}px; z-index:3; opacity:0;
              animation-name:fadeIn; animation-duration:600ms; animation-timing-function:ease-out;
              animation-fill-mode:both; }
  .cr { font-family:'Hanken Grotesk', sans-serif; font-weight:700; font-size:${p(18)}px;
        letter-spacing:${ph(-0.3)}px; line-height:${p(22)}px; color:#e8121a; transform:scaleX(0.9);
        transform-origin:center; white-space:nowrap; text-shadow:0 ${p(1)}px ${p(4)}px rgba(0,0,0,0.6); }
</style>
</head>
<body>
  <video class="vid" style="z-index:0" src="${meta.videoPath}" muted></video>
${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-059-peak', generate };
export default recipe;
