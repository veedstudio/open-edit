/**
 * Shared assembly for the authored-template ports (refs/html/template-0NN/recipe.ts). Each source
 * template was designed on a 480x864 canvas; a recipe authors in those px and this module scales them
 * to the run's canvas, gates cues/pages, wraps lines and emits the document shell.
 */
import {
  type RecipeGenerator,
  type RecipeOptions,
  type RecipeOutput,
  type RunMeta,
  type Unit,
  escapeHtml,
  manifestFor,
  paginate,
  splitLines,
  winMsFor,
} from './lib.ts';
import type { BeatTiming, WordTiming, WordTimings } from '../scripts/synth-word-timings.ts';

export { escapeHtml, paginate, splitLines, winMsFor, manifestFor };
export type { RecipeGenerator, RecipeOptions, RecipeOutput, RunMeta, Unit, WordTimings, BeatTiming, WordTiming };

export const REF_W = 480;
export const REF_H = 864;
export const DEMOTE_STEP = 0.92;

export type Casing = 'none' | 'uppercase' | 'lowercase';

export interface Canvas {
  W: number;
  H: number;
  portrait: boolean;
  /** size scale: fonts, paddings, horizontal offsets */
  s: number;
  /** vertical-anchor scale (bottom/top offsets) */
  sy: number;
  px: (n: number) => number;
  py: (n: number) => number;
  /** usable width in reference px for a block inset `margin` each side */
  refWidth: number;
}

// Portrait scales with width (the design's own axis). Landscape keeps type at a portrait-like share of
// the frame height and lets the wider measure absorb the difference.
export function canvasFor(meta: RunMeta): Canvas {
  const W = meta.width;
  const H = meta.height;
  const portrait = H >= W;
  const s = portrait ? W / REF_W : (H / REF_H) * 1.6;
  const sy = H / REF_H;
  return {
    W, H, portrait, s, sy,
    px: (n) => Math.round(n * s),
    py: (n) => Math.round(n * sy),
    refWidth: W / s,
  };
}

function applyCasing(w: string, casing: Casing): string {
  if (casing === 'uppercase') return w.toUpperCase();
  if (casing === 'lowercase') return w.toLowerCase();
  return w;
}

/** lib.toUnits with the VEED leading-"-" glue but caller-controlled casing. */
export function unitsOf(words: WordTiming[], casing: Casing): Unit[] {
  const units: Unit[] = [];
  for (const wt of words) {
    const text = applyCasing(wt.w, casing);
    const prev = units[units.length - 1];
    if (text.startsWith('-') && prev) {
      prev.spans.push({ text, delayMs: wt.delayMs });
      prev.chars += text.length;
    } else {
      units.push({ spans: [{ text, delayMs: wt.delayMs }], chars: text.length });
    }
  }
  return units;
}

export const unitText = (u: Unit): string => u.spans.map((s) => s.text).join('');
export const unitDelay = (u: Unit): number => u.spans[0].delayMs;

/** Greedy wrap by a per-unit width estimate; a two-line result is rebalanced when both halves fit. */
export function wrapByWidth(units: Unit[], maxW: number, widthOf: (u: Unit) => number, gap: number): Unit[][] {
  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let load = 0;
  for (const u of units) {
    const add = widthOf(u) + (line.length ? gap : 0);
    if (line.length && load + add > maxW) {
      lines.push(line);
      line = [u];
      load = widthOf(u);
    } else {
      line.push(u);
      load += add;
    }
  }
  if (line.length) lines.push(line);
  if (lines.length === 2) {
    const [a, b] = splitLines(units);
    const lw = (l: Unit[]) => l.reduce((acc, u) => acc + widthOf(u), 0) + gap * (l.length - 1);
    if (b && lw(a) <= maxW && lw(b) <= maxW) return [a, b];
  }
  return lines;
}

/** Char-budget wrap: width = chars * advance, gap = one space. */
export function wrapByChars(units: Unit[], maxChars: number): Unit[][] {
  return wrapByWidth(units, maxChars, (u) => u.chars, 1);
}

// The runner demotes by the exact element id --verify names (b<n>…); a recipe that sizes per beat
// reads the max across every id of that beat.
// Clamped: the ladder bottoms out at 0.92^6 ≈ 0.6, so a runner that counts one demotion per failing
// frame cannot shrink a beat to nothing.
export const MAX_DEMOTE_ROWS = 6;
export function demoteRowsFor(demote: Record<string, number>, n: number): number {
  return Math.min(MAX_DEMOTE_ROWS, Math.max(0, ...Object.keys(demote).filter((k) => new RegExp(`^b${n}([a-z]|$)`).test(k)).map((k) => demote[k])));
}

/** Reveal window of unit `idx` on a flat page: until the next later delay, else the cue end. */
export function unitWinMs(flat: Unit[], idx: number, cueEndMs: number): number {
  const d = unitDelay(flat[idx]);
  for (let k = idx + 1; k < flat.length; k++) {
    const nd = unitDelay(flat[k]);
    if (nd > d) return Math.max(80, nd - d);
  }
  return Math.max(80, cueEndMs - d);
}

/** Per-glyph spans at a fixed stagger from the unit's own delay (the typewriter/rise devices). */
export function glyphSpans(text: string, delayMs: number, stepMs: number, cls: string, styleExtra = ''): string {
  return [...text]
    .map((ch, k) => `<span class="${cls}" style="animation-delay:${delayMs + k * stepMs}ms;${styleExtra}">${escapeHtml(ch)}</span>`)
    .join('');
}

/** Page gate style: mid-beat pages switch on at their first word and off at the successor's. A middle
 * page runs ONE keyframe animation for its whole window, because two opacity owners on one element
 * (an on ramp plus an off ramp) is a contradiction the engine resolves by dropping one. */
export function pageGateStyle(pi: number, firstDelayMs: number, nextStartMs: number | null): string {
  if (pi > 0 && nextStartMs !== null) return `animation:pgMid ${Math.max(80, nextStartMs - firstDelayMs)}ms linear ${firstDelayMs}ms forwards;`;
  if (pi > 0) return `animation:pgOn 40ms linear ${firstDelayMs}ms forwards;`;
  if (nextStartMs !== null) return `opacity:1;animation:pgOff 40ms linear ${nextStartMs - 40}ms forwards;`;
  return 'opacity:1;';
}

export function cueDiv(n: number, cueDelayMs: number, winMs: number, inner: string): string {
  return `<div class="cue" id="cue${n}" style="z-index:${10 + n};animation-delay:${cueDelayMs}ms;animation-duration:${winMs}ms;">\n${inner}\n</div>`;
}

export interface BeatCtx {
  beat: BeatTiming;
  n: number;
  cueDelayMs: number;
  winMs: number;
  cueEndMs: number;
  rows: number;
  units: Unit[];
  isLast: boolean;
}

/** Walks the beats with the shared bookkeeping (window, demotion rows, units) so recipes only lay out. */
export function eachBeat(meta: RunMeta, timings: WordTimings, opts: RecipeOptions, casing: Casing, fn: (b: BeatCtx) => string): string[] {
  const demote = opts.demote ?? {};
  const out: string[] = [];
  for (let bi = 0; bi < timings.beats.length; bi++) {
    const beat = timings.beats[bi];
    if (beat.words.length === 0) continue;
    const winMs = winMsFor(timings.beats, bi, meta.durationSec);
    out.push(fn({
      beat,
      n: beat.i,
      cueDelayMs: beat.cueDelayMs,
      winMs,
      cueEndMs: beat.cueDelayMs + winMs,
      rows: demoteRowsFor(demote, beat.i),
      units: unitsOf(beat.words, casing),
      isLast: bi === timings.beats.length - 1,
    }));
  }
  return out;
}

export interface DocSpec {
  canvas: Canvas;
  videoPath: string;
  /** css2 family params, e.g. "Baloo+2:wght@800" */
  fonts: string[];
  css: string;
  body: string;
}

export function docShell(d: DocSpec): string {
  const { W, H } = d.canvas;
  const link = d.fonts.length
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?${d.fonts.map((f) => `family=${f}`).join('&')}&display=swap" rel="stylesheet">\n`
    : '';
  return `<meta charset="utf-8">
${link}<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; position:relative; overflow:hidden; }
  .vid { position:absolute; inset:0; width:${W}px; height:${H}px; object-fit:cover; z-index:0; }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0; animation:cueWin linear forwards; }
  .pg { position:absolute; opacity:0; z-index:1; }
  @keyframes pgOn { to{opacity:1} }
  @keyframes pgOff { to{opacity:0} }
  @keyframes pgMid { 0%{opacity:0} 0.01%,99.99%{opacity:1} 100%{opacity:0} }
${d.css}
</style>
<video class="vid" src="${d.videoPath}" muted></video>
${d.body}
`;
}

export function templateRecipe(id: string, gen: (meta: RunMeta, timings: WordTimings, opts: RecipeOptions) => string): RecipeGenerator {
  return {
    refId: id,
    generate: (meta, timings, opts) => ({ wv: gen(meta, timings, opts ?? {}), manifest: manifestFor(meta) }),
  };
}
