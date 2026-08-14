// Compiled recipe — hook-086-peak (16:9, authored at 1280×720 @24fps). Source sheet: ./recipe.md.
// Inter phrases resolving word-by-word at dead center over full-bleed footage, at HALF the old display
// size (the giant p236…p53 ladder became p118…p26, tracking re-tuned per row — it opens up as the size
// falls). The reveal is an Apple-style FOCUS PULL: each word slides in from the RIGHT on a cubic
// ease-out while a softly defocused copy of it resolves into the sharp one. Nothing else is on screen —
// no plate, no panel, no backdrop; plain white type over the footage from first beat to last.
//   ENGINE FACT A (probe: animated-blur-holds): an ANIMATED `filter: blur()` holds the keyframe's
//   INITIAL value and never ramps; opacity and transform in the SAME keyframes interpolate normally.
//   Only a STATIC filter renders, so a real blur ramp is impossible. An animated `clip-path` is NOT
//   the same case — it does interpolate (probe: animated-clip-path, refuted).
//   ENGINE FACT B (measured on the same fixture): `filter: blur()` ignores `em` — `blur(0.2em)`
//   renders perfectly SHARP while an equivalent `blur(23.6px)` renders. Filter lengths must be px,
//   which means the defocus cannot ride the font-size cascade — it is computed per ladder row from
//   that row's px size and written INLINE on the span.
//   So the ramp is a STEPPED focus pull, the nearest thing this engine can do: three stacked copies of
//   the word — a soft ghost, a softer ghost and the sharp ink — relayed by opacity keyframes (opacity
//   IS solid), so the defocus falls 0.09em → 0.032em → 0. The steps are shallow and their opacity
//   ramps OVERLAP, so it reads as a gentle softening rather than as three copies. The wrapper carries
//   the slide ONLY: any opacity on it would multiply into the ghosts and flatten the pull into a glow.
// Colour is monochrome: one Apple off-white (#f5f5f7) at two luminance levels — recessive body words,
// the beat's single accent word at full strength. No hue anywhere (the old black ink and blue accent
// are gone), so the per-beat ink switch and the stacked `.fx` colour copy are gone with it. The ink's
// only shadow is one tight low-alpha contact shadow — a heavy halo reads as grime around the type.
// Non-ladder verify fixes (top/bottom re-check, never-visible → timing/z audit, occluded → window
// audit) are NOT automated — the runner only demotes ladders; those failures are reported honestly.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow, type Unit,
  accentIndex, demotionFor, escapeHtml, manifestFor, paginate, pickRow, pgOutDelayMs,
  pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// sheet §3 tables — one row per effective char count (caps/digits weigh 1.3). Half the old display
// sizes: the line now fills ~570px of the 1140px box, and the air is the point.
const PAGE_SIZES = [118, 108, 98, 90, 83, 77, 72, 67, 63, 60, 57, 54, 51, 49, 47, 45, 43,
  41, 40, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26];
const PAGE_LADDER: LadderRow[] = PAGE_SIZES.map((s, i) => ({
  cls: `p${s}`, maxC: i < PAGE_SIZES.length - 1 ? i + 9 : Infinity,
}));
const PAGE_MAX_CHARS = 30;
const PAGE_MAX_UNITS = 5;
const MID_Y = 360;       // card vertical middle
const PG_OUT_MS = 120;
const SLIDE_PX = 28;     // right-to-left travel at the reference canvas (scales with p())
// Defocus steps as a FRACTION of the row's font size — resolved to px per row (filter ignores em).
// Deliberately shallow: a subtle pull, not a smear, and the two steps sit close enough together that
// the handoff reads as softening rather than as three stacked copies.
const GHOST_HEAVY = 0.09;
const GHOST_SOFT = 0.032;
const EASE_OUT_CUBIC = 'cubic-bezier(0.215, 0.61, 0.355, 1)';

// Word prep: strip a trailing `.` or `,`; keep `?` `!` `'` and internal punctuation; case preserved.
export function stripWord(w: string): string {
  return w.replace(/[.,]$/, '');
}

// Units keep their case + VEED glue: a leading-`-` token merges with the previous word into ONE unit,
// each span keeping its own verbatim delay.
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

// Effective chars: caps/digits/currency weigh 1.3 (measured 0.675em vs 0.512em lowercase), +1 per gap.
export function effChars(units: Unit[]): number {
  let c = Math.max(0, units.length - 1);
  for (const u of units) for (const s of u.spans) for (const ch of s.text) c += /[A-Z0-9£$€@#%&]/.test(ch) ? 1.3 : 1;
  return Math.ceil(c);
}

// Tracking is a function of SIZE, not a constant: the eye reads inter-letter distance non-linearly, so
// tracking falls as type grows and opens as it shrinks. Linear between the ladder's two ends —
// −0.012em at the 118px row, +0.014em at the 26px row — and applied per ladder row on the same line.
export function trackEm(fs: number): number {
  return Math.round((0.014 + (fs - 26) * (-0.026 / 92)) * 10000) / 10000;
}

// The reveal is longer than a pop — a focus pull needs room to resolve; it still compresses so a late
// word lands before its gate cuts it.
export function inMs086(availMs: number): number {
  return Math.min(560, Math.max(260, availMs - 80));
}

export function pageTopRef(fs: number): number {
  return Math.round(MID_Y - 0.65 * fs);
}

function fsOf(cls: string): number {
  return parseInt(cls.slice(1), 10);
}

// One word = a `.w` wrapper carrying the slide, over THREE stacked copies of the same text: the heavy
// `.g1` ghost, the soft `.g2` ghost and the sharp ink, relayed by opacity. The blur radii are written
// inline in px off the row's font size — `filter` ignores em, so they cannot ride the cascade. The
// wrapper never animates opacity (that would multiply into the ghosts).
function spansHtml(u: Unit, inkCls: string, cueEndMs: number, fs: number, p: (n: number) => number): string {
  const b1 = Math.max(2, p(fs * GHOST_HEAVY));
  const b2 = Math.max(1, p(fs * GHOST_SOFT));
  return u.spans
    .map((s, i) => {
      const glue = i < u.spans.length - 1 ? ';margin-right:0' : '';
      const inMs = inMs086(cueEndMs - s.delayMs);
      const t = `animation-delay:${s.delayMs}ms;animation-duration:${inMs}ms`;
      const text = escapeHtml(s.text);
      return `<span class="w" style="${t}${glue}">`
        + `<span class="g1" style="${t};filter:blur(${b1}px)">${text}</span>`
        + `<span class="g2" style="${t};filter:blur(${b2}px)">${text}</span>`
        + `<span class="${inkCls}" style="${t}">${text}</span></span>`;
    })
    .join('');
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 1280, 720));
  const demote = opts.demote ?? {};
  const beats = timings.beats;

  const cues = beats.map((beat, idx) => {
    const N = beat.i;
    const units = unitsFor(beat.words);
    if (!units.length) return '';
    const winMs = winMsFor(beats, idx, meta.durationSec);
    const cueEnd = beat.cueDelayMs + winMs;
    const pages = paginate(units, PAGE_MAX_CHARS, PAGE_MAX_UNITS);
    // accent: digit unit first, else most chars, tie later
    const accent = accentIndex(units);

    let at = 0;
    const rows = pages.map((page, j) => {
      const id = `b${N}p${j + 1}`;
      const isLastPage = j === pages.length - 1;
      const accentAt = accent >= at && accent < at + page.length ? accent - at : -1;
      at += page.length;
      // the row's px size is needed BEFORE the spans: it sets each ghost's inline blur radius
      const html = (fs: number, base: string, hi: string) =>
        page.map((u, k) => spansHtml(u, k === accentAt ? hi : base, cueEnd, fs, p)).join('');
      const row = pickRow(PAGE_LADDER, effChars(page), demotionFor(demote, id));
      const out = isLastPage
        ? ''
        : ` po" style="top:${p(pageTopRef(fsOf(row.cls)))}px;animation-delay:${pgOutDelayMs(page, pages[j + 1][0].spans[0].delayMs, PG_OUT_MS)}ms;animation-duration:${PG_OUT_MS}ms`;
      const attr = out || `" style="top:${p(pageTopRef(fsOf(row.cls)))}px`;
      return `  <div class="pg ${row.cls}${attr}" id="${id}" data-node-id="${id}" data-node-role="text">${html(fsOf(row.cls), 'ik', 'ia')}</div>`;
    });

    return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${winMs}ms">
${rows.join('\n')}
</div>`;
  }).filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; overflow: hidden; }
  body { position: relative; background: #000; font-family: 'Inter', Arial, Helvetica, sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; animation-name: cueWin;
         animation-timing-function: linear; animation-fill-mode: forwards; }

  /* a page = ONE centered nowrap line; pages of a beat take turns at the card's center.
     letter-spacing is NOT set here — it rides the size class, because tracking is a function of size */
  .pg { position: absolute; left: ${p(70)}px; width: ${p(1140)}px; text-align: center; white-space: nowrap;
        font-weight: 700; line-height: 1.3; }
  .po { animation-name: pgOut; animation-timing-function: linear; animation-fill-mode: both; }
  @keyframes pgOut { 0% { opacity: 1; } 100% { opacity: 0; } }

  /* THE FOCUS PULL — three parts, and only the first one moves.
     1. the wrapper slides right-to-left and settles on a cubic ease-out. Both ends authored; it
        carries NO opacity, or that opacity would multiply into the ghosts and kill the defocus. */
  @keyframes wIn { 0% { transform: translateX(${p(SLIDE_PX)}px); } 100% { transform: translateX(0px); } }
  .w  { display: inline-block; position: relative; margin-right: 0.3em;
        animation-name: wIn; animation-timing-function: ${EASE_OUT_CUBIC}; animation-fill-mode: both; }
  /*  2. the two ghosts: STATICALLY blurred copies stacked over the ink (an ANIMATED blur holds the
        keyframe's INITIAL value for the whole run, and filter ignores em — so the ramp is a relay of
        opacity across copies whose px radii are written inline per ladder row).
        The three stages OVERLAP rather than meet at a point — a ghost is still dissolving while the
        next stage is already coming up, so the pull reads as one continuous softening rather than as
        three stacked copies handing off. No text-shadow on a ghost: a shadow under a blurred copy is
        exactly what reads as grime.
        Explicit z-index — a positioned element animating opacity with none falls under the video. */
  @keyframes g1In { 0% { opacity: 0; } 20% { opacity: 1; } 55% { opacity: 0; } 100% { opacity: 0; } }
  @keyframes g2In { 0% { opacity: 0; } 16% { opacity: 0; } 50% { opacity: 1; } 84% { opacity: 0; } 100% { opacity: 0; } }
  .g1 { position: absolute; left: 0; top: 0; z-index: 3; opacity: 0; color: rgba(245,245,247,0.8);
        animation-name: g1In; animation-timing-function: linear; animation-fill-mode: both; }
  .g2 { position: absolute; left: 0; top: 0; z-index: 2; opacity: 0; color: rgba(245,245,247,0.85);
        animation-name: g2In; animation-timing-function: linear; animation-fill-mode: both; }
  /*  3. the ink: sharp, in flow (it is the wrapper's box), arriving as the soft ghost dissolves. Two
        luminance levels of ONE off-white are the whole colour system — no hue, ever. The shadow is a
        single tight contact shadow at low alpha: enough to lift plain white type off the footage,
        light enough that it never reads as dirt. */
  @keyframes ikIn { 0% { opacity: 0; } 46% { opacity: 0; } 82% { opacity: 1; } 100% { opacity: 1; } }
  .ik { display: inline-block; opacity: 0; color: rgba(245,245,247,0.9);
        text-shadow: 0 ${p(1)}px ${p(3)}px rgba(0,0,0,0.3);
        animation-name: ikIn; animation-timing-function: linear; animation-fill-mode: both; }
  .ia { display: inline-block; opacity: 0; color: #f5f5f7;
        text-shadow: 0 ${p(1)}px ${p(3)}px rgba(0,0,0,0.34);
        animation-name: ikIn; animation-timing-function: linear; animation-fill-mode: both; }

  ${PAGE_SIZES.map((s) => `.p${s}{font-size:${p(s)}px;letter-spacing:${trackEm(s)}em}`).join(' ')}
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

const recipe: RecipeGenerator = { refId: 'hook-086-peak', generate };
export default recipe;
