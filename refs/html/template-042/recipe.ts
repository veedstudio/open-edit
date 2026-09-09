/**
 * template-042 "Driftwood": dark slate Instrument Sans typed glyph by glyph in a fixed centred block
 * below mid-frame, a thin grey-blue caret trailing each glyph; the beat's strongest word switches to
 * Instrument Serif italic on the same baseline. Type is grounded by a stacked cream glow over a soft
 * dark drop shadow (the preset's updated shadow stack), never a plate.
 */
import { accentIndex } from '../../../pipeline/recipes/lib.ts';
import {
  type Unit,
  DEMOTE_STEP,
  REF_W,
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
const AVG_EM = 0.52; // Instrument Sans 500 mixed case
const LEFT = 96;
const TOP = 646;
const WIDTH = 288;
const PITCH = 45;
const MAX_LINES = 2;
const GLYPH_STEP = 36;
// The preset's shadow stack: blur/offset as fractions of the source canvas width.
const SHADOWS = [
  { blur: 0.012, dy: 0.01, color: 'rgba(26,42,47,0.65)' },
  { blur: 0.015, dy: 0, color: 'rgba(251,244,222,0.35)' },
  { blur: 0.025, dy: 0, color: 'rgba(251,244,222,0.25)' },
  { blur: 0.035, dy: 0, color: 'rgba(251,244,222,0.2)' },
];

export default templateRecipe('template-042', (meta, timings, opts) => {
  const c = canvasFor(meta);

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
      const pageEnd = nextStart ?? b.cueEndMs;
      const lines = pageLines[pi].map((line, li) => {
        const parts = line.map((u) => {
          const acc = b.units.indexOf(u) === accent ? ' acc' : '';
          const nextUnit = page[page.indexOf(u) + 1];
          const unitEnd = nextUnit ? unitDelay(nextUnit) : pageEnd;
          const glyphs: string[] = [];
          for (const s of u.spans) {
            const chars = [...s.text];
            chars.forEach((ch, k) => {
              const d = s.delayMs + k * GLYPH_STEP;
              // the caret sits after this glyph until the next one types; the word's last caret waits for the next word
              const caretEnd = k + 1 < chars.length ? d + GLYPH_STEP : Math.max(d + GLYPH_STEP, unitEnd);
              glyphs.push(`<span class="g${acc}" style="animation-delay:${d}ms">${escapeHtml(ch)}</span><span class="cur" style="animation-delay:${d}ms;animation-duration:${caretEnd - d}ms"></span>`);
            });
          }
          return `<span class="u">${glyphs.join('')}</span>`;
        });
        return `<div class="cl" id="${pageId}l${li + 1}" style="line-height:${pitch}px">${parts.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const shadow = SHADOWS.map((s) => `0 ${c.px(s.dy * REF_W)}px ${c.px(s.blur * REF_W)}px ${s.color}`).join(', ');
  const css = `
  .cap { left:${c.px(LEFT)}px; top:${c.py(TOP)}px; width:${c.px(WIDTH)}px; text-align:center; z-index:2;
         font-family:'Instrument Sans'; font-weight:500; letter-spacing:0.0081em; color:#1A2A2F; text-shadow:${shadow}; }
  .cl { display:block; }
  .u { display:inline-block; white-space:pre; }
  .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capG 100ms cubic-bezier(.2,.7,.3,1) forwards; }
  .acc { font-family:'Instrument Serif'; font-style:italic; }
  .cur { display:inline-block; width:${c.px(2)}px; height:0.8em; margin:0 -${c.px(3)}px 0 ${c.px(1)}px; background:#4C6274; opacity:0;
         animation-name:capCur; animation-fill-mode:forwards; animation-timing-function:linear; }
  @keyframes capG { from{opacity:0} to{opacity:1} }
  @keyframes capCur { 0%{opacity:0.82} 99.9%{opacity:0.82} 100%{opacity:0} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Instrument+Sans:wght@500', 'Instrument+Serif:ital@1'],
    css,
    body: cues.join('\n'),
  });
});
