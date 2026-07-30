// Compiled recipe — hook-036-peak (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// One quiet glowing register, top to bottom: an all-caps HEAD LINE hung from the TOP EDGE by its ink
// top and a sentence-case lower-third on tight leading (lh 1.0) SHARE one ladder (30/27/24/21) —
// the head is not an accent rung, it is the same size as the body. Archivo Narrow 600/500 at
// letter-spacing 0, ink #ffffff / #f8f6f4 under four white glow layers plus a dark grounding layer.
// The reveal is a TYPEWRITER: each glyph pops on at its word's delay + a 34ms intra-word stagger,
// and ONE cursor walks the whole beat (head line first, then the question stack). No blur, no block
// rise, no word fades. Emphasis is structural (position, not size) — no accent class exists. Non-ladder verify fixes (never-visible → timing/class
// audit, occluded → window/z audit) are NOT automated — the runner only demotes ladders; those are
// reported honestly.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { BeatTiming, WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const HEAD_MAX_CHARS = 12;
// The hero line is anchored by its INK TOP at the top safe margin — it rides the TOP EDGE of the
// frame, never a band centre (a centre makes the line drift down as the rung grows, and on tight
// beats it lands across the speaker's eyes). Constant for every rung: all four ladder sizes put
// their first ink on the same line, growing DOWNWARD from it.
const HEAD_INK_TOP_Y = 50;
const Q_CENTER_Y = 604;
const Q_LEADING = 1.0;     // was 1.5 — the question stack's leading tightens by 1.5×

// Ordered ladders (largest first — demotion steps DOWN = later index). maxC = floor(1126 / adv·F):
// head 0.66em/char caps 600 at letter-spacing 0, question 0.60em/char mixed 500
// (budgeted — clean sans, generous slack).
// The head line is NOT an accent rung — it runs at the question stack's own scale, so the poster
// reads as one quiet register top to bottom (maxC = floor(1126 / 0.66·F), the narrow face budgeted
// conservatively at the wider Figtree advance it replaced).
const HEAD_SIZES = [30, 27, 24, 21];
const HEAD_LADDER: LadderRow[] = [
  { cls: 'h30', maxC: 56 }, { cls: 'h27', maxC: 63 }, { cls: 'h24', maxC: 71 }, { cls: 'h21', maxC: Infinity },
];
const Q_SIZES = [30, 27, 24, 21];
const Q_LADDER: LadderRow[] = [
  { cls: 'q30', maxC: 62 }, { cls: 'q27', maxC: 69 }, { cls: 'q24', maxC: 78 }, { cls: 'q21', maxC: Infinity },
];

function sizeOf(cls: string): number {
  return parseInt(cls.slice(1), 10);
}

// Units keep their case (the head line uppercases at render time; question words render as given) +
// VEED glue: a leading-`-` token merges with the previous word, each span keeping its own delay.
export function unitsFor(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const text = w.w;
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

// Head line = the longest prefix with chars ≤ 12 (at least one unit — the first joins even if longer);
// everything else is the question.
export function splitHeadQuestion(units: Unit[]): { head: Unit[]; question: Unit[] } {
  const head: Unit[] = [];
  for (const u of units) {
    if (head.length && charsOf([...head, u]) > HEAD_MAX_CHARS) break;
    head.push(u);
  }
  return { head, question: units.slice(head.length) };
}

// L = min(3, ceil(S/3)); base = floor(S/L); the first (S mod L) lines take base+1 consecutive words.
export function questionLines(question: Unit[]): Unit[][] {
  const S = question.length;
  if (!S) return [];
  const L = Math.min(3, Math.ceil(S / 3));
  const base = Math.floor(S / L);
  const rem = S % L;
  const lines: Unit[][] = [];
  let i = 0;
  for (let l = 0; l < L; l++) {
    const take = base + (l < rem ? 1 : 0);
    lines.push(question.slice(i, i + take));
    i += take;
  }
  return lines;
}

export function headInMs(availMs: number): number {
  return Math.min(500, Math.max(250, availMs - 80));
}

export function wordInMs(availMs: number): number {
  return Math.min(300, Math.max(150, availMs - 80));
}

// Reference-canvas tops (pre-SCALE): one nowrap head line (lh 1.2) hung from the top safe margin;
// the question stack (L lines, lh 1.0) centered on y 604 — the two anchors are independent.
// Head: TOP-anchored, so the size argument is deliberately unused — the line box starts at
// HEAD_INK_TOP_Y on every rung and a demotion shortens it from the BOTTOM (h30 → y 50…86,
// h21 → y 50…75). Never convert this back to a centre.
export function headTopPx(_F: number): number {
  return HEAD_INK_TOP_Y;
}

export function qTopPx(F: number, L: number): number {
  return Q_CENTER_Y - Math.round((Q_LEADING / 2) * F * L);
}

// Fractional px scale UNROUNDED, to 3 decimals. Kept for scaled fractional values; the design
// carries none today (the static blur it was written for is gone).
export function fracPx(n: number, scale: number): number {
  return Number((n * scale).toFixed(3));
}

// TYPEWRITER — a glyph pops on at its word's verbatim delay plus a 34ms intra-word stagger, and the
// cursor after it is visible ONLY until the next glyph types, so exactly one cursor exists at any
// moment across the WHOLE beat (head line first, then the question stack).
const TYPE_MS = 34;
const TYPE_SAFE_MS = 100; // every glyph lands at least this long before the gate closes
const CUR_LINGER_MS = 350; // the final cursor holds this long
const CUR_MIN_WIN_MS = 12; // sub-half-frame windows are dropped — two cursors would coexist

export function typeDelay(delayMs: number, j: number, gateCloseMs: number): number {
  return Math.max(delayMs, Math.min(delayMs + TYPE_MS * j, gateCloseMs - TYPE_SAFE_MS));
}

interface Glyph { ch: string; delayMs: number }
interface Walk { i: number; flat: Glyph[] }

function unitGlyphs(u: Unit, upper: boolean, gateClose: number): Glyph[] {
  const out: Glyph[] = [];
  for (const s of u.spans) {
    [...(upper ? s.text.toUpperCase() : s.text)].forEach((ch, j) => {
      out.push({ ch, delayMs: typeDelay(s.delayMs, j, gateClose) });
    });
  }
  return out;
}

// The beat's glyphs in reading order — this ONE sequence drives every cursor window.
export function beatGlyphs(head: Unit[], question: Unit[], gateClose: number): Glyph[] {
  return [
    ...head.flatMap((u) => unitGlyphs(u, true, gateClose)),
    ...question.flatMap((u) => unitGlyphs(u, false, gateClose)),
  ];
}

function typedWordHtml(u: Unit, upper: boolean, w: Walk): string {
  let html = '';
  for (const s of u.spans) {
    for (const _ of [...(upper ? s.text.toUpperCase() : s.text)]) {
      const g = w.flat[w.i];
      const next = w.flat[w.i + 1];
      const win = next ? next.delayMs - g.delayMs : CUR_LINGER_MS;
      w.i += 1;
      const cur = win >= CUR_MIN_WIN_MS
        ? `<span class="cur" style="animation:curWin ${win}ms linear ${g.delayMs}ms both">|</span>`
        : '';
      html += `<span class="tg" style="animation-delay:${g.delayMs}ms">${escapeHtml(g.ch)}</span>${cur}`;
    }
  }
  return html;
}

function headSpansHtml(head: Unit[], w: Walk): string {
  return head.map((u) => `<span class="hw">${typedWordHtml(u, true, w)}</span>`).join('');
}

function qSpanHtml(u: Unit, w: Walk): string {
  return `<span class="w">${typedWordHtml(u, false, w)}</span>`;
}

function cueHtml(beat: BeatTiming, winMs: number, demote: Record<string, number>, p: (n: number) => number): string {
  const N = beat.i;
  const units = unitsFor(beat.words);
  if (!units.length) return '';
  const cueEnd = beat.cueDelayMs + beat.cueDurMs;
  const { head, question } = splitHeadQuestion(units);

  const hRow = pickRow(HEAD_LADDER, charsOf(head), demotionFor(demote, `b${N}h`));
  const walk: Walk = { i: 0, flat: beatGlyphs(head, question, cueEnd) };
  const rows = [
    `  <div class="hl ${hRow.cls}" id="b${N}h" data-node-id="b${N}h" data-node-role="text"
       style="top:${p(headTopPx(sizeOf(hRow.cls)))}px">${headSpansHtml(head, walk)}</div>`,
  ];
  const lines = questionLines(question);
  if (lines.length) {
    const Cq = Math.max(...lines.map(charsOf));
    const qRow = pickRow(Q_LADDER, Cq, demotionFor(demote, `b${N}q1`, `b${N}q2`, `b${N}q3`));
    const qls = lines.map((line, l) => {
      const id = `b${N}q${l + 1}`;
      return `    <div class="ql ${qRow.cls}" id="${id}" data-node-id="${id}" data-node-role="text">${line.map((u) => qSpanHtml(u, walk)).join('')}</div>`;
    });
    rows.push(`  <div class="qw" style="top:${p(qTopPx(sizeOf(qRow.cls), lines.length))}px">\n${qls.join('\n')}\n  </div>`);
  }
  return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${winMs}ms">
${rows.join('\n')}
</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 1280, 720);
  const p = pxScaler(scale);
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) => cueHtml(beat, winMsFor(timings.beats, idx, meta.durationSec), demote, p))
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Archivo+Narrow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; background: #000; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay + duration + z come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; animation-name: cueWin;
         animation-timing-function: linear; animation-fill-mode: forwards; }

  /* top-edge HEAD line — static: the typewriter below is the only reveal, the block never moves.
     Spans inside are STATIC (an animating span inside an animating-transform ancestor
     mis-composites in this engine). Blur is STATIC, never animated. Full-width block +
     text-align (never shrink-to-fit flex). Tracking is the ACCENT rung's own: −0.026em, ~3× tighter
     in em than the old small label's −0.3px/33px (−0.009em) — tracking falls as size rises. */
  .hl { position: absolute; left: 0; width: ${p(1280)}px; text-align: center; white-space: nowrap;
        font-family: 'Archivo Narrow', 'Archivo', sans-serif; font-weight: 600; line-height: 1.2;
        letter-spacing: 0; color: #ffffff;
        text-shadow: 0 0 ${p(4)}px #fff, 0 0 ${p(9)}px rgba(255,255,255,0.95), 0 0 ${p(18)}px rgba(255,255,255,0.7),
                     0 0 ${p(31)}px rgba(255,255,255,0.45), 0 ${p(1)}px ${p(6)}px rgba(0,0,0,0.55);
        }
  .hw { display: inline-block; margin-right: 0.26em; }

  /* lower-third question — sentence case, word-by-word plain fade; lines are full-width
     nowrap blocks in flow inside one positioned wrap */
  .qw { position: absolute; left: 0; width: ${p(1280)}px; }
  .ql { display: block; width: ${p(1280)}px; text-align: center; white-space: nowrap;
        font-family: 'Archivo Narrow', 'Archivo', sans-serif; font-weight: 500; line-height: ${Q_LEADING};
        letter-spacing: 0; color: #f8f6f4;
        text-shadow: 0 0 ${p(4)}px #fff, 0 0 ${p(9)}px rgba(255,255,255,0.95), 0 0 ${p(18)}px rgba(255,255,255,0.7),
                     0 0 ${p(31)}px rgba(255,255,255,0.45), 0 ${p(1)}px ${p(6)}px rgba(0,0,0,0.55); }
  .w  { display: inline-block; margin-right: 0.26em; }

  /* TYPEWRITER: a glyph POPS on (no fade, no slide) at its delay… */
  .tg { display: inline-block; opacity: 0; animation: tOn 30ms linear both; }
  @keyframes tOn { 0% { opacity: 0; } 100% { opacity: 1; } }
  /* …and the cursor bar after it is visible ONLY until the next glyph types (window inline).
     width:0 + pre keeps it out of layout — it overhangs right after the glyph, same face and glow. */
  .cur { display: inline-block; width: 0; overflow: visible; white-space: pre; opacity: 0; }
  @keyframes curWin { 0% { opacity: 0; } 0.01%, 99.99% { opacity: 1; } 100% { opacity: 0; } }

  ${HEAD_SIZES.map((s) => `.h${s} { font-size: ${p(s)}px; }`).join(' ')}
  ${Q_SIZES.map((s) => `.q${s} { font-size: ${p(s)}px; }`).join(' ')}
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

const recipe: RecipeGenerator = { refId: 'hook-036-peak', generate };
export default recipe;
