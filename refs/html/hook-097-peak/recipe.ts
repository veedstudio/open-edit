// Compiled recipe — hook-097-peak (9:16, authored at 736×1312 @25fps). Source sheet: ./recipe.md.
// Two tilted film-strip rows over full-bleed footage (the prefab's flat board is dropped): plain 2D
// rotate(-3deg)/rotate(5.5deg) bands with white film frames holding giant Archivo 900 caps (one red
// counter-accent unit per strip), mono label/marks chrome, later strips sliding in from off-screen
// with the rotate baked into the translateX keyframes; words pop on their spoken timing.
// NOTE: sheet §6's never-visible/occluded fixes are NOT automated — the runner only demotes ladders;
// those FAILs are reported honestly. Demote keys are the exact --verify ids (b{N}p{P}f{F} / …lab /
// …mk); sizing is per PAGE, so any flagged id demotes ALL the page's frames (geometry recomputes).
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  accentIndex, demotionFor, escapeHtml, manifestFor, paginate, pgOutDelayMs, pickRow, pxScaler,
  scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

// Archivo 900 caps advance em/char incl -0.026em tracking (measured by calibration render)
export const A097 = 0.75;
const INK = 544; // frames-row total budget (mid-pop growth + rotated bbox budgeted in); ×0.85 with the strip rescale
const PAD_X = 20; // frame chrome: 10px each side
const GAP = 18;
const STRIP_W = 818;
// Curation 2026-07-21: both strips ride in the LOWER THIRD (bottom band overlaps the top one — by
// design) and the whole strip package is ×0.85 so the rotated bboxes clear the social safe zones.
// v3: band tilt VARIES per beat (one fixed pair read as a stamp), EVERY strip slides in (the first
// page appeared with a hard cut while later pages slid), band/frame height adapts to 1-line pages,
// and every frame centres its words.
const FR_H2 = 150; // frame height when a page has a two-line frame
const FR_H1 = 108; // …when every frame is single-line
const BAND_CHROME = 62; // lab above + marks below
export const ANGLES_097: Array<[number, number]> = [[-3, 5.5], [4, -2.5], [-5, 2.5]];
const LINE_EM = 1.24; // span box: line-height 1 + 0.06/0.18em shear padding
const STACK2_EM = 2.14; // two stacked lines (.ln2 pulls -0.34em)
const POP_MS = 160;
const POP_MIN_MS = 100;
const SLIDE_MS = 420;
const FADE_MS = 250;
const MAX_CHARS = 24;
const MAX_UNITS = 6;

const LAB_T = '1214&#160;&#160;LUX&#160;&#160;PLUS';
const LAB_B = '212&#160;&#160;MED&#160;&#160;BALANCE&#160;&#160;FILM';
const MK_T = '1&#160;&#160;&#160;&#160;1A&#160;&#160;&#160;&#160;2&#160;&#160;&#160;&#160;2A&#160;&#160;&#160;&#160;3';
const MK_B = '3A&#160;&#160;&#160;&#160;4&#160;&#160;&#160;&#160;4A&#160;&#160;&#160;&#160;5&#160;&#160;&#160;&#160;5A';

export function budget097(F: number): number {
  return INK - PAD_X * F - GAP * (F - 1);
}

// fs ≤ B_F/(A·S), normalized to the F=3 budget so one table serves all F
const FS_ROWS = [51, 46, 41, 37, 32, 29, 26, 23, 20];
const LADDER: LadderRow[] = FS_ROWS.map((fs, i) => ({
  cls: `s${fs}`,
  maxC: i === FS_ROWS.length - 1 ? Infinity : budget097(3) / (A097 * fs),
}));

export function fsOf097(row: LadderRow): number {
  return Number(row.cls.slice(1));
}

// n units → F = min(3, n) frames; frame f takes floor(n/F) (+1 for the first n mod F), order kept
export function framesFor097(units: Unit[]): Unit[][] {
  const F = Math.min(3, units.length);
  const base = Math.floor(units.length / F);
  const rem = units.length % F;
  const out: Unit[][] = [];
  let i = 0;
  for (let f = 0; f < F; f++) {
    const take = base + (f < rem ? 1 : 0);
    out.push(units.slice(i, i + take));
    i += take;
  }
  return out;
}

export function sumMax097(frames: Unit[][]): number {
  return frames.reduce((s, fr) => s + Math.max(...fr.map((u) => u.chars)), 0);
}

export function normC097(S: number, F: number): number {
  return (S * budget097(3)) / budget097(F);
}

export function sizeRow097(C: number, demoteRows = 0): LadderRow {
  return pickRow(LADDER, C, demoteRows);
}

// entrance compression at the gate: null = the default 160ms pop fits
export function entranceDur097(delayMs: number, gateEndMs: number): number | null {
  if (delayMs + POP_MS <= gateEndMs) return null;
  return Math.max(gateEndMs - delayMs, POP_MIN_MS);
}

// frame geometry in UNROUNDED reference px — pxScaler rounds at emit
export function frameGeom097(frames: Unit[][], fs: number, frH: number): { widths: number[]; lefts: number[]; padTops: number[] } {
  const widths = frames.map((fr) => Math.max(...fr.map((u) => u.chars)) * A097 * fs + PAD_X);
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (frames.length - 1);
  const lefts: number[] = [];
  let x = (STRIP_W - total) / 2;
  for (const w of widths) {
    lefts.push(x);
    x += w + GAP;
  }
  const padTops = frames.map((fr) => (frH - (fr.length === 2 ? STACK2_EM : LINE_EM) * fs) / 2);
  return { widths, lefts, padTops };
}

function spanHtml(u: Unit, gateEndMs: number): string {
  const cls = u.accent ? 'wp red' : 'wp';
  return u.spans
    .map((s) => {
      const dur = entranceDur097(s.delayMs, gateEndMs);
      const style = `animation-delay:${s.delayMs}ms${dur !== null ? `; animation-duration:${dur}ms` : ''}`;
      return `<span class="${cls}" style="${style}">${escapeHtml(s.text)}</span>`;
    })
    .join('');
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const slideKfs: string[] = []; // per-beat slide keyframes (angles vary by beat)
  const cues = timings.beats.map((beat, idx) => {
    const units = toUnits(beat.words);
    const pages = paginate(units, MAX_CHARS, MAX_UNITS);
    const winMs = winMsFor(timings.beats, idx, meta.durationSec);
    const gateEnd = beat.cueDelayMs + winMs;
    const pgStarts = pages.map((pg) => pg[0].spans[0].delayMs);

    const [aT, aB] = ANGLES_097[(beat.i - 1) % ANGLES_097.length];
    slideKfs.push(
      `  @keyframes slT${beat.i} { 0%   { transform: translateX(${p(-880)}px) rotate(${aT}deg); }
                   100% { transform: translateX(0px) rotate(${aT}deg); } }`,
      `  @keyframes slB${beat.i} { 0%   { transform: translateX(${p(880)}px) rotate(${aB}deg); }
                   100% { transform: translateX(0px) rotate(${aB}deg); } }`,
      // page-1 entrance: a SHORT visible glide (±24px, fade) — its words AND the marks chrome pop on
      // their verbatim delays DURING the slide, so the strip must never carry ink off the viewport
      // (verify bounds; the marks row starts at global x≈31, which caps the glide)
      `  @keyframes seT${beat.i} { 0%   { opacity: 0; transform: translateX(${p(-24)}px) rotate(${aT}deg); }
                   100% { opacity: 1; transform: translateX(0px) rotate(${aT}deg); } }`,
      `  @keyframes seB${beat.i} { 0%   { opacity: 0; transform: translateX(${p(24)}px) rotate(${aB}deg); }
                   100% { opacity: 1; transform: translateX(0px) rotate(${aB}deg); } }`,
    );

    const pgs = pages.map((page, j) => {
      const top = j % 2 === 0;
      const key = `b${beat.i}p${j + 1}`;
      if (page.length) page[accentIndex(page)].accent = true;
      const frames = framesFor097(page);
      const F = frames.length;
      const ids = frames.map((_, f) => `${key}f${f + 1}`);
      const row = sizeRow097(
        normC097(sumMax097(frames), F),
        demotionFor(demote, key, ...ids, `${key}lab`, `${key}mk`),
      );
      const fs = fsOf097(row);
      // v3: band + frame height adapt — a page of single-line frames drops the two-line headroom
      const frH = frames.some((fr) => fr.length === 2) ? FR_H2 : FR_H1;
      const geom = frameGeom097(frames, fs, frH);

      const frHtml = frames
        .map((fr, f) => {
          const lns = fr
            .map((u, k) => `<div class="ln${k > 0 ? ' ln2' : ''}">${spanHtml(u, gateEnd)}</div>`)
            .join('');
          return `      <div class="fr" id="${ids[f]}box" data-node-id="${ids[f]}box" style="left:${p(geom.lefts[f])}px; width:${p(geom.widths[f])}px; height:${p(frH)}px"><div class="word alC ${row.cls}" id="${ids[f]}" data-node-id="${ids[f]}" data-node-role="text" style="padding-top:${p(geom.padTops[f])}px">${lns}</div></div>`;
        })
        .join('\n');

      // last page at EACH anchor holds — the cue gate cuts it; only pages with a same-anchor
      // successor (j+2) fade, completing as that successor's slide begins
      const hasSucc = j + 2 < pages.length;
      const spgStyle = hasSucc
        ? `animation-delay:${pgOutDelayMs(page, pgStarts[j + 2] - SLIDE_MS, FADE_MS)}ms`
        : 'animation:none';
      // v3: EVERY strip slides in — the first page from the gate open (it used to hard-cut while
      // later pages slid); band top/height/tilt come inline (per-beat angles, adaptive height)
      const ang = top ? aT : aB;
      const anim = j === 0
        ? `${top ? 'seT' : 'seB'}${beat.i} ${SLIDE_MS}ms cubic-bezier(.2,.7,.3,1) ${beat.cueDelayMs}ms both`
        : `${top ? 'slT' : 'slB'}${beat.i} ${SLIDE_MS}ms cubic-bezier(.2,.7,.3,1) ${pgStarts[j] - SLIDE_MS}ms both`;
      const rotStyle = ` style="top:${p(top ? 800 : 960)}px; height:${p(frH + BAND_CHROME)}px; transform:rotate(${ang}deg); animation:${anim}"`;

      // lower-third layout: a bottom-anchor band overlaps the TOP band's lower edge (by design), which
      // would fully cover the top band's bottom marks row → verify FAIL[occluded]. Multi-page beats
      // therefore omit the marks on top-anchored strips; a beat's lone strip keeps its full chrome.
      const mksRow = top && pages.length > 1
        ? ''
        : `\n      <div class="mks" id="${key}mk" data-node-id="${key}mk" data-node-role="text" style="animation-delay:${pgStarts[j]}ms">${top ? MK_T : MK_B}</div>`;
      return `  <div class="spg ${top ? 'sT' : 'sB'}" style="${spgStyle}">
    <div class="rot${top ? '' : ' shB'}" id="${key}rot" data-node-id="${key}rot"${rotStyle}>
      <div class="lab" id="${key}lab" data-node-id="${key}lab" data-node-role="text" style="animation-delay:${pgStarts[j]}ms">${top ? LAB_T : LAB_B}</div>
${frHtml}${mksRow}
    </div>
  </div>`;
    });

    return `<div class="cue" id="cue${beat.i}" data-node-id="cue${beat.i}"
     style="z-index:${10 + beat.i}; animation-delay:${beat.cueDelayMs}ms; animation-duration:${winMs}ms;">
${pgs.join('\n')}
</div>`;
  });

  const sizeRows = FS_ROWS.map((fs) => `  .s${fs} { font-size: ${p(fs)}px; }`).join('\n');

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@900&family=Roboto+Mono:wght@600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; background: #e4e5e2; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 0; top: 0; width: ${p(736)}px; height: ${p(1312)}px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* a page = one whole film strip; pages alternate anchors (odd → top .sT, even → bottom .sB) and
     take turns AT an anchor. Each mid page carries ONE inline fade-out (pgOut). */
  .spg { position: absolute; left: 0; top: 0; width: ${p(736)}px; height: ${p(1312)}px;
         animation-name: pgOut; animation-duration: ${FADE_MS}ms; animation-timing-function: ease;
         animation-fill-mode: forwards; }
  .sT { z-index: 2; }
  .sB { z-index: 3; }
  @keyframes pgOut { from { opacity: 1; } to { opacity: 0; } }

  /* the strip band — the PROVEN transform stack: static plain 2D rotate (origin 50% 50%); the slide
     animates translateX with the SAME rotate baked into both keyframes. The band is flat #1b1a16:
     the prefab's dot-texture background-image is dropped by this engine — never re-add it. */
  .rot { position: absolute; left: ${p(-41)}px; width: ${p(STRIP_W)}px; background-color: #1b1a16;
         box-shadow: 0 ${p(6)}px ${p(18)}px rgba(0,0,0,0.28); transform-origin: 50% 50%; }
  /* v3: the overlapping bottom band carries a soft wide shadow to lift off the top band —
     gentle on purpose (a hard edge reads heavy at phone scale) */
  .shB { box-shadow: 0 ${p(12)}px ${p(34)}px rgba(0,0,0,0.42); }
${slideKfs.join('\n')}

  /* strip chrome text — plain numbers only (the prefab's ::before arrows do not render in this
     engine); fades in at the page's first word so no glyph is ever drawn mid-slide. */
  .lab { position: absolute; left: 0; top: ${p(12)}px; width: ${p(STRIP_W)}px; text-align: center;
         font-family: "Roboto Mono", monospace; font-weight: 600; font-size: ${p(14)}px;
         letter-spacing: ${p(3)}px; line-height: 1.3; color: #b9b8b4; white-space: nowrap;
         opacity: 0; animation-name: labIn; animation-duration: ${POP_MS}ms; animation-fill-mode: both; }
  .mks { position: absolute; left: ${p(72)}px; bottom: ${p(8)}px;
         font-family: "Roboto Mono", monospace; font-weight: 600; font-size: ${p(14)}px;
         letter-spacing: ${p(2)}px; line-height: 1.3; color: #cfcecb; white-space: nowrap;
         opacity: 0; animation-name: labIn; animation-duration: ${POP_MS}ms; animation-fill-mode: both; }
  @keyframes labIn { 0% { opacity: 0; } 100% { opacity: 1; } }

  /* film frames — FIXED computed geometry (left/width inline per frame); never flex. */
  .fr { position: absolute; top: ${p(34)}px; background: #ffffff; border-radius: ${p(1)}px; } /* height inline (adaptive) */
  .word { position: absolute; left: ${p(10)}px; right: ${p(10)}px; top: 0;
          font-family: "Archivo", sans-serif; font-weight: 900; color: #1b1a16;
          letter-spacing: -0.026em; }
  .alL { text-align: left; } .alC { text-align: center; } .alR { text-align: right; }

${sizeRows}

  /* one unit per line; stacked pitch 0.9em (1.24em span box − 0.34em pull) */
  .ln  { display: block; line-height: 1; }
  .ln2 { margin-top: -0.34em; }

  /* word reveal — scale pop + fade IN, then HOLD; the page-level pgOut is the only fade-out.
     The vertical padding is mid-reveal shear headroom — never remove it. */
  .wp  { display: inline-block; opacity: 0; padding: 0.06em 0 0.18em;
         animation-name: wordPop; animation-duration: ${POP_MS}ms;
         animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .red { color: #e02b27; }
  @keyframes wordPop { 0% { opacity: 0; transform: scale(1.10); } 100% { opacity: 1; transform: scale(1); } }
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

const recipe: RecipeGenerator = { refId: 'hook-097-peak', generate };
export default recipe;
