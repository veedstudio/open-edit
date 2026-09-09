/**
 * template-030 "Sticker": every word on its own rounded sand plate (Baloo 2) popping in as spoken;
 * the beat's keyword sits in-line on a lavender plate in white italic Fraunces; the closing beat's
 * payoff word gets the larger plate. Blocks roam: centred / left / centred / right by beat.
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
  unitText,
  wrapByWidth,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 30;
const KW = 36;
const PAY = 44;
const AVG_EM = 0.57; // Baloo 2 800 lowercase incl. tracking
const AVG_EM_KW = 0.54; // Fraunces italic 900
const MARGIN = 44;
const ALIGN = ['center', 'left', 'center', 'right'] as const;
const BOTTOM = [170, 195, 285, 235, 260, 185];
const MAX_LINES = 3;

export default templateRecipe('template-030', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;
  let wordSeq = 0;

  const cues = eachBeat(meta, timings, opts, 'lowercase', (b) => {
    const kwIdx = b.isLast ? b.units.length - 1 : accentIndex(b.units);
    const role = (u: Unit): 'w' | 'kw' | 'pay' => (b.units.indexOf(u) !== kwIdx ? 'w' : b.isLast ? 'pay' : 'kw');
    const fontOf = (r: string, f: number) => (r === 'pay' ? PAY : r === 'kw' ? KW : FONT) * f;
    // plate width = ink + horizontal padding + 2x3px margin
    const widthOf = (u: Unit, f: number) => {
      const r = role(u);
      const em = r === 'w' ? AVG_EM : AVG_EM_KW;
      const pad = r === 'pay' ? 32 : r === 'kw' ? 26 : 20;
      return u.chars * em * fontOf(r, f) + (pad + 6) * f;
    };

    let rows = b.rows;
    let f = 1;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      pages = paginate(b.units, Math.floor(50 * f), 12);
      pageLines = pages.map((p) => {
        // the payoff word owns its own last line
        const pay = p.find((u) => role(u) === 'pay');
        const head = pay ? p.slice(0, p.indexOf(pay)) : p;
        const lines = head.length ? wrapByWidth(head, measure, (u) => widthOf(u, f), 0) : [];
        if (pay) lines.push([pay]);
        return lines;
      });
      if (pageLines.every((ls) => ls.length <= MAX_LINES && ls.every((l) => l.reduce((a, u) => a + widthOf(u, f), 0) <= measure))) break;
    }

    const align = ALIGN[(b.n - 1) % ALIGN.length];
    const bottom = BOTTOM[(b.n - 1) % BOTTOM.length];
    const pos = align === 'center'
      ? `left:0;right:0;text-align:center;`
      : align === 'left'
        ? `left:${c.px(MARGIN)}px;right:0;text-align:left;`
        : `left:0;right:${c.px(MARGIN + 12)}px;text-align:right;`;

    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const indent = align === 'left' ? `margin-left:${c.px(20 * li)}px;` : '';
        const spans = line.map((u) => u.spans.map((s) => {
          wordSeq++;
          const r = role(u);
          const cls = r === 'w' ? 'w' : `w ${r}`;
          const fs = Math.round(fontOf(r, f) * c.s);
          return `<span class="${cls}" id="b${b.n}w${wordSeq}" style="font-size:${fs}px;animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join('')).join('');
        return `<div class="cl" id="${pageId}l${li + 1}" style="${indent}">${spans}</div>`;
      }).join('\n      ');
      return `  <div class="pg" id="${pageId}" style="${pos}bottom:${c.py(bottom)}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const css = `
  .cl { display:block; line-height:1; margin-bottom:${c.px(8)}px; }
  .w { display:inline-block; opacity:0; font-family:'Baloo 2'; font-weight:800; letter-spacing:0.012em;
       color:#472B3F; background:#FFF4E1; border-radius:${c.px(10)}px;
       padding:${c.px(3)}px ${c.px(10)}px ${c.px(7)}px; margin:0 ${c.px(3)}px;
       box-shadow:0 ${c.px(3)}px ${c.px(12)}px rgba(71,43,63,0.4);
       animation:wIn 240ms cubic-bezier(.2,.7,.3,1) both; }
  .kw { font-family:'Fraunces'; font-style:italic; font-weight:900; letter-spacing:0.0065em;
        color:#FFFFFF; background:#7C5FC9; padding:${c.px(3)}px ${c.px(13)}px ${c.px(8)}px; }
  .pay { font-family:'Fraunces'; font-style:italic; font-weight:900; letter-spacing:0.0016em;
         color:#FFFFFF; background:#7C5FC9; padding:${c.px(4)}px ${c.px(16)}px ${c.px(10)}px; }
  @keyframes wIn { 0%{opacity:0; transform:translateY(0.35em) scale(1.08)} 100%{opacity:1; transform:translateY(0) scale(1)} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Baloo+2:wght@800', 'Fraunces:ital,wght@1,900'],
    css,
    body: cues.join('\n'),
  });
});
