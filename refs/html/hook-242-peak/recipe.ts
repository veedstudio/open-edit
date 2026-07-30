// Compiled recipe — hook-242-peak · scattered Caveat handwriting over full-bleed footage (16:9,
// authored at 1280×720 @24fps). Source sheet: ./recipe.md. Each spoken word is its own
// warm-white Caveat note, absolutely placed with big irregular gaps and a tiny per-word vertical
// jitter; every word rises 0.28em + fades in on its real spoken delay and accumulates until the cue
// gate cuts the beat. ONE accent word a beat carries the only emphasis: it rides ACCENT_SCALE
// (×1.74) of the beat's ladder size and a hand-drawn underline is swept under it — size + that one
// stroke, never a colour, a weight or a plate. The prefab's dark demo bg is replaced by full-bleed
// footage + a two-layer dark grounding text-shadow (overlay-on-subject tag policy). Prefab is
// 960×720; the composition here is RE-COMPOSED for 1280×720 (gap/offset tables derived from the
// prefab's ×4/3 center pitches).
//
// COMPOSITION: the beat draws a PATTERN — the shape of the scatter itself, not just where a fixed
// block sits. Six of them (cascade · column · pairs · split · cluster · arc) differ in how many
// words share a row, how tight the leading is, how far the gaps open, where each row starts, and
// whether the row bows or straddles a void — so they also land on different ladder sizes. A per-beat
// MIRROR flag flips the finished rows about the frame's vertical axis (word order inside a row is
// never reversed), and a per-beat band offset moves the block up or down. Periods 6 / 7 / 5 are
// coprime: a video runs 3-6 visibly different compositions before anything repeats.
//
// opts.demote (keys = the exact b{N}w{k} ids --verify names) steps THAT WORD'S WHOLE BEAT down the
// size ladder — placement is recomputed from the smaller size, pulling ink toward the row centers.
// The never-visible / occluded checklists are diagnostic — report-only.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, paginate, pickRow, pxScaler, scaleFor,
  winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

export interface ScatterWord {
  text: string; // spoken case KEPT, trailing ./, stripped, glue merged
  delayMs: number; // VERBATIM (a glued word keeps the FIRST token's delay)
}

// Caveat 600 through the engine (calibration render, string-doubling): advance em/char by class,
// worst right swash overhang 0.19em (final 'f') → 0.20 budget, worst left 0.09em ('j') → 0.10.
export const ADV_LC = 0.366;
export const ADV_UC = 0.511;
export const ADV_DIG = 0.455;
export const ADV_OTHER = 0.46;
export const OH_R = 0.2;
export const OH_L = 0.1;

export interface SizeRow extends LadderRow { size: number }
// C = the beat's longest row charsOf; demotion is the verify loop's only lever.
export const SIZE_LADDER: SizeRow[] = [
  { cls: 'w42', size: 42, maxC: 14 },
  { cls: 'w38', size: 38, maxC: 18 },
  { cls: 'w34', size: 34, maxC: 22 },
  { cls: 'w30', size: 30, maxC: 26 },
  { cls: 'w25', size: 25, maxC: Infinity },
];

// prefab-derived scatter tables (reference px / center-to-center)
export const XPITCH = [275, 400, 325, 210, 385, 285];
export const TJIT = [0, -2, 3, -3, 2];
export const VBAND = [0, -46, 34, -22, 58];
export const MIRROR = [false, true, false, true, true, false, true];
const BAND_CY = 396;
const EDGE_L = 90;
const EDGE_R = 1190;
const SAFE_T = 43;
const SAFE_B = 677;
const MIN_INK_GAP = 35;
const SPLIT_VOID = 260;
const RISE_MS = 420;
const MIN_RISE_MS = 250;

// The SHAPE of one beat's scatter. `anchor` + `rowShift` place each row's left ink edge (left-home
// coordinates — MIRROR flips the result); `gapScale` scales the XPITCH bases (the ink-gap floors
// always win); `dy` bows the row; `split` breaks the row across a centre void.
export interface Pattern {
  id: string;
  maxChars: number;
  maxWords: number;
  maxRows: number;
  pitchY: [number, number];
  gapScale: number;
  anchor: number;
  rowShift: number[];
  dy?: number;
  // 'edges' presses the two halves to the frame edges; 'centred' hangs them off the frame's centre
  // line so the block reads as one centred composition with a hole in it.
  split?: 'edges' | 'centred';
  gap?: number; // the middle clearance the split protects
  inset?: number; // how far off the frame edge an 'edges' split sits
  rhythm?: number[]; // words per row, cycled — replaces greedy packing for this shape
}

export const PATTERNS: Pattern[] = [
  // a staircase falling away from the anchor: short rows, each stepped far along the previous
  { id: 'cascade', maxChars: 13, maxWords: 3, maxRows: 5, pitchY: [86, 96], gapScale: 0.55,
    anchor: 108, rowShift: [0, 104, 208, 312, 416] },
  // a narrow ragged column: one or two words a row, tight leading, small gaps
  { id: 'column', maxChars: 11, maxWords: 2, maxRows: 6, pitchY: [76, 88], gapScale: 0.42,
    anchor: 120, rowShift: [0, 34, 12, 48, 20, 40] },
  // centred pairs: one word left of the centre line, one right, the middle always clear — the
  // composition sits ON the subject without a word ever landing on them
  { id: 'pairs', maxChars: 14, maxWords: 2, maxRows: 5, pitchY: [92, 104], gapScale: 0.3,
    anchor: 0, rowShift: [0, 34, 14, 52], split: 'centred', gap: 420 },
  // the row straddles a clear middle: half its words at one edge, half at the other, both pulled
  // a little off the frame edge (a word ON the edge reads as an afterthought)
  { id: 'split', maxChars: 24, maxWords: 4, maxRows: 4, pitchY: [98, 112], gapScale: 0.3,
    anchor: 92, rowShift: [0, 18, 6, 26], split: 'edges', gap: 260, inset: 30 },
  // a stacked block whose rows breathe 2 · 1 · 1 words instead of packing greedily, each row
  // stepped well clear of the last so the tail words read as their own beat
  { id: 'stack', maxChars: 22, maxWords: 5, maxRows: 4, pitchY: [96, 112], gapScale: 0.4,
    anchor: 130, rowShift: [0, 128, 56, 184], rhythm: [2, 1, 1] },
  // rows bow: each row's middle words ride up a shallow curve
  { id: 'arc', maxChars: 14, maxWords: 4, maxRows: 4, pitchY: [96, 108], gapScale: 0.8,
    anchor: 130, rowShift: [0, 40, 14, 58], dy: -26 },
];

const mod = (n: number, m: number): number => ((n % m) + m) % m;
export const patternFor = (N: number): Pattern => PATTERNS[mod(N - 1, PATTERNS.length)];
export const mirroredFor = (N: number): boolean => MIRROR[mod(N - 1, MIRROR.length)];

// ONE accent word per beat — the beat's counter-accent unit (digit-bearing first, else the longest,
// tie → the later one) rides ×1.74 of the beat's ladder size and gets a hand-drawn underline swept
// under it. Size + that stroke are the ONLY accent devices: never a colour, weight or plate.
export const ACCENT_SCALE = 1.74;
export const accentSizeFor = (size: number): number => Math.round(size * ACCENT_SCALE);

// Underline geometry, all in em of the accent size: the box hangs under the word's baseline, the
// stroke is the weight of the handwriting itself, and the curve is a shallow hand-drawn bow.
const UL_TOP = 1.02; // box top below the word div's top
const UL_H = 0.42; // box height
const UL_PAD = 0.1; // overshoot each side of the word's advance
// stroke thickness as a fraction of the BOX height (0.115 × 0.42em ≈ 0.048em of the accent size —
// the weight of the handwriting); the polygon is authored in %, so it stays put at any word width
const UL_T_H = 0.115;
const UL_DRAW_MS = 520; // the sweep, left edge to right
const UL_LEAD_MS = 130; // the stroke starts BEFORE the word lands and overtakes it

// Four hand-drawn centrelines, cycled by beat — a stroke is never the same twice running. Each
// returns the centre of the stroke at t (0..1 across the word) as a fraction of the box height.
export const UL_SPLINES: Array<(t: number) => number> = [
  (t) => 0.40 + 0.34 * (1 - (2 * t - 1) ** 2) - 0.20 * t, // a smile that lifts away at the end
  (t) => 0.62 - 0.32 * (1 - (2 * t - 1) ** 2) + 0.16 * t, // the same bow inverted, settling down
  (t) => 0.5 + 0.28 * Math.sin(2 * Math.PI * t) - 0.10 * t, // a shallow S, wrist-flick
  (t) => 0.34 + 0.16 * Math.sin(Math.PI * t * 1.6) + 0.28 * t, // near-straight, dropping right
];
export const splineFor = (N: number): ((t: number) => number) => UL_SPLINES[mod(N - 1, UL_SPLINES.length)];

// The stroke's OUTLINE: a closed `polygon()` point list, all in PERCENT of the box, tracing the
// spline's centreline offset ±r (r = half the stroke thickness) — `samples + 1` points along the top
// edge, then the same samples back along the bottom. The sample x runs r … wPx − r, so the nib never
// crosses the box's own left or right edge. Percent (never px) is what keeps one outline correct at
// any word width and any SCALE.
// The stroke is ONE element with this outline as a STATIC clip-path, grown by scaleX 0→1 from its
// left edge (see `.ul`) — the only draw device the engine honours: a `width` keyframe, an animated
// `clip-path` and an animated `inset()` all render the finished shape from frame one. One element is
// also the only clean shape: a chain of rotated boxes facets at every joint and a rotated wrapper
// around a scaled child renders many times too thick (both proven on fixtures).
export function underlinePolygon(spline: (t: number) => number, wPx: number, hPx: number, samples = 24): string {
  const r = (UL_T_H * hPx) / 2;
  const x = (t: number) => `${(((r + t * (wPx - 2 * r)) / wPx) * 100).toFixed(2)}%`;
  const y = (t: number, off: number) => `${(((spline(t) * hPx + off) / hPx) * 100).toFixed(2)}%`;
  const top: string[] = [];
  const bot: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    top.push(`${x(t)} ${y(t, -r)}`);
    bot.unshift(`${x(t)} ${y(t, r)}`);
  }
  return [...top, ...bot].join(', ');
}

// Optical tracking: the bigger the type the TIGHTER the letter-spacing (the eye reads inter-letter
// distance non-linearly — the same em value looks blown out once the size grows), so every rung
// carries its own value off one falling line, negative at the accent sizes. Reference px, scaled
// unrounded like every other fractional px in this sheet.
export const lsFor = (size: number): number => 0.9 - 0.0215 * size;

// Strip trailing . and , only (keep ? ! ' and internal punctuation), KEEP spoken case, VEED glue:
// a leading-`-` token concatenates into the previous word with no gap, counted as ONE word.
export function prepWords(words: WordTiming[]): ScatterWord[] {
  const out: ScatterWord[] = [];
  for (const w of words) {
    const text = w.w.trim().replace(/[.,]+$/, '');
    if (!text) continue;
    const prev = out[out.length - 1];
    if (text.startsWith('-') && prev) prev.text += text;
    else out.push({ text, delayMs: w.delayMs });
  }
  return out;
}

// Estimated advance in em: per-char class coefficients (measured), letter-spacing ignored (≤1px noise).
export function estAdvEm(text: string): number {
  let e = 0;
  for (const ch of text) {
    e += /[a-z]/.test(ch) ? ADV_LC : /[A-Z]/.test(ch) ? ADV_UC : /[0-9]/.test(ch) ? ADV_DIG : ADV_OTHER;
  }
  return e;
}

export function toRowUnits(words: ScatterWord[]): Unit[] {
  return words.map((w) => ({ spans: [{ text: w.text, delayMs: w.delayMs }], chars: w.text.length }));
}

// Greedy rows at the PATTERN's caps. A beat that would exceed the pattern's row budget re-packs with
// growing caps (+4 chars, +1 word) until it fits — the vertical band is finite.
export function packRowsFor(units: Unit[], p: Pattern): Unit[][] {
  if (p.rhythm) {
    // fixed word counts per row, cycled; a beat too long for the row budget bumps every count
    for (let bump = 0; bump <= 5; bump++) {
      const rows: Unit[][] = [];
      for (let i = 0, r = 0; i < units.length; r++) {
        const n = p.rhythm[r % p.rhythm.length] + bump;
        rows.push(units.slice(i, i + n));
        i += n;
      }
      if (rows.length <= p.maxRows || bump === 5) return rows;
    }
  }
  let rows = paginate(units, p.maxChars, p.maxWords);
  for (let mc = p.maxChars + 4; rows.length > p.maxRows && mc <= 62; mc += 4) {
    rows = paginate(units, mc, p.maxWords + 1);
  }
  return rows;
}

// Row centers Y: the pattern's leading cycle; the block's centre is 396 + the beat's VBAND offset,
// clamped so the ink (±0.9·size, + jitter + arc) stays inside the 43..677 safe band (fractional —
// rounded once at emission).
export function rowCentersY(L: number, N: number, size: number, p: Pattern): number[] {
  let h = 0;
  for (let r = 1; r < L; r++) h += p.pitchY[(r - 1) % 2];
  const pad = 0.9 * size + 3 + Math.abs(p.dy ?? 0) + h / 2;
  const lo = SAFE_T + pad;
  const hi = SAFE_B - pad;
  const want = BAND_CY + VBAND[mod(N - 1, VBAND.length)];
  const cy = hi < lo ? (lo + hi) / 2 : Math.min(Math.max(want, lo), hi);
  const ys = [cy - h / 2];
  for (let r = 1; r < L; r++) ys.push(ys[r - 1] + p.pitchY[(r - 1) % 2]);
  return ys;
}

const sum = (a: number[]): number => a.reduce((s, v) => s + v, 0);

// A run's ink overhangs: half the first advance + left swash, half the last + right swash.
function edgesFor(advPx: number[], size: number): [number, number] {
  return [advPx[0] / 2 + OH_L * size, advPx[advPx.length - 1] / 2 + OH_R * size];
}

// Centre-to-centre pitches for one run: the cycled XPITCH bases scaled by the pattern, floored so
// ink gaps (incl. swash overhang) stay ≥ 35px, then shrunk proportionally to fit `band`.
function pitchesFor(N: number, r: number, advPx: number[], size: number, gapScale: number, band: number): number[] {
  const k = advPx.length;
  const bases: number[] = [];
  const floors: number[] = [];
  for (let g = 0; g < k - 1; g++) {
    bases.push(XPITCH[(N + r + g + 1) % 6] * gapScale);
    floors.push(advPx[g] / 2 + advPx[g + 1] / 2 + (OH_R + OH_L) * size + MIN_INK_GAP);
  }
  const [eL, eR] = edgesFor(advPx, size);
  let pitches = bases.map((b, i) => Math.max(b, floors[i]));
  if (k > 1 && eL + sum(pitches) + eR > band) {
    const f = (band - eL - eR) / sum(bases);
    pitches = bases.map((b, i) => Math.max(floors[i], b * f));
    if (eL + sum(pitches) + eR > band) pitches = floors.slice();
  }
  return pitches;
}

function centersFrom(x0: number, eL: number, pitches: number[]): number[] {
  const centers = [x0 + eL];
  for (const p of pitches) centers.push(centers[centers.length - 1] + p);
  return centers;
}

// Reflect the row's ink BOX about the band's midline and translate the row there. Reflecting the
// box (not the individual slots) is what keeps the run intact: reading order, pitches and ink gaps
// are untouched, only the side changes — so a cascade steps the other way and a column hugs the
// other edge. Clamped back inside the band (the swash budget is asymmetric).
function mirrorRow(centers: number[], advPx: number[], size: number): number[] {
  const k = centers.length;
  const lo = centers[0] - advPx[0] / 2 - OH_L * size;
  const hi = centers[k - 1] + advPx[k - 1] / 2 + OH_R * size;
  let d = EDGE_L + EDGE_R - hi - lo;
  if (lo + d < EDGE_L) d = EDGE_L - lo;
  if (hi + d > EDGE_R) d = EDGE_R - hi;
  return centers.map((c) => c + d);
}

// SPLIT rows: the first ⌈k/2⌉ words go left of the middle, the rest right, with a clear void
// between them. 'edges' hangs the halves off the frame edges (inset), 'centred' hangs them off the
// frame's centre line so the row reads as one centred composition with a hole in it — the void
// widens per row so the shape never looks tabulated. Each half is fitted into the space it actually
// has; if the halves would still collide the row falls back to one ordinary run.
function splitCenters(N: number, ri: number, advPx: number[], size: number, p: Pattern): number[] | null {
  const centred = p.split === 'centred';
  const inset = p.inset ?? 0;
  const shift = p.rowShift[ri % p.rowShift.length];
  const voidW = (p.gap ?? SPLIT_VOID) + (centred ? shift : 0);
  const cut = Math.ceil(advPx.length / 2);
  const A = advPx.slice(0, cut);
  const B = advPx.slice(cut);
  const [aL, aR] = edgesFor(A, size);
  const [bL, bR] = edgesFor(B, size);
  const mid = (EDGE_L + EDGE_R) / 2;
  // the room each half has: up to its own edge of the void
  const roomA = centred ? mid - voidW / 2 - EDGE_L : (EDGE_R - EDGE_L - voidW) / 2;
  const roomB = centred ? EDGE_R - (mid + voidW / 2) : (EDGE_R - EDGE_L - voidW) / 2;
  const pa = pitchesFor(N, ri + 1, A, size, p.gapScale, roomA);
  const pb = pitchesFor(N, ri + 2, B, size, p.gapScale, roomB);
  const spanA = aL + sum(pa) + aR;
  const spanB = bL + sum(pb) + bR;
  const x0A = centred ? mid - voidW / 2 - spanA : EDGE_L + inset + shift;
  const x0B = centred ? mid + voidW / 2 : EDGE_R - inset - spanB - shift;
  if (x0A < EDGE_L || x0B + spanB > EDGE_R) return null;
  if (x0B - (x0A + spanA) < MIN_INK_GAP * 2) return null;
  return [...centersFrom(x0A, aL, pa), ...centersFrom(x0B, bL, pb)];
}

// Word centers X for row ri (0-based) of beat N, under the beat's pattern and mirror flag.
export function rowXCenters(
  N: number, ri: number, advPx: number[], size: number, p: Pattern, mirror = false,
): number[] {
  const band = EDGE_R - EDGE_L;
  const [eL, eR] = edgesFor(advPx, size);
  const shift = p.rowShift[ri % p.rowShift.length];
  let centers: number[] | null = null;
  if (p.split) {
    if (advPx.length > 1) centers = splitCenters(N, ri, advPx, size, p);
    else {
      // a lone word hangs off one side of the void outright, alternating by row
      const span = eL + eR;
      const half = ((p.gap ?? SPLIT_VOID) + (p.split === 'centred' ? shift : 0)) / 2;
      const left = p.split === 'centred' ? (EDGE_L + EDGE_R) / 2 - half - span : EDGE_L + (p.inset ?? 0) + shift;
      const right = p.split === 'centred' ? (EDGE_L + EDGE_R) / 2 + half : EDGE_R - (p.inset ?? 0) - span - shift;
      centers = centersFrom(ri % 2 === 0 ? left : right, eL, []);
    }
  }
  if (!centers) {
    const pitches = pitchesFor(N, ri + 1, advPx, size, p.gapScale, band);
    const span = eL + sum(pitches) + eR;
    const x0 = Math.min(Math.max(p.anchor + shift, EDGE_L), Math.max(EDGE_L, EDGE_R - span));
    centers = centersFrom(x0, eL, pitches);
  }
  return mirror ? mirrorRow(centers, advPx, size) : centers;
}

// The arc: a row's middle words ride up to `dy`, the ends stay on the row line.
export function wordDyFor(p: Pattern, wi: number, k: number): number {
  if (!p.dy || k < 2) return 0;
  const t = wi / (k - 1);
  return p.dy * (1 - 4 * (t - 0.5) ** 2) || 0;
}

// d = min(420, max(cueEnd − delay, 250)) — a word spoken closer than its rise to the gate close
// never reaches full visibility without this. ms never scale.
export function wordDurMs(cueEndMs: number, delayMs: number): number {
  return Math.min(RISE_MS, Math.max(cueEndMs - delayMs, MIN_RISE_MS));
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 1280, 720);
  const p = pxScaler(scale);
  const demote = opts.demote ?? {};
  // one class per size actually reachable (every ladder rung + its accent), each with its own
  // optical tracking; fractional px are scale-multiplied UNROUNDED
  const sizeCss = [...new Set(SIZE_LADDER.flatMap((r) => [r.size, accentSizeFor(r.size)]))]
    .sort((a, b) => b - a)
    .map((s) => `.s${s}{font-size:${p(s)}px;letter-spacing:${+(lsFor(s) * scale).toFixed(2)}px}`)
    .join('\n  ');

  const cues = timings.beats
    .map((beat, idx) => {
      const N = beat.i;
      const words = prepWords(beat.words);
      if (!words.length) return '';
      const pat = patternFor(N);
      const mirror = mirroredFor(N);
      const units = toRowUnits(words);
      const rows = packRowsFor(units, pat);
      const demoteRows = demotionFor(demote, ...words.map((_, k) => `b${N}w${k}`));
      const C = Math.max(...rows.map((row) => charsOf(row)));
      const sizeRow = pickRow(SIZE_LADDER, C, demoteRows) as SizeRow;
      const size = sizeRow.size;
      const accSize = accentSizeFor(size);
      const acc = accentIndex(units); // the ONE word this beat sizes up
      const winMs = winMsFor(timings.beats, idx, meta.durationSec);
      const cueEnd = beat.cueDelayMs + winMs;
      const ys = rowCentersY(rows.length, N, accSize, pat); // the accent sets the ink budget
      let k = 0;
      const divs: string[] = [];
      rows.forEach((row, ri) => {
        const first = k;
        const sizes = row.map((_, wi) => (first + wi === acc ? accSize : size));
        const advPx = row.map((u, wi) => estAdvEm(u.spans[0].text) * sizes[wi]);
        const centers = rowXCenters(N, ri, advPx, size, pat, mirror);
        row.forEach((u, wi) => {
          const myK = k++;
          const s = u.spans[0];
          const cy = ys[ri] + TJIT[myK % 5] + wordDyFor(pat, wi, row.length);
          const left = p(centers[wi] - advPx[wi] / 2);
          const top = p(cy - 0.75 * sizes[wi]);
          const d = wordDurMs(cueEnd, s.delayMs);
          const dur = d < RISE_MS ? `;animation-duration:${d}ms` : '';
          divs.push(
            `  <div class="word s${sizes[wi]}" id="b${N}w${myK}" data-node-id="b${N}w${myK}" data-node-role="text" style="left:${left}px;top:${top}px;animation-delay:${s.delayMs}ms${dur}">${escapeHtml(s.text)}</div>`,
          );
          if (myK !== acc) return;
          // The accent's underline: ONE div sized to the accent's own advance + UL_PAD overshoot,
          // statically clipped to the beat's spline outline and swept by scaleX 0→1 from its left
          // edge (`.ul` + `@keyframes ulDraw`, both ends authored explicitly — a partial keyframe
          // leaves the engine no end state and the stroke renders finished from frame one). It
          // STARTS BEFORE the word lands (UL_LEAD_MS) and overtakes it; the delay is clamped into
          // the cue's own window, so the stroke never opens before the gate nor runs past its close.
          const az = sizes[wi];
          const ulW = p(advPx[wi] + 2 * UL_PAD * az);
          const ulH = p(UL_H * az);
          const ulDelay = Math.min(
            Math.max(s.delayMs - UL_LEAD_MS, beat.cueDelayMs),
            Math.max(cueEnd - UL_DRAW_MS, beat.cueDelayMs),
          );
          divs.push(
            `  <div class="ul" id="b${N}u" data-node-id="b${N}u" data-node-role="text" style="left:${p(centers[wi] - advPx[wi] / 2 - UL_PAD * az)}px;top:${p(cy - 0.75 * az + UL_TOP * az)}px;width:${ulW}px;height:${ulH}px;clip-path:polygon(${underlinePolygon(splineFor(N), ulW, ulH)});animation-delay:${ulDelay}ms"></div>`,
          );
        });
      });
      return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${winMs}ms">
${divs.join('\n')}
</div>`;
    })
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; }
  body { background: #000; overflow: hidden; position: relative; font-family: 'Caveat', cursive; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: ${p(1280)}px; height: ${p(720)}px; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* one scattered handwritten note per word — positioned by its LEFT ink edge (no -50% translate:
     --verify measures ink pre-transform, a centering translate would false-fail bounds).
     padding-bottom 0.2em = rise headroom (descender ink reaches 1.31em; +0.28em rise passes the
     1.5em line box). The two-layer dark shadow grounds the warm-white ink over any footage. */
  .word { position: absolute; color: #fdf7f4; font-weight: 600; line-height: 1.5;
          white-space: nowrap; padding-bottom: 0.2em;
          text-shadow: 0 ${p(1)}px ${p(3)}px rgba(0,0,0,0.55), 0 ${p(2)}px ${p(10)}px rgba(0,0,0,0.45);
          opacity: 0; animation-name: wIn; animation-duration: ${RISE_MS}ms;
          animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  ${sizeCss}
  @keyframes wIn {
    0% { opacity: 0; transform: translateY(0.28em); }
    100% { opacity: 1; transform: translateY(0); }
  }

  /* the accent's hand-drawn underline: ONE element statically clipped to the beat's spline outline
     (clip-path: polygon() in %, so one outline holds at any word width and any SCALE), swept
     left→right by scaleX 0→1 from its left edge — the only draw device the engine honours (an
     animated width, clip-path or inset() renders the finished stroke from frame one). The
     drop-shadow sits on the whole stroke at once. */
  .ul { position: absolute; background: #fdf7f4; transform: scaleX(0); transform-origin: 0 50%;
        filter: drop-shadow(0 ${p(1)}px ${p(4)}px rgba(0,0,0,0.55));
        animation: ulDraw ${UL_DRAW_MS}ms cubic-bezier(.25,.8,.35,1) both; }
  @keyframes ulDraw { 0% { transform: scaleX(0); } 100% { transform: scaleX(1); } }
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

const recipe: RecipeGenerator = { refId: 'hook-242-peak', generate };
export default recipe;
