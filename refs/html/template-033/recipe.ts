/**
 * template-033 "Ghost ink": the whole beat stands in Newsreader at 42% ink from the cue's start; each
 * word takes on full ink at the instant it is spoken and holds. One italic accent per beat, centred
 * block hanging from a fixed last baseline. No motion.
 */
import { accentIndex } from '../../../pipeline/recipes/lib.ts';
import {
  type Unit,
  DEMOTE_STEP,
  canvasFor,
  cueDiv,
  docShell,
  eachBeat,
  escapeHtml,
  pageGateStyle,
  paginate,
  templateRecipe,
  unitDelay,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 40;
const AVG_EM = 0.47; // Newsreader 500 mixed case
const MARGIN = 34;
const BOTTOM = 116;
const LIGHT_MS = 260;
const MAX_LINES = 3; // the block grows upward, so a third line is safe

export default templateRecipe('template-033', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;
  let wordSeq = 0;

  const cues = eachBeat(meta, timings, opts, 'none', (b) => {
    const accent = accentIndex(b.units);
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(measure / (AVG_EM * FONT * f));
      pages = paginate(b.units, maxChars * 2, 10);
      pageLines = pages.map((p) => wrapByChars(p, maxChars));
      if (pageLines.every((ls) => ls.length <= MAX_LINES)) break;
    }
    const fs = Math.round(FONT * f * c.s);

    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const spans = line.map((u, ui) => u.spans.map((s, si) => {
          wordSeq++;
          const last = ui === line.length - 1 && si === u.spans.length - 1;
          const cls = ['w', last ? 'e' : '', b.units.indexOf(u) === accent ? 'i' : ''].filter(Boolean).join(' ');
          const dur = Math.max(60, Math.min(LIGHT_MS, b.cueEndMs - s.delayMs));
          return `<span class="${cls}" id="b${b.n}w${wordSeq}" style="animation-delay:${s.delayMs}ms;animation-duration:${dur}ms">${escapeHtml(s.text)}</span>`;
        }).join('')).join('');
        return `<div class="cl" id="${pageId}l${li + 1}">${spans}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; bottom:${c.py(BOTTOM)}px; text-align:center;
         font-family:'Newsreader'; font-weight:500; letter-spacing:0.0038em; line-height:1.34; color:#F5EFE4;
         text-shadow:0 0.05em 0.42em rgba(26,18,11,0.62); }
  .cl { display:block; white-space:nowrap; }
  .w { display:inline-block; margin-right:0.26em; opacity:0.42;
       animation-name:wLight; animation-timing-function:cubic-bezier(0.22,0.61,0.36,1); animation-fill-mode:forwards; }
  .e { margin-right:0; }
  .i { font-style:italic; }
  @keyframes wLight { 0%{opacity:0.42} 100%{opacity:1} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Newsreader:ital,wght@0,500;1,500'],
    css,
    body: cues.join('\n'),
  });
});
