/**
 * template-038 "Ledgerboard": dark Plex Mono caps on sharp cream chips, one chip per word popping in,
 * in a left-aligned block low in the frame; the beat's strongest word leaves the chips and lands as
 * huge cream Anton wall type at the top. The source composited the wall type behind the presenter;
 * here it sits on top.
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

const FONT = 27;
const AVG_EM = 0.66; // Plex Mono 0.6em + 0.06em tracking
const CHIP_PAD = 20; // 10px each side
const CHIP_GAP = 7;
const LEFT = 34;
const WIDTH = 412;
const TOP_2 = 609; // block top for two lines; one line sits centred on the same band
const LINE_H = 45;
const LINE_GAP = 5;
const MAX_LINES = 2;
const WALL_FONT = 225;
const WALL_EM = 0.5; // Anton caps
const WALL_LEFT = 24;

export default templateRecipe('template-038', (meta, timings, opts) => {
  const c = canvasFor(meta);
  let wordSeq = 0;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const wallIdx = b.units.length >= 2 ? accentIndex(b.units) : -1;
    const wall = wallIdx >= 0 ? b.units[wallIdx] : null;
    const capUnits = wall ? b.units.filter((u) => u !== wall) : b.units;
    let wallHtml = '';
    if (wall) {
      const text = unitText(wall).replace(/[.,!?;:]+$/, '');
      const font = Math.min(WALL_FONT, (c.refWidth - 2 * WALL_LEFT) / (WALL_EM * text.length)) * Math.pow(DEMOTE_STEP, b.rows);
      const top = font >= 200 ? 24 : 43;
      wallHtml = `  <div class="wall" id="b${b.n}x" style="left:${c.px(WALL_LEFT)}px;top:${c.py(top)}px;font-size:${Math.round(font * c.s)}px;animation-delay:${unitDelay(wall)}ms">${escapeHtml(text)}</div>\n`;
    }
    let rows = b.rows;
    let f = 1;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    const chipW = (u: Unit, f: number) => (u.chars * AVG_EM * FONT + CHIP_PAD) * f;
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      pages = capUnits.length ? paginate(capUnits, Math.floor(30 * f), 8) : [];
      pageLines = pages.map((p) => wrapByWidth(p, WIDTH, (u) => chipW(u, f), CHIP_GAP));
      if (pageLines.every((ls) => ls.length <= MAX_LINES && ls.every((l) => l.reduce((a, u) => a + chipW(u, f), 0) + CHIP_GAP * (l.length - 1) <= WIDTH))) break;
    }
    const fs = Math.round(FONT * f * c.s);
    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi];
      const top = lines.length === 1 ? TOP_2 + (LINE_H + LINE_GAP) / 2 : TOP_2;
      const lineDivs = lines.map((line, li) => {
        const spans = line.map((u) => u.spans.map((s) => {
          wordSeq++;
          return `<span class="w" id="b${b.n}w${wordSeq}" style="font-size:${fs}px;animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join('')).join('');
        return `<div class="ln" id="${pageId}l${li + 1}"${li ? ` style="margin-top:${c.px(LINE_GAP)}px"` : ''}>${spans}</div>`;
      }).join('\n      ');
      return `  <div class="pg blk" id="${pageId}" style="left:${c.px(LEFT)}px;top:${c.py(top)}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lineDivs}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, wallHtml + pageDivs.join('\n'));
  });

  const css = `
  .blk { width:${c.px(WIDTH)}px; z-index:2; }
  .ln { display:block; height:${c.px(LINE_H)}px; line-height:${c.px(LINE_H)}px; }
  .w { display:inline-block; vertical-align:top; opacity:0; white-space:pre; font-family:'IBM Plex Mono'; font-weight:600; letter-spacing:0.06em;
       line-height:1; color:#1A1512; background:#F0E6D2; padding:${c.px(9)}px ${c.px(10)}px; margin-right:${c.px(CHIP_GAP)}px;
       box-shadow:0 ${c.px(3)}px ${c.px(10)}px rgba(24,23,21,0.32);
       animation-name:chipIn; animation-duration:190ms; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes chipIn { from{opacity:0; transform:translateY(${c.px(7)}px)} to{opacity:1; transform:translateY(0)} }
  .wall { position:absolute; z-index:3; opacity:0; white-space:nowrap; line-height:1; padding:0.1em 0 0.15em; font-family:'Anton'; font-weight:400; letter-spacing:-0.02em; color:#F0E6D2;
          text-shadow:0 ${c.px(3)}px ${c.px(22)}px rgba(24,23,21,0.55), 0 ${c.px(1)}px ${c.px(5)}px rgba(24,23,21,0.40);
          animation-name:wallIn; animation-duration:340ms; animation-timing-function:cubic-bezier(.16,1,.3,1); animation-fill-mode:both; }
  @keyframes wallIn { from{opacity:0; transform:translateY(${c.px(18)}px)} to{opacity:1; transform:translateY(0)} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['IBM+Plex+Mono:wght@600', 'Anton'],
    css,
    body: cues.join('\n'),
  });
});
