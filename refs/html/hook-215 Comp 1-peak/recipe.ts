// Compiled recipe — hook-215 Comp 1-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// A clean-sans colour-story card: the footage plays inside a fixed window cut into a flat paper-cream
// mat that hard-flips to royal blue at beat K2, then signal red at beat K3; below the window, short
// Bricolage-Grotesque-ExtraBold phrases (soft 1.5px blur edge) pop in one at a time at a single
// anchor — rise in, hold, rise out — blue ink before the first flip, cream ink from it on. Timing is
// PAGE-level (whole-phrase pops, no per-word spans); emphasis is GLOBAL (the mat flips), never per-word.
// NOT automated (report-only, sheet §6): the second-failure blur removal (left/right overshoot ≤ 4px →
// delete the .ln blur line) and the top:960 restore — the runner's only mechanical lever is the ladder
// demote, keyed by the page id (b{N}p{P}).
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// sheet §3 table — pick by the page's char count (words joined with single spaces, punctuation kept)
const LADDER = [
  { cls: 's96', maxC: 11 }, { cls: 's89', maxC: 12 }, { cls: 's82', maxC: 13 },
  { cls: 's77', maxC: 14 }, { cls: 's71', maxC: 15 }, { cls: 's67', maxC: 16 },
  { cls: 's63', maxC: 17 }, { cls: 's59', maxC: 18 }, { cls: 's56', maxC: 19 },
  { cls: 's53', maxC: 20 }, { cls: 's51', maxC: 21 }, { cls: 's49', maxC: 22 },
  { cls: 's46', maxC: 23 }, { cls: 's44', maxC: 24 }, { cls: 's43', maxC: 25 },
  { cls: 's38', maxC: Infinity },
];
const DUR_FLOOR_MS = 450;
const HOLD_DUR_MS = 800;

// n words → ceil(n/3) pages of near-equal consecutive runs, longer pages first (n=8 → 3,3,2).
export function paginate215(words: WordTiming[]): WordTiming[][] {
  const n = words.length;
  if (!n) return [];
  const P = Math.ceil(n / 3);
  const base = Math.floor(n / P);
  const extra = n % P;
  const pages: WordTiming[][] = [];
  let i = 0;
  for (let k = 0; k < P; k++) {
    const take = base + (k < extra ? 1 : 0);
    pages.push(words.slice(i, i + take));
    i += take;
  }
  return pages;
}

// ONE-PAGE-AT-A-TIME: dur runs to the successor's start (next page, or the next beat's gate), NO tail —
// the capIO fade (last 30%) completes exactly as the successor rises; floored at 450 (brief overlap accepted).
export function pgDurMs215(pgStartMs: number, nextStartMs: number): number {
  return Math.max(DUR_FLOOR_MS, nextStartMs - pgStartMs);
}

// Mat-flip beat numbers (1-based). K > B ⇒ that phase is absent (its mat divs are deleted).
export function matKs215(B: number): { K2: number; K3: number } {
  const K2 = Math.max(2, Math.floor(B / 3) + 1);
  const K3 = Math.max(K2 + 1, Math.floor((2 * B) / 3) + 1);
  return { K2, K3 };
}

function matSet(cls: string): string {
  return `<div class="m mt ${cls}"></div><div class="m mb ${cls}"></div><div class="m ml ${cls}"></div><div class="m mr ${cls}"></div>`;
}

// rounded-corner patches — same colour class as the mats so they follow the flip narrative
function cornerSet(cls: string): string {
  return `<div class="m ctl ${cls}"></div><div class="m ctr ${cls}"></div><div class="m cbl ${cls}"></div><div class="m cbr ${cls}"></div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 736, 1312);
  const p = pxScaler(scale);
  const demote = opts.demote ?? {};
  const B = timings.beats.length;
  const { K2, K3 } = matKs215(B);
  const T2 = K2 <= B ? timings.beats[K2 - 1].cueDelayMs : 0;
  const T3 = K3 <= B ? timings.beats[K3 - 1].cueDelayMs : 0;

  const cues = timings.beats.map((beat, idx) => {
    const N = beat.i;
    const col = idx + 1 < K2 ? 'blue' : 'cream';
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const pages = paginate215(beat.words);
    const lastBeat = idx === B - 1;
    const lines = pages.map((pg, j) => {
      const id = `b${N}p${j + 1}`;
      const text = pg.map((w) => w.w).join(' '); // original case + punctuation; C = text.length
      const row = pickRow(LADDER, text.length, demotionFor(demote, id));
      const startMs = pg[0].delayMs; // VERBATIM — the page's first word
      const lastPage = j === pages.length - 1;
      const hold = lastBeat && lastPage; // final page of the final beat: rises once, the gate cuts it
      const durMs = hold
        ? HOLD_DUR_MS
        : pgDurMs215(startMs, lastPage ? timings.beats[idx + 1].cueDelayMs : pages[j + 1][0].delayMs);
      return `  <div class="ln ${row.cls} ${col}${hold ? ' hold' : ''}" id="${id}" data-node-id="${id}" data-node-role="text"
       style="animation-delay:${startMs}ms; animation-duration:${durMs}ms;">${escapeHtml(text)}</div>`;
    });
    return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${lines.join('\n')}
</div>`;
  });

  const mats = [matSet('cb')];
  if (K2 <= B) mats.push(matSet('ob'));
  if (K3 <= B) mats.push(matSet('rb'));
  mats.push(cornerSet('cb'));
  if (K2 <= B) mats.push(cornerSet('ob'));
  if (K3 <= B) mats.push(cornerSet('rb'));

  // blur scales UNROUNDED — Math.round(1.5)=2 would break the SCALE=1 verbatim rule
  const blurPx = +(1.5 * scale).toFixed(2);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; overflow: hidden; }
  body { position: relative; background: #000; font-family: 'Bricolage Grotesque', Arial, Helvetica, sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* colour mats — 4 opaque bands around the footage window (window = x26 y195 678×755).
     Base set is cream; the blue set fades in at T2, the red set at T3 (the K2/K3 beats). */
  .m  { position: absolute; }
  .mt { left: 0;     top: 0;     width: ${p(736)}px; height: ${p(195)}px; }
  .mb { left: 0;     top: ${p(950)}px; width: ${p(736)}px; height: ${p(362)}px; }
  .ml { left: 0;     top: ${p(195)}px; width: ${p(26)}px;  height: ${p(755)}px; }
  .mr { left: ${p(704)}px; top: ${p(195)}px; width: ${p(32)}px;  height: ${p(755)}px; }
  .cb { background: #f4f1ea; z-index: 1; }
  .ob { background: #2b419b; z-index: 2; opacity: 0; animation: matIn 350ms ease ${T2}ms both; }
  .rb { background: #c0281c; z-index: 3; opacity: 0; animation: matIn 350ms ease ${T3}ms both; }
  @keyframes matIn { from { opacity: 0; } to { opacity: 1; } }

  /* rounded window corners — mat-coloured 28×28 patches clipped to a quarter-circle. border-radius
     renders a straight 45° chamfer in this engine; the ALL-% clip-path polygon is the verified
     substitute (% coords stay verbatim at any SCALE). */
  .ctl { left: ${p(26)}px;  top: ${p(195)}px; width: ${p(28)}px; height: ${p(28)}px;
         clip-path: polygon(0% 0%, 100% 0%, 69.1% 4.9%, 41.2% 19.1%, 19.1% 41.2%, 4.9% 69.1%, 0% 100%); }
  .ctr { left: ${p(676)}px; top: ${p(195)}px; width: ${p(28)}px; height: ${p(28)}px;
         clip-path: polygon(100% 0%, 0% 0%, 30.9% 4.9%, 58.8% 19.1%, 80.9% 41.2%, 95.1% 69.1%, 100% 100%); }
  .cbl { left: ${p(26)}px;  top: ${p(922)}px; width: ${p(28)}px; height: ${p(28)}px;
         clip-path: polygon(0% 100%, 0% 0%, 4.9% 30.9%, 19.1% 58.8%, 41.2% 80.9%, 69.1% 95.1%, 100% 100%); }
  .cbr { left: ${p(676)}px; top: ${p(922)}px; width: ${p(28)}px; height: ${p(28)}px;
         clip-path: polygon(100% 100%, 100% 0%, 95.1% 30.9%, 80.9% 58.8%, 58.8% 80.9%, 30.9% 95.1%, 0% 100%); }

  /* beat gate — the one safe reveal recipe; delay+duration set inline per beat */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: ${p(72)}px; top: ${p(960)}px; width: ${p(583)}px; height: ${p(140)}px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* a page = one short phrase; pages of a beat stack at the same origin and take turns */
  .ln { position: absolute; left: 0; top: 0; width: ${p(583)}px; text-align: center;
        font-weight: 800; line-height: 1.15; letter-spacing: -0.045em;
        filter: blur(${blurPx}px); opacity: 0;
        animation-name: capIO; animation-timing-function: ease; animation-fill-mode: both; }
  .hold { animation-name: capHold; }   /* final page of the final beat only */
  .blue  { color: #2b419b; }           /* beats before the first flip */
  .cream { color: #fbf9f7; }           /* beats from the first flip on */

  @keyframes capIO {
    0%   { opacity: 0; transform: translateY(${p(14)}px); }
    18%  { opacity: 1; transform: translateY(0); }
    70%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(${p(-10)}px); }
  }
  @keyframes capHold {
    0%   { opacity: 0; transform: translateY(${p(14)}px); }
    18%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 1; transform: translateY(0); }
  }

  /* size ladder — pick by the page's char count; width budget 583px is baked in */
  .s96 { font-size: ${p(96)}px; } .s89 { font-size: ${p(89)}px; } .s82 { font-size: ${p(82)}px; }
  .s77 { font-size: ${p(77)}px; } .s71 { font-size: ${p(71)}px; } .s67 { font-size: ${p(67)}px; }
  .s63 { font-size: ${p(63)}px; } .s59 { font-size: ${p(59)}px; } .s56 { font-size: ${p(56)}px; }
  .s53 { font-size: ${p(53)}px; } .s51 { font-size: ${p(51)}px; } .s49 { font-size: ${p(49)}px; }
  .s46 { font-size: ${p(46)}px; } .s44 { font-size: ${p(44)}px; } .s43 { font-size: ${p(43)}px; }
  .s38 { font-size: ${p(38)}px; }
</style>
</head>
<body>
  <video class="vid" src="${meta.videoPath}" muted></video>
  ${mats.join('\n  ')}
${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-215 Comp 1-peak', generate };
export default recipe;
