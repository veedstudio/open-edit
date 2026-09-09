/**
 * template-036 "Monogram": cream IBM Plex Mono caps in a left-aligned block below centre, words rising
 * in; the beat's keyword flips to rust on a cream chip in-line, and the beat's strongest word lifts
 * out of the caption as huge dark-plum Bodoni wall type at the top. The source composited the wall
 * type behind the presenter; here it sits on top.
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
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 30;
const AVG_EM = 0.69; // Plex Mono 0.6em + 0.09em tracking
const LEFT = 40;
const TOP = 544;
const WIDTH = 384;
const MAX_LINES = 2;
const WALL_FONT = 132;
const WALL_EM = 0.8; // Bodoni Moda 900 caps
const WALL_LEFT = 38;
const WALL_TOP = 128;
const WALL_MIN_UNITS = 4;

export default templateRecipe('template-036', (meta, timings, opts) => {
  const c = canvasFor(meta);
  let wordSeq = 0;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const wallIdx = b.units.length >= WALL_MIN_UNITS ? accentIndex(b.units) : -1;
    const wall = wallIdx >= 0 ? b.units[wallIdx] : null;
    const capUnits = wall ? b.units.filter((u) => u !== wall) : b.units;
    const chip = capUnits.length ? capUnits[accentIndex(capUnits)] : null;
    let wallHtml = '';
    if (wall) {
      const text = unitText(wall).replace(/[.,!?;:]+$/, '');
      const font = Math.min(WALL_FONT, (c.refWidth - 2 * WALL_LEFT) / (WALL_EM * text.length)) * Math.pow(DEMOTE_STEP, b.rows);
      const start = unitDelay(wall);
      wallHtml = `  <div class="mon" style="left:${c.px(WALL_LEFT)}px;top:${c.py(WALL_TOP)}px;animation-delay:${start}ms;animation-duration:${Math.max(80, b.cueEndMs - start)}ms"><span class="moni" id="b${b.n}m" style="font-size:${Math.round(font * c.s)}px;animation-delay:${start}ms">${escapeHtml(text)}</span></div>\n`;
    }
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(WIDTH / (AVG_EM * FONT * f));
      pages = capUnits.length ? paginate(capUnits, maxChars * MAX_LINES - 2, 8) : [];
      pageLines = pages.map((p) => wrapByChars(p, maxChars));
      if (pageLines.every((ls) => ls.length <= MAX_LINES)) break;
    }
    const fs = Math.round(FONT * f * c.s);
    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const spans = line.map((u) => u.spans.map((s) => {
          wordSeq++;
          return `<span class="w${u === chip ? ' pve' : ''}" id="b${b.n}w${wordSeq}" style="animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join(''));
        return `<div class="cl" id="${pageId}l${li + 1}">${spans.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, wallHtml + pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(LEFT)}px; top:${c.py(TOP)}px; width:${c.px(WIDTH)}px; text-align:left; z-index:2;
         font-family:'IBM Plex Mono'; font-weight:400; letter-spacing:0.09em; line-height:1.45; color:#F6EDDF;
         text-shadow:0 ${c.px(3)}px ${c.px(14)}px rgba(4,2,4,0.38), 0 ${c.px(2)}px ${c.px(3)}px rgba(4,2,4,0.3); }
  .cl { display:block; white-space:pre; }
  .w { display:inline-block; white-space:pre; opacity:0; animation-name:wIn; animation-duration:260ms; animation-fill-mode:forwards; animation-timing-function:cubic-bezier(.2,.7,.3,1); }
  .sp { display:inline-block; white-space:pre; }
  .pve { font-weight:700; color:#B25430; background:#F6EDDF; border-radius:${c.px(3)}px; line-height:1; padding:0.13em 0.20em 0.03em; margin:0 -0.06em; text-shadow:none; }
  @keyframes wIn { from{opacity:0; transform:translateY(${c.px(7)}px)} to{opacity:1; transform:translateY(0)} }
  .mon { position:absolute; z-index:3; white-space:pre; opacity:0; animation:cueWin linear forwards; }
  .moni { display:inline-block; opacity:0; font-family:'Bodoni Moda'; font-weight:900; line-height:1; letter-spacing:0.015em; padding:0.06em 0 0.18em; color:#25192B;
          animation-name:monIn; animation-duration:540ms; animation-fill-mode:both; animation-timing-function:cubic-bezier(.16,.84,.3,1); }
  @keyframes monIn { from{opacity:0; transform:translateY(${c.px(20)}px)} to{opacity:1; transform:translateY(0)} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['IBM+Plex+Mono:wght@400;700', 'Bodoni+Moda:wght@900'],
    css,
    body: cues.join('\n'),
  });
});
