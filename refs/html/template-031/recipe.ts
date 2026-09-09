/**
 * template-031: all-caps wide-tracked Space Grotesk captions, centred low in the frame; each glyph
 * fades and rises into place on a 22ms stagger from its word, then holds until the cue's cut. The
 * beat's strongest word leaves the caption and lands as a Bodoni hero title at the top of the frame
 * under a rule that draws in; the source composited it behind the presenter, here it sits on top.
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
  escapeHtml,
  paginate,
  templateRecipe,
  unitDelay,
  unitText,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 28;
const AVG_EM = 0.71; // Space Grotesk 700 caps + 0.05em tracking
const MARGIN = 24;
const BOTTOM = 150;
const GLYPH_STEP = 22;
const MAX_LINES = 2;
const HERO_EM = 0.66; // Bodoni Moda 700 caps
const HERO_MIN_UNITS = 3; // a two-word beat keeps its words in the caption
// size rung by length: 4 chars fill the frame at 140px, 6 at 100px, longer words drop to the fine rung
const HERO_RUNGS = [
  { maxChars: 4, font: 140, ls: '-0.02em', top: 2, rule: 146 },
  { maxChars: 6, font: 100, ls: '-0.015em', top: 12, rule: 118 },
  { maxChars: 99, font: 52, ls: '0.03em', top: 25, rule: 86 },
];

export default templateRecipe('template-031', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const heroIdx = b.units.length >= HERO_MIN_UNITS ? accentIndex(b.units) : -1;
    const hero = heroIdx >= 0 ? b.units[heroIdx] : null;
    const capUnits = hero ? b.units.filter((u) => u !== hero) : b.units;
    let heroHtml = '';
    if (hero) {
      const text = unitText(hero).replace(/[.,!?;:]+$/, ''); // a title carries no sentence punctuation
      const rung = HERO_RUNGS.find((r) => text.length <= r.maxChars)!;
      const font = Math.min(rung.font, measure / (HERO_EM * text.length)) * Math.pow(DEMOTE_STEP, b.rows);
      const start = Math.max(b.cueDelayMs, unitDelay(hero) - 30);
      const dur = Math.max(80, b.cueEndMs - start);
      heroHtml = `  <div class="rg" id="b${b.n}r" style="top:${c.py(rung.rule)}px;animation-delay:${start}ms;animation-duration:${dur}ms"><span class="rb" style="animation-delay:${start + 40}ms"></span></div>
  <div class="hw" style="top:${c.py(rung.top)}px;font-size:${Math.round(font * c.s)}px;letter-spacing:${rung.ls};animation-delay:${start}ms,${start}ms;animation-duration:${dur}ms,${dur}ms"><span class="hx" id="b${b.n}h" style="animation-delay:${unitDelay(hero)}ms">${escapeHtml(text)}</span></div>\n`;
    }
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(measure / (AVG_EM * FONT * f));
      pages = paginate(capUnits, maxChars * MAX_LINES - 2, 8);
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
    return cueDiv(b.n, b.cueDelayMs, b.winMs, heroHtml + pageDivs.join('\n'));
  });

  const css = `
  .cap { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; bottom:${c.py(BOTTOM)}px; text-align:center;
         font-family:'Space Grotesk'; font-weight:700; letter-spacing:0.05em; color:#F5EFE3; line-height:1.25;
         text-shadow:0 ${c.px(1)}px 0 rgba(11,14,24,0.62), 0 ${c.px(3)}px ${c.px(14)}px rgba(11,14,24,0.52); }
  .cl { display:block; }
  .u { display:inline-block; white-space:pre; }
  .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capRise 150ms cubic-bezier(0.16,0.84,0.32,1) both; }
  @keyframes capRise { 0%{opacity:0; transform:translateY(0.42em)} 100%{opacity:1; transform:none} }
  .hw { position:absolute; left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; z-index:3; text-align:center; white-space:nowrap; line-height:1.2;
        font-family:'Bodoni Moda'; font-weight:700; color:#FFFFFF;
        text-shadow:0 ${c.px(2)}px 0 rgba(11,14,24,0.26), 0 ${c.px(12)}px ${c.px(30)}px rgba(11,14,24,0.30);
        opacity:0; animation-name:cueWin, heroDrift; animation-timing-function:linear, linear; animation-fill-mode:forwards, forwards; }
  .hx { display:inline-block; opacity:0; animation:heroIn 300ms cubic-bezier(0.16,0.84,0.32,1) both; }
  .rg { position:absolute; left:0; width:${c.W}px; height:${c.px(3)}px; z-index:2; opacity:0; animation:cueWin linear forwards; }
  .rb { display:block; width:${c.W}px; height:${c.px(3)}px; background:rgba(255,255,255,0.92); box-shadow:0 ${c.px(1)}px ${c.px(3)}px rgba(11,14,24,0.34);
        transform-origin:0 50%; animation:ruleIn 460ms cubic-bezier(0.16,0.84,0.32,1) both; }
  @keyframes heroIn { 0%{opacity:0; transform:translateY(${c.px(18)}px) scale(0.955)} 100%{opacity:1; transform:none} }
  @keyframes heroDrift { 0%{transform:scale(1)} 100%{transform:scale(1.035)} }
  @keyframes ruleIn { 0%{transform:scaleX(0)} 100%{transform:scaleX(1)} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Space+Grotesk:wght@700', 'Bodoni+Moda:wght@700'],
    css,
    body: cues.join('\n'),
  });
});
