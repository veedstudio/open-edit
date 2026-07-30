// Compiled recipe — hook-015 (0-00-14-06) · scattered handwritten collage (9:16, authored at 736×1312
// @25fps). Source sheet: ./recipe.md. Handwritten Caveat phrases on cream paper pills (slot 5 = the bare
// white aside), each pinned at its own rotated spot, popping in phrase-by-phrase with slide-from-bottom +
// blur + fade; a cream doodle arrow points at EVERY beat's accent pill (two silhouettes alternate).
//
// KNOWN --verify FALSE POSITIVE (cross-beat slot reuse): this layout time-multiplexes fixed slot positions
// across beats; the engine's occlusion pass once ignored the ancestor .cue opacity gate (engine bug
// 2026-07-09-verify-occlusion-ignores-cue-opacity-gate.md, FIXED in the published 0.6.0 — this ref is
// back in the draw pool). On an older engine, a run whose only failures are FAIL[occluded] is
// VERIFIED-WITH-KNOWN-EXCEPTION. Never move slot anchors to appease the occlusion rule.
//
// Only the sheet's sizing-row drop is automated (opts.demote keyed by the slot id b{N}s{K}, via pickRow).
// Report-only verify fixes NOT automated: edge-word move once a phrase is at 26px, top/bottom inward
// top-nudge, arrow deletion on arrow bounds, the 30px same-beat occlusion move.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta,
  demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

interface SizeRow extends LadderRow { fs: number; ls: number }

// table C — per-phrase size by char count; the 26px row absorbs any residual >35 overflow
// v3: tracking tightened across the board (letters were falling apart)
const SIZE_LADDER: SizeRow[] = [
  { cls: '', fs: 46, ls: 4, maxC: 12 },
  { cls: '', fs: 42, ls: 3, maxC: 16 },
  { cls: '', fs: 38, ls: 3, maxC: 20 },
  { cls: '', fs: 34, ls: 2, maxC: 24 },
  { cls: '', fs: 30, ls: 2, maxC: 28 },
  { cls: '', fs: 26, ls: 1, maxC: 35 },
];
// Curation 2026-07-21: the phrase-level hero bump (old table 5) is replaced by a WORD-level accent —
// one bottom-group word per beat renders at ×HERO_EM inside its pill; the phrase's ladder pick uses an
// INFLATED char count (hero word counted ×HERO_EM) so the stretched pill stays inside the slot budget.
const HERO_EM = 3; // v3: ×1.85 was not enough contrast

const SKIP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'with', 'my', 'we',
  'is', 'are', 'was', 'it', 'this', 'that', 'for', 'be', 'i', "mine's", "here's",
]);

// chars = exactly what gets typed into the div (letters+punctuation+inner single spaces)
export function phraseChars(ph: WordTiming[]): number {
  return ph.map((w) => w.w).join(' ').length;
}

// section-A table; rows 6..14 equal the 15+ closed form (base=floor(n/5), first n%5 get base+1)
export function phraseSizes(n: number): number[] {
  if (n <= 5) return Array(n).fill(1);
  const base = Math.floor(n / 5);
  return Array.from({ length: 5 }, (_, i) => base + (i < n % 5 ? 1 : 0));
}

// char-balance fix: at most two moves per beat; a >28 phrase sheds one edge word to an adjacent
// phrase ≥8 chars shorter (both qualify → the shorter neighbour, tie → previous); order preserved.
export function balancePhrases(phrases: WordTiming[][]): void {
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (let i = 0; i < phrases.length && !moved; i++) {
      const c = phraseChars(phrases[i]);
      if (c <= 28 || phrases[i].length < 2) continue;
      const prevOk = i > 0 && c - phraseChars(phrases[i - 1]) >= 8;
      const nextOk = i < phrases.length - 1 && c - phraseChars(phrases[i + 1]) >= 8;
      if (!prevOk && !nextOk) continue;
      const toPrev = prevOk && nextOk
        ? phraseChars(phrases[i - 1]) <= phraseChars(phrases[i + 1])
        : prevOk;
      if (toPrev) phrases[i - 1].push(phrases[i].shift()!);
      else phrases[i + 1].unshift(phrases[i].pop()!);
      moved = true;
    }
    if (!moved) break;
  }
}

// section-C escape hatch: a >35 phrase moves its edge word to the next slot (last slot → the word
// nearest the previous slot, keeping reading order); one move per phrase, then the ladder clamps.
export function overflowFix(phrases: WordTiming[][]): void {
  for (let i = 0; i < phrases.length; i++) {
    if (phraseChars(phrases[i]) <= 35 || phrases[i].length < 2) continue;
    if (i < phrases.length - 1) phrases[i + 1].unshift(phrases[i].pop()!);
    else if (i > 0) phrases[i - 1].push(phrases[i].shift()!);
  }
}

export function buildPhrases(words: WordTiming[]): WordTiming[][] {
  const phrases: WordTiming[][] = [];
  let i = 0;
  for (const s of phraseSizes(words.length)) {
    phrases.push(words.slice(i, i + s));
    i += s;
  }
  balancePhrases(phrases);
  overflowFix(phrases);
  return phrases;
}

// k phrases occupy a contiguous slot run starting here (section-B table's closed form)
export function slotStart(k: number): number {
  return 1 + Math.floor((5 - k) / 2);
}

const normWord = (w: string) => w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
const isContent = (w: string) => { const n = normWord(w); return n !== '' && !SKIP.has(n); };

// hero: digit-bearing beats all (longest, tie → earlier); else longest content word, tie → earlier;
// LAST beat → the beat's last content word instead. −1 = no hero.
export function heroIndex(words: WordTiming[], isLastBeat: boolean): number {
  if (isLastBeat) {
    for (let i = words.length - 1; i >= 0; i--) if (isContent(words[i].w)) return i;
    return -1;
  }
  let best = -1;
  for (let i = 0; i < words.length; i++) {
    if (/\d/.test(words[i].w) && (best < 0 || words[i].w.length > words[best].w.length)) best = i;
  }
  if (best >= 0) return best;
  for (let i = 0; i < words.length; i++) {
    if (isContent(words[i].w) && (best < 0 || words[i].w.length > words[best].w.length)) best = i;
  }
  return best;
}

// v3: arrows ANCHOR to pills — an arrow sits in the corridor between two consecutive pills of its
// beat and points toward the second one (the old fixed positions pointed at nothing). Slot tops and
// sides mirror the CSS slot table below (kept in one place via these consts).
export const SLOT_TOPS_015: Record<'A' | 'B', number[]> = {
  A: [145, 300, 665, 820, 1005],
  B: [160, 315, 680, 835, 1020],
};
export const SLOT_SIDE_015: Record<'A' | 'B', Array<'l' | 'r'>> = {
  A: ['l', 'r', 'l', 'r', 'l'],
  B: ['r', 'l', 'r', 'l', 'l'],
};

export function sizeFor(chars: number, demoteRows = 0): SizeRow {
  return pickRow(SIZE_LADDER, chars, demoteRows) as SizeRow;
}

// v6: EVERY beat's accent gets an arrow (Anton). TWO silhouettes alternate, as clip-path
// polygons on plain divs — inline <svg><path> does NOT render in this engine (measured: v4
// emitted 3 svg arrows, none drew; feature-support lists svg only under "failing parity").
// Both point DOWN toward the pill they mark; .aL* mirrors them left.
// ARROW-1 (the v3 curl) is BUILT, not hand-drawn: a band around the quadratic A→K→B, half-width
// tapered 6→9, 12 segments per edge — the dense sampling IS the rounding (the 5-point version
// showed hard corners at the bend; Anton: «скругли углы»). Head = two barbs + tip off the exit
// tangent. All numbers are % of the 112px arrow box.
function curlClip015(): string {
  const A = [16, 10];
  const K = [88, 12];
  const B = [64, 66];
  const q = (t: number, i: number) => (1 - t) * (1 - t) * A[i] + 2 * (1 - t) * t * K[i] + t * t * B[i];
  const dq = (t: number, i: number) => 2 * (1 - t) * (K[i] - A[i]) + 2 * t * (B[i] - K[i]);
  const f = (n: number) => `${Math.round(n * 10) / 10}%`;
  const N = 12;
  const outer: string[] = [];
  const inner: string[] = [];
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const [dx, dy] = [dq(t, 0), dq(t, 1)];
    const len = Math.hypot(dx, dy);
    const [nx, ny] = [dy / len, -dx / len];
    const w = 6 + 3 * t;
    outer.push(`${f(q(t, 0) + nx * w)} ${f(q(t, 1) + ny * w)}`);
    inner.unshift(`${f(q(t, 0) - nx * w)} ${f(q(t, 1) - ny * w)}`);
  }
  const len1 = Math.hypot(dq(1, 0), dq(1, 1));
  const [ux, uy] = [dq(1, 0) / len1, dq(1, 1) / len1];
  const [nx, ny] = [uy, -ux];
  const head = [
    `${f(B[0] + nx * 20)} ${f(B[1] + ny * 20)}`,
    `${f(B[0] + ux * 30)} ${f(B[1] + uy * 30)}`,
    `${f(B[0] - nx * 20)} ${f(B[1] - ny * 20)}`,
  ];
  return `polygon(${[...outer, ...head, ...inner].join(', ')})`;
}

export const ARROW_CLIPS_015 = [
  curlClip015(),
  // ARROW-2: thick vertical block, chunky head (the 12s arrow Anton liked as-is)
  'polygon(34% 4%, 62% 8%, 58% 46%, 80% 42%, 50% 96%, 20% 46%, 40% 48%)',
];
// per-beat variety: horizontal jitter in the corridor + one of two tilt variants
export const ARROW_XJIT_015 = [-44, 28, -20, 40, 0, -32];
export const ARROW_VAR_015 = [0, 1, 1, 0, 0, 1];

function arrowHtml(N: number, dir: 'l' | 'r', x: number, y: number, dMs: number, p: (n: number) => number): string {
  const shape = 1 + ((N - 1) % ARROW_CLIPS_015.length);
  const variant = ARROW_VAR_015[(N - 1) % ARROW_VAR_015.length] ? '2' : '';
  return `  <div class="arrow ar${shape} ${dir === 'r' ? 'aR' : 'aL'}${variant}" id="b${N}arr1"
       style="left:${p(x)}px; top:${p(y)}px; width:${p(112)}px; height:${p(112)}px; animation-delay:${dMs}ms;"></div>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};
  const beatCount = timings.beats.length;

  const cues = timings.beats.map((beat, idx) => {
    const phrases = buildPhrases(beat.words);
    const k = phrases.length;
    const s = slotStart(k);
    const set = beat.i % 2 === 1 ? 'A' : 'B';
    // accent word comes from the BOTTOM group only (slots 3-5) — a blown-up word in the top slots
    // would ride over the face zone (curation 2026-07-21)
    const bottomWords = phrases.flatMap((ph, j) => (s + j >= 3 ? ph : []));
    const h = heroIndex(bottomWords, idx === beatCount - 1);
    const heroWord = h >= 0 ? bottomWords[h] : null;

    const parts = phrases.map((ph, j) => {
      const slotN = s + j;
      const id = `b${beat.i}s${j + 1}`;
      const hero = heroWord != null && ph.includes(heroWord);
      // hero word inflates the ladder's char count by its own length ×(HERO_EM−1)
      const effC = phraseChars(ph) + (hero ? Math.round(heroWord!.w.length * (HERO_EM - 1)) : 0);
      const row = sizeFor(effC, demotionFor(demote, id));
      const text = ph
        .map((w) => (w === heroWord ? `<span class="hw">${escapeHtml(w.w)}</span>` : escapeHtml(w.w)))
        .join(' ');
      return `  <div class="s${set}${slotN}" id="${id}" data-node-role="text"
       style="font-size:${p(row.fs)}px; letter-spacing:${p(row.ls)}px; animation-delay:${ph[0].delayMs}ms;">${text}</div>`;
    });
    // v4: the arrow POINTS AT THE ACCENT pill — it sits in the corridor right above the hero's
    // slot, flipped toward the pill's side; only the rule-D beats carry one
    if (k >= 2 && heroWord != null) {
      const heroSlot = s + phrases.findIndex((ph) => ph.includes(heroWord));
      const above = SLOT_TOPS_015[set][Math.max(0, heroSlot - 2)];
      const own = SLOT_TOPS_015[set][heroSlot - 1];
      const dir = SLOT_SIDE_015[set][heroSlot - 1];
      // clamp so the .5s pop fully lands ≥150ms before the cue gate closes
      const aDelay = Math.min(heroWord.delayMs, beat.cueDelayMs + beat.cueDurMs - 650);
      const x = 312 + ARROW_XJIT_015[(beat.i - 1) % ARROW_XJIT_015.length];
      parts.push(arrowHtml(beat.i, dir, x, (above + own) / 2 - 25, aDelay, p));
    }

    return `<div class="cue" id="cue${beat.i}" style="animation-delay:${beat.cueDelayMs}ms; animation-duration:${beat.cueDurMs}ms;">
${parts.join('\n')}
</div>`;
  });

  const wv = `<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${p(736)}px; height:${p(1312)}px; position:relative; overflow:hidden; margin:0;
         font-family:'Caveat', cursive; background:#3a3640; }
  .vid { position:absolute; inset:0; width:${p(736)}px; height:${p(1312)}px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe. Delay+duration are set INLINE per beat. */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; z-index:10; opacity:0;
         animation:cueWin linear forwards; }

  /* ---- SLOTS (self-contained single classes; rotation is baked into each slot's own
          keyframes — NEVER var() in a transform). Set A = odd beats, Set B = even beats. ---- */
  /* v3: top pair rides higher still (safe zone allows it; words were kissing the face), bottom trio
     at the lower band; slot 5 wears the same cream pill; tops mirror SLOT_TOPS_015 */
  .sA1 { position:absolute; z-index:2; left:${p(70)}px;  top:${p(SLOT_TOPS_015.A[0])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1.5deg); animation:kA1 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sA2 { position:absolute; z-index:2; right:${p(106)}px; top:${p(SLOT_TOPS_015.A[1])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1deg); animation:kA2 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sA3 { position:absolute; z-index:2; left:${p(78)}px;  top:${p(SLOT_TOPS_015.A[2])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1.5deg); animation:kA3 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sA4 { position:absolute; z-index:2; right:${p(106)}px; top:${p(SLOT_TOPS_015.A[3])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1deg); animation:kA4 .5s cubic-bezier(.2,.7,.3,1) both; }
  /* slot 5 — same cream pill as the rest (curation 2026-07-21; was the bare white aside) */
  .sA5 { position:absolute; z-index:2; left:${p(300)}px; top:${p(SLOT_TOPS_015.A[4])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         animation:kA5 .5s cubic-bezier(.2,.7,.3,1) both; }

  .sB1 { position:absolute; z-index:2; right:${p(106)}px; top:${p(SLOT_TOPS_015.B[0])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1.5deg); animation:kB1 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB2 { position:absolute; z-index:2; left:${p(70)}px;  top:${p(SLOT_TOPS_015.B[1])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1deg); animation:kB2 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB3 { position:absolute; z-index:2; right:${p(106)}px; top:${p(SLOT_TOPS_015.B[2])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1.5deg); animation:kB3 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB4 { position:absolute; z-index:2; left:${p(78)}px;  top:${p(SLOT_TOPS_015.B[3])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1deg); animation:kB4 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB5 { position:absolute; z-index:2; left:${p(130)}px; top:${p(SLOT_TOPS_015.B[4])}px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:${p(4)}px ${p(12)}px ${p(8)}px;
         box-shadow:0 ${p(2)}px ${p(6)}px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         animation:kA5 .5s cubic-bezier(.2,.7,.3,1) both; }

  /* the beat's accent word — ×3 inside its pill (ladder pick already budgets the stretch);
     tracking tighter than the body to compensate the scale */
  .hw { font-size:${HERO_EM}em; letter-spacing:0; }

  /* slide-from-bottom + blur + fade, rotation held constant per keyframes (prefab-proven) */
  @keyframes kA1 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(-1.5deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(-1.5deg) translateY(0)}}
  @keyframes kA2 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(-1deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(-1deg) translateY(0)}}
  @keyframes kA3 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(1.5deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(1.5deg) translateY(0)}}
  @keyframes kA4 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(1deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(1deg) translateY(0)}}
  @keyframes kA5 {0%{opacity:0;filter:blur(${p(12)}px);transform:translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:translateY(0)}}
  @keyframes kB1 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(1.5deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(1.5deg) translateY(0)}}
  @keyframes kB2 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(1deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(1deg) translateY(0)}}
  @keyframes kB3 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(-1.5deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(-1.5deg) translateY(0)}}
  @keyframes kB4 {0%{opacity:0;filter:blur(${p(12)}px);transform:rotate(-1deg) translateY(0.7em)}60%{filter:blur(${p(2)}px)}100%{opacity:1;filter:blur(0);transform:rotate(-1deg) translateY(0)}}

  /* doodle arrows — anchored between two consecutive pills, pointing at the second (v3);
     z BELOW the slots (no base filter here) */
  .arrow { position:absolute; z-index:1; opacity:0; background:#f2efe6; }
  .ar1 { clip-path:${ARROW_CLIPS_015[0]}; }
  .ar2 { clip-path:${ARROW_CLIPS_015[1]}; }
  /* two tilt variants per direction — per-beat angle variety without per-arrow keyframes */
  .aR { transform:rotate(8deg); animation:kaR .5s cubic-bezier(.2,.7,.3,1) both; }
  .aL { transform:scaleX(-1) rotate(8deg); animation:kaL .5s cubic-bezier(.2,.7,.3,1) both; }
  .aR2 { transform:rotate(-7deg); animation:kaR2 .5s cubic-bezier(.2,.7,.3,1) both; }
  .aL2 { transform:scaleX(-1) rotate(-7deg); animation:kaL2 .5s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes kaR {0%{opacity:0;filter:blur(${p(10)}px);transform:rotate(8deg) translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:rotate(8deg) translateY(0)}}
  @keyframes kaL {0%{opacity:0;filter:blur(${p(10)}px);transform:scaleX(-1) rotate(8deg) translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:scaleX(-1) rotate(8deg) translateY(0)}}
  @keyframes kaR2 {0%{opacity:0;filter:blur(${p(10)}px);transform:rotate(-7deg) translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:rotate(-7deg) translateY(0)}}
  @keyframes kaL2 {0%{opacity:0;filter:blur(${p(10)}px);transform:scaleX(-1) rotate(-7deg) translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:scaleX(-1) rotate(-7deg) translateY(0)}}
</style>

<video class="vid" src="${meta.videoPath}" muted></video>

${cues.join('\n')}
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-015 (0-00-14-06)', generate };
export default recipe;
