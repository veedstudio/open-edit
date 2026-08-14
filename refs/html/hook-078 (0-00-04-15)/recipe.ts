// Compiled recipe — hook-078 (0-00-04-15) · neon movie-poster credits (9:16, authored at 736×1312 @25fps).
// Source sheet: ./recipe.md. Fixed Oswald credits chrome (kickers, laurel badges, subtitle, credit rows,
// logos) revealed once at clip start; the spoken beat is a monumental Staatliches title whose chars
// strike on per-CHAR like a neon tube on their real word timings. Ignite is opacity-ONLY: the one
// animated filter measured on this engine, blur, holds its initial value (probe: animated-blur-holds)
// and an animated drop-shadow was never probed, so the glow lives in the
// static 3-layer text-shadow (2 yellow neon + 1 dark grounding for light footage). The 12-role system:
// 11 chrome roles are fixed dressing on a one-time 150ms-cadence reveal wave; role 7 (title-char) is the
// only transcript-driven role — every spoken char, no exceptions. Emphasis is STRUCTURAL (the beat IS
// the title).
// NOT automated (report-only, the runner only demotes named ids): the sheet's never-visible/occluded
// checks stay manual per the verify loop.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const LADDER: LadderRow[] = [
  { cls: 's94', maxC: 12 },
  { cls: 's84', maxC: 14 },
  { cls: 's76', maxC: 15 },
  { cls: 's68', maxC: 17 },
  { cls: 's62', maxC: 19 },
  { cls: 's56', maxC: 21 },
  { cls: 's50', maxC: 23 },
  { cls: 's45', maxC: 26 },
  { cls: 's40', maxC: 29 },
  { cls: 's36', maxC: 33 },
  { cls: 's32', maxC: 37 },
  { cls: 's28', maxC: Infinity },
];
// height caps: the first ladder row a beat with L lines may use (keeps the stack above the subtitle chrome)
const L_CAP_ROW: Record<number, number> = { 1: 0, 2: 0, 3: 2, 4: 5 };
const K_MAIN = 65;
const K_TIGHT = 30;
const IGNITE_MS = 550;
const DUR_FLOOR_MS = 250;

// ---- the 9-role system (reversed from the prefab; curation 2026-07-21 cut the bottom brand logos —
// JBO + prima video + smile — so logo-word / logo-script / smile-panel are gone) ----
export type Role078 =
  | 'kicker-left' | 'kicker-right' | 'laurel-panel' | 'laurel-label' | 'joint'
  | 'title-char' | 'subtitle' | 'credit-seg';

// Chrome reveal wave (ms, one-time at clip start; prefab order + 150ms cadence). title-char is the only
// transcript-driven role: null here — its timing is charDelays078 off the real word delays.
export const ROLE_FADE_MS_078: Record<Role078, number | null> = {
  'kicker-left': 0, 'kicker-right': 0,
  'laurel-panel': 150, 'laurel-label': 150, joint: 150,
  'title-char': null,
  subtitle: 300, 'credit-seg': 450,
};

// Role assignment is total and deterministic by node id — spoken content only ever lands in b{N}l{k}.
export function roleFor078(nodeId: string): Role078 {
  if (nodeId === 'tagl') return 'kicker-left';
  if (nodeId === 'tagr') return 'kicker-right';
  if (/^lp\d$/.test(nodeId)) return 'laurel-panel';
  if (/^lbl\d$/.test(nodeId)) return 'laurel-label';
  if (nodeId === 'joint') return 'joint';
  if (/^b\d+l\d$/.test(nodeId)) return 'title-char';
  if (nodeId === 'subtitle') return 'subtitle';
  if (/^seg\d$/.test(nodeId)) return 'credit-seg';
  throw new Error(`hook-078 (0-00-04-15): no role for node id "${nodeId}"`);
}

// ---- title assembly ----
export function lineCount078(n: number): number {
  if (n <= 2) return 1;
  if (n <= 6) return 2;
  if (n <= 11) return 3;
  return 4;
}

// Closed-form L-way split: cut k at the unit boundary whose cumulative rendered chars is closest to
// k·total/L (tie → earlier); each cut leaves ≥1 unit per remaining line. Never reorder.
export function splitLines078(units: Unit[], L: number): Unit[][] {
  const n = units.length;
  const Leff = Math.max(1, Math.min(L, n));
  if (Leff === 1) return [units];
  const total = charsOf(units);
  const cuts: number[] = [];
  let prev = 0;
  for (let k = 1; k < Leff; k++) {
    const target = (k * total) / Leff;
    let best = prev + 1;
    let bestD = Infinity;
    for (let c = prev + 1; c <= n - (Leff - k); c++) {
      const d = Math.abs(charsOf(units.slice(0, c)) - target);
      if (d < bestD) { best = c; bestD = d; } // strict < : earlier boundary wins ties
    }
    cuts.push(best);
    prev = best;
  }
  const lines: Unit[][] = [];
  let s = 0;
  for (const c of cuts) { lines.push(units.slice(s, c)); s = c; }
  lines.push(units.slice(s));
  return lines;
}

// Size row: first row fitting C at or below the height cap for L lines, then demotion steps down.
export function rowFor078(C: number, L: number, demoteRows = 0): LadderRow {
  return pickRow(LADDER.slice(L_CAP_ROW[L] ?? 0), C, demoteRows);
}

// Char stagger, ONE guard per span: K=65 (the prefab's cadence) unless the run + full flicker would
// overrun the gate, then K=30 (if 30 still overruns, keep 30 — the mid-flicker cut is accepted).
export function charK078(delayMs: number, charCount: number, gateEndMs: number): number {
  return delayMs + (charCount - 1) * K_MAIN + IGNITE_MS > gateEndMs ? K_TIGHT : K_MAIN;
}

// End-of-beat compression: a char whose flicker would still be guttering at gate close gets a shortened
// inline ignite so it is fully lit before the cut; null = the skeleton's .55s applies.
export function compressDurMs078(delayMs: number, gateEndMs: number): number | null {
  return delayMs + IGNITE_MS > gateEndMs ? Math.max(gateEndMs - delayMs, DUR_FLOOR_MS) : null;
}

// One .ch span per character; a glued unit is one continuous char run (each span keeps its verbatim
// delay base). The unit's last char carries the word gap (class gp + trailing &#160;) unless line-final.
function unitCharSpans(unit: Unit, gateEndMs: number, lineFinal: boolean): string {
  const out: string[] = [];
  unit.spans.forEach((span, si) => {
    const chars = [...span.text];
    const K = charK078(span.delayMs, chars.length, gateEndMs);
    chars.forEach((c, i) => {
      const gap = !lineFinal && si === unit.spans.length - 1 && i === chars.length - 1;
      const d = span.delayMs + i * K;
      const dur = compressDurMs078(d, gateEndMs);
      let style = `animation-delay:${d}ms`;
      if (dur !== null) style += `; animation-duration:${dur}ms`;
      out.push(`<span class="${gap ? 'ch gp' : 'ch'}" style="${style}">${escapeHtml(c)}${gap ? '&#160;' : ''}</span>`);
    });
  });
  return out.join('');
}

function lineHtml(units: Unit[], id: string, sizeCls: string, tight: boolean, gateEndMs: number): string {
  const spans = units.map((u, i) => unitCharSpans(u, gateEndMs, i === units.length - 1)).join('');
  const cls = `tl ${sizeCls}${tight ? ' tn' : ''}`;
  return `  <div class="${cls}" id="${id}" data-node-id="${id}" data-node-role="text">${spans}</div>`;
}

// v3: the title block is anchored by its BOTTOM edge — a fixed SUB_GAP to the subtitle chrome at
// SUB_TOP, whatever the line count (fewer lines → more actor visible; 3 lines just start higher).
const SUB_TOP = 989;
const SUB_GAP = 56;
const LINE_PITCH_EM = 0.55; // v3 leading (was 0.82 — Anton: minus a third)

export function cueTop078(fs: number, L: number): number {
  // +0.13em per line beyond 2: measured on renders — the ideal-box model under-counts tall stacks,
  // which left 3-line beats ~10px closer to the INSPIRED chrome than 2-line beats
  return SUB_TOP - SUB_GAP - fs * (1 + LINE_PITCH_EM * (L - 1) + 0.13 * Math.max(0, L - 2));
}

function cueHtml(p: (n: number) => number, beatN: number, cueDelayMs: number, winMs: number, units: Unit[], demote: Record<string, number>): string {
  const gateEnd = cueDelayMs + winMs;
  const lines = splitLines078(units, lineCount078(units.length));
  const C = Math.max(...lines.map(charsOf));
  const row = rowFor078(C, lines.length, demotionFor(demote, `b${beatN}l1`, `b${beatN}l2`, `b${beatN}l3`, `b${beatN}l4`));
  const body = lines.map((ln, k) => lineHtml(ln, `b${beatN}l${k + 1}`, row.cls, k > 0, gateEnd)).join('\n');
  return `<div class="cue" id="cue${beatN}" data-node-id="cue${beatN}"
     style="top:${p(cueTop078(Number(row.cls.slice(1)), lines.length))}px; z-index:${10 + beatN}; animation-delay:${cueDelayMs}ms; animation-duration:${winMs}ms">
${body}
</div>`;
}

// Laurel wreath + smile — CSS clip-path panels copied verbatim from the prefab (percent-based, no rescale).
const LAUREL_A = 'polygon(51.1% 94.1%, 48.3% 91.5%, 45.8% 88.9%, 43.3% 86.1%, 41.0% 83.1%, 38.8% 80.1%, 36.8% 76.9%, 34.9% 73.6%, 33.2% 70.2%, 31.7% 66.7%, 13.0% 57.8%, 15.5% 55.6%, 30.2% 63.0%, 29.0% 59.3%, 27.9% 55.4%, 27.0% 51.4%, 11.0% 40.0%, 13.5% 37.8%, 26.2% 47.3%, 25.6% 43.1%, 25.2% 38.8%, 24.9% 34.4%, 14.0% 23.3%, 16.5% 21.1%, 24.8% 29.9%, 24.9% 25.3%, 25.2% 20.6%, 25.7% 15.8%, 24.0% 13.9%, 22.3% 15.4%, 21.8% 20.3%, 21.5% 25.1%, 21.4% 29.9%, 21.5% 34.6%, 34.0% 15.6%, 32.5% 18.3%, 21.8% 39.1%, 22.2% 43.6%, 22.8% 48.0%, 31.0% 32.2%, 29.5% 35.0%, 23.6% 52.3%, 24.6% 56.4%, 25.8% 60.5%, 27.1% 64.4%, 28.6% 68.2%, 32.0% 48.9%, 30.5% 51.7%, 30.2% 71.9%, 32.0% 75.5%, 34.0% 79.0%, 36.1% 82.3%, 38.4% 85.5%, 40.8% 88.6%, 43.4% 91.6%, 46.1% 94.4%, 48.9% 97.0%)';
const LAUREL_B = 'polygon(48.9% 94.1%, 51.7% 91.5%, 54.2% 88.9%, 56.7% 86.1%, 59.0% 83.1%, 61.2% 80.1%, 63.2% 76.9%, 65.1% 73.6%, 66.8% 70.2%, 68.3% 66.7%, 87.0% 57.8%, 84.5% 55.6%, 69.8% 63.0%, 71.0% 59.3%, 72.1% 55.4%, 73.0% 51.4%, 89.0% 40.0%, 86.5% 37.8%, 73.8% 47.3%, 74.4% 43.1%, 74.8% 38.8%, 75.1% 34.4%, 86.0% 23.3%, 83.5% 21.1%, 75.2% 29.9%, 75.1% 25.3%, 74.8% 20.6%, 74.3% 15.8%, 76.0% 13.9%, 77.7% 15.4%, 78.2% 20.3%, 78.5% 25.1%, 78.6% 29.9%, 78.5% 34.6%, 66.0% 15.6%, 67.5% 18.3%, 78.2% 39.1%, 77.8% 43.6%, 77.2% 48.0%, 69.0% 32.2%, 70.5% 35.0%, 76.4% 52.3%, 75.4% 56.4%, 74.2% 60.5%, 72.9% 64.4%, 71.4% 68.2%, 68.0% 48.9%, 69.5% 51.7%, 69.8% 71.9%, 68.0% 75.5%, 66.0% 79.0%, 63.9% 82.3%, 61.6% 85.5%, 59.2% 88.6%, 56.6% 91.6%, 53.9% 94.4%, 51.1% 97.0%)';

function laurelHtml(side: 'l' | 'r', lpA: string, lpB: string, lblId: string, lblLine2: string): string {
  const d = ROLE_FADE_MS_078['laurel-panel'];
  return `    <div id="laurel-${side}" class="laurel" data-node-id="laurel-${side}" data-node-role="icon">
      <div class="lp fader" id="${lpA}" style="animation-delay:${d}ms; clip-path: ${LAUREL_A}"></div>
      <div class="lp fader" id="${lpB}" style="animation-delay:${d}ms; clip-path: ${LAUREL_B}"></div>
      <div class="lbl y fader" id="${lblId}" style="animation-delay:${d}ms"><div>BEST</div><div>${lblLine2}</div></div>
    </div>`;
}

function seg(id: string, plain: string, bold: string): string {
  return `<span class="seg fader" id="${id}" style="animation-delay:${ROLE_FADE_MS_078['credit-seg']}ms">${plain} <b class="cb">${bold}</b></span>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, i) => beat.words.length
      ? cueHtml(p, beat.i, beat.cueDelayMs, winMsFor(timings.beats, i, meta.durationSec), toUnits(beat.words), demote)
      : '')
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Staatliches&family=Oswald:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; background: #000; overflow: hidden; }
  body { position: relative; font-family: 'Oswald', sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* poster chrome — fixed dressing, one reveal wave at clip start, persistent for the whole video */
  .y { color: #fff402; }
  .glow { text-shadow: 0 0 ${p(14)}px rgba(255,225,0,.55), 0 0 ${p(4)}px rgba(255,225,0,.7), 0 ${p(2)}px ${p(12)}px rgba(0,0,0,.7); }
  .fader { opacity: 0; animation: fadeon .45s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes fadeon { from { opacity: 0; } to { opacity: 1; } }

  #tagl { position: absolute; z-index: 2; left: ${p(87)}px; top: ${p(61)}px; font-weight: 700; font-size: ${p(18)}px; letter-spacing: ${p(2)}px; }
  #tagr { position: absolute; z-index: 2; right: ${p(61)}px; top: ${p(61)}px; font-weight: 700; font-size: ${p(18)}px; letter-spacing: ${p(2)}px; }

  /* curation 2026-07-21: joint row rises 393→225; the whole spoken block (cue title + subtitle +
     credits) drops +206 as one unit (relative spacing untouched); bottom brand logos removed */
  #joint-row { position: absolute; z-index: 2; left: 0; top: ${p(225)}px; width: ${p(736)}px; height: ${p(65)}px; }
  /* v4: A CREATOR! JOINT is ONE plain text entity — one font, one size, one baseline
     (the three-span mixed-face version read as a broken line) */
  #joint { position: absolute; top: ${p(4)}px; left: 0; width: ${p(736)}px; text-align: center;
           font-weight: 700; font-size: ${p(27)}px; letter-spacing: ${p(4)}px; }
  .laurel { position: absolute; top: 0; width: ${p(78)}px; height: ${p(65)}px; }
  #laurel-l { left: ${p(63)}px; }
  #laurel-r { left: ${p(595)}px; }
  .lp { position: absolute; left: 0; top: 0; width: ${p(78)}px; height: ${p(65)}px; background: #fff402; z-index: 1; }
  .lbl { position: absolute; left: 0; top: 0; width: ${p(78)}px; height: ${p(65)}px; z-index: 2;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         font-size: ${p(9)}px; font-weight: 700; line-height: 1.05; letter-spacing: .5px; }

  #subtitle-row { position: absolute; z-index: 2; left: 0; top: ${p(989)}px; width: ${p(736)}px; text-align: center; }
  #subtitle { display: inline-block; font-weight: 700; font-size: ${p(21)}px; letter-spacing: ${p(2)}px; }

  #credits { position: absolute; z-index: 2; left: 0; top: ${p(1070)}px; width: ${p(736)}px;
             display: flex; flex-direction: column; align-items: center; gap: ${p(9)}px; }
  .crow { display: flex; gap: ${p(17)}px; justify-content: center; font-size: ${p(19)}px; font-weight: 400; letter-spacing: .5px; }
  .seg { position: relative; z-index: 2; white-space: nowrap; }
  .cb { font-weight: 700; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: ${p(81)}px; width: ${p(574)}px; opacity: 0; /* top inline per beat (bottom-anchored) */
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* title line — full-width block, ink centered by text-align (never shrink-to-fit flex);
     skew baked static per line; glow = 2 yellow neon layers + 1 dark grounding layer */
  .tl { display: block; width: ${p(574)}px; text-align: center; white-space: nowrap;
        font-family: 'Staatliches', sans-serif; font-weight: 400; line-height: 1; letter-spacing: 0;
        color: #fff402; transform: skewX(-3deg);
        text-shadow: 0 0 ${p(14)}px rgba(255,225,0,.55), 0 0 ${p(4)}px rgba(255,225,0,.7), 0 ${p(2)}px ${p(12)}px rgba(0,0,0,.7); }
  .tn { margin-top: -0.45em; } /* lines 2..L — v3 leading, a third tighter than the prefab's 0.82em pitch */

  /* size ladder (picked by the sheet's table only — width and height budgets baked in) */
  .s94{font-size:${p(94)}px} .s84{font-size:${p(84)}px} .s76{font-size:${p(76)}px} .s68{font-size:${p(68)}px}
  .s62{font-size:${p(62)}px} .s56{font-size:${p(56)}px} .s50{font-size:${p(50)}px} .s45{font-size:${p(45)}px}
  .s40{font-size:${p(40)}px} .s36{font-size:${p(36)}px} .s32{font-size:${p(32)}px} .s28{font-size:${p(28)}px}

  /* per-char neon ignition — opacity gutters then holds lit. OPACITY ONLY (no filter).
     The vertical padding is descender headroom for the animating span's raster box. */
  @keyframes ignite { 0%{opacity:0} 10%{opacity:.9} 20%{opacity:.08} 34%{opacity:.7}
                      46%{opacity:.2} 62%{opacity:1} 100%{opacity:1} }
  .ch { display: inline-block; opacity: 0; padding-top: 0.08em; padding-bottom: 0.16em;
        animation: ignite .55s linear both; }
  .gp { margin-right: 0.32em; }
</style>
</head>
<body>
  <video class="vid" src="${meta.videoPath}" muted></video>

  <div id="tagl" class="y glow fader" style="animation-delay:${ROLE_FADE_MS_078['kicker-left']}ms" data-node-id="tagl" data-node-role="text">THE INTERNET</div>
  <div id="tagr" class="y glow fader" style="animation-delay:${ROLE_FADE_MS_078['kicker-right']}ms" data-node-id="tagr" data-node-role="text">PRESENTS</div>

  <div id="joint-row">
${laurelHtml('l', 'lp1', 'lp2', 'lbl1', 'PICTURE')}
    <div id="joint" class="y glow fader" style="animation-delay:${ROLE_FADE_MS_078.joint}ms" data-node-id="joint" data-node-role="text">A CREATOR! JOINT</div>
${laurelHtml('r', 'lp3', 'lp4', 'lbl2', 'ACT')}
  </div>

  <div id="subtitle-row" class="fader" style="animation-delay:${ROLE_FADE_MS_078.subtitle}ms">
    <div id="subtitle" class="y glow" data-node-id="subtitle" data-node-role="text">INSPIRED BY ACTUAL EVENTS</div>
  </div>

  <div id="credits" class="glow" data-node-id="credits">
    <div class="crow y" data-node-id="credit-row1" data-node-role="text">${seg('seg1', 'Directed By', 'THE ALGORITHM')}${seg('seg2', 'Camera By', 'A TRIPOD')}${seg('seg3', 'Audio By', 'THE MIC')}</div>
    <div class="crow y" data-node-id="credit-row2" data-node-role="text">${seg('seg4', 'Script By', 'NO ONE')}${seg('seg5', 'Editor By', 'CAFFEINE')}${seg('seg6', 'Art Director By', 'VIBES')}</div>
    <div class="crow y" data-node-id="credit-row3" data-node-role="text">${seg('seg7', 'Stylish By', 'DEFAULT')}${seg('seg8', 'VFX By', 'NONE, SORRY')}</div>
  </div>

${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-078 (0-00-04-15)', generate };
export default recipe;
