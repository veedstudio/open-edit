// Compiled recipe — hook-123-peak (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// A neon-sign poster in the left third: an all-caps League Gothic headline in hot red (white-hot core,
// red rim + bloom over a hard black plate) that strikes on like a tube warming up, with the rest of the
// sentence handwritten below in big Caveat script — words rising in on their spoken timings, one hero
// script word per beat underlined. Anchor alternates by beat parity (odd → left 77px, even → right 763px);
// punch-close bumps the last beat's title one ladder step when it carries a digit or a `!` word.
// NOTE: the sheet's DEVICE INTENSITY `calm` variant keys off the DIRECTION (execution contract), which a compiled
// recipe never sees — this module always emits `standard` ignite. Non-ladder verify fixes (bottom
// outside → structural re-check, never-visible → timing/class audit, occluded → window clamp) are NOT
// automated — the runner only demotes ladders; those failures are reported honestly.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { BeatTiming, WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// Ordered ladders (largest first — demotion steps DOWN = later index, punch-close steps UP = earlier).
const TITLE_SIZES = [184, 170, 149, 132, 119, 108, 99, 91, 85, 79, 74, 70, 66, 62, 59];
const SCRIPT_SIZES = [60, 58, 55, 51, 48, 45, 43, 41, 39, 37, 35, 34, 33, 31, 30, 29, 28, 27];
// C_t ≤6 → t184, then one row per char up to 19, ≥20 → t59.
const TITLE_LADDER: LadderRow[] = TITLE_SIZES.map((s, i) => ({ cls: `t${s}`, maxC: i < TITLE_SIZES.length - 1 ? i + 6 : Infinity }));
// C_s ≤13 → c60, then one row per char up to 29, ≥30 → c27.
const SCRIPT_LADDER: LadderRow[] = SCRIPT_SIZES.map((s, i) => ({ cls: `c${s}`, maxC: i < SCRIPT_SIZES.length - 1 ? i + 13 : Infinity }));

const TITLE_MAX_CHARS = 10;

// Word prep: strip a trailing `.` or `,`; keep `?` `!` `'` and internal punctuation.
export function stripWord(w: string): string {
  return w.replace(/[.,]$/, '');
}

// Units keep their case (the title's CSS uppercases; script words render as given) + VEED glue:
// a leading-`-` token merges with the previous word into ONE unit, each span keeping its own delay.
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

// Title = the longest prefix with chars ≤ 10 (at least one unit — the first joins even if longer);
// everything else is script.
export function splitTitleScript(units: Unit[]): { title: Unit[]; script: Unit[] } {
  const title: Unit[] = [];
  for (const u of units) {
    if (title.length && charsOf([...title, u]) > TITLE_MAX_CHARS) break;
    title.push(u);
  }
  return { title, script: units.slice(title.length) };
}

// L = min(3, ceil(S/3)); base = floor(S/L); the first (S mod L) lines take base+1 consecutive words.
export function scriptLineSplit(script: Unit[]): Unit[][] {
  const S = script.length;
  if (!S) return [];
  const L = Math.min(3, Math.ceil(S / 3));
  const base = Math.floor(S / L);
  const rem = S % L;
  const lines: Unit[][] = [];
  let i = 0;
  for (let l = 0; l < L; l++) {
    const take = base + (l < rem ? 1 : 0);
    lines.push(script.slice(i, i + take));
    i += take;
  }
  return lines;
}

export function titleRampMs(availMs: number): number {
  return Math.min(1300, Math.max(250, availMs - 80));
}

export function scriptInMs(availMs: number): number {
  return Math.min(320, Math.max(150, availMs - 80));
}

// punch-close when the last beat contains a digit word or a word ending in `!`.
export function isPunchClose(beat: BeatTiming): boolean {
  return beat.words.some((w) => { const t = stripWord(w.w); return /\d/.test(t) || t.endsWith('!'); });
}

// Title row: ladder fit, stepped UP one for punch-close (t184 stays t184), DOWN by demotion.
export function titleClass(C: number, promote = 0, demote = 0): string {
  let i = TITLE_LADDER.findIndex((r) => C <= r.maxC);
  if (i < 0) i = TITLE_LADDER.length - 1;
  return TITLE_LADDER[Math.max(0, Math.min(TITLE_LADDER.length - 1, i - promote + demote))].cls;
}

function spansHtml(u: Unit, cls: string, cueEndMs: number, durFor: (availMs: number) => number): string {
  return u.spans
    .map((s, i) => {
      // a glued unit's non-final spans zero their gap so the pair reads as one word
      const glue = i < u.spans.length - 1 ? ';margin-right:0' : '';
      const style = `animation-delay:${s.delayMs}ms;animation-duration:${durFor(cueEndMs - s.delayMs)}ms${glue}`;
      return `<span class="${cls}" style="${style}">${escapeHtml(s.text)}</span>`;
    })
    .join('');
}

function cueHtml(beat: BeatTiming, isLast: boolean, leftB: number | null, demote: Record<string, number>): string {
  const N = beat.i;
  const units = unitsFor(beat.words);
  if (!units.length) return '';
  const cueEnd = beat.cueDelayMs + beat.cueDurMs;
  const { title, script } = splitTitleScript(units);
  const promote = isLast && isPunchClose(beat) ? 1 : 0;
  const tCls = titleClass(charsOf(title), promote, demotionFor(demote, `b${N}t`));
  const lines = scriptLineSplit(script);
  const rows = [
    `  <div class="title ${tCls}" id="b${N}t" data-node-id="b${N}t" data-node-role="text">${title.map((u) => spansHtml(u, 'tw', cueEnd, titleRampMs)).join('')}</div>`,
  ];
  if (lines.length) {
    const Cs = Math.max(...lines.map(charsOf));
    const sRow = pickRow(SCRIPT_LADDER, Cs, demotionFor(demote, `b${N}s1`, `b${N}s2`, `b${N}s3`));
    const hero = accentIndex(script);
    let at = 0;
    for (let l = 0; l < lines.length; l++) {
      const id = `b${N}s${l + 1}`;
      const cls = l === 0 ? `script sind ${sRow.cls}` : `script ${sRow.cls}`;
      const spans = lines[l]
        .map((u, k) => spansHtml(u, at + k === hero ? 'w u' : 'w', cueEnd, scriptInMs))
        .join('');
      rows.push(`  <div class="${cls}" id="${id}" data-node-id="${id}" data-node-role="text">${spans}</div>`);
      at += lines[l].length;
    }
  }
  const anchor = leftB === null ? '' : `;left:${leftB}px`;
  return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${beat.cueDurMs}ms${anchor}">
${rows.join('\n')}
</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 1280, 720));
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) =>
      // ANCHOR alternates by beat parity: odd 1-indexed → A (the class's 77px), even → B (763px inline)
      cueHtml(beat, idx === timings.beats.length - 1, beat.i % 2 === 0 ? p(763) : null, demote))
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=League+Gothic&family=Caveat:wght@700&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${p(1280)}px; height: ${p(720)}px; background: #000; overflow: hidden; position: relative; font-kerning: none; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: ${p(77)}px; top: ${p(140)}px; width: ${p(520)}px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* neon headline — color and every shadow layer are STATIC; only opacity ever animates.
     Layers 1-3 = the tube (white-hot rim, red rim, bloom); layers 4-5 = the dark plate + halo that
     ground the red on bright footage (probe-calibrated: thinner plates fail the frame QA). */
  .title { font-family: 'League Gothic', sans-serif; font-weight: 400; line-height: 1.2;
           letter-spacing: 0.01em; white-space: nowrap; text-transform: uppercase;
           color: #ff4d3d; margin-bottom: 0.04em;
           text-shadow: 0 0 0.025em rgba(255,225,210,0.75), 0 0 0.09em rgba(240,15,10,1),
                        0 0 0.32em rgba(220,20,16,0.75), 0.11em 0.13em 0 #000000, 0 0 0.18em #000000; }

  /* handwritten script — line-height 1.45 is load-bearing: Caveat's ascenders touch the very top
     of a 1.3 line box and an animating span shears at its box edge — NEVER reduce this value; the
     stack's tightness is tuned via the title/script margins instead. The shadow is a SOFT ambient
     halo only — the hard offset plate is the title's display idiom, never the script's */
  .script { font-family: 'Caveat', cursive; font-weight: 700; line-height: 1.45;
            letter-spacing: 0.05em; white-space: nowrap; color: #e9e6e6; margin-top: 0.1em;
            text-shadow: 0 0.04em 0.10em rgba(0,0,0,0.95), 0 0.02em 0.22em rgba(0,0,0,0.80),
                         0 0 0.45em rgba(0,0,0,0.55); }
  .sind { margin-left: ${p(44)}px; }

  /* neon warm-up: opacity-only flicker, dips front-loaded (≤52%) so a beat's MID frame always
     catches ≥.9 — full at 55%, holds after */
  @keyframes ignite { 0% {opacity:0} 8% {opacity:.5} 18% {opacity:.1} 30% {opacity:.85}
                      42% {opacity:.4} 55% {opacity:1} 70% {opacity:.93} 82% {opacity:1} 100% {opacity:1} }
  @keyframes wordIn { 0% {opacity:0; transform:translateY(0.15em) rotate(-2deg);}
                      100% {opacity:1; transform:translateY(0) rotate(0);} }
  .tw { display: inline-block; opacity: 0; margin-right: 0.30em;
        animation-name: ignite; animation-timing-function: linear; animation-fill-mode: both; }
  .w  { display: inline-block; opacity: 0; margin-right: 0.45em;
        animation-name: wordIn; animation-timing-function: ease; animation-fill-mode: both; }
  /* hero underline — same ink + the tube's glow layers as .title (layers 1-3 + the grounding halo);
     the hard offset plate is EXCLUDED (title-only device — never an offset copy on the script) */
  .u  { text-decoration: underline; text-decoration-color: #ff4d3d; text-decoration-thickness: ${p(3)}px;
        text-underline-offset: ${p(9)}px; padding: 0 ${p(6)}px;
        text-shadow: 0 0 0.025em rgba(255,225,210,0.75), 0 0 0.09em rgba(240,15,10,1),
                     0 0 0.32em rgba(220,20,16,0.75), 0 0 0.18em #000000; }

  ${TITLE_SIZES.map((s) => `.t${s}{font-size:${p(s)}px}`).join(' ')}
  ${SCRIPT_SIZES.map((s) => `.c${s}{font-size:${p(s)}px}`).join(' ')}
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

const recipe: RecipeGenerator = { refId: 'hook-123-peak', generate };
export default recipe;
