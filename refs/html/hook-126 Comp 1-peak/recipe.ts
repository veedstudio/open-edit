// Compiled recipe — hook-126 Comp 1-peak (16:9, authored at 1280×720 @24fps). Source sheet:
// ./recipe.md. Editorial serif word-scatter over full-bleed footage, pushed OUT against one frame
// edge: each spoken word rises ~0.28em and fades in at its own absolute spot, the words interlocking
// into a loose descending staircase hugging the LEFT edge (odd beats) or the RIGHT edge (even beats),
// its outer edge ragged and its inward run hard-clamped so the frame's centre band never carries ink;
// short beats (≤2 slots) take the tighter edge offsets and go right out to the frame's edge. Amber
// Lora 400 in the prefab's mixed sizes (oversized opener, smaller followers), verbatim case, fattened
// by an 8-way same-ink text-shadow over a light, pulled-back drop. The beat's closing lone word SAGS
// in — the bottom corner sitting ON that beat's anchored edge is pinned to the line (bottom-LEFT on the
// left-hugging beats, bottom-RIGHT on the right-hugging ones, so two consecutive beats never fall from
// the same corner) while the free end — always the one pointing INTO the frame — is released and FALLS
// from level into that beat's own angle with an overshoot settle (baked into the span's own keyframes,
// never an ancestor transform). Every fall is DOWNWARD whichever corner is pinned — the free end drops,
// never rises; a word whose fall would break a safe bound steps DOWN the table to a smaller angle
// instead of moving the bound. Words accumulate and the beat gate cuts the stack.
//
// opts.demote (keys = the exact slot ids --verify names, b{N}s{k}) automates only the left/right
// bounds fix: that slot's multiplier steps one row down (fs and every later top recompute).
// Report-only (NOT automated): the top/bottom arithmetic re-check, the never-visible checklist
// (incl. a word spoken <200ms before the gate), and the occluded window re-check — cue windows are
// contiguous by construction (winMsFor).
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, paginate, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// Slot geometry (reference px): the prefab's five words re-composed as SIDE-EDGE offsets that hug the
// anchored frame edge — the offset family IS the ragged outer edge of the scatter.
export const BASES = [108, 76, 86, 76, 80];
export const OFFSETS = [40, 132, 24, 100, 60]; // L ≥ 3 — the staircase
export const OFFSETS_EDGE = [24, 72];          // L ≤ 2 — short beats go right out to the edge
const TOP1 = 48;
// The composition lives in the outer band: a line runs at most INNER_RUN px in from its anchored
// edge, so the 160px band across frame centre (560…720) never carries caption ink.
const INNER_RUN = 560;
const SAFE_BOTTOM = 676; // the safe band's floor — the only bound a downward sag can reach
// Lora 400 calibration (shipped TTF): ink band inside the 1.35 line box + the advance budget.
const INK_TOP = 0.28;
const INK_BOT = 1.31;
const ADV = 0.6;
const LINE = 1.35;              // the span's line box — the sag pivots on ONE of its bottom corners
const INK_RISE = LINE - INK_TOP; // 1.07 — ink height ABOVE that pinned corner (the rotated tip's arm)

// The ink. One source of truth: the letterforms, all 8 fattening copies and nothing else use it.
const INK = '#ffd400';

// The sag angle per beat: a MAGNITUDE, always DOWNWARD. The sign is the pinned corner's, not the
// table's — clockwise about a bottom-LEFT pivot, counter-clockwise about a bottom-RIGHT one; either
// way the free end drops. Magnitude varies beat to beat, never the same angle twice running.
// Indexed (beat.i − 1) mod 6. The swing is shaped by the keyframe stops, NOT by the easing: the word
// lands level by SAG_LAND_PCT, swings past its angle by SAG_OVER at SAG_PEAK_PCT, then settles onto
// it. (A single-interval ramp under the .w easing is over before the word is opaque — the tilt would
// read as static.) SAG_OVER is a RATIO, so it is retuned down as the angles go up: the excursion past
// the resting angle stays ~1.5–3° (a settle) instead of scaling into a wobble.
export const SAG_DEG = [16, 10, 20, 12, 18, 14];
const SAG_OVER = 1.15;
const SAG_LAND_PCT = 28;
const SAG_PEAK_PCT = 72;
// The step-down ladder IS the table: table indices ordered by angle, largest first. A word whose own
// beat angle breaks a bound (see `sags`) takes the next SMALLER angle — and that entry's class.
export const SAG_STEPS = SAG_DEG.map((_, i) => i).sort((a, b) => SAG_DEG[b] - SAG_DEG[a]);

// The two pinned corners. A beat pins the bottom corner sitting ON its own anchored edge — bottom-LEFT
// while the scatter hugs the left edge (odd beats), bottom-RIGHT while it hugs the right (even) — so
// the corner cycles with the edge cycle and no two consecutive beats fall from the same one. `sign`
// keeps the fall DOWNWARD in both: clockwise off a bottom-left pivot, counter-clockwise off a
// bottom-right one. Pinning the EDGE corner (never the inward one) is also what keeps the swing
// sweeping inward — the single direction the bounds guard tests.
const SAG_PIVOTS = { left: { key: 'L', origin: '0 100%', sign: 1 },
                     right: { key: 'R', origin: '100% 100%', sign: -1 } } as const;

// Multiplier ladder by slot char count (largest first; demotion steps DOWN = later index).
export const MULT_LADDER: LadderRow[] = [
  { cls: '1', maxC: 6 }, { cls: '0.86', maxC: 8 }, { cls: '0.74', maxC: 10 },
  { cls: '0.64', maxC: 13 }, { cls: '0.55', maxC: 16 }, { cls: '0.47', maxC: 20 },
  { cls: '0.4', maxC: Infinity },
];

// Greedy caps escalation: first row packing to ≤5 slots wins; the (unreachable for spoken beats)
// fallback is one slot absorbed by the width cap.
const CAPS: Array<[number, number]> = [[12, 3], [16, 4], [20, 4], [26, 5], [34, 6]];
const MAX_SLOTS = 5;

// Words keep case + punctuation verbatim; VEED glue — a leading-`-` token merges with the previous
// word into ONE unit, each glued span keeping its own verbatim delayMs.
export function unitsFor126(words: WordTiming[]): Unit[] {
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

export function packSlots(units: Unit[]): Unit[][] {
  for (const [maxChars, maxUnits] of CAPS) {
    const slots = paginate(units, maxChars, maxUnits);
    if (slots.length <= MAX_SLOTS) return slots;
  }
  return [units];
}

// Short beats (≤2 slots) take the tighter family; L ≥ 3 takes the staircase.
export function offsetsFor(L: number): number[] {
  return L <= OFFSETS_EDGE.length ? OFFSETS_EDGE : OFFSETS;
}

// fs = min(round(mult · base), floor(availW/(C·ADV))) — the ladder sizes the line, the width term is
// a HARD clamp against the centre band. The clamp FLOORS (rounding it up would leak a couple of px
// past the gutter) while the ladder size rounds, so off + W ≤ INNER_RUN holds for every C.
export function slotFs(k: number, C: number, demoteRows: number, L = 5): number {
  const mult = Number(pickRow(MULT_LADDER, C, demoteRows).cls);
  const availW = INNER_RUN - offsetsFor(L)[k];
  return Math.min(Math.round(mult * BASES[k]), Math.floor(availW / (C * ADV)));
}

// The sagging closer: the beat's LAST slot, iff one unit of one span AND the swing at the OVERSHOOT
// angle θ clears BOTH the safe bottom and the centre gutter. Measure everything as d, the distance
// INWARD from that beat's own anchored edge (pivot at top + LINE·fs, ink reaching INK_RISE·fs above it,
// W = the advance budget) — that is where the mirror pays off, because the pinned corner and the
// rotation sign flip TOGETHER with the side:
//   LEFT-hugging beat — pivot = bottom-LEFT (d = off), +θ. The free RIGHT end is the inward one; its
//     bottom corner swings back toward the pivot to d = off + W·cos θ while the ink's far TOP corner
//     swings a further INK_RISE·fs·sin θ inward. Their sum is the deepest ink.
//   RIGHT-hugging beat — pivot = bottom-RIGHT (again d = off, the corner on the edge), −θ. In screen x
//     this is the mirror: the free LEFT end is the inward one and the ink reaches back toward 720, not
//     out to 560. Re-derived in d it is the same two terms — the pivot's arm is still W and the top
//     corner's excursion is still INK_RISE·fs·sin θ — so ONE test covers both sides. (It would NOT if
//     only one of the pair flipped: pinning the INWARD corner leaves the deepest reach at the pivot,
//     off + W, which slotFs already guarantees, and moves the risk onto the FRAME edge at
//     off + W − W·cos θ − INK_RISE·fs·sin θ. That pairing is never emitted — see the sag class below.)
//   INWARD — off + W·cos θ + INK_RISE·fs·sin θ ≤ 560, so the 160px centre band stays clean from either
//     edge. NOT monotone in θ (it peaks at tan θ = INK_RISE·fs/W), which is why every candidate angle
//     is tested rather than only the largest.
//   BOTTOM — the free end is the lowest ink either way: pivot + W·sin θ ≤ 676.
//   TOP / anchored edge — slack for ANY downward angle: the topmost ink lands at pivot − INK_RISE·fs·
//     cos θ (below where it started) and the outermost point is the pivot itself, which does not move.
export function sags(slot: Unit[], top: number, fs: number, off: number, deg: number): boolean {
  if (slot.length !== 1 || slot[0].spans.length !== 1) return false;
  const th = (deg * SAG_OVER * Math.PI) / 180;
  const w = charsOf(slot) * ADV * fs;
  return top + LINE * fs + w * Math.sin(th) <= SAFE_BOTTOM
    && off + w * Math.cos(th) + INK_RISE * fs * Math.sin(th) <= INNER_RUN;
}

// The angle actually rendered, as a table index: the beat's own angle when it fits, else the next
// SMALLER angle down the table (reusing that entry's class) — the ANGLE steps down, never the safe
// area. −1 = the slot renders level (multi-span, or even the smallest angle overruns).
export function sagStepFor(slot: Unit[], top: number, fs: number, off: number, N: number): number {
  const own = sagDegFor(N);
  for (const i of SAG_STEPS) {
    if (SAG_DEG[i] > own) continue;
    if (sags(slot, top, fs, off, SAG_DEG[i])) return i;
  }
  return -1;
}

export function sagIndexFor(N: number): number {
  return (((N - 1) % SAG_DEG.length) + SAG_DEG.length) % SAG_DEG.length;
}
export function sagDegFor(N: number): number {
  return SAG_DEG[sagIndexFor(N)];
}

export function inMs(delayMs: number, gateEndMs: number): number {
  return Math.min(420, Math.max(120, gateEndMs - delayMs - 80));
}

// The sagging closer gets a LONGER window than a plain word-in — the swing has to be watchable — but
// still lands before the gate (same 80ms margin).
export function sagMs(delayMs: number, gateEndMs: number): number {
  return Math.min(620, Math.max(200, gateEndMs - delayMs - 80));
}

// A slot's spans: each unit's last span carries the gap (.wg + trailing &#160;) unless the unit is
// slot-final; glued spans inside a unit get neither. A sagging slot adds .sag{n} to every span.
function slotSpans(units: Unit[], gateEndMs: number, sagCls: string): string {
  return units
    .map((u, ui) =>
      u.spans
        .map((s, si) => {
          const gap = si === u.spans.length - 1 && ui !== units.length - 1;
          const cls = `w${gap ? ' wg' : ''}${sagCls ? ` ${sagCls}` : ''}`;
          const dur = sagCls ? sagMs(s.delayMs, gateEndMs) : inMs(s.delayMs, gateEndMs);
          return `<span class="${cls}" style="animation-delay:${s.delayMs}ms;animation-duration:${dur}ms">${escapeHtml(s.text)}${gap ? '&#160;' : ''}</span>`;
        })
        .join(''))
    .join('');
}

const sagPeak = (deg: number) => +(deg * SAG_OVER).toFixed(1);

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 1280, 720);
  const p = pxScaler(scale);
  const f = (n: number) => +(n * scale).toFixed(2); // derived tops stay fractional
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) => {
      const N = beat.i;
      const units = unitsFor126(beat.words);
      if (!units.length) return '';
      const winMs = winMsFor(timings.beats, idx, meta.durationSec);
      const gateEnd = beat.cueDelayMs + winMs;
      const side = N % 2 === 1 ? 'left' : 'right';

      const slots = packSlots(units);
      const L = slots.length;
      const offs = offsetsFor(L);
      const fss = slots.map((slot, i) => slotFs(i, charsOf(slot), demotionFor(demote, `b${N}s${i + 1}`), L));
      const tops: number[] = [TOP1];
      for (let i = 1; i < L; i++) tops.push(tops[i - 1] + INK_BOT * fss[i - 1] - INK_TOP * fss[i]);

      const lns = slots.map((slot, i) => {
        const sagIdx = i === L - 1 ? sagStepFor(slot, tops[i], fss[i], offs[i], N) : -1;
        const sagCls = sagIdx >= 0 ? `sag${SAG_PIVOTS[side].key}${sagIdx + 1}` : '';
        const id = `b${N}s${i + 1}`;
        return `  <div class="ln" id="${id}" data-node-id="${id}" data-node-role="text" style="${side}:${p(offs[i])}px;top:${f(tops[i])}px;font-size:${p(fss[i])}px">${slotSpans(slot, gateEnd, sagCls)}</div>`;
      });

      return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${winMs}ms">
${lns.join('\n')}
</div>`;
    })
    .filter(Boolean);

  const pivots = Object.values(SAG_PIVOTS);
  const sagRules = pivots
    .flatMap(({ key, origin }) => SAG_DEG
      .map((_, i) => `  .sag${key}${i + 1} { transform-origin: ${origin}; animation-name: wSag${key}${i + 1};
           animation-timing-function: cubic-bezier(.4,0,.25,1); }`))
    .join('\n');
  const sagFrames = pivots
    .flatMap(({ key, sign }) => SAG_DEG
      .map((d, i) => `  @keyframes wSag${key}${i + 1} { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       ${SAG_LAND_PCT}% { opacity: 1; transform: rotate(0deg); }
                       ${SAG_PEAK_PCT}% { opacity: 1; transform: rotate(${sign * sagPeak(d)}deg); }
                       100% { opacity: 1; transform: rotate(${sign * d}deg); } }`))
    .join('\n');

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; }
  body { background: #0e060b; overflow: hidden; position: relative;
         font-family: "Lora", Georgia, "Times New Roman", serif; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; inset: 0; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* a slot = one absolutely positioned nowrap line of the scatter; side offset / top / font-size
     come inline per slot. line-height 1.35 is the prefab's own AND the descender headroom — never
     tighten it. The yellow ink is fattened by an 8-way same-ink text-shadow (the engine has no text
     stroke) — that is what carries the letterforms' weight, so it stays at full strength. The two dark
     layers under it only GROUND the ink over light footage and are pulled well back: tight offset,
     small blur, low alpha, so they read as contact, not as a second darker typeface. em units, so the
     whole shadow scales with the type and never with the canvas. */
  .ln { position: absolute; white-space: nowrap; line-height: 1.35; font-weight: 400;
        color: ${INK};
        text-shadow: 0.012em 0 0 ${INK}, -0.012em 0 0 ${INK},
                     0 0.012em 0 ${INK}, 0 -0.012em 0 ${INK},
                     0.0085em 0.0085em 0 ${INK}, -0.0085em 0.0085em 0 ${INK},
                     0.0085em -0.0085em 0 ${INK}, -0.0085em -0.0085em 0 ${INK},
                     0 0.018em 0.05em rgba(0,0,0,0.24), 0 0 0.14em rgba(0,0,0,0.18); }

  /* word span — the ANIMATED unit (the prefab reveals word by word); .wg is the inter-unit gap. */
  .w  { display: inline-block; opacity: 0; animation-name: wIn;
        animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .wg { margin-right: 0.3em; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); }
                   100% { opacity: 1; transform: none; } }

  /* the SAG — the beat's closing lone word, in the two mirrored families. .sagL* pins the word's
     bottom-LEFT corner (transform-origin 0 100%) and rotates POSITIVE, dropping the free right end;
     .sagR* pins the bottom-RIGHT corner (100% 100%) and rotates NEGATIVE, dropping the free left end.
     A beat takes the family matching its anchored edge, which alternates every beat, so the word never
     falls from the same corner twice running — and the sign always follows the corner, so the free end
     goes DOWN either way and never rises. Both land LEVEL at ${SAG_LAND_PCT}%, overshoot at ${SAG_PEAK_PCT}% and settle.
     One keyframes per angle per corner, rotation composed INSIDE the keyframe on the animating span
     itself — never a static transform on an ancestor of animating children. */
${sagRules}
${sagFrames}
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

const recipe: RecipeGenerator = { refId: 'hook-126 Comp 1-peak', generate };
export default recipe;
