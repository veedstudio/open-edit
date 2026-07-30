// Compiled recipe — hook-236-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// Stop-motion word scatter over full-bleed footage: lowercase Work Sans words pinned at slightly-rotated
// spots meandering down the canvas, each popping in with a chunky 4-snap scale jump on its own spoken
// timing, while a white-ringed orange dot hops word to word (the counter-accent). The prefab's
// steps(4, jump-end) pop is BAKED as plateau keyframes (the engine drops steps() ramps to a smooth
// ease; discrete keyframe plateaus render exactly — calibration-proved) and the dot hop is a pair of
// keyframes 40ms apart. Static rotation lives on the outer .word div, the pop on the inner .wi span;
// the dot's animated <i> sits inside a static high-z wrapper (the engine paints an element animating its
// own transform/opacity beneath static siblings).
// Non-ladder verify fixes (dot bounds → slot-table audit, never-visible → timing/class audit,
// occluded → window audit) are NOT automated — the runner only demotes ladders; those failures are
// reported honestly.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

interface SizeRow extends LadderRow { fs: number }

// sizing table — fs by slot phrase chars; accent = fs + 2 (the prefab's 44→46 bump)
const LADDER: SizeRow[] = [
  { cls: '', fs: 45, maxC: 12 },
  { cls: '', fs: 41, maxC: 16 },
  { cls: '', fs: 37, maxC: 20 },
  { cls: '', fs: 33, maxC: 24 },
  { cls: '', fs: 29, maxC: 28 },
  { cls: '', fs: 25, maxC: Infinity },
];

// Work Sans 400 lowercase advance: calibration-measured 0.51em/char average, wide glyphs (w/m) 0.88em
const CHAR_EM = 0.58;
const POP_MS = 140; // v5: 320 → 140 — the snap must read as a hit, not a fade (Anton)

// slots: the prefab meander, center-anchored. Set A = odd beats; Set B mirrors cx about 368, negates rot.
interface Slot { cx: number; top: number; rot: number }
const SET_A: Slot[] = [
  { cx: 243, top: 198, rot: 5 },
  { cx: 370, top: 306, rot: 8 },
  { cx: 522, top: 367, rot: -24 },
  { cx: 394, top: 516, rot: 0 },
  { cx: 340, top: 655, rot: -4 },
  { cx: 236, top: 744, rot: -6 },
  { cx: 342, top: 840, rot: -4 },
  { cx: 467, top: 969, rot: 0 },
];
const SET_B: Slot[] = SET_A.map((s) => ({ cx: 736 - s.cx, top: s.top, rot: -s.rot }));

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// strip ONE trailing `.` or `,`; keep ? ! ' and internal punctuation (10,000 stays whole)
export function stripWord(w: string): string {
  return w.replace(/[.,]$/, '');
}

// stripped + LOWERCASED in code (the prefab is lowercase — never text-transform) + VEED glue
export function unitsFor236(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const text = stripWord(w.w).toLowerCase();
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

// k = min(n, 8) slots, front-loaded unit counts; the run starts at slot 1 + floor((8−k)/2)
export function slotCounts236(n: number): number[] {
  const k = Math.min(n, 8);
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => (i < extra ? base + 1 : base));
}

export function slotStart236(k: number): number {
  return 1 + Math.floor((8 - k) / 2);
}

export function phrasesFor236(units: Unit[]): Unit[][] {
  const phrases: Unit[][] = [];
  let at = 0;
  for (const c of slotCounts236(units.length)) {
    phrases.push(units.slice(at, at + c));
    at += c;
  }
  return phrases;
}

export function sizeFor236(C: number, accent: boolean, demoteRows = 0): number {
  const row = pickRow(LADDER, C, demoteRows) as SizeRow;
  return row.fs + (accent ? 2 : 0);
}

// left = clamp(round(cx − w/2), 44, 655 − w) — wide phrases slide inboard off their anchor
export function placement236(slot: Slot, C: number, fs: number): { left: number; w: number } {
  const w = Math.round(C * CHAR_EM * fs);
  return { left: clamp(Math.round(slot.cx - w / 2), 44, Math.max(44, 655 - w)), w };
}

export function dotPos236(slot: Slot): { left: number; top: number } {
  // v3: the ball is 38px (×0.85) — recentred on the slot, same gap above the word
  return { left: clamp(slot.cx - 19, 47, 614), top: slot.top - 42 };
}

// pop compression: a late word still completes its snaps before the gate cuts it
// (floor 90ms — below that a 4-step snap stops reading at 25fps)
export function popMs236(cueEndMs: number, delayMs: number): number {
  return Math.min(POP_MS, Math.max(90, cueEndMs - delayMs));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Curation 2026-07-21: the ~40ms slide read as a teleport — the dot now BOUNCES word to word on a
// parabolic arc (ARC_H px above the chord, 3 mid keyframes; translate-only so the proven transform
// pipeline is untouched). Flight time per hop = min(HOP_MS, the actual gap to the landing word), so
// fast speech turns into a continuous bouncy chain instead of a lagging dot.
const HOP_MS = 260;
const ARC_H = 90;

// hop percents: f_K from slot K's first delay, clamped ≤99.5, monotonic by j+0.01, capped 99.99;
// h_K = this hop's flight width in % (h_0 = j, only used for the appearance fade window)
export function hopPcts236(firstDelays: number[], cueDelayMs: number, winMs: number): { f: number[]; j: number; h: number[] } {
  const j = round2(4000 / winMs);
  const f: number[] = [];
  for (let i = 0; i < firstDelays.length; i++) {
    let v = round2(((firstDelays[i] - cueDelayMs) / winMs) * 100);
    v = Math.min(v, 99.5);
    if (i > 0) v = Math.max(v, f[i - 1] + j + 0.01);
    f.push(Math.min(round2(v), 99.99));
  }
  const hopMax = round2((HOP_MS * 100) / winMs);
  const h = f.map((v, i) => (i === 0 ? j : round2(Math.min(hopMax, v - f[i - 1] - 0.01))));
  return { f, j, h };
}

const fmtPct = (n: number) => String(round2(n));

function dotKeyframes(N: number, phrases: Unit[][], slots: Slot[], cueDelayMs: number, winMs: number, p: (n: number) => number): string {
  const xy = slots.map((s) => dotPos236(s));
  const tr = (x: number, y: number) => `translate(${p(x)}px,${p(y)}px)`;
  const pos = xy.map((d) => tr(d.left, d.top));
  const { f, j, h } = hopPcts236(phrases.map((ph) => ph[0].spans[0].delayMs), cueDelayMs, winMs);
  const lines: string[] = [];
  if (f[0] <= j) {
    lines.push(`    0% { opacity:1; transform:${pos[0]}; }`);
  } else {
    lines.push(`    0% { opacity:0; transform:${pos[0]}; }`);
    lines.push(`    ${fmtPct(f[0] - j)}% { opacity:0; transform:${pos[0]}; }`);
    lines.push(`    ${fmtPct(f[0])}% { opacity:1; transform:${pos[0]}; }`);
  }
  for (let k = 1; k < f.length; k++) {
    const a = xy[k - 1];
    const b = xy[k];
    lines.push(`    ${fmtPct(f[k] - h[k])}% { opacity:1; transform:${pos[k - 1]}; }`);
    // parabolic bounce: peak ARC_H above the straight chord at mid-hop
    for (const t of [0.25, 0.5, 0.75]) {
      const x = a.left + (b.left - a.left) * t;
      const y = a.top + (b.top - a.top) * t - ARC_H * 4 * t * (1 - t);
      lines.push(`    ${fmtPct(f[k] - h[k] + h[k] * t)}% { opacity:1; transform:${tr(x, y)}; }`);
    }
    lines.push(`    ${fmtPct(f[k])}% { opacity:1; transform:${pos[k]}; }`);
    // v4: bouncy landing — a small ~10px rebound right after the touch-down, squeezed into
    // whatever window exists before the next hop starts (skipped when the chain is too fast)
    const next = k + 1 < f.length ? f[k + 1] - h[k + 1] : 99.99;
    const rw = Math.min(round2(14000 / winMs), round2(next - f[k] - 0.02));
    if (rw >= 0.3) {
      lines.push(`    ${fmtPct(f[k] + 0.45 * rw)}% { opacity:1; transform:${tr(b.left, b.top - 10)}; }`);
      lines.push(`    ${fmtPct(f[k] + rw)}% { opacity:1; transform:${pos[k]}; }`);
    }
  }
  const last = pos[pos.length - 1];
  if (f[f.length - 1] < 99.99) lines.push(`    100% { opacity:1; transform:${last}; }`);
  return `  @keyframes dm${N} {\n${lines.join('\n')}\n  }`;
}

function phraseHtml(ph: Unit[], cueEndMs: number): string {
  const out: string[] = [];
  ph.forEach((u, ui) => {
    u.spans.forEach((s, si) => {
      const gp = si === u.spans.length - 1 && ui < ph.length - 1;
      const d = popMs236(cueEndMs, s.delayMs);
      const dur = d < POP_MS ? `;animation-duration:${d}ms` : '';
      out.push(`<span class="wi${gp ? ' gp' : ''}" style="animation-delay:${s.delayMs}ms${dur}">${escapeHtml(s.text)}</span>`);
    });
  });
  return out.join('');
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 736, 1312);
  const p = pxScaler(scale);
  const pf = (n: number) => round2(n * scale); // fractional keyframe px stay unrounded
  const demote = opts.demote ?? {};

  const dotKfs: string[] = [];
  const cues = timings.beats.map((beat, idx) => {
    const units = unitsFor236(beat.words);
    if (!units.length) return '';
    const phrases = phrasesFor236(units);
    const set = beat.i % 2 === 1 ? SET_A : SET_B;
    const s = slotStart236(phrases.length);
    const slots = phrases.map((_, k) => set[s + k - 1]);
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const cueEnd = beat.cueDelayMs + winMs;
    const accentUnit = units[accentIndex(units)];

    const parts = phrases.map((ph, k) => {
      const slot = slots[k];
      const id = `b${beat.i}w${k + 1}`;
      const C = charsOf(ph);
      const fs = sizeFor236(C, ph.includes(accentUnit), demotionFor(demote, id));
      const { left } = placement236(slot, C, fs);
      return `  <div class="word" id="${id}" data-node-id="${id}" data-node-role="text"
       style="left:${p(left)}px; top:${p(slot.top)}px; font-size:${p(fs)}px; transform:rotate(${slot.rot}deg);">${phraseHtml(ph, cueEnd)}</div>`;
    });
    dotKfs.push(dotKeyframes(beat.i, phrases, slots, beat.cueDelayMs, winMs, p));
    parts.push(`  <div class="dot" id="b${beat.i}dot" data-node-id="b${beat.i}dot"><i style="animation:dm${beat.i} ${winMs}ms linear ${beat.cueDelayMs}ms both"></i></div>`);

    return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}"
     style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${parts.join('\n')}
</div>`;
  }).filter(Boolean);

  const wv = `<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${p(736)}px; height:${p(1312)}px; position:relative; overflow:hidden; margin:0;
         font-family:'Work Sans', Arial, Helvetica, sans-serif; background:#000; }
  .vid { position:absolute; inset:0; width:${p(736)}px; height:${p(1312)}px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }

  /* scattered word slot — static rotation on the OUTER div, pop on the inner span (the engine paints an
     element animating its own transform/opacity beneath static siblings — never merge the two) */
  /* v4: option B BAKED (art-directed pick) — white ink on a soft drop shadow */
  .word { position:absolute; display:inline-block; width:max-content; z-index:2;
          color:#ffffff; font-weight:600; line-height:1.3; white-space:nowrap;
          overflow:visible; transform-origin:center;
          text-shadow:0 ${p(1)}px ${p(3)}px rgba(0,0,0,0.35), 0 ${p(1)}px ${p(8)}px rgba(0,0,0,0.22); }

  /* the stop-motion pop — 4-step plateau snap (the engine drops stepped timing functions to a
     smooth ease; discrete keyframe plateaus render exactly). v5: the word is VISIBLE from the
     first frame after its delay (opacity jumps at 0.01%), so it lands exactly when the ball
     touches down; range tightened to 0.8→1 and the whole snap runs in ${POP_MS}ms (Anton:
     "очень динамичная анимация"). */
  .wi { display:inline-block; opacity:0; animation:wpop ${POP_MS}ms linear both; }
  .gp { margin-right:0.35em; } /* word gap — the margin IS the space (inter-span whitespace drops) */
  @keyframes wpop {
    0%            { opacity:0; transform:scale(0.8)  translateY(${pf(-3)}px); }
    0.01%,24.99%  { opacity:1; transform:scale(0.8)  translateY(${pf(-3)}px); }
    25%,49.99%    { opacity:1; transform:scale(0.87) translateY(${pf(-2)}px); }
    50%,74.99%    { opacity:1; transform:scale(0.94) translateY(${pf(-1)}px); }
    75%,99.99%    { opacity:1; transform:scale(0.98) translateY(0); }
    100%          { opacity:1; transform:scale(1)    translateY(0); }
  }

  /* the counter-accent dot: animated inner <i> inside a static high-z wrapper */
  .dot { position:absolute; inset:0; z-index:50; }
  .dot i { position:absolute; left:0; top:0; width:${p(38)}px; height:${p(38)}px; /* v3: ×0.85 */
           background:#db5404; border-radius:50%;
           box-shadow:0 0 0 ${p(3)}px rgba(255,255,255,0.6); opacity:0; }
${dotKfs.join('\n')}
</style>

<video class="vid" src="${meta.videoPath}" muted></video>

${cues.join('\n')}
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-236-peak', generate };
export default recipe;
