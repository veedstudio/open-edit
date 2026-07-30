// Compiled recipe — hook-107-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// Scattered two-font editorial stack over full-bleed footage: sentence-case phrases step down six fixed
// slots (Archivo 800 sans alternating with Playfair italic), fading up on their spoken timings, while
// ONE counter-accent unit per beat pops scale(0)→scale(1) on the torn-paper red gradient sticker tilted
// −3° at mid-frame (the prefab's "intentional"). The prefab's flat green demo bg is replaced by the
// footage (overlay-on-subject) and the white ink gets a dark grounding text-shadow. The gradient fill
// is calibrated through the engine on this construct; fallback if it ever stops painting: flat #e2140c.
// The pop is scale-only on the INNER paper/word (static rotate stays on the box) — layout position is
// in-bounds, so --verify's pre-transform ink measurement stays clean.
// NOTE: non-ladder verify fixes (never-visible → timing/class audit, occluded → window/z audit) are NOT
// automated — the runner only demotes ladders; those failures are reported honestly.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// Advance budgets measured via a calibration render on the run engine (em/char incl the word gap):
// Archivo 800 sentence-case 0.62 (0.32em margin + nbsp), Playfair italic 0.56 (0.45em margin + nbsp),
// Playfair upright (sticker; digit-safe) 0.54.
const SANS_EM = 0.62;
const SERIF_EM = 0.56;
const STK_EM = 0.54;

export interface SlotDef {
  anchor: string; // inline-position fragment of the slot class (sheet section 3)
  font: 'sans' | 'serif';
  sizes: number[]; // descending; last row absorbs
  budget: number; // ink width budget px at the reference canvas
}

// The six scattered slots, position order 1..6 (prefab ×1.0222; p6 capped at 80 for the bottom margin).
// Curation 2026-07-21 (v4): slots 1-3 another 45px up (85/245/315 — the art-directed line), the sticker
// stays at 810 (clear of the face; overlapping a lower word is fine — the paper lies ON TOP),
// slots 4-6 at 875/985/1040.

// v4 (the picked trio, cycled): the v3 fine-zigzag rectangle, the coarse slanted tear
// ("pointless"), the notched ticket stub ("professionally").
export const PAPER_SHAPES_107 = [
  `polygon(2% 22%, 9% 8%, 18% 16%, 27% 4%, 38% 14%, 49% 2%, 60% 12%, 72% 3%, 83% 14%, 93% 6%, 99% 24%, 96% 42%, 100% 60%, 95% 78%, 99% 92%, 88% 86%, 77% 97%, 65% 88%, 53% 98%, 42% 87%, 30% 96%, 19% 85%, 8% 94%, 1% 74%, 4% 56%, 0% 40%)`,
  `polygon(0% 30%, 4% 8%, 20% 14%, 38% 2%, 60% 10%, 82% 4%, 98% 14%, 94% 38%, 99% 60%, 95% 88%, 76% 80%, 58% 94%, 38% 82%, 20% 92%, 4% 82%, 2% 56%)`,
  `polygon(2% 10%, 30% 4%, 52% 12%, 74% 3%, 98% 12%, 88% 30%, 97% 50%, 87% 68%, 98% 88%, 70% 95%, 50% 86%, 28% 96%, 3% 90%, 12% 68%, 2% 50%, 13% 30%)`,
];
export const PAPER_ROT_107 = [-3, 2.5, 2];
export const SLOTS: SlotDef[] = [
  { anchor: 'left:61px;   top:85px;', font: 'sans', sizes: [162, 120, 92, 72, 58, 46, 38], budget: 594 },
  { anchor: 'left:169px;  top:245px;', font: 'sans', sizes: [72, 58, 46, 38, 32], budget: 486 },
  { anchor: 'right:81px;  top:315px;', font: 'serif', sizes: [90, 72, 58, 46, 38, 32], budget: 480 },
  { anchor: 'right:81px;  top:875px;', font: 'serif', sizes: [86, 70, 58, 46, 38, 32], budget: 480 },
  { anchor: 'left:119px;  top:985px;', font: 'serif', sizes: [92, 74, 60, 48, 40, 32], budget: 536 },
  { anchor: 'right:81px;  top:1040px;', font: 'sans', sizes: [80, 64, 52, 42, 34, 28], budget: 486 },
];
export const STICKER_SIZES = [57, 48, 40, 34, 29, 25];
const STICKER_BUDGET = 330;

interface SizeRow extends LadderRow { fs: number }

// maxC = floor(budget / (em·F)); the last row absorbs any overflow (the sheet's per-slot tables).
export function ladderFor(sizes: number[], budget: number, em: number): SizeRow[] {
  return sizes.map((fs, i) => ({
    cls: '', fs,
    maxC: i === sizes.length - 1 ? Infinity : Math.floor(budget / (em * fs)),
  }));
}

const SLOT_LADDERS = SLOTS.map((s) => ladderFor(s.sizes, s.budget, s.font === 'sans' ? SANS_EM : SERIF_EM));
const STICKER_LADDER = ladderFor(STICKER_SIZES, STICKER_BUDGET, STK_EM);

// Word prep: strip a trailing `.` or `,`; keep `?` `!` `'` and internal punctuation (10,000 stays).
export function stripWord(w: string): string {
  return w.replace(/[.,]$/, '');
}

// Units keep transcript case (the design is sentence-case) + VEED glue: a leading-`-` token merges
// with the previous word into ONE unit, each span keeping its own verbatim delay.
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

// k = min(6, m); base = floor(m/k); the first (m mod k) phrases take base+1 consecutive units.
export function groupCounts(m: number): number[] {
  const k = Math.min(6, m);
  const base = Math.floor(m / k);
  const rem = m % k;
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

// k phrases occupy a contiguous slot run starting here (sheet section-3 table's closed form).
export function slotStart(k: number): number {
  return 1 + Math.floor((6 - k) / 2);
}

export function inMs107(availMs: number): number {
  return Math.min(420, Math.max(200, availMs - 80));
}
export function popMs107(availMs: number): number {
  return Math.min(500, Math.max(250, availMs - 80));
}

export function slotRowFor(P: number, C: number, demoteRows = 0): SizeRow {
  return pickRow(SLOT_LADDERS[P - 1], C, demoteRows) as SizeRow;
}
export function stickerRowFor(C: number, demoteRows = 0): SizeRow {
  return pickRow(STICKER_LADDER, C, demoteRows) as SizeRow;
}

function spansHtml(units: Unit[], wCls: string, cueEndMs: number): string {
  const out: string[] = [];
  units.forEach((u, ui) => {
    u.spans.forEach((s, k) => {
      // glued internal spans and the slot's final span drop the gap (margin zeroed, no nbsp)
      const gapless = k < u.spans.length - 1 || (ui === units.length - 1 && k === u.spans.length - 1);
      const style = `animation-delay:${s.delayMs}ms;animation-duration:${inMs107(cueEndMs - s.delayMs)}ms${gapless ? ';margin-right:0' : ''}`;
      out.push(`<span class="${wCls}" style="${style}">${escapeHtml(s.text)}${gapless ? '' : '&#160;'}</span>`);
    });
  });
  return out.join('');
}

function cueHtml(beat: WordTimings['beats'][number], demote: Record<string, number>, p: (n: number) => number): string {
  const N = beat.i;
  const units = unitsFor(beat.words);
  if (!units.length) return '';
  const cueEnd = beat.cueDelayMs + beat.cueDurMs;

  const acc = accentIndex(units);
  const accUnit = units[acc];
  const rest = units.filter((_, i) => i !== acc);

  const parts: string[] = [];
  if (rest.length) {
    const counts = groupCounts(rest.length);
    const start = slotStart(counts.length);
    let at = 0;
    counts.forEach((take, j) => {
      const phrase = rest.slice(at, at + take);
      at += take;
      const P = start + j;
      const slot = SLOTS[P - 1];
      const id = `b${N}s${P}`;
      const row = slotRowFor(P, charsOf(phrase), demotionFor(demote, id));
      parts.push(`  <div class="t ${slot.font} p${P}" id="${id}" data-node-id="${id}" data-node-role="text" style="font-size:${p(row.fs)}px">${spansHtml(phrase, slot.font === 'sans' ? 'w' : 'wi', cueEnd)}</div>`);
    });
  }

  const accDelay = accUnit.spans[0].delayMs;
  const pop = popMs107(cueEnd - accDelay);
  const stkIds = accUnit.spans.map((_, k) => `b${N}stk${k ? k + 1 : ''}`);
  const row = stickerRowFor(accUnit.chars, demotionFor(demote, ...stkIds));
  const stWords = accUnit.spans
    .map((s, k) => `<span class="stword" id="${stkIds[k]}" data-node-id="${stkIds[k]}" data-node-role="text" style="font-size:${p(row.fs)}px;animation-delay:${s.delayMs}ms;animation-duration:${pop}ms">${escapeHtml(s.text)}</span>`)
    .join('');
  // v4: the word sits shifted up-left off the paper's centre (0.12em diagonal misregistration —
  // the collage read); the v3 +0.08em optical drop is gone
  const d = Math.round(0.12 * row.fs);
  const stop = Math.floor((143 - Math.round(1.3 * row.fs)) / 2) - d;
  const shape = PAPER_SHAPES_107[(N - 1) % PAPER_SHAPES_107.length];
  const rot = PAPER_ROT_107[(N - 1) % PAPER_ROT_107.length];
  parts.push(`  <div class="stkr" data-node-id="b${N}kbox" style="transform:rotate(${rot}deg)">
    <span class="paper" style="clip-path:${shape};animation-delay:${accDelay}ms;animation-duration:${pop}ms"></span>
    <div class="stw" style="left:${p(-d)}px;top:${p(stop)}px">${stWords}</div>
  </div>`);

  return `<div class="cue" id="cue${N}" data-node-id="cue${N}"
     style="z-index:${10 + N};animation-delay:${beat.cueDelayMs}ms;animation-duration:${beat.cueDurMs}ms">
${parts.join('\n')}
</div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};
  const cues = timings.beats.map((beat) => cueHtml(beat, demote, p)).filter(Boolean);

  const wv = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,800;0,900&family=Playfair+Display:ital,wght@0,500;0,600;1,500;1,600&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${p(736)}px; height:${p(1312)}px; overflow:hidden; background:#000; }
  body { position:relative; }
  .vid { position:absolute; inset:0; width:${p(736)}px; height:${p(1312)}px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }

  /* scattered slot text — white ink over footage needs the dark grounding shadow */
  .t { position:absolute; z-index:2; color:#fff; white-space:nowrap; line-height:1.3;
       text-shadow:0 ${p(1)}px ${p(6)}px rgba(0,0,0,0.35), 0 ${p(1)}px ${p(2)}px rgba(0,0,0,0.25); } /* v3: gentler grounding — the old stack read dirty */
  .sans  { font-family:"Archivo","Helvetica Neue",Arial,sans-serif; font-weight:800; letter-spacing:-0.02em; }
  .serif { font-family:"Playfair Display",Georgia,serif; font-style:italic; font-weight:500; }

  /* the six scattered slots (anchors fixed; font-size comes inline from the sizing tables) */
${SLOTS.map((s, i) => `  .p${i + 1} { ${s.anchor.replace(/(\d+)px/g, (_, n) => `${p(Number(n))}px`)} }`).join('\n')}

  /* word reveal — the prefab's fade+rise; gap = margin + the &#160; each non-final span carries
     (inter-span whitespace is dropped; italic Playfair caps overhang, hence the wider .wi margin) */
  .w  { display:inline-block; opacity:0; margin-right:0.32em;
        animation-name:wIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  .wi { display:inline-block; opacity:0; margin-right:0.45em;
        animation-name:wIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wIn { 0%{opacity:0;transform:translateY(0.28em)} 100%{opacity:1;transform:translateY(0)} }

  /* torn-paper red sticker — tilt + silhouette cycled per beat (inline); ONLY the inner paper/word
     animate. v3: the pop runs 120%→100% with a fade-in — the paper LANDS on the frame instead of
     inflating from nothing. Gradient calibrated through the engine (fallback: flat #e2140c). */
  /* v4: 40px left of the v3 spot — at 192 the plate cut through the right-anchored slot words */
  .stkr { position:absolute; left:${p(152)}px; top:${p(810)}px; width:${p(368)}px; height:${p(143)}px;
          transform-origin:center center; z-index:3; }
  .paper { position:absolute; inset:0; z-index:1;
           background:linear-gradient(135deg, #ff2a1c 0%, #e2140c 55%, #c20f08 100%);
           opacity:0; transform:scale(1.2); transform-origin:50% 50%;
           animation-name:pop; animation-timing-function:cubic-bezier(.2,.8,.25,1); animation-fill-mode:both; }
  /* word row = full-width block + text-align:center (a translate(-50%,-50%) wrapper mis-centers in
     this engine); its inline top comes from the sheet's closed form */
  .stw { position:absolute; left:0; width:100%; text-align:center; z-index:2; white-space:nowrap; }
  .stword { display:inline-block; font-family:"Playfair Display",Georgia,serif; font-style:normal;
            font-weight:500; color:#0a0a0a; letter-spacing:0.009em; line-height:1.3;
            opacity:0; transform:scale(1.2); transform-origin:50% 50%;
            animation-name:pop; animation-timing-function:cubic-bezier(.2,.8,.25,1); animation-fill-mode:both; }
  @keyframes pop { 0%{opacity:0;transform:scale(1.2)} 100%{opacity:1;transform:scale(1)} }
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

const recipe: RecipeGenerator = { refId: 'hook-107-peak', generate };
export default recipe;
