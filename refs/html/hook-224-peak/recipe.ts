// Compiled recipe — hook-224-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md (v2).
// Neon-filament lockup in the lower-middle band: white glowing Schibsted Grotesk on the footage —
// a 600 kicker line, a monumental 800 hero word striking on per-CHAR like bulb filaments, a centered
// 700 closer line. Ignite is opacity-ONLY (animated filter/drop-shadow under sub-1 opacity clips
// glyphs in this engine); the glow lives in the static .txt text-shadow, whose 4th DARK layer grounds
// white type on light footage. Emphasis is STRUCTURAL (the hero lands alone in line2). Bounded variety:
// even beats add `arrB` to line2 (align-self/text-align only — no transform; translate(-50%) mis-centers
// in this engine, flex centering is the safe construct).
// NOT automated (report-only, the runner only demotes named ids): the sheet's bottom-outside fix
// re-targets the BEAT's line2 (then line3) rather than the named element; the occluded fix trims a
// cue's duration to the next beat's start. Both stay manual per the sheet's verify loop.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const H_LADDER = [
  { cls: '', maxC: 7 },       // base 121px — max chars at fs = floor(574 / (0.64·fs))
  { cls: 'h101', maxC: 8 },
  { cls: 'h85', maxC: 10 },
  { cls: 'h68', maxC: 13 },
  { cls: 'h58', maxC: Infinity },
];
const K_LADDER = [
  { cls: '', maxC: 30 },      // base 32px
  { cls: 'k26', maxC: 37 },
];
const T_LADDER = [
  { cls: '', maxC: 19 },      // base 50px
  { cls: 't39', maxC: 24 },
  { cls: 't31', maxC: 30 },
  { cls: 't25', maxC: 37 },
];
const SIDE_SPLIT_C = 24;
const IGNITE_MS = 550;
const DUR_FLOOR_MS = 250;

const unitText = (u: Unit) => u.spans.map((s) => s.text).join('');

// This sheet renders case + punctuation VERBATIM (never uppercase), so lib's toUnits doesn't apply;
// the '-' glue rule is the same: a leading-`-` token merges with the previous word into ONE unit.
export function glue224(words: WordTiming[]): Unit[] {
  const units: Unit[] = [];
  for (const w of words) {
    const prev = units[units.length - 1];
    if (w.w.startsWith('-') && prev) {
      prev.spans.push({ text: w.w, delayMs: w.delayMs });
      prev.chars += w.w.length;
    } else {
      units.push({ spans: [{ text: w.w, delayMs: w.delayMs }], chars: w.w.length });
    }
  }
  return units;
}

// Hero pick: first digit-bearing unit, else most letters+digits (punctuation and hyphens don't
// count for the pick), tie → the LATER unit.
export function heroIndex224(units: Unit[]): number {
  const digit = units.findIndex((u) => /\d/.test(unitText(u)));
  if (digit >= 0) return digit;
  const score = (u: Unit) => (unitText(u).match(/[\p{L}\p{N}]/gu) ?? []).length;
  let best = 0;
  for (let i = 1; i < units.length; i++) if (score(units[i]) >= score(units[best])) best = i;
  return best;
}

// Side-line split: C ≤ 24 stays one row, else EXACTLY 2 — break at the unit boundary whose
// first-row char count is closest to C/2 (tie → earlier boundary). Never reorder, never 3 rows.
export function splitRows224(units: Unit[]): [Unit[], Unit[] | null] {
  const C = charsOf(units);
  if (C <= SIDE_SPLIT_C || units.length < 2) return [units, null];
  let best = 1;
  let bestDiff = Infinity;
  for (let k = 1; k < units.length; k++) {
    const d = Math.abs(charsOf(units.slice(0, k)) - C / 2);
    if (d < bestDiff) { best = k; bestDiff = d; } // strict < : earlier boundary wins ties
  }
  return [units.slice(0, best), units.slice(best)];
}

// Char stagger, ONE guard per beat: K=60 unless the cascade + full flicker would overrun the gate,
// then K=30 (if 30 still overruns, keep 30 — the mid-flicker cut is accepted).
export function heroK224(heroDelayMs: number, charCount: number, cueEndMs: number): number {
  return heroDelayMs + (charCount - 1) * 60 + IGNITE_MS > cueEndMs ? 30 : 60;
}

// End-of-beat compression: a span whose flicker would still be guttering when the gate closes gets
// a shortened inline ignite so it is FULLY LIT before the cut; null = the skeleton's .55s applies.
export function compressDurMs224(delayMs: number, cueEndMs: number): number | null {
  return delayMs + IGNITE_MS > cueEndMs ? Math.max(cueEndMs - delayMs, DUR_FLOOR_MS) : null;
}

function spanStyle(delayMs: number, cueEndMs: number, zeroGap: boolean): string {
  let style = `animation-delay:${delayMs}ms`;
  const dur = compressDurMs224(delayMs, cueEndMs);
  if (dur !== null) style += `; animation-duration:${dur}ms`;
  if (zeroGap) style += '; margin-right:0';
  return style;
}

function wordSpans(units: Unit[], cueEndMs: number): string {
  return units
    .map((u) => u.spans
      .map((s, i) => `<span class="w" style="${spanStyle(s.delayMs, cueEndMs, i < u.spans.length - 1)}">${escapeHtml(s.text)}</span>`)
      .join(''))
    .join('');
}

function heroSpans(hero: Unit, cueEndMs: number): string {
  const text = unitText(hero); // a glued hero renders as one continuous char run
  const base = hero.spans[0].delayMs; // VERBATIM base — never adjusted
  const K = heroK224(base, text.length, cueEndMs);
  return [...text]
    .map((c, i) => `<span class="ch" style="${spanStyle(base + i * K, cueEndMs, false)}">${escapeHtml(c)}</span>`)
    .join('');
}

function lineDiv(id: string, cls: string, inner: string): string {
  return `  <div class="${cls}" id="${id}" data-node-id="${id}" data-node-role="text">${inner}</div>`;
}

function sideLines(units: Unit[], beatN: number, L: 1 | 3, ladder: typeof T_LADDER, demote: Record<string, number>, cueEndMs: number): string[] {
  const [r1, r2] = splitRows224(units);
  const C = Math.max(charsOf(r1), r2 ? charsOf(r2) : 0); // both rows share one size — longest decides
  const row = pickRow(ladder, C, demotionFor(demote, `b${beatN}l${L}r1`, `b${beatN}l${L}r2`));
  const cls = `txt line${L}${row.cls ? ` ${row.cls}` : ''}`;
  const out = [lineDiv(`b${beatN}l${L}r1`, cls, wordSpans(r1, cueEndMs))];
  if (r2) out.push(lineDiv(`b${beatN}l${L}r2`, cls, wordSpans(r2, cueEndMs)));
  return out;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat) => {
    const units = glue224(beat.words);
    const cueEnd = beat.cueDelayMs + beat.cueDurMs;
    const h = heroIndex224(units);
    const hero = units[h];
    const lines: string[] = [];
    if (h > 0) lines.push(...sideLines(units.slice(0, h), beat.i, 1, K_LADDER, demote, cueEnd));
    const hRow = pickRow(H_LADDER, hero.chars, demotionFor(demote, `b${beat.i}l2`));
    const arr = beat.i % 2 === 0 ? ' arrB' : ''; // bounded variety: odd → A (flush-left), even → B (centered)
    lines.push(lineDiv(`b${beat.i}l2`, `txt line2${hRow.cls ? ` ${hRow.cls}` : ''}${arr}`, heroSpans(hero, cueEnd)));
    if (h < units.length - 1) lines.push(...sideLines(units.slice(h + 1), beat.i, 3, T_LADDER, demote, cueEnd));
    return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}"
     style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${beat.cueDurMs}ms">
${lines.join('\n')}
</div>`;
  });

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${p(736)}px; height: ${p(1312)}px; background: #101010; overflow: hidden; position: relative;
         font-family: 'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; }

  /* beat gate — the one safe reveal recipe; delay+duration + z-index come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: ${p(79)}px; top: ${p(683)}px; width: ${p(574)}px;
         display: flex; flex-direction: column; align-items: flex-start;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* shared glow text — 3 white neon layers + the 4th dark GROUNDING layer so white type survives
     light footage. Never edit or drop any layer. */
  .txt { color: #fbf9f7; line-height: 1.2; letter-spacing: -0.01em; white-space: nowrap;
         text-shadow: 0 0 ${p(3)}px rgba(255,255,255,0.9), 0 0 ${p(7)}px rgba(255,255,255,0.55),
                      0 0 ${p(16)}px rgba(255,255,255,0.3), 0 ${p(2)}px ${p(14)}px rgba(0,0,0,0.65); }
  .line1 { font-weight: 600; font-size: ${p(32)}px; margin-left: ${p(7)}px; margin-top: ${p(12)}px; line-height: 0.93; }
  .line2 { font-weight: 800; font-size: ${p(121)}px; letter-spacing: -0.03em; margin-top: ${p(-12)}px; }
  .line3 { align-self: center; text-align: center; font-weight: 700; font-size: ${p(50)}px; margin-top: ${p(20)}px; line-height: 0.93; }
  /* BOUNDED VARIETY — arrangement B: centers the hero alongside the closer */
  .arrB { align-self: center; text-align: center; }

  /* size-down rows (picked by char count — never invent other sizes) */
  .h101 { font-size: ${p(101)}px; }  .h85 { font-size: ${p(85)}px; }  .h68 { font-size: ${p(68)}px; }  .h58 { font-size: ${p(58)}px; }
  .k26 { font-size: ${p(26)}px; }
  .t39 { font-size: ${p(39)}px; }  .t31 { font-size: ${p(31)}px; }  .t25 { font-size: ${p(25)}px; }

  /* filament strike-on: opacity gutters then holds lit. OPACITY ONLY — no filter (glyph-clip bug). */
  @keyframes ignite { 0%{opacity:0} 10%{opacity:.9} 20%{opacity:.08} 34%{opacity:.7}
                      46%{opacity:.2} 62%{opacity:1} 100%{opacity:1} }
  .w  { display: inline-block; opacity: 0; margin-right: 0.28em; padding: 0.1em 0 0.15em 0;
        animation: ignite .55s linear both; }
  .ch { display: inline-block; opacity: 0; animation: ignite .55s linear both; }
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

const recipe: RecipeGenerator = { refId: 'hook-224-peak', generate };
export default recipe;
