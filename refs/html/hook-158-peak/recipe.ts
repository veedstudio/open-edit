// Compiled recipe — hook-158-peak (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// A full-frame stack of up to three giant Archivo Black caps rows JUSTIFIED to ONE common container:
// every row of every page of every beat has its INK flush at x 80 and x 1200. The row's tracking is
// SOLVED, not tabled — from the font's real per-glyph advances, kern pairs and side bearings — so a
// 7-letter word and a 2-letter word measure the same 1120px block (the prefab's PEACE / OF / MIND
// register taken to its literal end). White ink wearing the prefab's layered white glow over
// full-bleed footage; words rise + fade in on their spoken timing, and word-groups take turns as
// pages at the shared center stack. The prefab's opaque #0a0e16 poster background is dropped (it
// would occlude the footage); a dark grounding shadow under the glow replaces it. Emphasis is
// structural (the justified register) — no per-word accent. Non-ladder verify fixes (never-visible →
// timing/class audit, occluded → window/z audit) are NOT automated — the runner only demotes
// ladders; those failures are reported honestly.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  demotionFor, escapeHtml, manifestFor, paginate, pgOutDelayMs, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// ---------------------------------------------------------------------------------------------
// ARCHIVO BLACK 400 METRICS — read straight from the shipped Google font (hmtx / glyf / GPOS ÷ 1000
// upem), not budgeted. Justification is arithmetic: it is only as exact as these numbers.
// ---------------------------------------------------------------------------------------------
function expand(m: Record<string, string>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [v, cs] of Object.entries(m)) for (const c of cs) o[c] = Number(v);
  return o;
}
// advance width, em
const ADV = expand({
  0.667: '0123456789FJL$£€', 0.333: '  !,-.:;`', 0.778: 'ABCDRVXY', 0.833: 'GHKNOQU',
  0.389: 'I()[]{}', 0.66: '#+<=>^~', 0.278: '\'/\\|‘’', 0.722: 'EPSTZ', 0.5: '"_–“”', 1: 'W%—…',
  0.944: 'M', 0.889: '&', 0.556: '*', 0.611: '?', 0.74: '@',
});
// left side bearing, em (the ink inset at the start of a glyph)
const LSB = expand({
  0.074: 'BDEFHKLNPRU', 0.023: '4JT`€', 0.045: '7CGOQ', 0: '  _–—', 0.041: '068“',
  0.066: '+=[]', 0.039: '5-~', 0.06: 'M,;', 0.061: '.:…', 0.02: '#@', 0.055: '(^', '-0.002': '/\\',
  0.044: '‘”', 0.105: '1', 0.049: '2', 0.042: '3', 0.036: '9', 0.01: 'A', 0.084: 'I', 0.043: 'S',
  0.017: 'V', 0.005: 'W', 0.004: 'X', 0.007: 'Y', 0.024: 'Z', 0.047: '!', 0.059: '"', 0.069: '$',
  0.046: '%', 0.075: '&', 0.057: '\'', 0.034: ')', 0.095: '*', 0.067: '<', 0.068: '>', 0.037: '?',
  0.03: '{', 0.077: '|', 0.04: '}', 0.031: '£', 0.048: '’',
});
// right side bearing, em (advance minus the glyph's ink extent)
const RSB = expand({
  0.06: 'M,.:;…', 0.045: 'CDOQ?', 0: 'X  _–', 0.041: '089”', 0.042: '357P', 0.074: 'HJNU',
  0.039: '-~€', 0.048: '2‘', 0.023: '4`', 0.036: '6S', 0.04: 'B{', 0.031: 'RZ', 0.055: '%)',
  0.066: '+=', '-0.001': '/\\', 0.05: '[]', 0.044: '’“', 0.043: '1', 0.009: 'A', 0.046: 'E',
  0.037: 'F', 0.063: 'G', 0.084: 'I', 0.014: 'K', 0.019: 'L', 0.027: 'T', 0.018: 'V', 0.005: 'W',
  0.008: 'Y', 0.047: '!', 0.059: '"', 0.021: '#', 0.053: '$', 0.001: '&', 0.058: '\'', 0.034: '(',
  0.096: '*', 0.068: '<', 0.067: '>', 0.02: '@', 0.056: '^', 0.077: '|', 0.03: '}', 0.029: '£',
  '-0.002': '—',
});
// GPOS `kern` pair adjustments, 1/1000 em — `<pair><signed value>`, the pair always the first 2 chars.
const KERN_SRC =
  'P.-188 P,-180 Y.-170 Y,-162 F.-153 T.-153 F,-146 T,-146 V.-128 V,-120 FA-94 YA-94 Y--86 ' +
  'AY-85 PA-85 LY-77 AT-69 OY-68 TA-68 T--68 YC-60 YG-60 YO-60 Y:-60 Y;-60 VA-57 AV-55 OX-52 ' +
  'W.-52 LT-51 LV-51 QY-51 DA-43 OV-43 QV-43 RY-43 V--43 W,-43 YS-43 AU-34 DV-34 DY-34 KC-34 ' +
  'KG-34 KO-34 OA-34 TC-34 TG-34 TO-34 TQ-34 T:-34 T;-34 UA-34 U.-34 VC-34 VG-34 VO-34 VQ-34 ' +
  'XC-34 XG-34 XO-34 Q,33 BU-26 JA-26 J.-26 LU-26 OT-26 O.-26 U,-26 V:-26 V;-26 B,25 C,25 RQ-20 ' +
  'AQ-19 AC-18 AG-18 AO-18 J,-18 QT-18 RC-18 RG-18 BA-17 C.17 DW17 D.-17 LC-17 LG-17 LO-17 ' +
  'LW-17 OW-17 O,-17 QA17 Q.17 RO-17 RU-17 RV-17 WC-17 WG-17 WO-17 B.16 G,16 D,-10 G.10 NA-10 ' +
  'W--10 RT-9 AW8';
const KERN: Record<string, number> = {};
for (const t of KERN_SRC.split(' ')) KERN[t.slice(0, 2)] = Number(t.slice(2)) / 1000;
const ADV_FALLBACK = 0.75; // a glyph outside the table (accented input) — the caps average

// ---------------------------------------------------------------------------------------------
// THE CONTAINER — one justified block for the whole video: ink flush at x 80 … x 1200.
// ---------------------------------------------------------------------------------------------
export const BLOCK_LEFT = 80;
export const BLOCK_W = 1120;
// The shared-row word gap (only rows that carry more than one word have one): two nbsp, tracked
// like any other slot, so the gap always reads wider than the letter gaps it sits among.
export const SEP = '  ';
const SEP_HTML = '&#160;&#160;';

// Ordered ladder (largest first — demotion steps DOWN = later index). A row fits at a size when its
// ink at ZERO tracking still fits the block, i.e. inkEm ≤ BLOCK_W / size; tracking then opens the
// rest of the block. The page's WIDEST row picks the size for all of them.
const SIZES = [172, 154, 138, 124, 112, 100, 90, 80, 72, 64, 56];
const LADDER: LadderRow[] = SIZES.map((s) => ({ cls: `f${s}`, maxC: BLOCK_W / s }));

export const PAGE_MAX_CHARS = 24;
export const PAGE_MAX_UNITS = 3;
const CENTER_Y = 360;
const LINE_BOX = 1.2; // line-height — a page's row stack is 1.2·F·L
const FADE_MS = 160;
const W_IN_MS = 420;

// Word prep: strip ONE trailing `.` or `,`; keep `?` `!` `'` `£` and internal punctuation.
export function stripWord(w: string): string {
  return w.replace(/[.,]$/, '');
}

// UPPERCASE + strip + VEED glue: a leading-`-` token merges with the previous word into ONE unit
// for paging/counting, but keeps its own span + verbatim delay (renders adjacent, tracked).
export function unitsFor(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const text = stripWord(w.w).toUpperCase();
    if (!text) continue;
    const prev = units[units.length - 1];
    if (text.startsWith('-') && prev) {
      prev.spans.push({ text, delayMs: w.delayMs });
      prev.chars += text.length;
    } else {
      units.push({ spans: [{ text, delayMs: w.delayMs }], chars: text.length });
    }
  }
  return units;
}

// Rows of a page: one word per row — EXCEPT a one-letter unit, which has no gap of its own to open
// and so shares a row with its neighbour (forward; backward when it closes the page), the two words
// split by SEP. Never reorders.
export function rowsFor(page: Unit[]): Unit[][] {
  const rows: Unit[][] = [];
  for (let i = 0; i < page.length; i++) {
    const u = page[i];
    if (u.chars === 1 && i + 1 < page.length) { rows.push([u, page[++i]]); continue; }
    if (u.chars === 1 && rows.length) { rows[rows.length - 1].push(u); continue; }
    rows.push([u]);
  }
  return rows;
}

// A row's shaping runs in order: one per span, SEP between units. Kerning applies INSIDE a run only
// — every word is its own inline box, and an inline boundary breaks the shaping run.
function runsOf(row: Unit[]): string[] {
  const runs: string[] = [];
  row.forEach((u, i) => { if (i) runs.push(SEP); for (const s of u.spans) runs.push(s.text); });
  return runs;
}
export function advEm(s: string): number {
  let w = 0;
  for (const c of s) w += ADV[c] ?? ADV_FALLBACK;
  return w;
}
export function kernEm(s: string): number {
  let k = 0;
  for (let i = 1; i < s.length; i++) k += KERN[s.slice(i - 1, i + 1)] ?? 0;
  return k;
}
// Glyph slots on the row — the number of tracking gaps is slots − 1.
export function slotsOf(row: Unit[]): number {
  return runsOf(row).reduce((n, r) => n + r.length, 0);
}
// The row's INK width at zero tracking, em: the advance sum minus the two end side bearings —
// justification is OPTICAL (the ink meets the container, not the advance box).
export function inkEm(row: Unit[]): number {
  const runs = runsOf(row);
  const first = runs[0];
  const last = runs[runs.length - 1];
  const adv = runs.reduce((w, r) => w + advEm(r) + kernEm(r), 0);
  return adv - (LSB[first[0]] ?? 0) - (RSB[last[last.length - 1]] ?? 0);
}
// THE JUSTIFICATION: solve ink = F·inkEm + ls·(slots − 1) = BLOCK_W for ls. Returned in em, so it
// never scales (the px it resolves to scales with the font size, exactly like the block does).
export function trackEm(row: Unit[], F: number): number {
  const slots = slotsOf(row);
  if (slots < 2) return 0; // a lone single glyph has no gap to open — it centres in the block instead
  return Math.max(0, (BLOCK_W / F - inkEm(row)) / (slots - 1));
}
// Row left: the container edge pulled back by the first glyph's side bearing, so the INK starts at
// BLOCK_LEFT. Reference px, unrounded (the caller scale-multiplies before rounding to 2dp).
export function leftRef(row: Unit[], F: number): number {
  if (slotsOf(row) < 2) return BLOCK_LEFT;
  return BLOCK_LEFT - F * (LSB[runsOf(row)[0][0]] ?? 0);
}

// Ladder row for a page: the widest row's ink at zero tracking must fit the block.
export function sizeCls(inkMaxEm: number, demote = 0): string {
  return pickRow(LADDER, inkMaxEm, demote).cls;
}

// Row top: the stack (1.2·F per row) centered on y 360 — reference px, unrounded (the caller
// scale-multiplies before rounding to 2dp).
export function topRef(F: number, L: number, J: number): number {
  return CENTER_Y - (LINE_BOX / 2) * F * L + LINE_BOX * F * (J - 1);
}

// The prefab's 420ms rise compresses so a word spoken just before its page turns (or the gate
// closes) still lands.
export function wInMs(limitMs: number, delayMs: number): number {
  return Math.min(W_IN_MS, Math.max(200, limitMs - delayMs - 80));
}

function pageHtml(page: Unit[], N: number, K: number, isLast: boolean, pgOutMs: number, limitMs: number, demote: Record<string, number>, f: (n: number) => number): string {
  const key = `b${N}p${K}`;
  const rows = rowsFor(page);
  // all rows of a page share one size, so a flagged row demotes the whole page
  const cls = sizeCls(Math.max(...rows.map(inkEm)), demotionFor(demote, key, ...rows.map((_, j) => `${key}r${j + 1}`)));
  const F = Number(cls.slice(1));
  const style = isLast ? 'animation:none' : `animation-delay:${pgOutMs}ms`;
  const html = rows.map((row, j) => {
    const id = `${key}r${j + 1}`;
    const ls = +trackEm(row, F).toFixed(4);
    const solo = slotsOf(row) < 2 ? '; text-align:center' : '';
    const body = row
      .map((u) => u.spans
        .map((s) => `<span class="w" style="animation-delay:${s.delayMs}ms; animation-duration:${wInMs(limitMs, s.delayMs)}ms">${escapeHtml(s.text)}</span>`)
        .join(''))
      .join(SEP_HTML);
    return `    <div class="row ${cls}" id="${id}" data-node-id="${id}" data-node-role="text" style="left:${f(leftRef(row, F))}px; top:${f(topRef(F, rows.length, j + 1))}px; letter-spacing:${ls}em${solo}">${body}</div>`;
  });
  return `  <div class="pg" style="${style}">\n${html.join('\n')}\n  </div>`;
}

function cueHtml(N: number, cueDelayMs: number, winMs: number, pages: Unit[][], demote: Record<string, number>, f: (n: number) => number): string {
  const cueEnd = cueDelayMs + winMs;
  const body = pages
    .map((page, j) => {
      const isLast = j === pages.length - 1;
      const pgOutMs = isLast ? 0 : pgOutDelayMs(page, pages[j + 1][0].spans[0].delayMs, FADE_MS);
      return pageHtml(page, N, j + 1, isLast, pgOutMs, isLast ? cueEnd : pgOutMs, demote, f);
    })
    .join('\n');
  return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N}; animation-delay:${cueDelayMs}ms; animation-duration:${winMs}ms;">
${body}
</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 1280, 720);
  const p = pxScaler(scale);
  const f = (n: number) => +(n * scale).toFixed(2); // derived lefts/tops stay fractional
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) => {
      const units = unitsFor(beat.words);
      if (!units.length) return '';
      const pages = paginate(units, PAGE_MAX_CHARS, PAGE_MAX_UNITS);
      return cueHtml(beat.i, beat.cueDelayMs, winMsFor(timings.beats, idx, meta.durationSec), pages, demote, f);
    })
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; background: #0a0e16; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay + duration come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 0; top: 0; width: ${p(1280)}px; height: ${p(720)}px; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* a page = up to three justified rows at the shared center stack; mid-beat pages fade out
     COMPLETING at the successor's first word; the beat's LAST page holds and the gate cuts it. */
  .pg { position: absolute; inset: 0; z-index: 1;
        animation-name: pgOut; animation-duration: ${FADE_MS}ms; animation-timing-function: linear;
        animation-fill-mode: forwards; }
  @keyframes pgOut { 0% { opacity: 1; } 100% { opacity: 0; } }

  /* one JUSTIFIED row — flush-left in the shared block, its solved letter-spacing and its
     bearing-corrected left both inline per row, so the ink runs x 80 … x 1200 whatever the word.
     Never shrink-to-fit flex around animated children. Shadow = the prefab's layered white glow +
     a dark grounding layer for footage (the prefab's flat dark demo bg is not carried over). */
  .row { position: absolute; width: ${p(BLOCK_W)}px; text-align: left; white-space: nowrap;
         color: #fff; font-weight: 400; line-height: 1.2;
         font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
         text-shadow: 0 0 ${p(8)}px rgba(255,255,255,0.45), 0 0 ${p(22)}px rgba(255,255,255,0.3),
                      0 0 ${p(44)}px rgba(255,255,255,0.18),
                      0 ${p(2)}px ${p(12)}px rgba(0,0,0,0.55), 0 ${p(1)}px ${p(3)}px rgba(0,0,0,0.7); }

  /* rise + fade (the prefab's wIn) — duration compresses inline near a page turn / gate close */
  .w { display: inline-block; opacity: 0;
       animation-name: wIn; animation-timing-function: cubic-bezier(.2,.7,.3,1);
       animation-fill-mode: both; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: none; } }

  ${SIZES.map((s) => `.f${s}{font-size:${p(s)}px}`).join(' ')}
</style>
</head>
<body>
  <video class="vid" src="${meta.videoPath}" muted></video>
${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-158-peak', generate };
export default recipe;
