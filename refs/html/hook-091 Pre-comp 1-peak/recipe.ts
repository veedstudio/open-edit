// Compiled recipe — hook-091 Pre-comp 1-peak (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// Brutalist Anton-caps type poster over full-bleed footage, BOTTOM-ANCHORED in the lower frame: a sparse
// row of small words scattered wide, ONE giant slab word (the accent) under them revealing with a
// restrained opacity+rise, the trailing words in a small centered line under the slab's ink. The ink is
// poster neon yellow (#fff402 + 2 yellow glow layers over 1 dark grounding layer). The stack runs on ONE
// leading: every adjacent pair measures baseline(upper) → ink top(lower) = LEAD, whatever the sizes are.
// Tracking is optical — each ladder rung carries its own letter-spacing off a falling curve, negative at
// the display sizes. WORDS pop on their verbatim spoken timings, the poster accumulates, the beat gate
// cuts it. The prefab's bottom fine-print caption (demo promo copy) is deliberately not carried over.
// Non-ladder verify fixes (top/bottom bounds → closed-form re-check, never-visible → timing/class
// audit, occluded → window clamp) are NOT automated — the runner only demotes ladders; those
// failures are reported honestly.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow, type Unit,
  accentIndex, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const BUDGET_EM = 1088; // px; all rows center on 640 and fit x 96..1184
// Coarse per-char width budget behind the maxC ladders. Anton caps average 0.479em; the widest rung
// tracking is +0.026em (f21) → 0.505em, so 0.51 stays an upper bound at EVERY rung of the curve below.
const CHAR_EM = 0.51;

// Optical tracking curve — tracking FALLS as the size rises. The eye reads inter-letter distance
// non-linearly: the em value that is right on the small words is blown out once the word is a display
// slab, so every ladder rung carries its OWN letter-spacing, track(f) = A/f + B (em, 4dp):
// +0.026em at f21 → ~0 around f47 → −0.012em at g113. Strictly falling across both ladders, and the
// width model charges the rung's own value per character (never one flat value).
const TRACK_A = 0.98;
const TRACK_B = -0.0207;
export function trackEm(size: number): number {
  return +(TRACK_A / size + TRACK_B).toFixed(4);
}

// Anton 400 advances (em/char, engine calibration render at letter-spacing 0; unknown char → CHAR_EM).
const ADV: Record<string, number> = {
  A: .484, B: .475, C: .473, D: .489, E: .409, F: .396, G: .483, H: .495, I: .224, J: .464,
  K: .470, L: .395, M: .741, N: .494, O: .484, P: .469, Q: .491, R: .474, S: .459, T: .395,
  U: .471, V: .469, W: .710, X: .484, Y: .446, Z: .409,
  '0': .493, '1': .329, '2': .493, '3': .491, '4': .494, '5': .493, '6': .493, '7': .490, '8': .493, '9': .493,
  "'": .211, '?': .490, '!': .226, '£': .471, ',': .234, '.': .226, '&': .518, '%': 1.055,
  '$': .460, '+': .354, ':': .239, ';': .243, '"': .426, '-': .309,
};

// Bare glyph advances (tracking excluded — it is charged per rung, not baked in).
export function rawAdvEm(text: string): number {
  let s = 0;
  for (const c of text) s += ADV[c] ?? CHAR_EM;
  return s;
}
export function advEm(text: string, track: number): number {
  return rawAdvEm(text) + track * [...text].length;
}

// A row's width model, tracking-free: the rung's letter-spacing is applied later (aminEm), so one row
// can be measured against every rung of its ladder.
export interface RowWidth {
  raw: number; // Σ bare advances (em)
  chars: number; // characters that each take the rung's tracking
  gapEm: number; // minGap · (units − 1)
}
export function widthOf(units: Unit[], minGapEm: number): RowWidth {
  let raw = 0;
  let chars = 0;
  for (const u of units) for (const sp of u.spans) { raw += rawAdvEm(sp.text); chars += [...sp.text].length; }
  return { raw, chars, gapEm: minGapEm * Math.max(0, units.length - 1) };
}
export function aminEm(w: RowWidth, track: number): number {
  return w.raw + w.chars * track + w.gapEm;
}

// Anton ink extents of the padded span construction (em from the row top, calibration render):
// cap top 0.115, baseline 0.985 (cap height 0.87), descenders (Q J , ;) reach 1.095.
export const INK = 0.115, BASELINE = 0.985, CAP = BASELINE - INK;
// Bottom-anchored stack: the LOWEST row's baseline is pinned, everything else derives upward, so the
// poster always sits low in the frame whatever the beat's sizes are.
export const BASE = 648; // baseline of the lowest row
// ONE leading for the whole poster: EVERY adjacent pair of rows measures baseline(upper row) →
// ink top(lower row) = LEAD px, independent of the two sizes involved. Equal by construction, not by eye.
export const LEAD = 26;

// Ordered ladders (largest first — demotion steps DOWN = later index). Sizes are the prefab's cap
// heights ÷ 0.87 (Anton's cap/em), so the composition keeps its optical scale; maxC = ⌊1088/(CHAR_EM·f)⌋.
const F_SIZES = [49, 45, 41, 38, 34, 31, 29, 26, 24, 21];
const F_MAXC = [43, 47, 52, 56, 62, 68, 73, 82, 88, Infinity];
const F_LADDER: LadderRow[] = F_SIZES.map((s, i) => ({ cls: `f${s}`, maxC: F_MAXC[i] }));
const G_SIZES = [113, 104, 95, 88, 81, 74, 69, 63, 58, 53, 49, 45];
const G_MAXC = [18, 20, 22, 24, 26, 28, 30, 33, 36, 40, 43, Infinity];
const G_LADDER: LadderRow[] = G_SIZES.map((s, i) => ({ cls: `g${s}`, maxC: G_MAXC[i] }));

const sizeOf = (cls: string) => Number(cls.replace(/^[a-z]+/, ''));

// Coarse pick by C (+ the verify loop's demotion), then the exact-fit floor with the row's REAL
// advances AT EACH RUNG'S TRACKING: step down while the layout width f·Amin(f) would overflow the budget.
export function fitRow(ladder: LadderRow[], C: number, w: RowWidth, demoteSteps = 0): LadderRow {
  let i = ladder.indexOf(pickRow(ladder, C, demoteSteps));
  while (i < ladder.length - 1) {
    const f = sizeOf(ladder[i].cls);
    if (f <= BUDGET_EM / aminEm(w, trackEm(f))) break;
    i++;
  }
  return ladder[i];
}

// Word prep: uppercase (never text-transform), strip a trailing `.` or `,`, keep `?` `!` `'` and
// internal punctuation. VEED glue: a leading-`-` token merges with the previous word into ONE unit.
export function stripWord(w: string): string {
  return w.toUpperCase().replace(/[.,]$/, '');
}

export function unitsFor(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const text = stripWord(w.w);
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

export interface Slots {
  top: Unit[];
  big: Unit;
  sub: Unit[];
}

// Accent → the giant slab; everything before it → the scattered TOP row; everything after → the SUB
// line. Word order is never changed.
export function splitSlots(units: Unit[]): Slots {
  const a = accentIndex(units);
  return { top: units.slice(0, a), big: units[a], sub: units.slice(a + 1) };
}

// The wide scatter: TOP justifies its slack toward the full budget, clamped to the prefab's gap range.
export function topGapEm(f: number, sumAdvEm: number, n: number): number {
  if (n < 2) return 0;
  return Math.min(7, Math.max(1.2, (BUDGET_EM / f - sumAdvEm) / (n - 1)));
}

// Entrance compresses so a late word still lands before the gate.
export function entranceMs(baseMs: number, availMs: number): number {
  return Math.min(baseMs, Math.max(220, availMs - 80));
}

// Closed-form row tops, derived UPWARD from the pinned bottom baseline (reference px; f1/F/f2 = the px
// sizes of the TOP / BIG / SUB rows, null when that slot is empty). ONE leading: both pairs are LEAD.
export function stackTops(F: number, f1: number | null, f2: number | null): { topTop: number | null; bigTop: number; subTop: number | null } {
  const subTop = f2 === null ? null : BASE - BASELINE * f2;
  // sub ink top = BASE − CAP·f2; the slab's BASELINE rides LEAD above it
  const slabBase = f2 === null ? BASE : BASE - CAP * f2 - LEAD;
  const bigTop = slabBase - BASELINE * F;
  // slab ink top = bigTop + INK·F; the TOP row's BASELINE rides LEAD above it
  const topTop = f1 === null ? null : bigTop + INK * F - LEAD - BASELINE * f1;
  return { topTop, bigTop, subTop };
}

const chunkC = (units: Unit[], gapC: number) =>
  units.reduce((s, u) => s + u.chars, 0) + gapC * Math.max(0, units.length - 1);

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 1280, 720);
  const p = pxScaler(scale);
  const fx = (n: number) => +(n * scale).toFixed(2); // derived tops/gaps stay fractional
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat) => {
    const N = beat.i;
    const units = unitsFor(beat.words);
    if (!units.length) return '';
    const cueEnd = beat.cueDelayMs + beat.cueDurMs;
    const { top, big, sub } = splitSlots(units);

    // spans of one row, adjacent, margins are the gaps (glued spans keep margin-right:0)
    const spansOf = (row: Unit[], cls: string, baseMs: number, gapPx: number) => row.map((u, ui) => u.spans.map((sp, si) => {
      const last = ui === row.length - 1 && si === u.spans.length - 1;
      const gap = si < u.spans.length - 1 ? ';margin-right:0' : last ? '' : `;margin-right:${gapPx}px`;
      return `<span class="${cls}" style="animation-delay:${sp.delayMs}ms;animation-duration:${entranceMs(baseMs, cueEnd - sp.delayMs)}ms${gap}">${escapeHtml(sp.text)}</span>`;
    }).join('')).join('');

    // Every row's size first — the stack hangs off the bottom row, so the tops need them all.
    const gW = widthOf([big], 0);
    const gRow = fitRow(G_LADDER, big.chars, gW, demotionFor(demote, `b${N}g`));
    const F = sizeOf(gRow.cls);
    const tW = widthOf(top, 1.2);
    const tRow = top.length
      ? fitRow(F_LADDER, chunkC(top, 3), tW, demotionFor(demote, `b${N}t`))
      : null;
    const sRow = sub.length
      ? fitRow(F_LADDER, chunkC(sub, 2), widthOf(sub, 0.75), demotionFor(demote, `b${N}s`))
      : null;
    const f1 = tRow ? sizeOf(tRow.cls) : null;
    const f2 = sRow ? sizeOf(sRow.cls) : null;
    const { topTop, bigTop, subTop } = stackTops(F, f1, f2);

    const parts: string[] = [];
    if (tRow && f1 !== null && topTop !== null) {
      const topSum = tW.raw + tW.chars * trackEm(f1); // the scatter justifies against the rung's real width
      parts.push(`  <div class="row ${tRow.cls}" id="b${N}t" data-node-id="b${N}t" data-node-role="text" style="top:${fx(topTop)}px">${spansOf(top, 'w', 350, fx(topGapEm(f1, topSum, top.length) * f1))}</div>`);
    }
    parts.push(`  <div class="row ${gRow.cls}" id="b${N}g" data-node-id="b${N}g" data-node-role="text" style="top:${fx(bigTop)}px">${spansOf([big], 'b', 500, 0)}</div>`);
    if (sRow && f2 !== null && subTop !== null) {
      parts.push(`  <div class="row ${sRow.cls}" id="b${N}s" data-node-id="b${N}s" data-node-role="text" style="top:${fx(subTop)}px">${spansOf(sub, 'w', 350, fx(0.75 * f2))}</div>`);
    }

    return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${beat.cueDurMs}ms">
${parts.join('\n')}
</div>`;
  }).filter(Boolean);

  const ink = `color: #fff402;
       text-shadow: 0 0 ${p(14)}px rgba(255,225,0,.55), 0 0 ${p(4)}px rgba(255,225,0,.7), 0 ${p(2)}px ${p(12)}px rgba(0,0,0,.7);`;

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${p(1280)}px; height: ${p(720)}px; background: #1a1410; overflow: hidden; position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; inset: 0; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* full-width centered row + inline-block spans — the layout construct. This wrapper is load-bearing:
     a bare absolutely-positioned inline-block in body flow gets page-coupled ink offsets in this
     engine — always center through .row, never translate(-50%). Tracking is NOT set here: every size
     class carries its own (the optical curve), so the value falls as the size rises. */
  .row { position: absolute; left: 0; width: ${p(1280)}px; text-align: center; line-height: 1; z-index: 2;
         font-family: 'Anton', sans-serif; font-weight: 400; }

  /* word spans: the vertical padding is shear headroom (an animating span rasterizes at its
     line-height:1 box and glyph edges clip without it); ink extents are calibrated WITH it.
     ONE ink for every word at every size — poster neon yellow: two yellow glow layers over a dark
     grounding layer that holds the type off bright footage. */
  @keyframes fadeIn { 0% { opacity: 0; } 100% { opacity: 1; } }
  @keyframes slabIn { 0% { opacity: 0; transform: translateY(0.09em); } 100% { opacity: 1; transform: translateY(0); } }
  .w { display: inline-block; white-space: nowrap; padding: 0.06em 0 0.14em; opacity: 0; ${ink}
       animation-name: fadeIn; animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .b { display: inline-block; white-space: nowrap; padding: 0.06em 0 0.14em; opacity: 0; ${ink}
       animation-name: slabIn; animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }

  ${F_SIZES.map((s) => `.f${s}{font-size:${p(s)}px;letter-spacing:${trackEm(s)}em}`).join(' ')}
  ${G_SIZES.map((s) => `.g${s}{font-size:${p(s)}px;letter-spacing:${trackEm(s)}em}`).join(' ')}
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

const recipe: RecipeGenerator = { refId: 'hook-091 Pre-comp 1-peak', generate };
export default recipe;
