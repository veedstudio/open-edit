// Compiled recipe — hook-071 (0-00-02-21) · elegant script lockup (16:9, authored at 1280×720 @24fps).
// Source sheet: ./recipe.md. ONE center-aligned lockup in the lower band: 24px white Inter Bold
// kicker/caption lines (Inter Bold 700 — SPLIT_C is derived from that weight) centered
// above/below ONE display-size acid-green Pinyon Script hero word per
// beat, all three registers on the x=640 axis. The hero's BASELINE is the one fixed anchor (y=560);
// the body rows hug the hero's OPTICAL ink band — the letterform bodies — with the SAME 12px clearance
// above and below, so the three registers read as ONE tight block. Script TAILS (a LETTER's ink deeper
// than TAIL_EM below the baseline — the `g`/`y`/`p` descenders, the cap swashes) are excluded from that
// band and overhang the gap: budgeted only against the frame's safe line, never against the caption
// (figures keep their dips: a digit hero is centered right over the caption). Sans words rise
// in on their spoken timings (kicker settles down, caption rises up); the hero fades in with a soft
// scale-in pop; words accumulate and the cue gate cuts the beat — no fade-outs.
// TYPE SIZING IS METRIC-EXACT: PINYON below is the font's own per-glyph advance + ink box (from the
// Google Fonts Pinyon Script TTF, upm 2048), so hero width, ascent and descent are computed, never
// guessed. The hero takes the LARGEST size that fits the frame budget — that is what keeps every
// accent word at the same display size instead of shrinking with word length.
// DEMOTION: only the hero is wired (key b{N}h → one 10% step down, the sheet's section-7 hero fix).
// The sheet's other verify fixes (body-row re-split, top arithmetic, never-visible, occluded) are not
// ladder levers — report-only, as in hook-210-peak/recipe.ts.
// BOUNDED VARIETY: scale-arc (steady/punch-close) is computed from the run inputs; device intensity
// is always `standard` (the generator has no DIRECTION input, soft is never triggered).
// Sheet ambiguity resolved: a glued unit CAN win the hero pick — it renders as one per-letter run of
// its combined text and the hero div takes the unit's FIRST span delay (per-letter runs never animate
// individually, so the later span's delay has no slot).
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const BODY_PX = 24; // Inter Bold body — the small register
const LINE_ADVANCE = 31; // round(1.30·24), the body line advance
const SPLIT_C = 34; // widest 24px Inter BOLD line inside the 536px measure column (Bold is ~2-3%
// wider than Medium per-glyph — data/font-cache/Inter-VariableFont_wght.ttf hmtx — so the char budget
// steps down from Medium's 36; re-derive again if the body weight changes)
const HERO_BASE = 560; // the script BASELINE — the composition's one fixed anchor
const H_MAX = 260; // display size every accent word reaches unless the frame budget bites
const H_MIN = 88;
const HERO_W = 1140; // hero ink budget, frame-centered (70px inset each side of 1280)
const GAP = 12; // ONE rhythm unit (half the body size) — the same clearance above and below the hero
// A LETTER whose ink drops more than this below the baseline is carrying a TAIL — a script descender
// or a cap swash. Tails leave the optical band and overhang the gap. Pinyon's letters split cleanly:
// every non-tail letter bottoms out inside 0.0229em of the baseline (plain overshoot — `s` 0.0112,
// `Z` 0.0229), while every tail is 0.1123em or deeper (`Y` `C` `E` `Q`, then `p` `J` `f` `g` `j` `q`
// `y` `z` at 0.3462-0.3843) — 0.08 splits those clusters with nothing near the line. FIGURES and
// PUNCTUATION are never tails: a digit hero is a short, centered word, so its dip (`7` 0.2661, `5`
// 0.1548, `,` 0.104) lands exactly where the caption goes and must be cleared.
const TAIL_EM = 0.08;
const LETTER = /\p{L}/u; // an unknown letter takes the fallback's deep descent → tail, like a real one
const SAFE_TOP = 44;
const SAFE_BOT = 700;
const PUNCH = 1.12; // punch-close cap bump
const DEMOTE_STEP = 0.9; // one verify ladder step
// Baseline offset from a .hero row box top at line-height 1.2: half-leading + ascent, with Pinyon's
// own hhea metrics (ascent 1768, descent −787, upm 2048; OS/2 typo metrics are identical).
const BASE_EM = 0.8395;

// Pinyon Script per-glyph metrics, em-normalised: [advance, ink xMin, ink xMax, ink yMin, ink yMax].
// Measured from the shipped TTF — never re-derive, never round differently. Letters render as adjacent
// inline-block runs, so there is no kerning: a word's box is the plain sum of advances.
const PINYON: Record<string, [number, number, number, number, number]> = {
  a: [0.418, -0.0098, 0.4834, -0.001, 0.3345],
  b: [0.3843, 0.0, 0.6401, -0.0049, 0.771],
  c: [0.334, 0.0, 0.4014, -0.0029, 0.3359],
  d: [0.4414, 0.0005, 0.7593, -0.001, 0.7788],
  e: [0.3228, 0.0, 0.3877, -0.0029, 0.3345],
  f: [0.333, -0.1934, 0.6143, -0.3843, 0.771],
  g: [0.4492, -0.2788, 0.5142, -0.3843, 0.3345],
  h: [0.4434, -0.0796, 0.5288, -0.001, 0.7788],
  i: [0.2217, -0.0391, 0.3257, -0.001, 0.5039],
  j: [0.188, -0.562, 0.2998, -0.3843, 0.5039],
  k: [0.4204, -0.0796, 0.5283, -0.001, 0.7788],
  l: [0.2227, -0.0278, 0.5293, -0.001, 0.7788],
  m: [0.7007, -0.0059, 0.7656, -0.0024, 0.3345],
  n: [0.5088, -0.0059, 0.5737, -0.001, 0.3345],
  o: [0.3672, -0.001, 0.4321, -0.001, 0.3345],
  p: [0.4209, -0.3374, 0.4858, -0.3462, 0.4775],
  q: [0.4546, -0.0898, 0.5195, -0.3843, 0.3271],
  r: [0.333, 0.0156, 0.3979, -0.001, 0.3921],
  s: [0.291, -0.0732, 0.356, -0.0112, 0.3926],
  t: [0.2095, -0.0332, 0.4204, -0.001, 0.5576],
  u: [0.4321, -0.0308, 0.4971, -0.001, 0.3315],
  v: [0.3955, -0.0361, 0.4604, -0.001, 0.3462],
  w: [0.5635, -0.0391, 0.6284, -0.001, 0.3511],
  x: [0.4424, -0.043, 0.5073, -0.001, 0.3345],
  y: [0.4443, -0.271, 0.5093, -0.3843, 0.3315],
  z: [0.3389, -0.2412, 0.4165, -0.3843, 0.3921],
  A: [0.7949, 0.0, 1.0342, -0.0024, 0.6855],
  B: [0.7974, 0.0, 1.0063, -0.001, 0.7031],
  C: [0.6279, 0.1465, 0.8379, -0.1279, 0.7163],
  D: [0.7925, 0.0, 0.9854, -0.0029, 0.6758],
  E: [0.4849, -0.0005, 0.7393, -0.1392, 0.6841],
  F: [0.6118, 0.0, 1.0923, -0.0005, 0.7686],
  G: [0.5269, 0.0, 0.731, -0.0015, 0.7031],
  H: [0.8525, 0.0, 1.1831, -0.001, 0.6885],
  I: [0.6509, -0.0015, 0.9932, -0.001, 0.6797],
  J: [0.5962, -0.2554, 0.9453, -0.3618, 0.6841],
  K: [0.8428, 0.0, 1.2778, -0.0068, 0.7061],
  L: [0.7505, 0.0, 1.0249, -0.0122, 0.6841],
  M: [0.9351, 0.0, 1.2427, -0.001, 0.7261],
  N: [0.7241, 0.0, 1.3857, -0.0093, 0.7305],
  O: [0.5479, 0.0186, 0.7329, -0.001, 0.6841],
  P: [0.6294, 0.0, 0.8623, -0.001, 0.6865],
  Q: [0.7017, 0.0, 0.8687, -0.1416, 0.6841],
  R: [0.8574, 0.0195, 0.9141, -0.001, 0.6841],
  S: [0.5142, 0.0, 0.8887, -0.001, 0.6841],
  T: [0.5503, 0.0, 1.1313, -0.001, 0.7451],
  U: [0.5039, -0.001, 0.7686, -0.001, 0.6841],
  V: [0.5024, 0.0, 0.8896, -0.021, 0.749],
  W: [0.8408, 0.0, 1.4663, -0.021, 0.7061],
  X: [0.8511, 0.0, 1.1392, -0.001, 0.7012],
  Y: [0.6299, 0.0146, 0.9131, -0.1123, 0.7007],
  Z: [0.7788, 0.019, 0.8745, -0.0229, 0.688],
  '0': [0.563, 0.0967, 0.6597, -0.0024, 0.6875],
  '1': [0.3887, 0.0928, 0.5757, 0.0063, 0.6953],
  '2': [0.6211, 0.0063, 0.6665, -0.0283, 0.6885],
  '3': [0.5928, -0.0391, 0.6611, -0.1162, 0.6885],
  '4': [0.7305, 0.0635, 0.7705, -0.0562, 0.6904],
  '5': [0.5845, -0.0928, 0.7598, -0.1548, 0.7324],
  '6': [0.6069, 0.1338, 0.7246, -0.0024, 0.6885],
  '7': [0.5122, 0.1514, 0.7222, -0.2661, 0.6885],
  '8': [0.54, 0.103, 0.6235, -0.0024, 0.6885],
  '9': [0.5903, 0.0688, 0.6509, -0.001, 0.6875],
  "'": [0.1846, 0.1953, 0.3799, 0.5684, 0.8037],
  '!': [0.1807, 0.0098, 0.4688, -0.001, 0.6245],
  '?': [0.3955, 0.0391, 0.4688, -0.001, 0.5625],
  ',': [0.1807, -0.083, 0.0786, -0.104, 0.0889],
  '.': [0.1973, 0.0049, 0.0981, -0.001, 0.0889],
  '-': [0.3369, 0.0928, 0.293, 0.2251, 0.2529],
};
// Anything outside the table (an accented glyph, a stray symbol) takes the family's worst case, so an
// unknown character can only ever make the hero SMALLER and its clearances LARGER.
const PINYON_FALLBACK: [number, number, number, number, number] = [0.45, -0.3374, 0.7593, -0.3843, 0.7788];

export interface HeroInk {
  halfEm: number; // half of the ink width the frame must hold (the row centers on the ADVANCE box)
  ascEm: number; // ink top above the baseline — Pinyon has no ascending outlier, so this IS the optical top
  descEm: number; // deepest ink below the baseline, TAILS INCLUDED (the frame budget for the overhang)
  descOptEm: number; // OPTICAL bottom: the deepest ink that is not a letter's tail — where the bodies stop
}

// Ink box of the rendered hero word, in em, relative to its baseline and its centered advance box.
export function heroInk(rendered: string): HeroInk {
  let x = 0;
  let left = 0;
  let right = 0;
  let asc = 0;
  let desc = 0;
  let descOpt = 0;
  for (const ch of rendered) {
    const [adv, xMin, xMax, yMin, yMax] = PINYON[ch] ?? PINYON_FALLBACK;
    left = Math.min(left, x + xMin);
    right = Math.max(right, x + xMax);
    asc = Math.max(asc, yMax);
    desc = Math.max(desc, -yMin);
    if (!(-yMin > TAIL_EM && LETTER.test(ch))) descOpt = Math.max(descOpt, -yMin); // tails drop out
    x += adv;
  }
  return {
    halfEm: Math.max(x / 2 - left, right - x / 2),
    ascEm: asc,
    descEm: Math.max(0, desc),
    descOptEm: Math.max(0, descOpt),
  };
}

// Hero size: the display cap H_MAX unless a frame budget bites — width, the ascender's room over the
// kicker, the optical bottom's room over the caption, or the TAIL's room over the bottom safe line
// (the tail is budgeted against the frame only, never against the caption — it is allowed to overhang
// the gap). Word LENGTH is not a term: every accent word lands at the same size until it physically
// stops fitting. Width always wins (it is what --verify sees).
export function heroH(rendered: string, kLines: number, cLines: number, punch = false, demote = 0): number {
  const m = heroInk(rendered);
  const capWidth = Math.floor(HERO_W / (2 * m.halfEm));
  const capBelow = m.descOptEm > 0
    ? Math.floor((SAFE_BOT - HERO_BASE - (cLines ? GAP + cLines * LINE_ADVANCE : 0)) / m.descOptEm)
    : Infinity;
  const capTail = m.descEm > 0 ? Math.floor((SAFE_BOT - HERO_BASE) / m.descEm) : Infinity;
  const capAbove = Math.floor((HERO_BASE - SAFE_TOP - (kLines ? GAP + kLines * LINE_ADVANCE : 0)) / m.ascEm);
  const cap = Math.round((punch ? PUNCH : 1) * H_MAX);
  const H = Math.max(H_MIN, Math.min(cap, capBelow, capTail, capAbove));
  return Math.min(capWidth, Math.round(H * DEMOTE_STEP ** demote));
}

// Word prep: strip ONE trailing `.` or `,`; keep `?` `!` `'` and internal punctuation.
export function stripWord(w: string): string {
  return w.replace(/[.,]$/, '');
}

// Sheet toUnits: text VERBATIM after stripping (the CSS lowercases the sans rows — never uppercase
// here) + VEED glue: a leading-`-` token merges with the previous word into ONE unit, keeping its
// own span + verbatim delay.
export function toUnits071(words: WordTiming[]): Unit[] {
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

// A sans row splits ONLY at C > SPLIT_C (34, derived for Bold): break between consecutive words minimizing |left − right| chars
// (counting gaps); tie → FEWER words on line 1 (differs from lib splitLines, which is top-heavy).
export function splitRow071(units: Unit[]): [Unit[], Unit[] | null] {
  if (units.length < 2 || charsOf(units) <= SPLIT_C) return [units, null];
  let best = 1;
  let bestDiff = Infinity;
  for (let k = 1; k < units.length; k++) {
    const d = Math.abs(charsOf(units.slice(0, k)) - charsOf(units.slice(k)));
    if (d < bestDiff) { best = k; bestDiff = d; } // strict < : earliest break wins ties
  }
  return [units.slice(0, best), units.slice(best)];
}

export function riseMs071(availMs: number): number {
  return Math.min(400, Math.max(180, availMs - 120));
}

export function heroMs071(availMs: number): number {
  return Math.min(700, Math.max(250, availMs - 120));
}

// Section-3 closed forms, reference px. The hero's baseline is FIXED at HERO_BASE; both body rows are
// placed off the hero's MEASURED OPTICAL band with the same GAP, so the stack keeps one rhythm and the
// clearance holds for every word by construction (a body row's ink is inside its 31px box: Inter's
// content area is 1.21em inside a 1.30em line box). The band's bottom is where the letterform bodies
// stop, NOT the tail's tip — a `g` hangs past the caption's top edge by design (it is off the centered
// caption's short measure), which is what keeps the caption tucked under the hero instead of adrift.
// kLines/cLines ∈ {0,1,2}; the unused register's top is returned but never emitted.
export function layout071(rendered: string, H: number, kLines: number, cLines: number): {
  heroTop: number; kickerTop: number; captionTop: number;
} {
  const m = heroInk(rendered);
  const inkTop = HERO_BASE - Math.round(m.ascEm * H);
  const optBot = HERO_BASE + Math.round(m.descOptEm * H);
  return {
    heroTop: HERO_BASE - Math.round(BASE_EM * H),
    kickerTop: inkTop - GAP - Math.max(1, kLines) * LINE_ADVANCE,
    captionTop: optBot + GAP,
  };
}

// SCALE ARC: punch-close when the last beat's hero contains a digit or any word ends with `!`.
export function punchClose071(units: Unit[], heroText: string): boolean {
  return /\d/.test(heroText) || units.some((u) => u.spans.some((s) => s.text.endsWith('!')));
}

function sansLineHtml(units: Unit[], id: string, kind: 'wk' | 'wc', topPx: number, fontPx: number, cueEndMs: number): string {
  const spans = units
    .map((u, ui) =>
      u.spans
        .map((s, i) => {
          // a glued unit's non-final spans zero their gap so the pair reads as one word; the row's
          // LAST span zeroes it too, so the centered line has no trailing margin pushing it off-axis
          const last = ui === units.length - 1 && i === u.spans.length - 1;
          const glue = i < u.spans.length - 1 || last ? ';margin-right:0' : '';
          return `<span class="w ${kind}" style="animation-delay:${s.delayMs}ms;animation-duration:${riseMs071(cueEndMs - s.delayMs)}ms${glue}">${escapeHtml(s.text)}</span>`;
        })
        .join(''),
    )
    .join('');
  return `  <div class="row sans" id="${id}" data-node-id="${id}" data-node-role="text" style="top:${topPx}px;font-size:${fontPx}px">${spans}</div>`;
}

function heroLineHtml(rendered: string, id: string, topPx: number, hPx: number, delayMs: number, durMs: number): string {
  // static per-letter runs inside the ONE animated div (keeps every glyph texture small)
  const letters = [...rendered].map((ch) => `<span class="hl">${escapeHtml(ch)}</span>`).join('');
  return `  <div class="row hero" id="${id}" data-node-id="${id}" data-node-role="text" style="top:${topPx}px;font-size:${hPx}px;animation-delay:${delayMs}ms;animation-duration:${durMs}ms">${letters}</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 1280, 720));
  const demote = opts.demote ?? {};
  const bodyPx = p(BODY_PX);

  const cues = timings.beats
    .map((beat, idx) => {
      const units = toUnits071(beat.words);
      if (!units.length) return '';
      const N = beat.i;
      const cueEnd = beat.cueDelayMs + beat.cueDurMs;

      const hIdx = accentIndex(units); // section-5 pick: digit first, else longest, tie → later
      const hero = units[hIdx];
      const heroText = hero.spans.map((s) => s.text).join('');
      const rendered = heroText.slice(0, 1).toUpperCase() + heroText.slice(1).toLowerCase();

      const kicker = units.slice(0, hIdx);
      const caption = units.slice(hIdx + 1);
      const [k1, k2] = kicker.length ? splitRow071(kicker) : [[], null];
      const [c1, c2] = caption.length ? splitRow071(caption) : [[], null];
      const kLines = kicker.length ? (k2 ? 2 : 1) : 0;
      const cLines = caption.length ? (c2 ? 2 : 1) : 0;

      const punch = idx === timings.beats.length - 1 && punchClose071(units, heroText);
      const H = heroH(rendered, kLines, cLines, punch, demotionFor(demote, `b${N}h`));
      const { heroTop, kickerTop, captionTop } = layout071(rendered, H, kLines, cLines);

      const heroDelay = hero.spans[0].delayMs;
      const rows: string[] = [];
      if (k1.length) rows.push(sansLineHtml(k1, `b${N}k`, 'wk', p(kickerTop), bodyPx, cueEnd));
      if (k2) rows.push(sansLineHtml(k2, `b${N}k2`, 'wk', p(kickerTop + LINE_ADVANCE), bodyPx, cueEnd));
      rows.push(heroLineHtml(rendered, `b${N}h`, p(heroTop), p(H), heroDelay, heroMs071(cueEnd - heroDelay)));
      if (c1.length) rows.push(sansLineHtml(c1, `b${N}c`, 'wc', p(captionTop), bodyPx, cueEnd));
      if (c2) rows.push(sansLineHtml(c2, `b${N}c2`, 'wc', p(captionTop + LINE_ADVANCE), bodyPx, cueEnd));

      return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${beat.cueDurMs}ms">
${rows.join('\n')}
</div>`;
    })
    .filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Pinyon+Script&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${p(1280)}px; height: ${p(720)}px; background: #000; overflow: hidden; position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue.
     The cue is the CENTERING FRAME: full-frame, so every row is a full-width block with
     text-align:center (the ONLY engine-safe way to center animated children — shrink-to-fit flex
     reflows as its lines reveal) and the whole lockup shares the frame's center axis. Nothing
     overflows: the hero's ink budget keeps it inside the frame at every size. */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: ${p(1280)}px; height: ${p(720)}px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  .row  { position: absolute; left: 0; width: 100%; text-align: center; white-space: nowrap; }
  /* ONE restrained shadow idiom composition-wide: a tight low-opacity drop on both registers — no
     halos, no solid rims, no offset copies. */
  .sans { font-family: 'Inter', sans-serif; font-weight: 700; letter-spacing: 0.02em;
          line-height: 1.3; text-transform: lowercase; color: #ffffff;
          text-shadow: 0 0.05em 0.14em rgba(0,0,0,0.5); }
  /* the hero div is the ANIMATED node; its letters are static per-letter runs. Every keyframe ends
     at identity, so bounds are budgeted at the untransformed width. transform-origin 50% 60% pops the
     scale-in from the lockup's shared center axis. */
  .hero { font-family: 'Pinyon Script', cursive; font-weight: 400; line-height: 1.2; letter-spacing: 0;
          color: #96FF1A; text-shadow: 0 0.016em 0.036em rgba(0,0,0,0.45);
          opacity: 0; z-index: 1; transform-origin: 50% 60%;
          animation-name: heroIn; animation-timing-function: cubic-bezier(.2,.7,.3,1);
          animation-fill-mode: both; }
  .hl { display: inline-block; }
  .w  { display: inline-block; opacity: 0; margin-right: 0.35em;
        animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .wk { animation-name: riseK; }
  .wc { animation-name: riseC; }

  @keyframes heroIn { 0% { opacity: 0; transform: scale(0.94); } 100% { opacity: 1; transform: scale(1); } }
  @keyframes riseK  { 0% { opacity: 0; transform: translateY(-0.22em); } 100% { opacity: 1; transform: none; } }
  @keyframes riseC  { 0% { opacity: 0; transform: translateY(0.22em); }  100% { opacity: 1; transform: none; } }
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

const recipe: RecipeGenerator = { refId: 'hook-071 (0-00-02-21)', generate };
export default recipe;
