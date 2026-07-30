// Compiled recipe — hook-031 (0-00-00-00) · brutalist split-ledger stack (9:16, authored at 736×1312
// @25fps). Source sheet: ./recipe.md. Up to five fixed rows of huge yellow Fjalla One caps over
// full-bleed footage; early rows split a left phrase against a right-flushed counterweight, later rows
// land flush left; words reveal by plain eased alpha fade on their spoken timing; each beat's stack
// accumulates, holds, and the cue gate cuts it.
//
// Only the sheet's per-beat ladder step is automated (opts.demote keyed by the group ids b{N}r{j}l /
// b{N}r{j}r — any flagged group demotes the whole beat's uniform size, via pickRow). Report-only verify
// fixes NOT automated: never-visible (skeleton typo / missing inline gate values) and occluded (beats
// time-multiplex the slots behind the .cue gate — engine ≥0.6.0 verifies through it, so a real
// occlusion means overlapping cue windows, i.e. a generator bug).
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, paginate, pickRow, pxScaler, scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

interface SizeRow extends LadderRow { fs: number }

// section-C table: fs by beat load L; ink budget 611px between the 44/81 anchors.
// Curation 2026-07-21: face swapped Fjalla One (0.452em/char, weight 400 only) → Anton (heavier
// condensed, ~0.49em/char) — maxC scaled ×0.92 to keep the same ink budget; verify's ladder is the net.
const LADDER: SizeRow[] = [
  { cls: '', fs: 137, maxC: 9.0 },
  { cls: '', fs: 122, maxC: 10.1 },
  { cls: '', fs: 112, maxC: 11.0 },
  { cls: '', fs: 100, maxC: 12.4 },
  { cls: '', fs: 90, maxC: 13.8 },
  { cls: '', fs: 79, maxC: 15.6 },
  { cls: '', fs: 71, maxC: 17.5 },
  { cls: '', fs: 62, maxC: 19.8 },
  { cls: '', fs: 56, maxC: 22.1 },
  { cls: '', fs: 48, maxC: 25.8 },
  { cls: '', fs: 42, maxC: 29.4 },
];
const MAX_ROWS = 5;
const CANVAS_H = 1312;
const INK_EM = 0.72; // Anton caps ink height (em)

// v3: the fixed 158px slot table is gone — row pitch adapts to the beat's font (1em ≈ cap + a third
// of the old air) and the whole stack is CENTRED vertically on the canvas.
export function rowTop031(fs: number, k: number, j: number): number {
  const blockH = fs * (k - 1) + fs * INK_EM;
  return (CANVAS_H - blockH) / 2 + j * fs;
}

export interface Row { units: Unit[]; split: boolean }

// section A + B: pack at 12 chars / 3 units, bump capacity (+4, +1) until ≤5 rows; row j splits
// (first unit left, rest right) iff it has ≥2 units and j ≤ ceil(k/2)
export function buildRows(units: Unit[]): Row[] {
  let maxC = 12;
  let maxU = 3;
  let pages = paginate(units, maxC, maxU);
  while (pages.length > MAX_ROWS) {
    maxC += 4;
    maxU += 1;
    pages = paginate(units, maxC, maxU);
  }
  const k = pages.length;
  return pages.map((u, j) => ({ units: u, split: u.length >= 2 && j + 1 <= Math.ceil(k / 2) }));
}

// section C: C_eff = chars + 0.6 per W/M (their ink runs ~60% over the per-char budget);
// split rows carry the 40px middle gap as the 1.07 factor
export function rowLoad(row: Row): number {
  const text = row.units.map((u) => u.spans.map((s) => s.text).join('')).join(' ');
  const wide = (text.match(/[WM]/g) ?? []).length;
  return (charsOf(row.units) + 0.6 * wide) * (row.split ? 1.07 : 1);
}

export function beatFs(rows: Row[], demoteRows = 0): number {
  const L = Math.max(...rows.map(rowLoad));
  return (pickRow(LADDER, L, demoteRows) as SizeRow).fs;
}

// section 4: entrances compress when the gate closes before a full 350ms reveal (250ms floor)
export function wordDurMs(delayMs: number, gateEndMs: number): number {
  return Math.min(350, Math.max(250, gateEndMs - delayMs));
}

// glued-unit spans stay adjacent (no separator); units join on a single &#160; text node
function groupHtml(units: Unit[], gateEndMs: number): string {
  return units
    .map((u) => u.spans
      .map((s) => `<span class="w" style="animation-delay:${s.delayMs}ms; animation-duration:${wordDurMs(s.delayMs, gateEndMs)}ms">${escapeHtml(s.text)}</span>`)
      .join(''))
    .join('&#160;');
}

function rowHtml(row: Row, beatN: number, j: number, topPx: number, fsPx: number, gateEndMs: number): string {
  const id = `b${beatN}r${j}`;
  if (!row.split) {
    return `  <div class="grp gl" id="${id}l" data-node-role="text" style="top:${topPx}px; font-size:${fsPx}px;">${groupHtml(row.units, gateEndMs)}</div>`;
  }
  return [
    `  <div class="grp gl" id="${id}l" data-node-role="text" style="top:${topPx}px; font-size:${fsPx}px;">${groupHtml([row.units[0]], gateEndMs)}</div>`,
    `  <div class="grp gr" id="${id}r" data-node-role="text" style="top:${topPx}px; font-size:${fsPx}px;">${groupHtml(row.units.slice(1), gateEndMs)}</div>`,
  ].join('\n');
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat, idx) => {
    const rows = buildRows(toUnits(beat.words));
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const gateEnd = beat.cueDelayMs + winMs;
    const ids = rows.flatMap((_, j) => [`b${beat.i}r${j + 1}l`, `b${beat.i}r${j + 1}r`]);
    const fs = beatFs(rows, demotionFor(demote, ...ids));
    const body = rows
      .map((row, j) => rowHtml(row, beat.i, j + 1, p(rowTop031(fs, rows.length, j)), p(fs), gateEnd))
      .join('\n');
    return `<div class="cue" id="cue${beat.i}" style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${body}
</div>`;
  });

  const wv = `<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${p(736)}px; height:${p(1312)}px; position:relative; overflow:hidden; margin:0;
         background:#101010; font-family:'Anton', Impact, "Arial Narrow Bold", sans-serif; }
  .vid { position:absolute; inset:0; width:${p(736)}px; height:${p(1312)}px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0; animation-name:cueWin;
         animation-timing-function:linear; animation-fill-mode:forwards; }

  /* a row group — static layout anchor (only the .w children animate; no flex anywhere).
     gl = flush left, gr = flush right (the split counterweight). */
  .grp { position:absolute; z-index:2; display:inline-block; white-space:nowrap;
         line-height:1; letter-spacing:${p(-1)}px; color:#fede0c; font-weight:400; }
  /* v3: symmetric margins — the 44/81 pair read as a leftward drift of the whole block */
  .gl { left:${p(62)}px; }
  .gr { right:${p(62)}px; }

  /* word reveal — the prefab's plain eased alpha fade IN, then HOLD; the cue gate is the only exit.
     The dark text-shadow grounds the yellow ink over light footage. */
  .w { display:inline-block; opacity:0; text-shadow:0 ${p(2)}px ${p(10)}px rgba(0,0,0,0.7);
       animation-name:wIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wIn { 0%{opacity:0} 100%{opacity:1} }
</style>

<video class="vid" src="${meta.videoPath}" muted></video>

${cues.join('\n')}
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-031 (0-00-00-00)', generate };
export default recipe;
