// Compiled recipe — hook-210-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md (v3).
// An optically-centred, upper-third caption stream: a small sentence-case Kalam line above a monumental
// yellow Anton accent that FILLS the block width (FIT LAW font-size, set inline). Words rise in and HOLD;
// mid-beat pages fade out as a unit (pageFade) exactly as the next page rises — the anti-collision
// hand-off; the beat's LAST page rides the cue gate. Emphasis is STRUCTURAL (page-final words land in
// the accent) — no per-word styling.
// Sheet deviations, why: (a) the runner's only lever is demote counts, so a `b{N}p{P}l2` bounds FAIL maps
// each demotion to the sheet's §6 per-run nudge (font-size ×0.94, rounded) instead of a ladder row;
// (b) the sheet's illustrative two-word worked sizes (`BEEN AN` → 176, `APP THAT` → 158) disagree with its
// own closed form (183/159) — the closed form is "one reading only", so the formula wins.
// NOTE: the sheet's top-outside fix (bump .cue top by 10px steps) is NOT automated — the runner only
// demotes; a top-outside FAIL is reported honestly.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// line1 fallback rows (single over-long word only); '' = the base class size (57px)
const L1_LADDER = [
  { cls: '', maxC: 15 },
  { cls: 'k45', maxC: 18 },
  { cls: 'k34', maxC: 22 },
];
const L1_MAX_CHARS = 15;
const L1_MAX_WORDS = 4;
const L2_PAIR_MAX = 9;
const BLOCK_W = 574;
const L2_TRACK = 2;   // accent letter-spacing px
const GLYPH_EM = 0.463;
const SP_EM = 0.30;
const FS_MIN = 64;
const FS_MAX = 190;   // HEIGHT guard — a 5–6 glyph accent would otherwise tower
const ENTER_MIN = 200;
const ENTER_MAX = 600;
const FADE_MS = 200;
const NUDGE = 0.94;   // §6 bounds fix: per-run accent shrink per demotion

interface Page { l1: WordTiming[]; l2: WordTiming[] }

const chars = (ws: WordTiming[]) => ws.reduce((s, w) => s + w.w.length, 0) + Math.max(0, ws.length - 1);

// Sheet paging walk: line1 takes ≤15 chars / ≤4 words while ≥1 word remains for line2 (a monster
// first word still goes to line1 — the k-rows absorb it); line2 takes the next word, +1 more only if
// the pair (incl. space) ≤9 chars; a page starting with the beat's LAST word is line2-only.
export function paginate210(words: WordTiming[]): Page[] {
  const pages: Page[] = [];
  let i = 0;
  while (i < words.length) {
    if (i === words.length - 1) {
      pages.push({ l1: [], l2: [words[i]] });
      break;
    }
    const l1: WordTiming[] = [words[i++]];
    while (
      i < words.length - 1 &&
      l1.length < L1_MAX_WORDS &&
      chars([...l1, words[i]]) <= L1_MAX_CHARS
    ) l1.push(words[i++]);
    const l2: WordTiming[] = [words[i++]];
    if (i < words.length && chars([...l2, words[i]]) <= L2_PAIR_MAX) l2.push(words[i++]);
    pages.push({ l1, l2 });
  }
  return pages;
}

// enterMs = clamp(nextStart − delayMs, 200, 600) — the word rises in then HOLDS (riseIn holds full from
// 65%); nextStart = the next page's first word delay, or winEnd on the beat's last page.
export function durMs210(delayMs: number, nextStartMs: number): number {
  return Math.max(ENTER_MIN, Math.min(ENTER_MAX, nextStartMs - delayMs));
}

// ACCENT FIT LAW: fsPx = clamp((574 − 2·(L−1)) / (0.463·L + 0.30·S), 64, 190) → round, in scaled px
// (BLOCK_W/track/clamps ride SCALE — the result is never scaled a second time).
export function fitFs210(L: number, S: number, p: (n: number) => number = (n) => n): number {
  const raw = (p(BLOCK_W) - p(L2_TRACK) * (L - 1)) / (GLYPH_EM * L + SP_EM * S);
  return Math.round(Math.min(p(FS_MAX), Math.max(p(FS_MIN), raw)));
}

function lineHtml(ws: WordTiming[], nextStartMs: number, upper: boolean): string {
  return ws
    .map((w) => `<span class="w" style="animation-delay:${w.delayMs}ms; animation-duration:${durMs210(w.delayMs, nextStartMs)}ms;">${escapeHtml(upper ? w.w.toUpperCase() : w.w)}</span>`)
    .join('<span class="sp"></span>');
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat, idx) => {
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const winEnd = beat.cueDelayMs + winMs;
    const pages = paginate210(beat.words);
    const pagesHtml = pages
      .map((page, j) => {
        const last = j + 1 === pages.length;
        // nextStart = the next page's first word delay; the beat's last page holds to winEnd
        const nextStart = last ? winEnd : pages[j + 1].l1.concat(pages[j + 1].l2)[0].delayMs;
        const P = j + 1;
        const lines: string[] = [];
        if (page.l1.length) {
          const row = pickRow(L1_LADDER, chars(page.l1), demotionFor(demote, `b${beat.i}p${P}l1`));
          lines.push(`    <div class="line1${row.cls ? ` ${row.cls}` : ''}" id="b${beat.i}p${P}l1" data-node-role="text">${lineHtml(page.l1, nextStart, false)}</div>`);
        }
        const L = page.l2.reduce((s, w) => s + w.w.length, 0);
        let fs = fitFs210(L, page.l2.length - 1, p);
        for (let d = demotionFor(demote, `b${beat.i}p${P}l2`); d > 0; d--) fs = Math.round(fs * NUDGE);
        lines.push(`    <div class="line2" id="b${beat.i}p${P}l2" style="font-size:${fs}px" data-node-role="text">${lineHtml(page.l2, nextStart, true)}</div>`);
        // mid-beat pages fade as a unit, reaching 0 exactly as the next page rises; the last page never fades
        const open = last
          ? '  <div class="pg">'
          : `  <div class="pg fade" style="animation-delay:${nextStart - FADE_MS}ms; animation-duration:${FADE_MS}ms;">`;
        return `${open}\n${lines.join('\n')}\n  </div>`;
      })
      .join('\n');
    return `<div class="cue" id="cue${beat.i}" style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${pagesHtml}
</div>`;
  });

  const wv = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Kalam:wght@300&family=Permanent+Marker&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; overflow: hidden; }
  body { position: relative; font-size: 0; background: #000; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay+duration set inline per beat */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: ${p(81)}px; top: ${p(95)}px; width: ${p(574)}px; height: ${p(420)}px; /* raised from 175 per curation 2026-07-21 */
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* every page TOP-aligns inside the cue box (fixed anchor at the box top, horizontally centred) so
     the block's top edge stays put at every beat; content only ever grows DOWN from the fixed top */
  .pg { position: absolute; left: 0; top: 0; width: ${p(574)}px; height: ${p(420)}px;
        display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        text-align: center; }
  /* mid-beat pages carry .fade; the beat's LAST page never does — it rides the cue gate */
  .pg.fade { animation-name: pageFade; animation-timing-function: linear; animation-fill-mode: forwards; }

  .line1 { font-family: 'Kalam', 'Permanent Marker', cursive; font-weight: 300;
           font-size: ${p(57)}px; line-height: 1.3; letter-spacing: ${p(3)}px; color: #ffffff;
           margin-top: ${p(-7)}px;
           text-shadow: 0 ${p(2)}px ${p(6)}px rgba(0,0,0,0.8), 0 0 ${p(18)}px rgba(0,0,0,0.6); }
  /* line2 has NO size class — its font-size is the §3 FIT LAW, set inline; the shadow is ONE soft-halo
     idiom (both layers blurred, no offset block) for the bright upper-third footage */
  .line2 { font-family: 'Anton', 'Impact', sans-serif; font-weight: 400;
           line-height: 1.24; letter-spacing: ${p(2)}px; color: #f0d10a;
           margin-top: ${p(-18)}px; text-shadow: 0 ${p(3)}px ${p(10)}px rgba(0,0,0,0.7), 0 0 ${p(30)}px rgba(0,0,0,0.65); }
  /* line1 fallback rows (single over-long word only) */
  .k45  { font-size: ${p(45)}px; }
  .k34  { font-size: ${p(34)}px; }

  /* words: rise up from below, then HOLD (no per-word exit — the page fades as a unit).
     delay + duration are set INLINE per word (delay = word-timings delayMs VERBATIM). */
  .w  { display: inline-block; opacity: 0;
        animation-name: riseIn; animation-timing-function: ease-out; animation-fill-mode: both; }
  .sp { display: inline-block; width: 0.3em; }
  @keyframes riseIn {
    0%   { opacity: 0; transform: translateY(${p(64)}px); }
    65%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 1; transform: translateY(0); }
  }
  /* page-level exit: ONE group fade (opacity only — an ancestor transform would break the words) */
  @keyframes pageFade { 0% { opacity: 1; } 100% { opacity: 0; } }
</style>
<video class="vid" src="${meta.videoPath}" muted></video>
${cues.join('\n')}
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-210-peak', generate };
export default recipe;
