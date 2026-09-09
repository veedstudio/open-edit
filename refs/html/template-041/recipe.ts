/**
 * template-041 "Standfirst": a centred Fraunces serif block just below mid-frame, one position and one
 * fixed line pitch for every beat; words fade and rise into place then hold; the beat's pivot word
 * changes register into the face's own italic in gold, same size, same baseline.
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

const FONT = 34;
const AVG_EM = 0.5; // Fraunces 600 mixed case
const LEFT = 56;
const TOP = 518;
const WIDTH = 368;
const PITCH = 52;
const MAX_LINES = 2;

export default templateRecipe('template-041', (meta, timings, opts) => {
  const c = canvasFor(meta);
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
      maxChars = Math.floor(WIDTH / (AVG_EM * FONT * f));
      pages = paginate(b.units, maxChars * MAX_LINES - 2, 9);
      pageLines = pages.map((p) => wrapByChars(p, maxChars));
      if (pageLines.every((ls) => ls.length <= MAX_LINES)) break;
    }
    const fs = Math.round(FONT * f * c.s);
    const pitch = Math.round(PITCH * f * c.s);
    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const spans = line.map((u) => u.spans.map((s) => {
          wordSeq++;
          return `<span class="w${b.units.indexOf(u) === accent ? ' a' : ''}" id="b${b.n}w${wordSeq}" style="line-height:${pitch}px;animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join(''));
        return `<div class="cl" id="${pageId}l${li + 1}" style="line-height:${pitch}px">${spans.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(LEFT)}px; top:${c.py(TOP)}px; width:${c.px(WIDTH)}px; text-align:center; z-index:2;
         font-family:'Fraunces'; font-weight:600; letter-spacing:0.004em; color:#F7F1E6;
         text-shadow:0 ${c.px(2)}px ${c.px(14)}px rgba(36,28,21,0.62), 0 ${c.px(1)}px ${c.px(3)}px rgba(36,28,21,0.5); }
  .cl { display:block; white-space:nowrap; }
  .sp { display:inline-block; white-space:pre; }
  .w { display:inline-block; white-space:pre; opacity:0; animation-name:wordIn; animation-duration:260ms; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wordIn { 0%{opacity:0; transform:translateY(0.22em)} 100%{opacity:1; transform:translateY(0)} }
  .a { font-style:italic; color:#FEC719; }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Fraunces:ital,wght@0,600;1,600'],
    css,
    body: cues.join('\n'),
  });
});
