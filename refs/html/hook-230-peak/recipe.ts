// Compiled recipe — hook-230-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// v4 (curation 2026-07-21): the TITLE ARC is GONE. Two straight blocks share ONE style — glowing
// white Archivo Narrow over full-bleed footage: the first half of the beat's words in an upper
// block (1–2 centered lines at top 250), the rest in the lower block (1–3 lines at 880). BOTH
// reveal as a TYPEWRITER: each glyph pops on (no fade/slide) at its word's verbatim delay + 34ms
// intra-word stagger, and a cursor bar styled by the same face sits after the last typed glyph —
// exactly one cursor visible at any moment (per-glyph opacity windows), lingering 350ms after the
// final glyph. One hero word per beat, picked over the LOWER block's units: pure white, weight 600.
// NOTE: only ladder demotions are automated — #b{N}t1/t2 and #b{N}h1/h2/h3 step the shared
// headline ladder. Non-ladder verify fixes are NOT automated — those FAILs are reported honestly.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const TYPE_MS = 34; // intra-word per-glyph stagger
const TYPE_SAFE_MS = 100; // every glyph lands ≥100ms before the gate
const CUR_LINGER_MS = 350; // the final cursor holds this long
const CUR_MIN_WIN_MS = 12; // sub-half-frame windows are dropped (two cursors would coexist)
const TOP_STREAM_CAP = 26; // split rule: shrink k until the top stream fits

// The ONE size ladder both blocks share (a block is sized by its longest line's C).
const HEAD_LADDER = [
  { cls: 'f46', maxC: 15 }, { cls: 'f42', maxC: 17 }, { cls: 'f38', maxC: 19 }, { cls: 'f35', maxC: 20 },
  { cls: 'f32', maxC: 22 }, { cls: 'f29', maxC: 25 }, { cls: 'f26', maxC: 27 }, { cls: 'f23', maxC: Infinity },
];

// Word prep: ORIGINAL case + punctuation; a leading-`-` token glues to the previous word as ONE unit
// (each half keeps its own delayMs).
export function toUnits230(words: WordTiming[]): Unit[] {
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

const unitText = (u: Unit) => u.spans.map((s) => s.text).join('');

// char stream length of a unit run (words joined by ONE space; glued halves adjacent)
export function streamLen230(units: Unit[]): number {
  return units.reduce((s, u) => s + u.chars, 0) + Math.max(0, units.length - 1);
}

// Split: k = ceil(n/2), then shrink while the TOP stream exceeds 26 chars (k ≥ 1; n=1 → top only).
export function splitK230(units: Unit[]): number {
  let k = Math.ceil(units.length / 2);
  while (k > 1 && streamLen230(units.slice(0, k)) > TOP_STREAM_CAP) k--;
  return k;
}

// typewriter glyph time: 34ms stagger, clamped so every glyph lands ≥100ms before the gate
// (never before the word's own delay).
export function typeDelay230(delayMs: number, j: number, gateCloseMs: number): number {
  return Math.max(delayMs, Math.min(delayMs + TYPE_MS * j, gateCloseMs - TYPE_SAFE_MS));
}

// Headline counting: strip ONE trailing `.` or `,`; keep ? ! ' - and internal commas (10,000 = 6).
export function headLen(text: string): number {
  return text.replace(/[.,]$/, '').length;
}
export function lineC(units: Unit[]): number {
  return units.reduce((s, u) => s + headLen(unitText(u)), 0) + Math.max(0, units.length - 1);
}
// L = 1 (C_tot ≤ 17) / 2 (≤ 34) / 3, capped by the block's maxL; greedy fill to ceil(C_tot/L).
export function headLines(units: Unit[], maxL = 3): Unit[][] {
  const cTot = lineC(units);
  const L = Math.min(maxL, cTot <= 17 ? 1 : cTot <= 34 ? 2 : 3);
  const target = Math.ceil(cTot / L);
  const lines: Unit[][] = [[]];
  let running = 0;
  for (const u of units) {
    const line = lines[lines.length - 1];
    const add = headLen(unitText(u)) + (line.length ? 1 : 0);
    if (line.length && running + add > target && lines.length < L) {
      lines.push([u]);
      running = headLen(unitText(u));
    } else {
      line.push(u);
      running += add;
    }
  }
  return lines;
}

// Hero over the LOWER block's units only: first digit-bearing token, else most LETTERS, tie → later.
export function heroIndex230(units: Unit[]): number {
  if (!units.length) return -1;
  const digit = units.findIndex((u) => /\d/.test(unitText(u)));
  if (digit >= 0) return digit;
  const letters = (u: Unit) => (unitText(u).match(/[a-zA-Z]/g) ?? []).length;
  let best = 0;
  for (let i = 1; i < units.length; i++) if (letters(units[i]) >= letters(units[best])) best = i;
  return best;
}

// one typed glyph + (maybe) the cursor that follows it; windows computed over the WHOLE beat
interface Glyph { ch: string; delayMs: number }

function blockHtml(beatN: number, prefix: 't' | 'h', units: Unit[], maxL: number, hero: number,
                   demote: Record<string, number>,
                   flat: Glyph[], starts: number[]): string {
  const lines = headLines(units, maxL);
  const C = Math.max(...lines.map(lineC));
  const ids = lines.map((_, li) => `b${beatN}${prefix}${li + 1}`);
  const row = pickRow(HEAD_LADDER, C, demotionFor(demote, ...ids));
  let at = starts.shift() ?? 0; // this block's first index into the beat's flat glyph sequence
  let offset = 0;
  const html = lines.map((lineUnits, li) => {
    const spans = lineUnits
      .map((u, i) => {
        const isHero = prefix === 'h' && offset + i === hero;
        const word = u.spans
          .map((s) => [...s.text]
            .map(() => {
              const g = flat[at];
              const next = flat[at + 1];
              const win = next ? next.delayMs - g.delayMs : CUR_LINGER_MS;
              at += 1;
              const cur = win >= CUR_MIN_WIN_MS
                ? `<span class="cur" style="animation:curWin ${win}ms linear ${g.delayMs}ms both">|</span>`
                : '';
              return `<span class="tg" style="animation-delay:${g.delayMs}ms">${escapeHtml(g.ch)}</span>${cur}`;
            })
            .join(''))
          .join('');
        return `<span class="${isHero ? 'hw hero' : 'hw'}">${word}</span>`;
      })
      .join('');
    offset += lineUnits.length;
    return `    <div class="hl ${row.cls}${li ? ' hg' : ''}" id="${ids[li]}" data-node-id="${ids[li]}" data-node-role="text">${spans}</div>`;
  });
  starts.unshift(at); // hand the running index to the next block
  const bid = `b${beatN}${prefix}`;
  return `  <div class="head ${prefix === 't' ? 'top' : 'bot'}" id="${bid}" data-node-id="${bid}">\n${html.join('\n')}\n  </div>`;
}

// flatten a block's glyphs in reading order with their typewriter delays
function blockGlyphs(units: Unit[], maxL: number, gateClose: number): Glyph[] {
  const out: Glyph[] = [];
  for (const lineUnits of headLines(units, maxL)) {
    for (const u of lineUnits) {
      for (const s of u.spans) {
        [...s.text].forEach((ch, j) => out.push({ ch, delayMs: typeDelay230(s.delayMs, j, gateClose) }));
      }
    }
  }
  return out;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const scale = scaleFor(meta, 736, 1312);
  const p = pxScaler(scale);
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, idx) => {
      const units = toUnits230(beat.words);
      if (!units.length) return '';
      const winMs = winMsFor(timings.beats, idx, meta.durationSec);
      const gateClose = beat.cueDelayMs + winMs;
      const k = splitK230(units);
      const top = units.slice(0, k);
      const bot = units.slice(k);
      const hero = heroIndex230(bot);
      // the beat's flat glyph sequence (top block first) drives the cursor windows
      const flat = [...blockGlyphs(top, 2, gateClose), ...(bot.length ? blockGlyphs(bot, 3, gateClose) : [])];
      const starts = [0];
      const parts = [blockHtml(beat.i, 't', top, 2, -1, demote, flat, starts)];
      if (bot.length) parts.push(blockHtml(beat.i, 'h', bot, 3, hero, demote, flat, starts));
      return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}" style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms">\n${parts.join('\n')}\n</div>`;
    })
    .filter(Boolean);

  const wv = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Archivo+Narrow:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; overflow: hidden; }
  body { position: relative; background: #101010; font-family: 'Archivo', system-ui, sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* cue gate — opacity-only (never a transform ancestor over animated words); hard cut at the successor */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; pointer-events: none;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* the ONE register both blocks share: glowing white Archivo Narrow, frame-centered block lines
     (never flex around animated children). Last shadow layer = the dark ground. */
  .head { position: absolute; left: 0; width: ${p(736)}px; }
  .top { top: ${p(250)}px; } /* upper block — the arc's old zone, now a straight title */
  .bot { top: ${p(880)}px; } /* lower block — the body in the lower third */
  .hl { display: block; white-space: nowrap; line-height: 1; text-align: center;
        font-family: 'Archivo Narrow', 'Archivo', sans-serif; font-weight: 500; letter-spacing: 0;
        color: #f8f6f4;
        text-shadow: 0 0 ${p(4)}px #fff, 0 0 ${p(9)}px rgba(255,255,255,0.95), 0 0 ${p(18)}px rgba(255,255,255,0.7),
                     0 0 ${p(31)}px rgba(255,255,255,0.45), 0 ${p(1)}px ${p(6)}px rgba(0,0,0,0.55); }
  .hg { margin-top: -0.17em; }
  .hw { display: inline-block; margin-right: 0.26em; padding: 0.08em 0 0.15em; }
  .hw.hero { color: #ffffff; font-weight: 600; } /* heaviest Archivo Narrow cut loaded */

  /* TYPEWRITER: a glyph POPS on (no fade, no slide) at its delay… */
  .tg { display: inline-block; opacity: 0; animation: tOn 30ms linear both; }
  @keyframes tOn { 0% { opacity: 0; } 100% { opacity: 1; } }
  /* …and the cursor bar after it is visible ONLY until the next glyph types (window inline).
     width:0 + pre keeps it out of layout — it overhangs right after the glyph, same face/glow. */
  .cur { display: inline-block; width: 0; overflow: visible; white-space: pre; opacity: 0; }
  @keyframes curWin { 0% { opacity: 0; } 0.01%, 99.99% { opacity: 1; } 100% { opacity: 0; } }

  /* the shared size ladder */
  .f46 { font-size: ${p(46)}px; } .f42 { font-size: ${p(42)}px; } .f38 { font-size: ${p(38)}px; } .f35 { font-size: ${p(35)}px; }
  .f32 { font-size: ${p(32)}px; } .f29 { font-size: ${p(29)}px; } .f26 { font-size: ${p(26)}px; } .f23 { font-size: ${p(23)}px; }
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

const recipe: RecipeGenerator = { refId: 'hook-230-peak', generate };
export default recipe;
