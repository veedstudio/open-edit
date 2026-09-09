/**
 * template-040: a left-aligned all-caps Instrument Sans block low in the frame, wide tracking and
 * generous leading; each word fades and rises 0.3em over 280ms then holds dead still until the cut.
 * The beat's strongest word takes the mint accent colour, nothing else changes.
 */
import { accentIndex } from '../../../pipeline/recipes/lib.ts';
import {
  type Unit,
  DEMOTE_STEP,
  canvasFor,
  cueDiv,
  docShell,
  eachBeat,
  glyphSpans,
  pageGateStyle,
  paginate,
  templateRecipe,
  unitDelay,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 36;
const AVG_EM = 0.67; // Instrument Sans 500 caps + 0.05em tracking
const MARGIN = 44;
const BOTTOM = 132;
const MAX_LINES = 2;

export default templateRecipe('template-040', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const accent = accentIndex(b.units);
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(measure / (AVG_EM * FONT * f));
      pages = paginate(b.units, maxChars * MAX_LINES - 2, 8);
      pageLines = pages.map((p) => wrapByChars(p, maxChars));
      if (pageLines.every((ls) => ls.length <= MAX_LINES)) break;
    }
    const fs = Math.round(FONT * f * c.s);
    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const units = line.map((u) => `<span class="u${b.units.indexOf(u) === accent ? ' ac' : ''}">${u.spans.map((s) => glyphSpans(s.text, s.delayMs, 0, 'g')).join('')}</span>`);
        return `<div class="cl" id="${pageId}l${li + 1}">${units.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; bottom:${c.py(BOTTOM)}px; text-align:left; z-index:2;
         font-family:'Instrument Sans'; font-weight:500; letter-spacing:0.05em; line-height:1.38; color:#F5F1E6;
         text-shadow:0 ${c.px(2)}px ${c.px(14)}px rgba(20,17,14,0.62), 0 ${c.px(1)}px ${c.px(3)}px rgba(20,17,14,0.48); }
  .cl { display:block; }
  .u { display:inline-block; white-space:pre; }
  .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capG 280ms cubic-bezier(.2,.7,.3,1) forwards; }
  @keyframes capG { 0%{opacity:0; transform:translateY(0.3em)} 100%{opacity:1; transform:translateY(0)} }
  .ac { color:#7FD5AA; }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Instrument+Sans:wght@500'],
    css,
    body: cues.join('\n'),
  });
});
