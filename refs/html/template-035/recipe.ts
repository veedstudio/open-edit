/**
 * template-035 "Verdict stamp": condensed all-caps Barlow captions low in the frame, each word fading
 * and rising in; the beat's strongest word leaves the caption and slams in above it as an Anton
 * stamp on an orange slab (die-drop squash, alternating tilt), holding until the next stamp.
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
  glyphSpans,
  pageGateStyle,
  paginate,
  templateRecipe,
  unitDelay,
  unitText,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 30;
const AVG_EM = 0.58; // Barlow Semi Condensed 700 caps + 0.03em tracking
const MARGIN = 53;
const BOTTOM = 150;
const MAX_LINES = 2;
const STAMP_FONT = 96;
const STAMP_EM = 0.52; // Anton caps
const STAMP_BOTTOM = 243;
const STAMP_MIN_UNITS = 2;
const TILT = ['-2.4deg', '1.9deg'];

export default templateRecipe('template-035', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const stampIdx = b.units.length >= STAMP_MIN_UNITS ? accentIndex(b.units) : -1;
    const stamp = stampIdx >= 0 ? b.units[stampIdx] : null;
    const capUnits = stamp ? b.units.filter((u) => u !== stamp) : b.units;
    let stampHtml = '';
    if (stamp) {
      const text = unitText(stamp);
      const font = Math.min(STAMP_FONT, (c.refWidth - 2 * 36 - 36) / (STAMP_EM * text.length)) * Math.pow(DEMOTE_STEP, b.rows);
      const start = unitDelay(stamp);
      stampHtml = `  <div class="st" style="animation-delay:${start}ms;animation-duration:${Math.max(80, b.cueEndMs - start)}ms"><div class="sr" style="transform:rotate(${TILT[(b.n - 1) % 2]})"><div class="sk" id="b${b.n}s" style="font-size:${Math.round(font * c.s)}px;animation-delay:${start}ms">${escapeHtml(text)}</div></div></div>\n`;
    }
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(measure / (AVG_EM * FONT * f));
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
        const units = line.map((u) => `<span class="u">${u.spans.map((s) => glyphSpans(s.text, s.delayMs, 0, 'g')).join('')}</span>`);
        return `<div class="cl" id="${pageId}l${li + 1}">${units.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${pageId}" style="font-size:${fs}px;${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, stampHtml + pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; bottom:${c.py(BOTTOM)}px; text-align:center; z-index:2;
         font-family:'Barlow Semi Condensed'; font-weight:700; letter-spacing:0.03em; color:#F4EFE6;
         text-shadow:0 ${c.px(2)}px 0 rgba(22,19,15,.92), 0 0 ${c.px(12)}px rgba(22,19,15,.6); }
  .cl { display:block; line-height:1.08; padding:${c.px(1)}px 0; }
  .u { display:inline-block; white-space:pre; }
  .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capG 150ms cubic-bezier(.2,.7,.3,1) forwards; }
  @keyframes capG { 0%{opacity:0; transform:translateY(${c.px(10)}px)} 100%{opacity:1; transform:none} }
  .st { position:absolute; left:0; right:0; bottom:${c.py(STAMP_BOTTOM)}px; display:flex; justify-content:center; z-index:6; opacity:0; animation:cueWin linear forwards; }
  .sr { display:inline-block; transform-origin:50% 50%; }
  .sk { display:block; font-family:'Anton'; font-weight:400; line-height:.86; letter-spacing:-0.03em; color:#16130F; background:#FF6A13;
        padding:${c.px(14)}px ${c.px(18)}px ${c.px(12)}px; box-shadow:${c.px(6)}px ${c.px(6)}px 0 #16130F;
        animation-name:stHit; animation-duration:230ms; animation-timing-function:cubic-bezier(.3,.9,.2,1); animation-fill-mode:both; }
  @keyframes stHit { 0%{transform:scale(1.14,1.3)} 52%{transform:scale(1.03,.93)} 78%{transform:scale(.99,1.02)} 100%{transform:scale(1,1)} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Anton', 'Barlow+Semi+Condensed:wght@700'],
    css,
    body: cues.join('\n'),
  });
});
