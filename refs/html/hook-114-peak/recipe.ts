// Compiled recipe — hook-114-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// Hand-scrawled yellow Gochi Hand captions revealed glyph-by-glyph with a rising fade; each beat a
// centered column of small "whisper" lead-in lines over one BIG punch line whose accent word pops in
// as a whole word with a scale-overshoot. EVERY beat: a spinning pink star pops in tucked into the
// accent's corner on the accent's own delay, and the accent gets a drawn underline right after.
// NOTE (report-only, not automated): the sheet's bottom-bounds fix (reduce the flagged cue's top by
// overshoot+8px, never more than 16px) moves a slot, not a ladder — the runner only demotes, so that
// FAIL is reported honestly. Slot tops are ≥80px apart by construction, so it should not fire.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const PUNCH_MAX_CHARS = 14;
const SETUP_LINE_CHARS = 23;
const SETUP_MAX_LINES = 3;
const GLYPH_STAGGER_MS = 45;
const END_SAFE_MS = 450; // Lsafe = cueEnd − 450
const GIN_TAIL_MS = 40; // late-word shorthand duration = cueEnd − d − 40
const BIGPOP_LEAD_MS = 560;
const BIGPOP_TAIL_MS = 60;
const DOODLE_LAG_MS = 250;
const DOODLE_SAFE_MS = 460;
const LINE_GAP = 6; // tight stack (curation 2026-07-21; was flex gap 31)

// Curation 2026-07-21: the 6-slot scatter is replaced by TWO zones — POS#1 (top, 150) and POS#2
// (lower third, 810) — beats alternate zones; the engine (≥0.6.0) verifies through the cue gate, so
// cross-beat top reuse is safe. Same pass: tight leading, the transplanted star under the accent
// word (pink, ×2 cap height, TL/BR/BL/TR corner pattern), a single drawn underline, white accent.
const POS_TOPS = [150, 810];
const STAR_COLOR = '#ec307d'; // transplanted pink — kept verbatim (art-directed)
const STAR_CLIP = 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)';
const ADV_EM = 0.48; // Gochi Hand advance em/char — MEASURED off real renders (0.58 was the ladder's conservative budget, ~20% wide)
const SPACER_EM = 0.3;
const CUE_W = 608;

// {S} punch / {B} accent px by PUNCH chars incl spaces (width-budgeted at 0.58em/char, accent 1.2×)
const PUNCH_LADDER = [
  { cls: '', maxC: 9, S: 82, B: 98 },
  { cls: '', maxC: 11, S: 78, B: 94 },
  { cls: '', maxC: 13, S: 66, B: 79 },
  { cls: '', maxC: 14, S: 62, B: 74 },
  { cls: '', maxC: 17, S: 51, B: 61 },
  { cls: '', maxC: 20, S: 43, B: 52 },
];
// small-line fallback by the line's char count; 45 = the .lns default (no inline style)
const LEAD_LADDER = [
  { cls: '', maxC: 23, size: 45 },
  { cls: '', maxC: 26, size: 40 },
  { cls: '', maxC: 30, size: 34 },
  { cls: '', maxC: 34, size: 30 },
];

export const charsIn = (ws: WordTiming[]) => ws.reduce((s, w) => s + w.w.length, 0) + Math.max(0, ws.length - 1);

// PUNCH = from the beat's LAST word, prepending while total chars ≤ 14 (min 1 word); SETUP = the rest.
export function splitPunch(words: WordTiming[]): { setup: WordTiming[]; punch: WordTiming[] } {
  let k = words.length - 1;
  while (k > 0 && charsIn(words.slice(k - 1)) <= PUNCH_MAX_CHARS) k--;
  return { setup: words.slice(0, k), punch: words.slice(k) };
}

// L = min(3, ceil(chars/23)), T = ceil(chars/L); lines 1..L−1 fill to T (never left empty), line L takes the rest.
export function splitSetupLines(setup: WordTiming[]): WordTiming[][] {
  if (!setup.length) return [];
  const total = charsIn(setup);
  const L = Math.min(SETUP_MAX_LINES, Math.ceil(total / SETUP_LINE_CHARS));
  const T = Math.ceil(total / L);
  const lines: WordTiming[][] = [];
  let i = 0;
  for (let j = 1; j < L; j++) {
    const line: WordTiming[] = [setup[i++]];
    while (i < setup.length - (L - j) && charsIn([...line, setup[i]]) <= T) line.push(setup[i++]);
    lines.push(line);
  }
  lines.push(setup.slice(i));
  return lines;
}

const strip = (w: string) => w.replace(/[^\p{L}\p{N}]+/gu, '');

// E: digit-bearing PUNCH word (later wins tie), else most chars after stripping punctuation (tie → later).
export function accentIdx(punch: WordTiming[]): number {
  let best = -1;
  for (let i = 0; i < punch.length; i++) if (/\d/.test(punch[i].w)) best = i;
  if (best >= 0) return best;
  for (let i = 0; i < punch.length; i++) if (best < 0 || strip(punch[i].w).length >= strip(punch[best].w).length) best = i;
  return best;
}

export function slotFor(n: number): { top: number } {
  return { top: POS_TOPS[(n - 1) % 2] };
}

// star corner by beat: TL, BR, BL, TR, repeating (curation pattern)
export function starCorner114(n: number): 'tl' | 'br' | 'bl' | 'tr' {
  return (['tl', 'br', 'bl', 'tr'] as const)[(n - 1) % 4];
}

export function doodleDelayMs(eDelayMs: number, cueDelayMs: number, cueDurMs: number): number {
  return Math.min(eDelayMs + DOODLE_LAG_MS, cueDelayMs + cueDurMs - DOODLE_SAFE_MS);
}

export function punchRowFor(C: number, demoteRows = 0) {
  return pickRow(PUNCH_LADDER, C, demoteRows) as (typeof PUNCH_LADDER)[number];
}
export function leadRowFor(C: number, demoteRows = 0) {
  return pickRow(LEAD_LADDER, C, demoteRows) as (typeof LEAD_LADDER)[number];
}

// One span per glyph, delayMs verbatim as glyph 0 + 45ms stagger; the sheet's end clamp shrinks the
// stagger to fit Lsafe, and a word starting past Lsafe gets the full inline gIn shorthand (st = 0).
export function glyphWordHtml(w: WordTiming, cueEndMs: number, cls = 'g'): string {
  const glyphs = [...w.w];
  const lsafe = cueEndMs - END_SAFE_MS;
  if (w.delayMs > lsafe) {
    const anim = `animation:gIn ${cueEndMs - w.delayMs - GIN_TAIL_MS}ms cubic-bezier(.2,.7,.3,1) ${w.delayMs}ms both`;
    return glyphs.map((g) => `<span class="${cls}" style="${anim}">${escapeHtml(g)}</span>`).join('');
  }
  let st = GLYPH_STAGGER_MS;
  if (glyphs.length > 1 && w.delayMs + (glyphs.length - 1) * st > lsafe) {
    st = Math.max(0, Math.floor((lsafe - w.delayMs) / (glyphs.length - 1)));
  }
  return glyphs.map((g, k) => `<span class="${cls}" style="animation-delay:${w.delayMs + k * st}ms">${escapeHtml(g)}</span>`).join('');
}

// the spacer IS the space (inter-span whitespace is dropped); {d} = the NEXT word's delayMs
const spacerHtml = (nextDelayMs: number) => `<span class="g" style="width:0.3em;animation-delay:${nextDelayMs}ms">&nbsp;</span>`;

function bigSpanHtml(w: WordTiming, bPx: number, cueEndMs: number): string {
  const style = w.delayMs + BIGPOP_LEAD_MS > cueEndMs
    ? `font-size:${bPx}px;animation:bigPop ${cueEndMs - w.delayMs - BIGPOP_TAIL_MS}ms cubic-bezier(.2,.8,.25,1) ${w.delayMs}ms both`
    : `font-size:${bPx}px;animation-delay:${w.delayMs}ms`;
  return `<span class="big" style="${style}">${escapeHtml(w.w)}</span>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

  const cues = timings.beats.map((beat, idx) => {
    const N = beat.i;
    const cueEnd = beat.cueDelayMs + beat.cueDurMs;
    const { setup, punch } = splitPunch(beat.words);
    const e = accentIdx(punch);
    const lines: string[] = [];
    const setupRows: number[] = [];
    splitSetupLines(setup).forEach((line, k) => {
      const id = `b${N}s${k + 1}`;
      const row = leadRowFor(charsIn(line), demotionFor(demote, id));
      setupRows.push(row.size);
      const sizeStyle = row.size === 45 ? '' : ` style="font-size:${p(row.size)}px"`;
      const spans = line.map((w, i) => (i ? spacerHtml(w.delayMs) : '') + glyphWordHtml(w, cueEnd)).join('');
      lines.push(`  <div class="lns" id="${id}" data-node-role="text"${sizeStyle}>${spans}</div>`);
    });
    const prow = punchRowFor(charsIn(punch), demotionFor(demote, `b${N}p`));
    const corner = starCorner114(N);
    const pspans = punch
      .map((w, i) => (i ? spacerHtml(w.delayMs) : '') + (i === e ? bigSpanHtml(w, p(prow.B), cueEnd) : glyphWordHtml(w, cueEnd, 'g gz')))
      .join('');
    lines.push(`  <div class="lnb" id="b${N}p" data-node-role="text" style="font-size:${p(prow.S)}px">${pspans}</div>`);

    // accent geometry off the MEASURED Gochi advance (0.48em/char, read off real renders)
    const slot = slotFor(N);
    const widths = punch.map((w, i) => ADV_EM * (i === e ? prow.B : prow.S) * [...w.w].length);
    const totalW = widths.reduce((a, b) => a + b, 0) + SPACER_EM * prow.S * (punch.length - 1);
    const accL = (CUE_W - totalW) / 2 + widths.slice(0, e).reduce((a, b) => a + b, 0) + SPACER_EM * prow.S * e;
    const accW = widths[e];
    const punchTop = setupRows.reduce((a, sz) => a + sz * 1.21, 0) + LINE_GAP * setupRows.length;
    const B = prow.B;

    // the 047 star — cue-level sibling UNDER the text layers (the reliable layout; a child of the
    // animated word reflows in this engine). v5: its CENTRE sits 0.3B diagonally INSIDE the word
    // from the pattern corner (the drawn dot), so half the star tucks behind the accent; it pops in
    // on the accent word's own delay (beat-start placement tried and rejected 2026-07-21).
    const IN = 0.3 * B;
    const scx = corner === 'tl' || corner === 'bl' ? accL + IN : accL + accW - IN;
    const scy = corner === 'tl' || corner === 'tr' ? punchTop + 0.08 * B + IN : punchTop + 0.98 * B - IN;
    lines.push(`  <div class="star" id="b${N}star" style="left:${p(scx - B)}px; top:${p(scy - B)}px; width:${p(2 * B)}px; height:${p(2 * B)}px; animation-delay:${punch[e].delayMs}ms"><i></i></div>`);

    // v5: EVERY beat underlines its accent (was beat 1 + final only)
    const dd = doodleDelayMs(punch[e].delayMs, beat.cueDelayMs, beat.cueDurMs);
    lines.push(`  <div class="ul" id="b${N}d" style="left:${p(accL)}px; top:${p(punchTop + 1.02 * B)}px; width:${p(accW)}px; animation-delay:${dd}ms"></div>`);
    return `<div class="cue" id="cue${N}" style="top:${p(slot.top)}px; animation:cueWin ${beat.cueDurMs}ms linear ${beat.cueDelayMs}ms forwards">
${lines.join('\n')}
</div>`;
  });

  const wv = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gochi+Hand&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; }
  body { position: relative; overflow: hidden; background: #101010; }

  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* beat gate — opacity-trap-safe: absolute + explicit z-index, gated on the cue itself */
  .cue { position: absolute; left: ${p(46)}px; width: ${p(608)}px; z-index: 12; opacity: 0;
         display: flex; flex-direction: column; align-items: center; gap: ${p(LINE_GAP)}px;
         font-family: "Gochi Hand", cursive; color: #f5cf00; text-align: center;
         text-shadow: 0 ${p(2)}px ${p(5)}px rgba(0,0,0,0.45); }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }

  /* tight leading (curation 2026-07-21). Layering: setup lines (z4) ride above the punch line (z3)
     so the accent's corner star can never cover them; inside the punch line the non-accent glyphs
     carry .gz (z2) to stay above the star (z1). */
  .lns { font-size: ${p(45)}px; line-height: 1.05; padding-bottom: 0.16em; white-space: nowrap;
         position: relative; z-index: 4; }
  .lnb { line-height: 1.05; padding-bottom: 0.16em; white-space: nowrap;
         position: relative; z-index: 3; }
  .gz { position: relative; z-index: 2; }

  /* per-glyph reveal (the ref's signature) */
  .g { display: inline-block; opacity: 0; animation: gIn .4s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes gIn { 0%{opacity:0;transform:translateY(0.5em)} 100%{opacity:1;transform:translateY(0)} }

  /* accent word pops in as ONE word, overshooting its final size — WHITE (curation 2026-07-21) */
  .big { display: inline-block; opacity: 0; animation: bigPop .5s cubic-bezier(.2,.8,.25,1) both;
         transform-origin: 50% 75%; color: #ffffff; position: relative; }
  @keyframes bigPop { 0%{opacity:0;transform:scale(.4)} 55%{opacity:1;transform:scale(1.28)} 100%{opacity:1;transform:scale(1)} }
  /* the 047 star — pink clip-path, absolute in CUE coords, painted UNDER the text lines
     (.lns z4 / .lnb z3 / .star z1); the WRAPPER pops in on the accent's delay, the inner <i>
     spins forever on its own axis (the 047 wrapper/inner split) */
  .star { position: absolute; z-index: 1; opacity: 0;
          animation: starPop .45s cubic-bezier(.2,.7,.3,1) both; }
  .star i { position: absolute; inset: 0; display: block; background: ${STAR_COLOR};
            clip-path: ${STAR_CLIP}; transform-origin: center;
            animation: stSpin 5.6s linear infinite; }
  @keyframes starPop { 0% { opacity: 0; transform: scale(0.55); }
                       65% { opacity: 1; transform: scale(1.07); }
                       100% { opacity: 1; transform: scale(1); } }
  @keyframes stSpin { 0% { transform: rotate(-14deg); } 100% { transform: rotate(346deg); } }

  /* single accent underline, drawn left → right (scaleX from the left edge) */
  .ul { position: absolute; z-index: 2; height: ${p(5)}px; background: #f5cf00;
        border-radius: ${p(3)}px; opacity: 0; transform: scaleX(0); transform-origin: 0 50%;
        animation: ulDraw .45s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes ulDraw { 0% { opacity: 1; transform: scaleX(0); } 100% { opacity: 1; transform: scaleX(1); } }
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

const recipe: RecipeGenerator = { refId: 'hook-114-peak', generate };
export default recipe;
