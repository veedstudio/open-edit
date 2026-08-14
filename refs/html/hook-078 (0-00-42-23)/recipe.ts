// Compiled recipe — hook-078 (0-00-42-23) · movie-poster credits card (9:16, authored at 736×1312 @25fps).
// Source sheet: ./recipe.md. Constant red Albert Sans credits chrome sits directly on the raw footage
// (no panel/scrim) around a big DM-Serif-Display-italic headline (the spoken beat); words rise in on their
// real timings; ONE +HERO accent per beat. Word gap = margin-right:0.3em PLUS a trailing &#160; inside the
// span text — italic ink overhang eats a bare gap; BOTH parts are required (validated offline).
// Only the sheet's bounds fix is automated via opts.demote (size class steps DOWN the ladder on ALL the
// beat's lines, tops re-read from the new row; keys = the b{N}l{K} ids --verify names). The sheet's
// never-visible / occluded / exit-2 fixes are diagnostic checklists, not ladder steps — report-only.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

export interface Row078 { cls: string; maxC: number; tops: [number, number, number] } // line2/3/4 tops

// C (longest line, chars incl +/'/- and inter-unit spaces) → class + line tops; line1 is always 571.
// The 480px width budget, −0.026em tracking and the prefab's 0.92 leading are baked into these numbers.
// Ladder = the prior ladder ×1.12 (the sheet's main-quote bump), same C-row boundaries.
export const LADDER: Row078[] = [
  { cls: 't140', maxC: 6, tops: [700, 829, 958] },
  { cls: 't120', maxC: 7, tops: [681, 791, 901] },
  { cls: 't105', maxC: 8, tops: [667, 763, 859] },
  { cls: 't93', maxC: 9, tops: [656, 741, 826] },
  { cls: 't84', maxC: 10, tops: [648, 725, 802] },
  { cls: 't76', maxC: 11, tops: [642, 713, 784] },
  { cls: 't69', maxC: 12, tops: [635, 699, 763] },
  { cls: 't64', maxC: 13, tops: [629, 687, 745] },
  { cls: 't59', maxC: 14, tops: [626, 681, 736] },
  { cls: 't56', maxC: 15, tops: [623, 675, 727] },
  { cls: 't53', maxC: 16, tops: [619, 667, 715] },
  { cls: 't49', maxC: 17, tops: [616, 661, 706] },
  { cls: 't46', maxC: 18, tops: [614, 657, 700] },
  { cls: 't44', maxC: 19, tops: [611, 651, 691] },
  { cls: 't41', maxC: 20, tops: [609, 647, 685] },
  { cls: 't39', maxC: 21, tops: [607, 643, 679] },
  { cls: 't38', maxC: 22, tops: [606, 641, 676] },
  { cls: 't36', maxC: 23, tops: [603, 635, 667] },
  { cls: 't35', maxC: 24, tops: [603, 635, 667] },
  { cls: 't34', maxC: 25, tops: [602, 633, 664] },
  { cls: 't31', maxC: 26, tops: [600, 629, 658] },
  { cls: 't30', maxC: 28, tops: [599, 627, 655] },
  { cls: 't28', maxC: 30, tops: [597, 623, 649] },
  { cls: 't25', maxC: 33, tops: [593, 615, 637] },
  { cls: 't22', maxC: Infinity, tops: [591, 611, 631] },
];
const LINE1_TOP = 571;
// Curation 2026-07-21: whole stack rides 27px lower (line-1 ink top ≈598); applied to every line so
// the ladder's leading survives; bottom-block clearance re-checked (L3 cap ink bottom ≈946 < 980).
const STACK_DROP = 27;
// Caps held near their pre-bump absolute reach (sheet: hard vertical ceiling vs the bottom block).
const CAP_L3 = LADDER.findIndex((r) => r.cls === 't93');
const CAP_L4 = LADDER.findIndex((r) => r.cls === 't76');

// Strip trailing . and , only; keep ? ! ' - (internal punctuation untouched).
export function stripWord(w: string): string {
  return w.replace(/[.,]+$/, '');
}

// Height caps FIRST (L=3 → never above t93, L=4 → never above t76), then the C row, then demotion.
export function rowFor(C: number, lineCount: number, demoteRows = 0): Row078 {
  const capIdx = lineCount >= 4 ? CAP_L4 : lineCount === 3 ? CAP_L3 : 0;
  return pickRow(LADDER.slice(capIdx), C, demoteRows) as Row078;
}

// L = min(4, ceil(n/2)) (n=1 → 1); first (n mod L) lines take base+1 CONSECUTIVE units, rest base.
export function linesFor(units: Unit[]): Unit[][] {
  const n = units.length;
  if (!n) return [];
  const L = Math.min(4, Math.ceil(n / 2));
  const base = Math.floor(n / L);
  const extra = n % L;
  const lines: Unit[][] = [];
  let i = 0;
  for (let k = 0; k < L; k++) {
    const take = base + (k < extra ? 1 : 0);
    lines.push(units.slice(i, i + take));
    i += take;
  }
  return lines;
}

// Digit-bearing unit first; else most LETTERS (+ ' - ? ! etc. ignored); tie → the LATER unit.
export function heroIndex(units: Unit[]): number {
  const digit = units.findIndex((u) => u.spans.some((s) => /\d/.test(s.text)));
  if (digit >= 0) return digit;
  const letters = (u: Unit) => u.spans.reduce((n, s) => n + (s.text.match(/[a-z]/gi)?.length ?? 0), 0);
  let best = 0;
  for (let i = 1; i < units.length; i++) if (letters(units[i]) >= letters(units[best])) best = i;
  return best;
}

function lineHtml(line: Unit[], id: string, cls: string, topPx: number): string {
  const spans: string[] = [];
  line.forEach((u, ui) => {
    u.spans.forEach((s, si) => {
      // glued partner span: gap zeroed inline, NO trailing &#160; so the pair renders joined (TO-DO)
      const glued = si < u.spans.length - 1;
      const last = ui === line.length - 1 && si === u.spans.length - 1;
      const style = `animation-delay:${s.delayMs}ms${glued ? '; margin-right:0' : ''}`;
      spans.push(`<span class="w" style="${style}">${escapeHtml(s.text)}${glued || last ? '' : '&#160;'}</span>`);
    });
  });
  return `  <div class="tl ${cls}" id="${id}" data-node-id="${id}" data-node-role="text" style="top:${topPx}px">${spans.join('')}</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 736, 1312);
  const p = pxScaler(scale);
  // fractional px (the 0.5px tracking): integer rounding would break SCALE=1 verbatim
  const ph = (n: number) => Math.round(n * scale * 100) / 100;
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) => {
      const units = toUnits(beat.words.map((w) => ({ ...w, w: stripWord(w.w) })).filter((w) => w.w));
      if (!units.length) return '';
      const hero = units[heroIndex(units)];
      hero.spans[0].text = `+${hero.spans[0].text}`; // the + counts as a character
      hero.chars += 1;
      const lines = linesFor(units);
      const C = Math.max(...lines.map(charsOf));
      const ids = lines.map((_, k) => `b${beat.i}l${k + 1}`);
      const row = rowFor(C, lines.length, demotionFor(demote, ...ids));
      const winMs = winMsFor(timings.beats, idx, meta.durationSec);
      const divs = lines.map((ln, k) => lineHtml(ln, ids[k], row.cls, p((k === 0 ? LINE1_TOP : row.tops[k - 1]) + STACK_DROP)));
      return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}"
     style="z-index:${10 + beat.i};animation-delay:${beat.cueDelayMs}ms;animation-duration:${winMs}ms">
${divs.join('\n')}
</div>`;
    })
    .filter(Boolean);

  const wv = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@1&family=Albert+Sans:wght@700;800;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${p(736)}px; height:${p(1312)}px; overflow:hidden; background:#000; }
  body { position:relative; font-family:'Albert Sans',sans-serif; }
  .vid { position:absolute; inset:0; width:${p(736)}px; height:${p(1312)}px; object-fit:cover; z-index:0; }

  /* persistent credits chrome — fixed text, revealed once at clip start, up for the whole video */
  .chrome { position:absolute; z-index:2; color:#e62129; white-space:nowrap; }
  #tagl    { left:${p(110)}px; top:${p(172)}px; font-weight:700; font-size:${p(15)}px; letter-spacing:${p(1)}px; line-height:${p(22)}px; }
  #tagr    { right:${p(146)}px; top:${p(172)}px; text-align:right; font-weight:700; font-size:${p(15)}px; letter-spacing:${p(1)}px; line-height:${p(22)}px; }
  /* bottom block — ONE anchor, four lines top-to-bottom; #sub2's ink bottom lands ~1084px (<1089px) */
  #basedon { left:${p(73)}px; width:${p(554)}px; top:${p(980)}px; text-align:center; font-weight:700; font-size:${p(14)}px; letter-spacing:${p(2)}px; line-height:1; }
  #embreve { left:${p(73)}px; width:${p(554)}px; top:${p(999)}px; text-align:center; font-weight:800; font-size:${p(41)}px; letter-spacing:${p(3)}px; line-height:1; }
  #sub1    { left:${p(73)}px; width:${p(554)}px; top:${p(1051)}px; text-align:center; font-weight:800; font-size:${p(14)}px; letter-spacing:${ph(0.5)}px; line-height:1; }
  #sub2    { left:${p(73)}px; width:${p(554)}px; top:${p(1070)}px; text-align:center; font-weight:800; font-size:${p(14)}px; letter-spacing:${ph(0.5)}px; line-height:1; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }

  /* headline line — ABSOLUTE lines (the engine has no half-leading); the per-row tops ARE the 0.92 leading;
     line-height stays 1. padding-bottom is wordIn rise headroom — without it the engine shears a
     rising glyph's bottom at the box edge mid-reveal.
     ALIGNMENT LAW: left here MUST equal #tagl's left (110px) — one shared flush-left edge, every beat. */
  .tl { position:absolute; left:${p(110)}px; z-index:1; white-space:nowrap; padding-bottom:0.3em;
        font-family:'DM Serif Display',serif; font-style:italic; font-weight:400; /* DM Serif ships italic 400 only */
        color:#e62129; letter-spacing:-0.026em; line-height:1; text-transform:uppercase; }

  /* size ladder (width budget 480px already baked in — pick by the C table only) */
  .t140{font-size:${p(140)}px} .t120{font-size:${p(120)}px} .t105{font-size:${p(105)}px} .t93{font-size:${p(93)}px}
  .t84{font-size:${p(84)}px}   .t76{font-size:${p(76)}px}   .t69{font-size:${p(69)}px} .t64{font-size:${p(64)}px}
  .t59{font-size:${p(59)}px}   .t56{font-size:${p(56)}px}   .t53{font-size:${p(53)}px} .t49{font-size:${p(49)}px}
  .t46{font-size:${p(46)}px}   .t44{font-size:${p(44)}px}   .t41{font-size:${p(41)}px} .t39{font-size:${p(39)}px}
  .t38{font-size:${p(38)}px}   .t36{font-size:${p(36)}px}   .t35{font-size:${p(35)}px} .t34{font-size:${p(34)}px}
  .t31{font-size:${p(31)}px}   .t30{font-size:${p(30)}px}   .t28{font-size:${p(28)}px} .t25{font-size:${p(25)}px}
  .t22{font-size:${p(22)}px}

  /* word reveal — keep position:relative + z-index:1 (the prefab's .w stacking trick).
     Word gap = 0.3em margin PLUS the trailing &#160; in the span text — italic caps can overhang
     their advance and eat a bare gap. The vertical padding is descender headroom. Never shrink these. */
  .w  { display:inline-block; position:relative; z-index:1; opacity:0;
        margin-right:0.3em; padding-bottom:0.2em; padding-top:0.1em;
        animation:wordIn 0.3s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes wordIn { 0%{opacity:0; transform:translateY(0.16em)} 100%{opacity:1; transform:translateY(0)} }
</style>
</head>
<body>
  <video class="vid" src="${meta.videoPath}" muted></video>
  <div id="tagl" class="chrome" data-node-role="text"><span class="w" style="animation-delay:0ms">THE&#160;</span><span class="w" style="animation-delay:90ms">INTERNET</span></div>
  <div id="tagr" class="chrome" data-node-role="text"><span class="w" style="animation-delay:180ms">PRESENTS</span></div>
  <div id="basedon" class="chrome" data-node-role="text"><span class="w" style="animation-delay:270ms">BASED&#160;</span><span class="w" style="animation-delay:330ms">ON&#160;</span><span class="w" style="animation-delay:390ms">A&#160;</span><span class="w" style="animation-delay:450ms">TRUE&#160;</span><span class="w" style="animation-delay:510ms">STORY</span></div>
  <div id="embreve" class="chrome" data-node-role="text"><span class="w" style="animation-delay:590ms">COMING&#160;</span><span class="w" style="animation-delay:670ms">SOON</span></div>
  <div id="sub1" class="chrome" data-node-role="text"><span class="w" style="animation-delay:730ms">LIKE,&#160;</span><span class="w" style="animation-delay:790ms">REALLY&#160;</span><span class="w" style="animation-delay:850ms">SOON</span></div>
  <div id="sub2" class="chrome" data-node-role="text"><span class="w" style="animation-delay:890ms">TRUST&#160;</span><span class="w" style="animation-delay:930ms">US&#160;</span><span class="w" style="animation-delay:970ms">:P</span></div>
${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-078 (0-00-42-23)', generate };
export default recipe;
