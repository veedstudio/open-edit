// Shared assembly library for compiled recipes (refs/html/<id>/recipe.ts, next to the prose sheet).
// A compiled recipe is the executable form of a ref's styling recipe: generate(meta, word-timings) →
// the final template.wv + manifest.json, deterministically — no model in the loop. The rules here
// are the invariants every recipe sheet shares (glue, paging, split, ladder, gate/fade math); per-ref
// skeletons and constants live in the recipe modules.
import type { WordTimings, BeatTiming, WordTiming } from '../scripts/synth-word-timings.ts';

export interface RunMeta {
  key: string;
  videoPath: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

export interface RecipeOptions {
  // page key ('b3p1') → rows DOWN the size ladder; the verify loop's mechanical bounds fix.
  demote?: Record<string, number>;
}

export interface RecipeOutput {
  wv: string;
  manifest: string;
}

export interface RecipeGenerator {
  refId: string;
  generate(meta: RunMeta, timings: WordTimings, opts?: RecipeOptions): RecipeOutput;
}

// Ref ids are folder names: letters/digits plus the spaces, parens, dots, hyphens and underscores the
// pool already uses ("hook-091 Pre-comp 1-peak"). No separators, so no id can climb out of refs/html/.
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9 ()._-]*$/;

// Module path convention — file exists ⇔ the ref's recipe is compiled (sample-style keys hasRecipe on this).
// The result is import()ed by generate-recipe.ts, so a traversing id would execute an arbitrary file:
// this syntactic gate is the cheap backstop under readStylePick's index check and the call-site
// containment assert, not the only guard.
export function generatorRelPath(refId: string): string {
  if (!REF_ID.test(refId)) throw new Error(`unsafe refId: ${JSON.stringify(refId)}`);
  return `refs/html/${refId}/recipe.ts`;
}

// Recipes author px at their aspect's reference canvas; a mismatched aspect is a STOP, never a re-layout.
export function scaleFor(meta: RunMeta, refW: number, refH: number): number {
  const scale = meta.width / refW;
  if (Math.abs(meta.height - refH * scale) > 0.02 * meta.height) {
    throw new Error(`aspect mismatch: run canvas ${meta.width}x${meta.height} vs reference ${refW}x${refH}`);
  }
  return scale;
}
// px scaler: positions/sizes/fonts/px-spacings scale; em values and ms timings never do.
export function pxScaler(scale: number): (n: number) => number {
  return (n: number) => Math.round(n * scale);
}

export interface UnitSpan {
  text: string;
  delayMs: number; // VERBATIM from word-timings.json — absolute on the single timeline
}
export interface Unit {
  spans: UnitSpan[]; // >1 span = a glued unit; renders adjacent with the gap zeroed
  chars: number;
  accent?: boolean;
}

// UPPERCASE (never text-transform) + VEED glue: a leading-`-` token merges with the previous word into
// ONE unit for paging/splitting/counting, but keeps its own span + verbatim delay.
export function toUnits(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const text = w.w.toUpperCase();
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

// Chars of a rendered sequence = unit chars + 1 per inter-unit space.
export function charsOf(units: Unit[]): number {
  return units.reduce((s, u) => s + u.chars, 0) + Math.max(0, units.length - 1);
}

// A page takes units (order preserved, every unit used once) while BOTH caps hold; an oversized first
// unit still gets a page of its own (the ladder's smallest row absorbs it).
export function paginate(units: Unit[], maxChars: number, maxUnits: number): Unit[][] {
  const pages: Unit[][] = [];
  let page: Unit[] = [];
  for (const u of units) {
    if (page.length && (charsOf([...page, u]) > maxChars || page.length + 1 > maxUnits)) {
      pages.push(page);
      page = [];
    }
    page.push(u);
  }
  if (page.length) pages.push(page);
  return pages;
}

// Split at the break minimizing |chars(l1) − chars(l2)|; tie → more chars on l1 (top-heavy). Never reorder.
export function splitLines(page: Unit[]): [Unit[], Unit[] | null] {
  if (page.length < 2) return [page, null];
  let best = 1;
  let bestDiff = Infinity;
  for (let k = 1; k < page.length; k++) {
    const d = Math.abs(charsOf(page.slice(0, k)) - charsOf(page.slice(k)));
    if (d <= bestDiff) { best = k; bestDiff = d; } // <= : later break wins ties → more chars on l1
  }
  return [page.slice(0, best), page.slice(best)];
}

export interface LadderRow {
  cls: string;
  g?: string; // l2 leading class paired with this size
  maxC: number;
}

// First row fitting C, stepped down by the demotion count (the verify loop's only lever), clamped.
export function pickRow(ladder: LadderRow[], C: number, demoteRows = 0): LadderRow {
  let i = ladder.findIndex((r) => C <= r.maxC);
  if (i < 0) i = ladder.length - 1;
  return ladder[Math.min(ladder.length - 1, i + demoteRows)];
}

// The runner demotes by the exact element id --verify names; a recipe that sizes per PAGE reads the
// max across its page key + line ids.
export function demotionFor(demote: Record<string, number>, ...keys: string[]): number {
  return Math.max(0, ...keys.map((k) => demote[k] ?? 0));
}

// Gate window extends to the next beat's start so fade-outs finish; the last beat runs to video end.
export function winMsFor(beats: BeatTiming[], i: number, durationSec: number): number {
  const end = i + 1 < beats.length ? beats[i + 1].cueDelayMs : Math.round(durationSec * 1000);
  return Math.max(0, end - beats[i].cueDelayMs);
}

// Mid-beat pages share one anchor with their successor, so the fade must COMPLETE at the successor's
// first word — any hold term past nextStart double-prints (invisible to --verify). The beat's LAST page
// never fades: it holds and the cue gate cuts it (fading it leaves dead-air at every beat end).
export function pgOutDelayMs(page: Unit[], nextPageStartMs: number, fadeMs: number): number {
  const spans = page[page.length - 1].spans;
  return Math.max(nextPageStartMs - fadeMs, spans[spans.length - 1].delayMs);
}

// ONE counter-accent unit per beat, no judgment: digit-bearing first, else longest (chars incl
// punctuation), tie → the later unit.
export function accentIndex(units: Unit[]): number {
  const digit = units.findIndex((u) => u.spans.some((s) => /\d/.test(s.text)));
  if (digit >= 0) return digit;
  let best = 0;
  for (let i = 1; i < units.length; i++) if (units[i].chars >= units[best].chars) best = i;
  return best;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function manifestFor(meta: RunMeta): string {
  return JSON.stringify({ render: { width: meta.width, height: meta.height, fps: meta.fps, duration: meta.durationSec } });
}
