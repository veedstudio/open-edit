// Compiled recipe — hook-045 (0-00-06-22) · giant-word overlay (9:16, authored at 736×1312 @25fps).
// Source sheet: ./recipe.md. One monumental all-caps League Gothic word per beat (ultra-condensed,
// off-white, glyph-by-glyph reveal from the cue start) over full-bleed footage, with the full spoken
// line as a small Inter caption near the bottom rising in on its real timing. Plain overlay — the
// prefab's text-behind-subject occlusion machinery is gone and is not reinvented. The prefab's
// scaleX(0.5) squeeze is dropped: --verify measures glyph ink PRE-transform, so parent-scaled
// monumental text false-fails (and shears) — the condensation is the font's own.
// NOTE: sheet §6's never-visible/occluded fixes are NOT automated — the runner only demotes ladders;
// those FAILs are reported honestly. Demote keys are the exact --verify ids: b{N}big steps the giant
// word's ladder; b{N}p{P}l1 (or the page key b{N}p{P}) steps that caption page's ladder.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, paginate, pgOutDelayMs, pickRow,
  pxScaler, scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// fs = floor(1983/E) capped at 780 — 704px centered ink budget / 0.355·fs advance per char
// (caps-alphabet average incl. tracking, measured by calibration render); E = display-copy chars
// + the wide-glyph surcharge (W 0.512em, M 0.480em measured — never-visible clips don't demote,
// so width must fit by construction).
export const BIG_LADDER: LadderRow[] = [
  { cls: 'B780', maxC: 2 },
  { cls: 'B661', maxC: 3 },
  { cls: 'B495', maxC: 4 },
  { cls: 'B396', maxC: 5 },
  { cls: 'B330', maxC: 6 },
  { cls: 'B283', maxC: 7 },
  { cls: 'B247', maxC: 8 },
  { cls: 'B220', maxC: 9 },
  { cls: 'B198', maxC: 10 },
  { cls: 'B180', maxC: 11 },
  { cls: 'B165', maxC: 12 },
  { cls: 'B152', maxC: 13 },
  { cls: 'B141', maxC: 14 },
  { cls: 'B132', maxC: 15 },
  { cls: 'B123', maxC: 16 },
  { cls: 'B116', maxC: 17 },
  { cls: 'B110', maxC: 18 },
  { cls: 'B104', maxC: 19 },
  { cls: 'B99', maxC: 20 },
  { cls: 'B82', maxC: 24 },
  { cls: 'B70', maxC: Infinity },
];

// caption: 574px centered ink budget / 0.60·fs per char (Inter-500 caps, measured)
export const CAP_LADDER: LadderRow[] = [
  { cls: 's34', maxC: 26 },
  { cls: 's31', maxC: 30 },
  { cls: 's28', maxC: 34 },
  { cls: 's25', maxC: 38 },
  { cls: 's22', maxC: Infinity },
];

const MAX_CHARS = 26;
const MAX_UNITS = 6;
const FADE_MS = 250;
const CAP_ENTR_MS = 380;
const CAP_ENTR_MIN_MS = 250;
const CHAR_MS = 140;
const CHAR_STAG_MS = 70;
const CHAR_MIN_MS = 100;

export function fsOf(row: LadderRow): number {
  return Number(row.cls.slice(1));
}

// display copy = the hero unit's span texts joined, leading/trailing non-A–Z/0–9 stripped
// (THING. → THING, 10,000 stays); an all-punctuation token falls back to the joined text.
export function displayCopy045(u: Unit): string {
  const joined = u.spans.map((s) => s.text).join('');
  const stripped = joined.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
  return stripped || joined;
}

// effective width units of a display copy: chars + 0.45 per W + 0.35 per M
export function effUnits045(copy: string): number {
  let e = copy.length;
  for (const ch of copy) {
    if (ch === 'W') e += 0.45;
    else if (ch === 'M') e += 0.35;
  }
  return e;
}

export function bigRow045(E: number, demoteRows = 0): LadderRow {
  return pickRow(BIG_LADDER, E, demoteRows);
}

export function capRow045(C: number, demoteRows = 0): LadderRow {
  return pickRow(CAP_LADDER, C, demoteRows);
}

// glyph stagger: the reveal leads the beat from cueDelayMs and always completes inside the gate
export function charStagger045(n: number, cueDelayMs: number, gateEndMs: number): number {
  if (n <= 1) return 0;
  return Math.min(CHAR_STAG_MS, Math.max(0, Math.floor((gateEndMs - CHAR_MS - cueDelayMs) / (n - 1))));
}

// glyph entrance compression: null = the default 140ms fits
export function charDur045(delayMs: number, gateEndMs: number): number | null {
  if (delayMs + CHAR_MS <= gateEndMs) return null;
  return Math.max(gateEndMs - delayMs, CHAR_MIN_MS);
}

// caption entrance compression: null = the default 380ms fits
export function entranceDur045(delayMs: number, gateEndMs: number): number | null {
  if (delayMs + CAP_ENTR_MS <= gateEndMs) return null;
  return Math.max(gateEndMs - delayMs, CAP_ENTR_MIN_MS);
}

function bigHtml(hero: Unit, beatN: number, gateEndMs: number, demote: Record<string, number>): string {
  const copy = displayCopy045(hero);
  const row = bigRow045(effUnits045(copy), demotionFor(demote, `b${beatN}big`));
  // v3 (curation 2026-07-21): the giant word reveals when the hero word is actually SPOKEN — its
  // verbatim delayMs — not at the beat start (the old cue-start reveal read as out-of-sync)
  const heroDelayMs = hero.spans[0].delayMs;
  const stag = charStagger045(copy.length, heroDelayMs, gateEndMs);
  const spans = [...copy]
    .map((ch, k) => {
      const delay = heroDelayMs + k * stag;
      const dur = charDur045(delay, gateEndMs);
      return `<span class="c" style="animation-delay:${delay}ms${dur !== null ? `; animation-duration:${dur}ms` : ''}">${escapeHtml(ch)}</span>`;
    })
    .join('');
  return `  <div class="big ${row.cls}" id="b${beatN}big" data-node-id="b${beatN}big" data-node-role="text">${spans}</div>`;
}

function wordSpanHtml(u: Unit, gateEndMs: number): string {
  return u.spans
    .map((s, i) => {
      const dur = entranceDur045(s.delayMs, gateEndMs);
      // a glued unit's non-final spans zero their gap so the pair reads as one word
      const style = `animation-delay:${s.delayMs}ms${dur !== null ? `; animation-duration:${dur}ms` : ''}${i < u.spans.length - 1 ? '; margin-right:0' : ''}`;
      return `<span class="w" style="${style}">${escapeHtml(s.text)}</span>`;
    })
    .join('');
}

function pageHtml(page: Unit[], beatN: number, pageP: number, isLast: boolean, nextStartMs: number, gateEndMs: number, demote: Record<string, number>): string {
  const key = `b${beatN}p${pageP}`;
  const row = capRow045(charsOf(page), demotionFor(demote, key, `${key}l1`));
  // last page HOLDS — the cue gate cuts it; only mid-beat pages fade (turn-taking at the anchor)
  const style = isLast ? 'animation:none' : `animation-delay:${pgOutDelayMs(page, nextStartMs, FADE_MS)}ms`;
  return `  <div class="pg" style="${style}">
    <div class="cl ${row.cls}" id="${key}l1" data-node-id="${key}l1" data-node-role="text">${page.map((u) => wordSpanHtml(u, gateEndMs)).join('')}</div>
  </div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat, idx) => {
    const units = toUnits(beat.words);
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const gateEnd = beat.cueDelayMs + winMs;
    const hero = units[accentIndex(units)];
    // the giant word CARRIES the accent — the caption renders the rest of the line only, never a
    // duplicate (curation 2026-07-21, restore condition); a single-word beat gets no caption at all
    const rest = units.filter((u) => u !== hero);
    const pages = rest.length ? paginate(rest, MAX_CHARS, MAX_UNITS) : [];
    const pgs = pages
      .map((page, j) => {
        const isLast = j === pages.length - 1;
        const nextStartMs = isLast ? 0 : pages[j + 1][0].spans[0].delayMs;
        return pageHtml(page, beat.i, j + 1, isLast, nextStartMs, gateEnd, demote);
      })
      .join('\n');
    return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}"
     style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${bigHtml(hero, beat.i, gateEnd, demote)}
${pgs}
</div>`;
  });

  const bigRows = BIG_LADDER.map((r) => `  .${r.cls} { font-size: ${p(fsOf(r))}px; }`).join('\n');
  const capRows = CAP_LADDER.map((r) => `  .${r.cls} { font-size: ${p(fsOf(r))}px; }`).join('\n');

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=League+Gothic&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; background: #000; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 0; top: 0; width: ${p(736)}px; height: ${p(1312)}px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* the giant word — one per beat, holds for the whole beat (the gate cuts it). Full-width block
     centered by text-align (never shrink-to-fit flex); NO scaleX squeeze (--verify measures glyph
     ink pre-transform — parent-scaled monumental text false-fails and shears). The dark shadow is
     grounding: pure off-white glyphs vanish over light footage. */
  .big { position: absolute; left: 0; top: ${p(95)}px; width: ${p(736)}px; text-align: center; /* v3: same headline height as hook-210 */
         font-family: 'League Gothic', sans-serif; font-weight: 400;
         line-height: 0.72; letter-spacing: 0.004em; color: #f6f3f7; white-space: nowrap;
         text-shadow: 0 ${p(4)}px ${p(28)}px rgba(0,0,0,0.40); }

  /* glyph reveal — opacity only, then HOLD. The vertical padding is mid-reveal shear headroom for
     the 0.72 line-height box — never remove it. */
  .c { display: inline-block; opacity: 0; padding: 0.14em 0 0.14em;
       animation-name: cIn; animation-duration: ${CHAR_MS}ms;
       animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  @keyframes cIn { 0% { opacity: 0; } 100% { opacity: 1; } }

  /* giant-word size ladder (fs = floor(1983/E) capped at 780) */
${bigRows}

  /* a caption page = one single-line subtitle; pages of a beat sit at one anchor and take turns.
     PLAIN BLOCKS on purpose (no flex); each mid-beat page carries ONE inline fade-out (pgOut). */
  .pg { position: absolute; left: 0; top: ${p(1030)}px; width: ${p(736)}px;
        animation-name: pgOut; animation-duration: ${FADE_MS}ms; animation-timing-function: ease;
        animation-fill-mode: forwards; }
  @keyframes pgOut { from { opacity: 1; } to { opacity: 0; } }

  /* caption line — full-width block, ink centered by text-align, nowrap so the ladder's width
     math holds */
  .cl { display: block; width: ${p(736)}px; text-align: center;
        font-family: Inter, sans-serif; font-weight: 500; letter-spacing: 0.004em;
        color: #fbfbfb; white-space: nowrap;
        text-shadow: 0 ${p(1)}px ${p(5)}px rgba(0,0,0,0.55); }

  /* caption size ladder */
${capRows}

  /* caption word reveal — rise + eased fade IN, then HOLD; the page-level pgOut is the only
     fade-out. Word gap = the margin (never spacer spans); the vertical padding is shear headroom. */
  .w { display: inline-block; opacity: 0; margin-right: 0.26em; padding: 0.08em 0 0.15em;
       animation-name: wIn; animation-duration: ${CAP_ENTR_MS}ms;
       animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: none; } }
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

const recipe: RecipeGenerator = { refId: 'hook-045 (0-00-06-22)', generate };
export default recipe;
