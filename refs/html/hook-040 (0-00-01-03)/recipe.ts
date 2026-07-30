// Compiled recipe — hook-040 (0-00-01-03) · scattered kinetic word-cloud (16:9, authored at
// 1280×720 @24fps). Source sheet: ./recipe.md. ONE FACE THROUGHOUT — Archivo Black 400, body words
// and accents alike. Each spoken word is its own white glow element rising in (fade + lift — the
// prefab's entrance blur is deliberately dropped: the engine holds an animated filter's INITIAL
// value) at its own slot on a 12-slot serpentine path (down the near column, up the far column),
// keeping its spoken case, accumulating until the cue gate cuts the beat; odd beats anchor left, even
// beats mirror via `right:`. Beats longer than 12 words page — a mid-beat page dies via ONE pgOut
// completing at its successor's first word; the last page holds.
//
// TWO ACCENT WORDS per beat on TWO RUNGS, so every beat plays THREE type sizes — small / medium /
// HUGE. LEAD (2.8× the page rung, the beat's payoff word) = lib `accentIndex`: digit-bearing unit
// first, else the longest, tie → the LATER one. SUB (1.5× — the middle rung, the beat's setup word) =
// the same contest over the beat MINUS the lead, but the first digit-bearing unit else the longest
// unit of ≥4 chars, tie → the EARLIER one. The opposite tie-breaks pull the two apart in reading
// order; a beat under MIN_UNITS units, or with no ≥4-char candidate left, carries the LEAD ALONE (a
// two-word beat must never end up all-accent). With one face the hierarchy is PURE SIZE — no face
// swap left to lean on, so the rungs are spread WIDE (1× / 1.5× / 2.8×): a lead of 1.8 against a sub
// of 1.5 read as ONE size and the beat collapsed. CONTRAST OUTRANKS BODY SIZE — where the lead
// cannot fit, the BODY steps down and the lead stays huge, never the other way round.
//
// TRACKING falls as the type grows: body +0.02em (Archivo Black is heavy — the small rungs need their
// counters opened, and the old −0.01em was a Poppins correction), sub −0.04em, lead −0.07em (its own
// tightest value — at 2.8× the sub's −0.04 reads airy). Those three values ARE the width model:
// Archivo Black measures ≈0.615 em/char mixed-case at zero tracking on this skeleton's calibration
// render, so ≈0.635 / 0.575 / 0.545 em/char per rung. Each accent's char weight is therefore the pure
// size ratio × its advance ratio against the body (SUB_W = 1.5 × 0.575/0.635,
// LEAD_W = 2.8 × 0.545/0.635), so both obey the same side-band budget as the body words and neither
// can grow across the frame centre; on the far column's inner slot (x 640 = the centre line) an accent
// of either rung nudges outward to 700. If a rung does not fit, the WHOLE page steps down the
// f-ladder together — the 1.5×/2.8× ratios never move.
//
// opts.demote (keys = the exact ids --verify names: b{N}w{k} words / b{N}p{j} pages) automates only
// the §6 left/right bounds fix: the flagged word's PAGE steps down the f-ladder (all its words shrink
// together, both accents with them via their paired a-/l-classes). Report-only (NOT automated): the
// top/bottom closed-form re-check, the never-visible checklist, and the occlusion window clamp.
import {
  type RecipeGenerator, type RecipeOptions, type RunMeta, type LadderRow,
  accentIndex, demotionFor, escapeHtml, manifestFor, pgOutDelayMs, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

export interface Word {
  text: string; // spoken case kept, trailing ./, stripped, glue merged
  delayMs: number; // VERBATIM (a glued word keeps the FIRST token's delay)
}

export const SLOTS_PER_PAGE = 12;
// §3 slot path (reference px): slots 0–5 step down the near column, 6–11 climb the far column.
export const SLOT_X = [133, 104, 236, 107, 210, 160, 640, 700, 760, 820, 880, 940];
export const SLOT_Y = [96, 188, 282, 370, 466, 556, 556, 466, 370, 282, 188, 96];
// §3 width budgets (reference px; near: 624 − x, far: 1203 − x) — C is computed here, never scaled.
export const AVAIL = [491, 520, 388, 517, 414, 464, 563, 503, 443, 383, 323, 263];

// §3 sizing ladder: F by page pressure C = ceil(1000·max(charLen/avail)). ADV budget = 0.70 em/char
// = the body rung's measured advance (Archivo Black @ +0.02em ≈ 0.635) × the 1.10 safety margin.
// maxC = floor(1000/(ADV·size)) — re-derived for Archivo Black, which eats ~13% more width per char
// than the Poppins body this ladder was first cut for, so every row now fits fewer chars per slot.
//
// The ladder TOPS OUT AT 36, not the prefab's 47, and that is a VERTICAL budget, not a width one: a
// slot is TOP-anchored, so the 2.8× lead grows DOWNWARD out of the bottom slot row (y 556). Its
// deepest ink sits ≈1.22·F below the element top (0.08em half-leading at line-height 1.4 + 0.98em
// ascent + a ≈0.16em descender) and the wordIn lift holds it 33px LOWER on its entrance frame:
//   556 + 1.22·(2.8·36) + 33 = 712 ≤ 720 ✓   (2.8·40 = 112 measured 5.5px out of frame on "phone")
// Stepping the whole body ladder down is the deliberate trade — the three-rung CONTRAST is the design,
// the body's absolute size is not, and the runner's demote loop would shrink the LEAD along with it.
export const ADV = 0.7;
const SIZES = [36, 32, 29, 26, 23, 21];
export const LADDER: LadderRow[] = [
  { cls: 'f36', maxC: 39 }, { cls: 'f32', maxC: 44 }, { cls: 'f29', maxC: 49 },
  { cls: 'f26', maxC: 54 }, { cls: 'f23', maxC: 62 }, { cls: 'f21', maxC: Infinity },
];
const FADE_MS = 280;

// §5 the two accent rungs, both keyed off the page's body size.
// SUB = 1.5× (Archivo Black at −0.04em) · LEAD = 2.8× (Archivo Black at −0.07em).
// The gap between the rungs is the whole point: 1.5 vs 1.8 read as ONE size on a shared face, so the
// lead jumps clear of the sub instead of nudging past it. 2.8 is what the bottom slot row's descender
// budget allows (see the ladder above) and it is paid for out of the BODY — the f-ladder tops out at
// 36 so the lead can stay huge — never out of the lead.
export const SUB_SCALE = 1.5;
export const LEAD_SCALE = 2.8;
export const SUB_SIZES = SIZES.map((s) => Math.round(s * SUB_SCALE)); // 54 48 44 39 35 32
export const LEAD_SIZES = SIZES.map((s) => Math.round(s * LEAD_SCALE)); // 101 90 81 73 64 59
const SUB_CLS: Record<string, string> = Object.fromEntries(LADDER.map((r, i) => [r.cls, `a${SUB_SIZES[i]}`]));
const LEAD_CLS: Record<string, string> = Object.fromEntries(LADDER.map((r, i) => [r.cls, `l${LEAD_SIZES[i]}`]));
export const subClsFor = (cls: string): string => SUB_CLS[cls];
export const leadClsFor = (cls: string): string => LEAD_CLS[cls];
// §5 accent char weights in the page pressure = the size step × the rung's advance ratio against the
// body rung. ONE FACE now, so the only thing left to correct for is TRACKING: Archivo Black measures
// ≈0.635 em/char mixed-case at the body's +0.02em, ≈0.575 at the sub's −0.04em, ≈0.545 at the lead's
// −0.07em. Each rung keeps the SAME 1.10 safety margin as ADV (it rides in via the ladder's maxC).
export const SUB_W = 1.36; // 1.5 × (0.575/0.635)
export const LEAD_W = 2.4; // 2.8 × (0.545/0.635)
// §5 centre gutter: slot 6 anchors ON the frame centre (x 640). An accent of EITHER rung steps outward
// to the next far-column anchor so a blown-up word sits in the side band instead of straddling the
// subject. Body words at slot 6 never move.
export const CENTRE_SLOT = 6;
export const ACC_X = SLOT_X.map((x, s) => (s === CENTRE_SLOT ? 700 : x));
export const ACC_AVAIL = AVAIL.map((a, s) => (s === CENTRE_SLOT ? 503 : a));

// §5 degradation floors — below either one the beat carries the LEAD alone.
export const MIN_UNITS = 4; // a 2- or 3-word beat must keep a body majority
export const MIN_SUB_CHARS = 4; // no 3-letter function word ("And", "the", "one") is ever blown up

// keep spoken case; strip a trailing `.` or `,` (keep ? ! ' and internal punctuation); VEED glue:
// a leading-`-` token concatenates into the previous word with no gap, counted as ONE word.
export function prepWords(words: WordTiming[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const text = w.w.trim().replace(/[.,]$/, '');
    if (!text) continue;
    const prev = out[out.length - 1];
    if (text.startsWith('-') && prev) prev.text += text;
    else out.push({ text, delayMs: w.delayMs });
  }
  return out;
}

// §3 paging: P = ceil(n/12), sizes as equal as possible, earlier pages take the extra, order kept.
export function paginateWords(words: Word[]): Word[][] {
  const P = Math.ceil(words.length / SLOTS_PER_PAGE);
  const base = Math.floor(words.length / P);
  const extra = words.length % P;
  const pages: Word[][] = [];
  let at = 0;
  for (let j = 0; j < P; j++) {
    const take = base + (j < extra ? 1 : 0);
    pages.push(words.slice(at, at + take));
    at += take;
  }
  return pages;
}

// §3 page pressure: C = ceil(1000 · max_s(charLen_s / avail_s)) over the page's words at their slots.
// The accent slots (leadS/subS = their indices in THIS page, −1 when the accent is on another page or
// absent) count LEAD_W/SUB_W · charLen against the gutter-corrected budget — each blown-up word fits
// its band or the page steps down together.
export function pressureFor(page: Word[], leadS = -1, subS = -1): number {
  return Math.ceil(1000 * Math.max(...page.map((w, s) => {
    if (s === leadS) return (w.text.length * LEAD_W) / ACC_AVAIL[s];
    if (s === subS) return (w.text.length * SUB_W) / ACC_AVAIL[s];
    return w.text.length / AVAIL[s];
  })));
}

// §5 the beat's two accent indices (indices in the BEAT, so a paged beat still emphasises exactly two
// words in total). LEAD keeps the lib rule (digit first, else longest, tie → the LATER unit) — the
// payoff word, which naturally sits late. SUB re-runs the contest over the rest with the tie flipped
// to the EARLIER unit and a MIN_SUB_CHARS floor on the length branch (a digit unit is strong at any
// length and skips the floor) — the setup word, which naturally sits early. sub = −1 → lead alone.
export function accentsFor(words: Word[]): { lead: number; sub: number } {
  const lead = accentIndex(words.map((w) => ({ spans: [{ text: w.text, delayMs: w.delayMs }], chars: w.text.length })));
  if (words.length < MIN_UNITS) return { lead, sub: -1 };
  for (let i = 0; i < words.length; i++) {
    if (i !== lead && /\d/.test(words[i].text)) return { lead, sub: i };
  }
  let sub = -1;
  for (let i = 0; i < words.length; i++) {
    if (i === lead || words[i].text.length < MIN_SUB_CHARS) continue;
    if (sub < 0 || words[i].text.length > words[sub].text.length) sub = i; // strict > → ties keep the EARLIER
  }
  return { lead, sub };
}

// §4 entrance compression: a late word still lands before the gate. ms never scale.
export function inMsFor(delayMs: number, cueEndMs: number): number {
  return Math.min(500, Math.max(220, cueEndMs - delayMs - 80));
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 1280, 720));
  const demote = opts.demote ?? {};

  const cues = timings.beats.map((beat) => {
    const N = beat.i;
    const words = prepWords(beat.words);
    if (!words.length) return '';
    const cueEnd = beat.cueDelayMs + beat.cueDurMs;
    const side = N % 2 === 1 ? 'left' : 'right';
    const pages = paginateWords(words);
    const { lead: leadK, sub: subK } = accentsFor(words);
    let k = 0;
    const pageDivs = pages.map((page, j) => {
      const pgId = `b${N}p${j + 1}`;
      const wordIds = page.map((_, i) => `b${N}w${k + i}`);
      // each accent's slot in THIS page (out of range on the other pages, −1 when the beat has no sub)
      const leadS = leadK - k;
      const subS = subK < 0 ? -1 : subK - k;
      const row = pickRow(LADDER, pressureFor(page, leadS, subS), demotionFor(demote, pgId, ...wordIds));
      const isLast = j === pages.length - 1;
      const pgStyle = isLast
        ? 'animation:none'
        : `animation-delay:${pgOutDelayMs(
            page.map((w) => ({ spans: [{ text: w.text, delayMs: w.delayMs }], chars: w.text.length })),
            pages[j + 1][0].delayMs, FADE_MS)}ms`;
      const wordDivs = page.map((w, s) => {
        const id = `b${N}w${k++}`;
        const isLead = s === leadS;
        const isSub = s === subS;
        const cls = isLead ? `w acc lead ${leadClsFor(row.cls)}`
          : isSub ? `w acc ${subClsFor(row.cls)}`
          : `w ${row.cls}`;
        const x = isLead || isSub ? ACC_X[s] : SLOT_X[s];
        return `    <div class="${cls}" id="${id}" data-node-id="${id}" data-node-role="text" style="${side}:${p(x)}px;top:${p(SLOT_Y[s])}px;animation-delay:${w.delayMs}ms;animation-duration:${inMsFor(w.delayMs, cueEnd)}ms">${escapeHtml(w.text)}</div>`;
      });
      return `  <div class="pg" id="${pgId}" data-node-id="${pgId}" style="${pgStyle}">
${wordDivs.join('\n')}
  </div>`;
    });
    return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${beat.cueDurMs}ms">
${pageDivs.join('\n')}
</div>`;
  }).filter(Boolean);

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(1280)}px; height: ${p(720)}px; }
  /* ONE FACE for the whole cloud — Archivo Black ships a single weight (400); never ask for 700. */
  body { background: #0e0d10; overflow: hidden; position: relative; font-family: "Archivo Black", system-ui, sans-serif; }
  .vid { position: absolute; inset: 0; width: ${p(1280)}px; height: ${p(720)}px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: ${p(1280)}px; height: ${p(720)}px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* page wrapper — a mid-beat page dies together via ONE pgOut (delay comes inline);
     the beat's LAST page holds (inline animation:none) and the cue gate cuts it */
  .pg { position: absolute; left: 0; top: 0; width: ${p(1280)}px; height: ${p(720)}px;
        animation-name: pgOut; animation-duration: ${FADE_MS}ms; animation-timing-function: ease;
        animation-fill-mode: forwards; }
  @keyframes pgOut { from { opacity: 1; } to { opacity: 0; } }

  /* scattered word — the ANIMATED unit is one absolutely positioned word div. Rise + fade ONLY:
     the prefab's 12px entrance blur is deliberately dropped (the engine holds an animated filter's
     INITIAL value — the word would stay blurred forever). translateY ends at identity. Shadow =
     the prefab's tight white halo + one dark grounding layer for light footage. */
  @keyframes wordIn { 0% { opacity: 0; transform: translateY(${p(33)}px); } 100% { opacity: 1; transform: none; } }
  .w { position: absolute; white-space: nowrap; color: #ffffff; opacity: 0;
       font-weight: 400; line-height: 1.4; letter-spacing: 0.02em;
       text-shadow: 0 0 ${p(1)}px rgba(255,255,255,0.95), 0 0 ${p(5)}px rgba(255,255,255,0.5),
                    0 0 ${p(14)}px rgba(235,242,255,0.3), 0 ${p(2)}px ${p(10)}px rgba(0,0,0,0.55);
       animation-name: wordIn; animation-timing-function: cubic-bezier(.2,.7,.3,1);
       animation-fill-mode: both; }

  /* ACCENTS — TWO words per beat on two rungs. One face throughout, so the hierarchy is PURE SIZE
     and the only thing these classes carry is the TRACKING CURVE: it falls as the type grows, body
     +0.02em (Archivo Black is heavy — the small rungs need their counters opened) → .acc −0.04em
     (the SUB rung, 1.5×) → .lead −0.07em (the LEAD rung, 2.8×, its own tightest value: at ~110px the
     sub's −0.04 reads loose and airy). Declared after .w, .lead after .acc, so every override lands. */
  .acc { letter-spacing: -0.04em; }
  .lead { letter-spacing: -0.07em; }

  ${SIZES.map((s) => `.f${s}{font-size:${p(s)}px}`).join(' ')}
  ${SUB_SIZES.map((s) => `.a${s}{font-size:${p(s)}px}`).join(' ')}
  ${LEAD_SIZES.map((s) => `.l${s}{font-size:${p(s)}px}`).join(' ')}
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

const recipe: RecipeGenerator = { refId: 'hook-040 (0-00-01-03)', generate };
export default recipe;
