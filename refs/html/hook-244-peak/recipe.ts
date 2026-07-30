// Compiled recipe — hook-244-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// Retro pixel-arcade headline: ALL-CAPS Press Start 2P, cream fill with a 5-step orange-red extruded
// echo trail (pure text-shadow on .ext/.exts — the glyph spans inherit it), per-GLYPH neon light-up
// reveal (JIT-scrambled delays off each word's verbatim onset, clamped to close 500ms before the
// gate), one oversized hero word per beat, and an 86px accent numeral row (Layout B) when a beat
// leads with a pure 1–2-digit number.
// NOTE (report-only, NOT automated — the runner only demotes ladders): the sheet's bottom-outside
// fix (flip the beat's top band 800 → 165) is not a ladder step, so a bottom bounds FAIL is reported
// honestly. never-visible (clamp) and occluded (gate/z-index) are generation invariants here, not
// post-hoc levers. The 86px numeral has no size tier — a bounds FAIL on b{N}num is also report-only.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { BeatTiming, WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// ladder cls = "<flat class> <font px>" — the sheet forbids compound selectors, so size goes inline
const HERO_LADDER = [
  { cls: 'ext 64', maxC: 6 },
  { cls: 'ext 56', maxC: 8 },
  { cls: 'ext 48', maxC: 10 },
  { cls: 'ext 44', maxC: 12 },
  { cls: 'ext 36', maxC: Infinity },
];
const SUPPORT_LADDER = [
  { cls: 'ext 27', maxC: 20 },
  { cls: 'ext 21', maxC: 26 },
  { cls: 'exts 16', maxC: 34 },
];
const COL_LADDERS: Record<1 | 2, { cls: string; maxC: number }[]> = {
  1: [{ cls: 'ext 27', maxC: 15 }, { cls: 'ext 21', maxC: 19 }, { cls: 'exts 16', maxC: 25 }],
  2: [{ cls: 'ext 27', maxC: 12 }, { cls: 'ext 21', maxC: 15 }, { cls: 'exts 16', maxC: 20 }],
};

export const JIT = [0, 120, 40, 160, 80, 20, 140, 60, 100, 180];

export function clampMsFor(cueDelayMs: number, cueDurMs: number): number {
  return cueDelayMs + cueDurMs - 500;
}

export function glyphDelayMs(wordDelayMs: number, k: number, clampMs: number): number {
  return Math.min(wordDelayMs + JIT[k % 10], clampMs);
}

const STOPLIST = new Set(
  'a an the to of in on at my we so and or but is are was it its i me you your how just one with for'.split(' '),
);
const strip = (w: string) => w.replace(/[^\p{L}\p{N}]+/gu, '');
const isNumber = (w: string) => /^\d+$/.test(strip(w));
const isContent = (w: string) => {
  const s = strip(w).toLowerCase();
  return s.length > 0 && !STOPLIST.has(s);
};

// Section 5: number wins; last beat → last content word; else longest content word by stripped
// letter count, ties → LATER word. No content words at all → same length rule over every word.
export function emphasisIndex(words: WordTiming[], isLastBeat: boolean): number {
  const num = words.findIndex((w) => isNumber(w.w));
  if (num >= 0) return num;
  if (isLastBeat) {
    for (let i = words.length - 1; i >= 0; i--) if (isContent(words[i].w)) return i;
  }
  const anyContent = words.some((w) => isContent(w.w));
  let best = -1;
  for (let i = 0; i < words.length; i++) {
    if (anyContent && !isContent(words[i].w)) continue;
    if (best < 0 || strip(words[i].w).length >= strip(words[best].w).length) best = i;
  }
  return best;
}

export const groupChars = (ws: WordTiming[]) =>
  ws.reduce((s, w) => s + w.w.length, 0) + Math.max(0, ws.length - 1);

// Balanced split at word boundaries; ties → later break (top-heavy). Never reorders.
export function splitBalanced(words: WordTiming[], n: 2 | 3): WordTiming[][] {
  if (words.length <= n) return words.map((w) => [w]);
  if (n === 2) {
    let best = 1;
    let bestDiff = Infinity;
    for (let k = 1; k < words.length; k++) {
      const d = Math.abs(groupChars(words.slice(0, k)) - groupChars(words.slice(k)));
      if (d <= bestDiff) { best = k; bestDiff = d; }
    }
    return [words.slice(0, best), words.slice(best)];
  }
  let cut: [number, number] = [1, 2];
  let bestMax = Infinity;
  for (let k1 = 1; k1 < words.length - 1; k1++) {
    for (let k2 = k1 + 1; k2 < words.length; k2++) {
      const m = Math.max(groupChars(words.slice(0, k1)), groupChars(words.slice(k1, k2)), groupChars(words.slice(k2)));
      if (m <= bestMax) { cut = [k1, k2]; bestMax = m; }
    }
  }
  return [words.slice(0, cut[0]), words.slice(cut[0], cut[1]), words.slice(cut[1])];
}

// Section 3 step 2: ≤20 chars → 1 line · 21–68 → 2 lines · 69+ → 3 lines, all forced 16px .exts.
export function splitGroup(words: WordTiming[]): { lines: WordTiming[][]; forced16: boolean } {
  const L = groupChars(words);
  if (L <= 20) return { lines: [words], forced16: false };
  if (L <= 68) return { lines: splitBalanced(words, 2), forced16: false };
  return { lines: splitBalanced(words, 3), forced16: true };
}

// Layout B column: fewest lines (≤3) whose every line fits the column table's 16px-tier cap for
// that digit count; null → abandon Layout B.
export function fitColumn(words: WordTiming[], digits: 1 | 2): WordTiming[][] | null {
  if (!words.length) return [];
  const ladder = COL_LADDERS[digits];
  const cap = ladder[ladder.length - 1].maxC;
  for (const n of [1, 2, 3] as const) {
    const lines = n === 1 ? [words] : splitBalanced(words, n);
    if (lines.every((l) => groupChars(l) <= cap)) return lines;
  }
  return null;
}

function lineGlyphs(ws: WordTiming[], clampMs: number): string {
  return ws
    .map((w) =>
      [...w.w.toUpperCase()]
        .map((ch, k) => `<span class="ch" style="animation-delay:${glyphDelayMs(w.delayMs, k, clampMs)}ms">${escapeHtml(ch)}</span>`)
        .join(''))
    .join('<span class="sp"></span>');
}

function lineDiv(ws: WordTiming[], id: string, rowCls: string, p: (n: number) => number, clampMs: number, indent = '  '): string {
  const [klass, size] = rowCls.split(' ');
  return `${indent}<div class="${klass}" id="${id}" style="font-size:${p(Number(size))}px;">${lineGlyphs(ws, clampMs)}</div>`;
}

function beatHtml(beat: BeatTiming, isLast: boolean, p: (n: number) => number, demote: Record<string, number>): string {
  const N = beat.i;
  const clamp = clampMsFor(beat.cueDelayMs, beat.cueDurMs);
  const top = N % 2 === 1 ? 165 : 800;
  let ln = 0;
  const supportDivs = (group: WordTiming[]): string[] => {
    if (!group.length) return [];
    const { lines, forced16 } = splitGroup(group);
    return lines.map((l) => {
      ln++;
      const id = `b${N}l${ln}`;
      const row = forced16 ? SUPPORT_LADDER[SUPPORT_LADDER.length - 1] : pickRow(SUPPORT_LADDER, groupChars(l), demotionFor(demote, id));
      return lineDiv(l, id, row.cls, p, clamp);
    });
  };
  const heroDiv = (w: WordTiming): string => {
    const row = pickRow(HERO_LADDER, w.w.length, demotionFor(demote, `b${N}hero`));
    return lineDiv([w], `b${N}hero`, row.cls, p, clamp);
  };

  const children: string[] = [];
  const firstDigits = strip(beat.words[0].w);
  let layoutB = /^\d{1,2}$/.test(firstDigits);
  if (layoutB) {
    const digits = firstDigits.length as 1 | 2;
    const rest = beat.words.slice(1);
    // the accent numeral is the beat's device; the hero (if any) is re-picked from the rest —
    // no rest → the 86px accent IS the hero (no separate hero line)
    const heroIdx = rest.length ? emphasisIndex(rest, isLast) : -1;
    const between = heroIdx >= 0 ? rest.slice(0, heroIdx) : [];
    const colLines = fitColumn(between, digits);
    if (colLines === null) {
      layoutB = false; // abandon — the number is then just a normal word (Layout A)
    } else {
      const numDiv = `    <div class="ext" id="b${N}num" style="font-size:${p(86)}px; line-height:0.95;">${lineGlyphs([beat.words[0]], clamp)}</div>`;
      const colDivs = colLines.map((l, j) => {
        const id = `b${N}c${j + 1}`;
        const row = pickRow(COL_LADDERS[digits], groupChars(l), demotionFor(demote, id));
        return lineDiv(l, id, row.cls, p, clamp, '      ');
      });
      const colHtml = colDivs.length ? `\n    <div class="col">\n${colDivs.join('\n')}\n    </div>` : '';
      children.push(`  <div class="row">\n${numDiv}${colHtml}\n  </div>`);
      if (heroIdx >= 0) {
        children.push(heroDiv(rest[heroIdx]));
        children.push(...supportDivs(rest.slice(heroIdx + 1)));
      }
    }
  }
  if (!layoutB) {
    const emph = emphasisIndex(beat.words, isLast);
    children.push(...supportDivs(beat.words.slice(0, emph)));
    children.push(heroDiv(beat.words[emph]));
    children.push(...supportDivs(beat.words.slice(emph + 1)));
  }
  return `<div class="cue" id="b${N}" style="top:${p(top)}px; animation:cueWin ${beat.cueDurMs}ms linear ${beat.cueDelayMs}ms forwards;">
${children.join('\n')}
</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};
  const beats = timings.beats.filter((b) => b.words.length);
  const cues = beats.map((beat, idx) => beatHtml(beat, idx === beats.length - 1, p, demote));

  const wv = `<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');

  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${p(736)}px; height:${p(1312)}px; overflow:hidden; }
  body { position:relative; background:#000; font-family:'Press Start 2P', monospace; }
  .vid { position:absolute; inset:0; width:${p(736)}px; height:${p(1312)}px; object-fit:cover; z-index:0; }

  /* beat gate — THE one safe reveal recipe (opacity-trap-safe: explicit z-index on the gate) */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; left:${p(70)}px; z-index:12; opacity:0;
         display:flex; flex-direction:column; align-items:flex-start; gap:${p(14)}px; }

  /* extruded pixel headline — the echo trail IS this shadow stack */
  .ext  { color:#fae3bb; line-height:1.2; letter-spacing:-0.06em; white-space:nowrap;
          text-shadow: ${p(1)}px ${p(1)}px 0 #b74933, ${p(2)}px ${p(2)}px 0 #b74933, ${p(3)}px ${p(3)}px 0 #ad4530,
                       ${p(4)}px ${p(4)}px 0 #a8412e, ${p(5)}px ${p(5)}px 0 #9a3b2a; }
  /* small-size variant (2-step trail) — its OWN flat class, never a compound selector */
  .exts { color:#fae3bb; line-height:1.2; letter-spacing:-0.06em; white-space:nowrap;
          text-shadow: ${p(1)}px ${p(1)}px 0 #b74933, ${p(2)}px ${p(2)}px 0 #a8412e; }

  /* accent-numeral row (Layout B only) */
  .row { display:flex; flex-direction:row; align-items:flex-start; gap:${p(49)}px; }
  .col { display:flex; flex-direction:column; align-items:flex-start; gap:${p(14)}px; }

  /* per-glyph neon light-up (verbatim from prefab — do not edit) */
  .ch { display:inline-block; opacity:0; animation:neon .42s cubic-bezier(.2,.7,.3,1) both; }
  .sp { display:inline-block; width:0.6em; }
  @keyframes neon {
    0%   { opacity:0; transform:translateY(-0.6em); /* glyphs DROP from above (curation 2026-07-21); glow ramp unchanged */
           filter:drop-shadow(0 0 0 rgba(255,224,138,0)); }
    55%  { opacity:1;
           filter:drop-shadow(0 0 ${p(10)}px rgba(255,210,90,0.95)) drop-shadow(0 0 ${p(22)}px rgba(255,150,40,0.7)); }
    100% { opacity:1; transform:translateY(0);
           filter:drop-shadow(0 0 0 rgba(255,224,138,0)); }
  }
</style>

<video class="vid" src="${meta.videoPath}" muted></video>

${cues.join('\n')}
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-244-peak', generate };
export default recipe;
