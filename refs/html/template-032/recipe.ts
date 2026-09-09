/**
 * template-032: right-aligned Archivo captions in the lower third with a fast per-glyph typewriter
 * fade (30ms stagger). The beat's strongest word leaves the caption and runs down a frame edge as a
 * giant green Cinzel title rotated 90 degrees, glyphs sliding in; the source composited it behind
 * the presenter, here it sits on top. Sides alternate every two beats.
 */
import { accentIndex } from '../../../pipeline/recipes/lib.ts';
import {
  type Unit,
  DEMOTE_STEP,
  REF_H,
  canvasFor,
  cueDiv,
  docShell,
  eachBeat,
  glyphSpans,
  pageGateStyle,
  escapeHtml,
  paginate,
  templateRecipe,
  unitDelay,
  unitText,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 34;
const AVG_EM = 0.56; // Archivo 600 mixed case
const MARGIN = 29;
const BOTTOM = 190;
const GLYPH_STEP = 30;
const MAX_LINES = 2;
const TITLE_FONT = 72;
const TITLE_EM = 0.8; // Cinzel 900 caps
const TITLE_TOP = 64;
const TITLE_LEFT = [94, 476]; // rotated 90deg about its top-left, so `left` is the title's right edge
const TITLE_MIN_UNITS = 3;
const TITLE_STEP = 48;

export default templateRecipe('template-032', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;

  const cues = eachBeat(meta, timings, opts, 'none', (b) => {
    const titleIdx = b.units.length >= TITLE_MIN_UNITS ? accentIndex(b.units) : -1;
    const title = titleIdx >= 0 ? b.units[titleIdx] : null;
    const capUnits = title ? b.units.filter((u) => u !== title) : b.units;
    let titleHtml = '';
    if (title) {
      const text = unitText(title).toUpperCase().replace(/[.,!?;:]+$/, ''); // a title carries no sentence punctuation
      const font = Math.min(TITLE_FONT, (REF_H - TITLE_TOP - 40) / (TITLE_EM * text.length)) * Math.pow(DEMOTE_STEP, b.rows);
      const left = TITLE_LEFT[Math.floor((b.n - 1) / 2) % 2];
      const start = Math.max(b.cueDelayMs, unitDelay(title) - 70);
      const dur = Math.max(80, b.cueEndMs - start);
      const glyphs = [...text].map((ch, k) => `<span class="sc" style="animation-delay:${unitDelay(title) + k * TITLE_STEP}ms">${escapeHtml(ch)}</span>`).join('');
      titleHtml = `  <div class="swg" style="animation-delay:${start}ms;animation-duration:${dur}ms"><div class="sw" id="b${b.n}t" style="left:${c.px(left)}px;top:${c.py(TITLE_TOP)}px;font-size:${Math.round(font * c.s)}px">${glyphs}</div></div>\n`;
    }
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(measure / (AVG_EM * FONT * f));
      pages = paginate(capUnits, maxChars * MAX_LINES - 2, 9);
      pageLines = pages.map((p) => wrapByChars(p, maxChars));
      if (pageLines.every((ls) => ls.length <= MAX_LINES)) break;
    }
    const fs = Math.round(FONT * f * c.s);

    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const units = line.map((u) => `<span class="u">${u.spans.map((s) => glyphSpans(s.text, s.delayMs, GLYPH_STEP, 'g')).join('')}</span>`);
        return `<div class="cl" id="${pageId}l${li + 1}">${units.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, titleHtml + pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; bottom:${c.py(BOTTOM)}px; text-align:right;
         font-family:'Archivo'; font-weight:600; letter-spacing:0.0081em; color:#F4EDDF; line-height:1.28;
         text-shadow:0 ${c.px(2)}px ${c.px(9)}px rgba(2,2,1,0.38), 0 ${c.px(1)}px ${c.px(2)}px rgba(2,2,1,0.3); }
  .cl { display:block; }
  .u { display:inline-block; white-space:pre; }
  .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capG 120ms cubic-bezier(.2,.7,.3,1) forwards; }
  @keyframes capG { from{opacity:0} to{opacity:1} }
  .swg { position:absolute; inset:0; z-index:3; opacity:0; animation:cueWin linear forwards; }
  .sw { position:absolute; transform-origin:0 0; transform:rotate(90deg); white-space:nowrap;
        font-family:'Cinzel'; font-weight:900; letter-spacing:0.01em; color:#96FF1A;
        text-shadow:0 ${c.px(4)}px ${c.px(18)}px rgba(2,2,1,0.38), 0 ${c.px(2)}px ${c.px(4)}px rgba(2,2,1,0.3); }
  .sc { display:inline-block; opacity:0; animation:scIn 380ms cubic-bezier(.16,.84,.28,1) both; }
  @keyframes scIn { 0%{opacity:0; transform:translateX(-0.16em)} 100%{opacity:1; transform:none} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Archivo:wght@600', 'Cinzel:wght@900'],
    css,
    body: cues.join('\n'),
  });
});
