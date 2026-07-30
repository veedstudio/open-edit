// Compiled recipe — hook-054-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// Two-register caption: per beat the first 2–3 words ride a gold italic Cormorant accent arc (per-glyph
// rotation about the fixed crown centre 368/520, radius 325, dark 8-direction stroke), the remaining
// words land as a white Archivo payoff block in the lower third; both reveal within ONE cue and hold
// together until the gate cuts at the next beat. One hero word per beat: hot-amber on the arc (+`big`
// 1.32em when a digit token — DEVICE INTENSITY axis: standard), white 800 in the body.
// NOTE: only ladder demotions are automated — #b{N}k steps the arc down the distinct-FONT ladder
// (angles re-solved via the sheet's closed form), #b{N}l1/l2 step the payoff ladder. The sheet's
// non-ladder fixes (a drifted .pay top, never-visible/occluded checks) are NOT automated — the runner
// only demotes ladders; those FAILs are reported honestly. Anchors are fixed here, so they should not fire.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const R = 325; // crown radius (px, scales)
const BASE_IN_MS = 420; // wordIn/payIn entrance
const DUR_FLOOR_MS = 250;
const DEVICE_INTENSITY: 'standard' | 'calm' = 'standard';

// Section-3 arc table, verbatim: FONT per C (1..15) + the angle rows (degrees — NEVER scaled).
const ARC_ROW_FONT = [125, 125, 125, 125, 118, 118, 106, 106, 99, 99, 93, 90, 86, 83, 80];
const ARC_ANGLE_TABLE: string[][] = [
  ['0.00'],
  ['-6.61', '6.61'],
  ['-13.22', '0.00', '13.22'],
  ['-19.83', '-6.61', '6.61', '19.83'],
  ['-24.96', '-12.48', '0.00', '12.48', '24.96'],
  ['-31.20', '-18.72', '-6.24', '6.24', '18.72', '31.20'],
  ['-33.64', '-22.42', '-11.21', '0.00', '11.21', '22.42', '33.64'],
  ['-39.24', '-28.03', '-16.82', '-5.61', '5.61', '16.82', '28.03', '39.24'],
  ['-41.89', '-31.42', '-20.94', '-10.47', '0.00', '10.47', '20.94', '31.42', '41.89'],
  ['-47.12', '-36.65', '-26.18', '-15.71', '-5.24', '5.24', '15.71', '26.18', '36.65', '47.12'],
  ['-49.19', '-39.35', '-29.51', '-19.67', '-9.84', '0.00', '9.84', '19.67', '29.51', '39.35', '49.19'],
  ['-52.36', '-42.84', '-33.32', '-23.80', '-14.28', '-4.76', '4.76', '14.28', '23.80', '33.32', '42.84', '52.36'],
  ['-54.58', '-45.48', '-36.39', '-27.29', '-18.19', '-9.10', '0.00', '9.10', '18.19', '27.29', '36.39', '45.48', '54.58'],
  ['-57.07', '-48.29', '-39.51', '-30.73', '-21.95', '-13.17', '-4.39', '4.39', '13.17', '21.95', '30.73', '39.51', '48.29', '57.07'],
  ['-59.24', '-50.77', '-42.31', '-33.85', '-25.39', '-16.92', '-8.46', '0.00', '8.46', '16.92', '25.39', '33.85', '42.31', '50.77', '59.24'],
];
// Demotion ladder: the distinct FONTs, largest→smallest ("next smaller FONT + its ANGLE row").
export const ARC_FONT_LADDER = [125, 118, 106, 99, 93, 90, 86, 83, 80];

// Sheet closed form: angle(k) = (k − (C−1)/2) × step, step(deg) = 0.60·FONT·(180/π) ÷ 325.
export function arcStepDeg(font: number): number {
  return (0.6 * font * (180 / Math.PI)) / R;
}
export function arcAngles(C: number, font: number): string[] {
  const step = arcStepDeg(font);
  return Array.from({ length: C }, (_, k) => ((k - (C - 1) / 2) * step).toFixed(2));
}
// Base row = the table verbatim (C>15 keeps FONT=80 with the C=15 step); demoted rows re-solve angles.
export function arcRow(C: number, demote = 0): { font: number; angles: string[] } {
  const base = ARC_FONT_LADDER.indexOf(ARC_ROW_FONT[Math.min(C, 15) - 1]);
  const font = ARC_FONT_LADDER[Math.min(ARC_FONT_LADDER.length - 1, base + demote)];
  if (!demote && C <= 15) return { font, angles: ARC_ANGLE_TABLE[C - 1] };
  return { font, angles: arcAngles(C, font) };
}

// PAYOFF ladder (both lines share the ONE class, sized by the longest line's C).
const BODY_LADDER = [
  { cls: 'p54', maxC: 18 }, { cls: 'p52', maxC: 19 }, { cls: 'p50', maxC: 20 }, { cls: 'p47', maxC: 21 },
  { cls: 'p45', maxC: 22 }, { cls: 'p43', maxC: 23 }, { cls: 'p41', maxC: 24 }, { cls: 'p40', maxC: 25 },
  { cls: 'p38', maxC: 26 }, { cls: 'p37', maxC: 27 }, { cls: 'p35', maxC: 29 }, { cls: 'p33', maxC: 31 },
  { cls: 'p31', maxC: 33 }, { cls: 'p29', maxC: 35 }, { cls: 'p27', maxC: Infinity },
];

// Word prep: ORIGINAL case + punctuation; a leading-`-` token glues to the previous word as ONE unit
// (each half keeps its own delayMs).
export function toUnits054(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const prev = units[units.length - 1];
    if (w.w.startsWith('-') && prev) {
      prev.spans.push({ text: w.w, delayMs: w.delayMs });
      prev.chars += w.w.length;
    } else {
      units.push({ spans: [{ text: w.w, delayMs: w.delayMs }], chars: w.w.length });
    }
  }
  return units;
}

const unitText = (u: Unit) => u.spans.map((s) => s.text).join('');

// Accent = first k words, k = min(3, ceil(n/2)); n=1 → accent only (body empty, omit .pay).
export function accentCount054(n: number): number {
  return n <= 1 ? n : Math.min(3, Math.ceil(n / 2));
}

// Hero: first digit-bearing token, else most LETTERS (a–z, punctuation ignored), tie → later.
export function heroIndex054(units: Unit[]): number {
  const digit = units.findIndex((u) => /\d/.test(unitText(u)));
  if (digit >= 0) return digit;
  const letters = (u: Unit) => (unitText(u).match(/[a-zA-Z]/g) ?? []).length;
  let best = 0;
  for (let i = 1; i < units.length; i++) if (letters(units[i]) >= letters(units[best])) best = i;
  return best;
}

// Gate-compress: delay + 420 > gateClose → inline duration max(gateClose − delay, 250); else none.
export function gateDur054(delayMs: number, gateCloseMs: number): number | null {
  return delayMs + BASE_IN_MS > gateCloseMs ? Math.max(gateCloseMs - delayMs, DUR_FLOOR_MS) : null;
}

// Accent character stream: words joined by ONE space (a glued unit's halves are adjacent, no space);
// unit: -1 marks the bare space slots (no inner .w).
export interface ArcChar { ch: string; delayMs: number | null; unit: number }
export function arcChars054(accent: Unit[]): ArcChar[] {
  const out: ArcChar[] = [];
  accent.forEach((u, ui) => {
    if (ui) out.push({ ch: ' ', delayMs: null, unit: -1 });
    for (const s of u.spans) for (const ch of s.text) out.push({ ch, delayMs: s.delayMs, unit: ui });
  });
  return out;
}

// Body counting: strip ONE trailing `.` or `,`; keep ? ! ' - and internal commas (10,000 = 6).
export function bodyLen(text: string): number {
  return text.replace(/[.,]$/, '').length;
}
export function lineC(units: Unit[]): number {
  return units.reduce((s, u) => s + bodyLen(unitText(u)), 0) + Math.max(0, units.length - 1);
}
// C_tot ≤ 20 → 1 line; else the greedy half-walk (line 1 always keeps ≥ its first word).
export function bodyLines(units: Unit[]): [Unit[], Unit[] | null] {
  const cTot = lineC(units);
  if (cTot <= 20) return [units, null];
  const half = Math.ceil(cTot / 2);
  const l1: Unit[] = [];
  let running = 0;
  let i = 0;
  for (; i < units.length; i++) {
    const add = bodyLen(unitText(units[i])) + (l1.length ? 1 : 0);
    if (l1.length && running + add > half) break;
    l1.push(units[i]);
    running += add;
  }
  return [l1, units.slice(i)];
}

function arcHtml(beatN: number, accent: Unit[], heroIdx: number, heroDigit: boolean, gateClose: number,
                 demote: Record<string, number>, p: (n: number) => number): string {
  const chars = arcChars054(accent);
  const { font, angles } = arcRow(chars.length, demotionFor(demote, `b${beatN}k`));
  const spans = chars.map((c, i) => {
    const id = `b${beatN}a${i}`;
    const tf = `transform:translate(-50%,-50%) rotate(${angles[i]}deg) translateY(-${p(R)}px);transform-origin:50% 50%`;
    if (c.delayMs === null) return `    <span class="arc-char" data-node-id="${id}" style="${tf}"> </span>`;
    const hero = c.unit === heroIdx;
    const cls = hero ? `arc-char hero${heroDigit && DEVICE_INTENSITY === 'standard' ? ' big' : ''}` : 'arc-char';
    const dur = gateDur054(c.delayMs, gateClose);
    const wStyle = `animation-delay:${c.delayMs}ms${dur === null ? '' : `; animation-duration:${dur}ms`}`;
    return `    <span class="${cls}" data-node-id="${id}" data-node-role="text" style="${tf}"><span class="w" style="${wStyle}">${escapeHtml(c.ch)}</span></span>`;
  });
  return `  <div class="arc" id="b${beatN}k" data-node-id="b${beatN}k" style="font-size:${p(font)}px">\n${spans.join('\n')}\n  </div>`;
}

function pwHtml(u: Unit, hero: boolean, gateClose: number): string {
  return u.spans
    .map((s, i) => {
      const parts = [`animation-delay:${s.delayMs}ms`];
      const dur = gateDur054(s.delayMs, gateClose);
      if (dur !== null) parts.push(`animation-duration:${dur}ms`);
      // glued unit: facing gap zeroed
      if (u.spans.length > 1 && i < u.spans.length - 1) parts.push('margin-right:0');
      if (u.spans.length > 1 && i > 0) parts.push('margin-left:0');
      return `<span class="${hero ? 'pw hero' : 'pw'}" style="${parts.join('; ')}">${escapeHtml(s.text)}</span>`;
    })
    .join('');
}

function payHtml(beatN: number, body: Unit[], heroIdx: number, gateClose: number, demote: Record<string, number>): string {
  const [l1, l2] = bodyLines(body);
  const C = Math.max(lineC(l1), l2 ? lineC(l2) : 0);
  const row = pickRow(BODY_LADDER, C, demotionFor(demote, `b${beatN}l1`, `b${beatN}l2`));
  const line = (units: Unit[], L: number, offset: number) => {
    const id = `b${beatN}l${L}`;
    const spans = units.map((u, i) => pwHtml(u, offset + i === heroIdx, gateClose)).join('');
    return `    <div class="payline ${row.cls}" id="${id}" data-node-id="${id}" data-node-role="text">${spans}</div>`;
  };
  const lines = [line(l1, 1, 0)];
  if (l2) lines.push(line(l2, 2, l1.length));
  return `  <div class="pay" id="b${beatN}p" data-node-id="b${beatN}p">\n${lines.join('\n')}\n  </div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 736, 1312);
  const p = pxScaler(scale);
  const f = (n: number) => n * scale; // fractional px: scale-multiplied, unrounded (SCALE=1 → verbatim)
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) => {
      const units = toUnits054(beat.words);
      if (!units.length) return '';
      const winMs = winMsFor(timings.beats, idx, meta.durationSec);
      const gateClose = beat.cueDelayMs + winMs;
      const k = accentCount054(units.length);
      const hero = heroIndex054(units);
      const heroDigit = /\d/.test(unitText(units[hero]));
      const parts = [arcHtml(beat.i, units.slice(0, k), hero < k ? hero : -1, heroDigit, gateClose, demote, p)];
      if (units.length > k) parts.push(payHtml(beat.i, units.slice(k), hero >= k ? hero - k : -1, gateClose, demote));
      return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}" style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms">\n${parts.join('\n')}\n</div>`;
    })
    .filter(Boolean);

  const wv = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Cormorant+Garamond:ital,wght@1,600;1,700&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; overflow: hidden; }
  body { position: relative; background: #000; font-family: "Cormorant Garamond", Georgia, serif; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* cue gate — opacity-only (never a transform ancestor over animated words); hard cut at the successor */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; pointer-events: none;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* ARC: gold Cormorant italic accent crown; font-size inline on .arc, inherited by the arc-chars */
  .arc { position: absolute; inset: 0; }
  .arc-char { position: absolute; left: ${p(368)}px; top: ${p(520)}px;
    font-style: italic; font-weight: 700; line-height: 1; color: #e9bd2b; white-space: pre;
    text-shadow:
      -${p(1)}px -${p(1)}px 0 #15100a, ${p(1)}px -${p(1)}px 0 #15100a, -${p(1)}px ${p(1)}px 0 #15100a, ${p(1)}px ${p(1)}px 0 #15100a,
      0 -${f(1.7)}px 0 #15100a, 0 ${f(1.7)}px 0 #15100a, -${f(1.7)}px 0 0 #15100a, ${f(1.7)}px 0 0 #15100a; }
  .arc-char.hero { color: #e89a1c; }
  .arc-char.big  { font-size: 1.32em; }

  /* arc word reveal — on an INNER span only; the glyph's static arc transform is untouched */
  .w { display: inline-block; opacity: 0; padding: 0.1em 0 0.18em;
       animation: wordIn .42s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes wordIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: translateY(0); } }

  /* BODY: clean white Archivo payoff (lower third) */
  .pay { position: absolute; left: ${p(68)}px; top: ${p(852)}px; width: ${p(600)}px; }
  .payline { display: block; width: ${p(600)}px; text-align: center; white-space: nowrap; line-height: 1.0;
             font-family: 'Archivo', system-ui, sans-serif; font-weight: 700; letter-spacing: ${f(-0.5)}px; color: #f7f5f3;
             text-shadow: 0 ${p(2)}px ${p(7)}px rgba(0,0,0,.6), 0 0 ${p(3)}px rgba(0,0,0,.55); }
  .pw { display: inline-block; opacity: 0; margin-right: 0.24em;
        animation: payIn .42s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes payIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: translateY(0); } }
  .pw.hero { color: #ffffff; font-weight: 800; }

  /* PAYOFF size ladder (class names keep the original ladder's px for lookup) */
  .p54 { font-size: ${p(43)}px; } .p52 { font-size: ${p(42)}px; } .p50 { font-size: ${p(40)}px; } .p47 { font-size: ${p(38)}px; }
  .p45 { font-size: ${p(36)}px; } .p43 { font-size: ${p(34)}px; } .p41 { font-size: ${p(33)}px; } .p40 { font-size: ${p(32)}px; }
  .p38 { font-size: ${p(30)}px; } .p37 { font-size: ${p(30)}px; } .p35 { font-size: ${p(28)}px; } .p33 { font-size: ${p(26)}px; }
  .p31 { font-size: ${p(25)}px; } .p29 { font-size: ${p(23)}px; } .p27 { font-size: ${p(22)}px; }
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

const recipe: RecipeGenerator = { refId: 'hook-054-peak', generate };
export default recipe;
