// Compiled recipe — hook-082 (0-00-43-14) · brutalist end-card (9:16, authored at 736×1312 @25fps).
// Source sheet: ./recipe.md. Upright condensed Oswald caps, flag-anchored low in the frame — the anchor
// alternates aL/aR by beat parity (CUE ANCHOR axis: alternating, the only validated value). ONE hero
// word per beat (digit wins, else longest, tie → later) blown up in signal-yellow with the hard maroon
// offset block; setup words sit small in cream above/below on a tight poster leading. A line is ONE
// LINE UNIT (nested slide/ink spans — the over-video engine-bug workaround): the whole line slides in
// from the anchor's side while it rises + fades, on the line's FIRST word's verbatim delayMs. Every
// beat cross-fades via cueGate; the LAST beat holds (cueHold). SCALE ARC axis: steady (the default —
// punch-close needs a payoff/number judgment call, not compiled).
// Demotion (--verify bounds ids): b{N}h → hero one ladder class smaller (pickRow); b{N}s{K}/b{N}a{K} →
// that support cluster RE-PAGINATES with Ls+1 lines (the sheet's mechanical fix — support is a fixed
// 42px, there is no font ladder for it). NOT automated (deterministic output cannot drift into them;
// report-only): cue top/anchor restores, never-visible/occluded gate checks, font-warning STOPs.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// hero size ladder — fs = min(132, floor(990 / C)) by the hero word's char count C (sheet table)
const HERO_LADDER = [
  { cls: 'h132', maxC: 7 }, { cls: 'h123', maxC: 8 }, { cls: 'h110', maxC: 9 },
  { cls: 'h99', maxC: 10 }, { cls: 'h90', maxC: 11 }, { cls: 'h82', maxC: 12 },
  { cls: 'h76', maxC: 13 }, { cls: 'h70', maxC: 14 }, { cls: 'h66', maxC: 15 },
  { cls: 'h61', maxC: 16 }, { cls: 'h58', maxC: 17 }, { cls: 'h55', maxC: 18 },
  { cls: 'h52', maxC: 19 }, { cls: 'h49', maxC: 20 }, { cls: 'h47', maxC: 21 },
  { cls: 'h45', maxC: 22 }, { cls: 'h43', maxC: Infinity },
];
const MAX_SUP_CHARS = 26; // support line budget (Oswald 600 caps at 42px inside 580px — baked in)
const LE_MIN = 250;
const LE_MAX = 500;

// Word prep: strip ONE trailing `.` `,` `!` `?` (internal punctuation kept — `10,000` stays 6 chars).
export function stripToken(w: string): string {
  return w.replace(/[.,!?]$/, '');
}

// Stripped + uppercased units with VEED glue: a leading-`-` token merges with the previous token into
// one unit for counting + line mapping (`TO-DO` = 5), each span keeping its own verbatim delayMs.
export function prepUnits(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const text = stripToken(w.w).toUpperCase();
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

// Support pagination — per cluster: Ls = max(1, ceil(cc / 26)) (+ demoted extra), first r lines take
// base+1 consecutive units, the rest base. Extra lines clamp at one unit per line.
export function supportLines(cluster: Unit[], extraLines = 0): Unit[][] {
  if (!cluster.length) return [];
  const Ls = Math.min(cluster.length, Math.max(1, Math.ceil(charsOf(cluster) / MAX_SUP_CHARS)) + extraLines);
  const base = Math.floor(cluster.length / Ls);
  const r = cluster.length % Ls;
  const lines: Unit[][] = [];
  for (let k = 0, i = 0; k < Ls; k++) {
    const take = base + (k < r ? 1 : 0);
    lines.push(cluster.slice(i, i + take));
    i += take;
  }
  return lines;
}

// le = clamp(cueEnd − ld, 250, 500): a line starting <500ms before the gate compresses so it lands.
export function leMs(ldMs: number, cueEndMs: number): number {
  return Math.max(LE_MIN, Math.min(LE_MAX, cueEndMs - ldMs));
}

export function heroClass(C: number, demoteRows = 0): string {
  return pickRow(HERO_LADDER, C, demoteRows).cls;
}

// A cluster's demotion = max over the demote keys naming its line ids (b{N}s* / b{N}a*).
export function clusterDemotion(demote: Record<string, number>, prefix: string): number {
  return demotionFor(demote, ...Object.keys(demote).filter((k) => new RegExp(`^${prefix}\\d+$`).test(k)));
}

// A glued unit renders back-to-back with no gap inside the one .ink text node (line-level timing —
// the line's entrance is its first word's delay; sub-spans would re-split the LINE UNIT).
function unitText(u: Unit): string {
  return u.spans.map((s) => s.text).join('');
}

function lineHtml(units: Unit[], id: string, cls: string, dir: string, cueEndMs: number): string {
  const ld = units[0].spans[0].delayMs; // first word's delayMs VERBATIM
  const t = `animation-delay:${ld}ms;animation-duration:${leMs(ld, cueEndMs)}ms`; // BOTH spans, same timing
  const text = escapeHtml(units.map(unitText).join(' '));
  return `  <div class="${cls}" id="${id}" data-node-id="${id}" data-node-role="text"><span class="slide ${dir}" style="${t}"><span class="ink" style="${t}">${text}</span></span></div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat, idx) => {
    const N = beat.i;
    const units = prepUnits(beat.words);
    if (!units.length) return '';
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const cueEnd = beat.cueDelayMs + winMs; // = next beat's start, or round(durationSec×1000) on the last
    const isLast = idx === timings.beats.length - 1;
    const anchor = N % 2 === 1 ? 'aL' : 'aR';
    const dir = N % 2 === 1 ? 'fromL' : 'fromR'; // ONE direction for the whole beat, matching its anchor
    const h = accentIndex(units); // hero: digit first, else longest, tie → later
    const hero = units[h];
    const row = pickRow(HERO_LADDER, hero.chars, demotionFor(demote, `b${N}h`));
    const lines = [
      ...supportLines(units.slice(0, h), clusterDemotion(demote, `b${N}s`))
        .map((ws, k) => lineHtml(ws, `b${N}s${k + 1}`, 'line sup', dir, cueEnd)),
      lineHtml([hero], `b${N}h`, `line hero ${row.cls}`, dir, cueEnd),
      ...supportLines(units.slice(h + 1), clusterDemotion(demote, `b${N}a`))
        .map((ws, k) => lineHtml(ws, `b${N}a${k + 1}`, 'line sup', dir, cueEnd)),
    ];
    return `<div class="cue ${anchor}" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N}; animation-name:${isLast ? 'cueHold' : 'cueGate'}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${lines.join('\n')}
</div>`;
  }).filter(Boolean);

  const ladderCss = HERO_LADDER.map((r) => `.${r.cls}{font-size:${p(Number(r.cls.slice(1)))}px}`).join(' ');

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; overflow: hidden; }
  body { position: relative; background: #000; font-family: 'Oswald', 'Arial Narrow', sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* warm grounding scrim — lower band only; static, never gated */
  .scrim { position: absolute; left: 0; top: ${p(686)}px; width: ${p(736)}px; height: ${p(626)}px; z-index: 1;
           pointer-events: none;
           background: linear-gradient(180deg, rgba(10,8,6,0) 0%, rgba(10,8,6,.30) 46%, rgba(10,8,6,.52) 100%); }

  /* beat gate — cue-fade: hold, then fade over the last 6% of the window. z-index is inline per cue
     (positioned + opacity-animated => the stacking trap needs an explicit z). */
  @keyframes cueGate { 0%, 94% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes cueHold { 0%, 100% { opacity: 1; } }        /* FINAL beat only — rides the video end, no fade */
  .cue { position: absolute; top: ${p(740)}px; width: ${p(580)}px; height: ${p(336)}px;
         display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
         opacity: 0; animation-timing-function: linear; animation-fill-mode: both; }
  /* cue anchor — the ONLY thing that varies horizontally per beat; top/height never move.
     text-align is set HERE and inherited down into .line (which sets none of its own). */
  .aL { left: ${p(64)}px; right: auto; text-align: left; }
  .aR { left: auto; right: ${p(100)}px; text-align: right; }

  /* a line = one full-width row (NEVER shrink-to-fit — a shrink-to-fit line resizes with its content, so one word moves everything beside it);
     words flow from the anchor's side. line-height cut well under 1 for a tight poster stack — this
     drops the ≥1.2 shear guard, so .ink's padding below now carries shear-safety alone. */
  .line { width: 100%; line-height: .82; white-space: nowrap; text-transform: uppercase;
          position: relative; z-index: 2; }
  .sup  { font-weight: 600; font-size: ${p(42)}px; letter-spacing: .01em; color: #f2ead2;
          text-shadow: 0 ${p(2)}px ${p(8)}px rgba(0,0,0,.72); }                     /* setup: cream, ONE soft dark halo */
  .hero { font-weight: 700; letter-spacing: -.01em; color: #ffde04;
          text-shadow: ${p(6)}px ${p(9)}px 0 #5a1808, 0 ${p(3)}px ${p(10)}px rgba(0,0,0,.5); }  /* hero: yellow, hard maroon block + soft ground */

  /* HERO size ladder — pick by the hero word's char count C: fs = min(132, floor(990 / C)) */
  ${ladderCss}

  /* LINE UNIT = nested two spans (engine-bug-safe over <video>): the WHOLE line slides in from one side
     (outer .slide) while it rises + fades (inner .ink). ONE unit per line — the words are plain text
     inside and move TOGETHER (no relative motion = no overlap during the slide). NEVER collapse to one
     span; NEVER put a transform (scaleX/skew/perspective/rotate) on the .cue, a .line, or any ancestor. */
  .slide { display: inline-block; vertical-align: top;
           animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .fromL { animation-name: slL; }              /* the line enters from the LEFT  */
  .fromR { animation-name: slR; }              /* the line enters from the RIGHT */
  .ink   { display: inline-block; padding: .1em 0 .18em; opacity: 0;    /* padding = descender headroom (sole guard now that line-height < 1) */
           animation-name: rise; animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  @keyframes slL  { 0% { transform: translateX(-${p(48)}px); } 100% { transform: translateX(0); } }
  @keyframes slR  { 0% { transform: translateX(${p(48)}px); }  100% { transform: translateX(0); } }
  @keyframes rise { 0% { opacity: 0; } 100% { opacity: 1; } } /* alpha only — a translateY here + the line's X slide read as a diagonal */
</style>
</head>
<body>
  <video class="vid" src="${meta.videoPath}" muted></video>
  <div class="scrim"></div>
${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-082 (0-00-43-14)', generate };
export default recipe;
