// Compiled recipe — hook-072 (0-00-04-10) (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// A WhatsApp-style chat over the footage: dark-green OUT bubbles (right edge of a centered column,
// time + double ticks) alternate with dark-slate IN bubbles (left edge, time only) on ONE global
// counter that never resets; white system-sans text, a tail at each bubble's anchored bottom corner;
// each message pops in (scale overshoot) at its first spoken word and messages stack upward
// chat-style; one mint hero word per beat (colour only — the engine renders this stack's bold as regular).
// Demotion (--verify bounds left/right on #b{N}m{j}[l|t]) re-splits THAT beat at the greedy limit 16
// (the LIMITS ladder); a single unit longer than the active limit drops its meta spans (the sheet's
// other width fix, applied structurally). NOT automated (report-only — the runner only demotes):
// top/bottom bounds (formula recheck), never-visible (checklist), occluded (cap cueDurMs at the next
// cue's start). DEVICE INTENSITY is fixed at `standard` (the sheet's default; `minimal` needs an
// explicit calm direction, which RecipeOptions cannot carry).
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// greedy char limit per message; one demotion step re-splits the beat at 16
export const LIMITS: LadderRow[] = [
  { cls: 'lim18', maxC: 18 },
  { cls: 'lim16', maxC: 16 },
];
const POP_MS = 400;
const POP_MIN_MS = 250;
const POP_AVAIL_MS = 500;
const STACK_TOP = 563; // 640 − 77
const PITCH = 87; // 77 + 10 gap
const ANCHOR = 395;

export interface Unit072 {
  text: string; // display: each token stripped of ONE trailing `.`/`,`, glued tokens concatenated
  delayMs: number; // FIRST token's, verbatim
  charLen: number;
  boundary: boolean; // RAW last token ends `.` `,` `!` `?` (last-unit exemption lives in the walk)
}

export function toUnits072(words: WordTiming[]): Unit072[] {
  const units: Unit072[] = [];
  for (const w of words) {
    const raw = w.w.trim();
    const display = raw.replace(/[.,]$/, '');
    const boundary = /[.,!?]$/.test(raw);
    const prev = units[units.length - 1];
    if (raw.startsWith('-') && prev) {
      prev.text += display;
      prev.charLen = prev.text.length;
      prev.boundary = boundary;
    } else {
      units.push({ text: display, delayMs: w.delayMs, charLen: display.length, boundary });
    }
  }
  return units;
}

// Greedy walk: close on a punctuation boundary, else close when the NEXT unit would push past the
// limit (chars = charLens + 1 per gap). An oversized single unit lands alone (meta dropped at render).
export function splitMessages072(units: Unit072[], limit: number): Unit072[][] {
  const msgs: Unit072[][] = [];
  let cur: Unit072[] = [];
  let chars = 0;
  units.forEach((u, k) => {
    cur.push(u);
    chars = cur.length > 1 ? chars + 1 + u.charLen : u.charLen;
    const next = units[k + 1];
    if (next && (u.boundary || chars + 1 + next.charLen > limit)) {
      msgs.push(cur);
      cur = [];
      chars = 0;
    }
  });
  if (cur.length) msgs.push(cur);
  return msgs;
}

// Hero: first digit-bearing unit, else longest charLen, tie → later.
export function heroIndex072(units: Unit072[]): number {
  const digit = units.findIndex((u) => /\d/.test(u.text));
  if (digit >= 0) return digit;
  let best = 0;
  for (let i = 1; i < units.length; i++) if (units[i].charLen >= units[best].charLen) best = i;
  return best;
}

// avail = cueEnd − msgDelay; a message spoken just before the gate closes still finishes popping.
export function popMs072(msgDelayMs: number, cueEndMs: number): number {
  const avail = cueEndMs - msgDelayMs;
  return avail >= POP_AVAIL_MS ? POP_MS : Math.max(POP_MIN_MS, avail - 100);
}

// Bubbles stack bottom-up from stackBottom 640 (top of message j among K).
export function topFor072(j: number, K: number): number {
  return STACK_TOP - (K - j) * PITCH;
}

function tickHtml(p: (n: number) => number): string {
  // viewBox, points and stroke-width verbatim — they ride the scaled width/height
  return `<span class="tk"><svg class="tkS" width="${p(28)}" height="${p(18)}" viewBox="0 0 28 18"><polyline points="1.5,9.8 6.2,14.4 14.2,3.6" fill="none" stroke="#9fceb8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline><polyline points="9.8,9.8 14.5,14.4 22.5,3.6" fill="none" stroke="#9fceb8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline></svg></span>`;
}

function bubbleHtml(
  msg: Unit072[], N: number, j: number, K: number, out: boolean, hero: Unit072 | undefined,
  time: string, cueEndMs: number, limit: number, p: (n: number) => number,
): string {
  const id = `b${N}m${j}`;
  const spans = msg
    .map((u, i) => {
      const cls = u === hero ? 'wd hero' : 'wd';
      const style = i === msg.length - 1 ? ' style="margin-right:0"' : '';
      return `<span class="${cls}"${style}>${escapeHtml(u.text)}</span>`;
    })
    .join('');
  const dropMeta = msg.length === 1 && msg[0].charLen > limit;
  const meta = dropMeta
    ? ''
    : `<span class="${out ? 'tmO' : 'tmI'}" id="${id}t" data-node-id="${id}t" data-node-role="text">${time}</span>${out ? tickHtml(p) : ''}`;
  const anchor = out ? `right:${p(ANCHOR)}px` : `left:${p(ANCHOR)}px`;
  return `  <div class="bub ${out ? 'out' : 'in'}" id="${id}" data-node-id="${id}"
       style="z-index:${j};${anchor};top:${p(topFor072(j, K))}px;animation-delay:${msg[0].delayMs}ms;animation-duration:${popMs072(msg[0].delayMs, cueEndMs)}ms">
    <div class="${out ? 'skOut' : 'skIn'}">
      <div class="ln" id="${id}l" data-node-id="${id}l" data-node-role="text">${spans}${meta}</div>
      <i class="${out ? 'tlO' : 'tlI'}"></i>
    </div>
  </div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 1280, 720));
  const demote = opts.demote ?? {};

  let g = 0; // global side counter — beats in order, messages in order, never resets
  const cues = timings.beats.map((beat) => {
    const N = beat.i;
    const units = toUnits072(beat.words);
    const keys = Object.keys(demote).filter((k) => new RegExp(`^b${N}m\\d+[lt]?$`).test(k));
    const limit = pickRow(LIMITS, 0, demotionFor(demote, ...keys)).maxC;
    const msgs = splitMessages072(units, limit);
    const hero = units.length ? units[heroIndex072(units)] : undefined;
    const cueEnd = beat.cueDelayMs + beat.cueDurMs;
    const time = `14:${20 + N}`;
    const bubbles = msgs.map((msg, idx) => {
      g += 1;
      return bubbleHtml(msg, N, idx + 1, msgs.length, g % 2 === 1, hero, time, cueEnd, limit, p);
    });
    return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${beat.cueDurMs}ms">
${bubbles.join('\n')}
</div>`;
  });

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; }
  body { background: #000; overflow: hidden; position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: ${p(1280)}px; height: ${p(720)}px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* message pop — rides the padded wrapper (the engine clips an opacity-animating element to its border
     box, so the protruding tail lives inside the wrapper's padding); visuals live on the skin */
  @keyframes pop { 0% { opacity: 0; transform: scale(0.6); }
                   65% { opacity: 1; transform: scale(1.05); }
                   100% { opacity: 1; transform: scale(1); } }
  .bub { position: absolute; opacity: 0; z-index: 1;
         animation-name: pop; animation-timing-function: cubic-bezier(.2,.7,.3,1);
         animation-fill-mode: both; }
  .out { transform-origin: 100% 100%; padding-right: ${p(9)}px; }
  .in  { transform-origin: 0% 100%;  padding-left: ${p(9)}px; }

  /* asymmetric 21/11 padding: the engine seats the 36/45 line ~5px high in the box — this centers
     the ink optically (measured); height stays 21+45+11 = 77 */
  .skOut { position: relative; background: #124c34; border-radius: ${p(19)}px;
           border-bottom-right-radius: 0; padding: ${p(21)}px ${p(18)}px ${p(11)}px ${p(18)}px; }
  .skIn  { position: relative; background: #233138; border-radius: ${p(19)}px;
           border-bottom-left-radius: 0; padding: ${p(21)}px ${p(18)}px ${p(11)}px ${p(18)}px; }

  .ln { font-family: "Helvetica Neue", Arial, sans-serif; font-size: ${p(36)}px; font-weight: 400;
        line-height: ${p(45)}px; color: #ffffff; white-space: nowrap; text-align: left; }
  .wd { display: inline-block; margin-right: 0.28em; }
  .hero { color: #9fceb8; }

  /* meta ride the text line's optical axis: time +2px, tick box +3px (measured seats) */
  .tmO { display: inline-block; position: relative; top: ${p(2)}px; margin-left: ${p(8)}px; font-family: "Helvetica Neue", Arial, sans-serif;
         font-size: ${p(20)}px; font-weight: 400; line-height: ${p(20)}px; color: #9fceb8; }
  .tmI { display: inline-block; position: relative; top: ${p(2)}px; margin-left: ${p(8)}px; font-family: "Helvetica Neue", Arial, sans-serif;
         font-size: ${p(20)}px; font-weight: 400; line-height: ${p(20)}px; color: #8d9ba3; }
  .tk  { display: inline-block; position: relative; top: ${p(3)}px; margin-left: ${p(4)}px; width: ${p(28)}px; height: ${p(18)}px; }
  .tkS { display: block; width: ${p(28)}px; height: ${p(18)}px; }
  .tlO { position: absolute; bottom: 0; left: 100%; margin-left: ${p(-2)}px; width: ${p(11)}px; height: ${p(20)}px;
         background: #124c34; clip-path: polygon(0% 0%, 0% 100%, 100% 100%); }
  .tlI { position: absolute; bottom: 0; right: 100%; margin-right: ${p(-2)}px; width: ${p(11)}px; height: ${p(20)}px;
         background: #233138; clip-path: polygon(100% 0%, 100% 100%, 0% 100%); }
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

const recipe: RecipeGenerator = { refId: 'hook-072 (0-00-04-10)', generate };
export default recipe;
