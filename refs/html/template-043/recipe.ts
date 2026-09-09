/**
 * template-043 "Script hero": centred EB Garamond caps typed glyph by glyph with a honey caret, in a
 * lockup of two blocks; the beat's strongest word leaves the caption and is handwritten between them
 * in large honey Pinyon Script, scaling in. Words before the hero sit in the upper block, words after
 * it in the lower one.
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
  templateRecipe,
  unitDelay,
  unitText,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 26;
const AVG_EM = 0.56; // EB Garamond 600 caps + 0.06em tracking
const MARGIN = 53;
const BOTTOM_K = 328; // the upper block (words before the hero)
const BOTTOM_C = 152; // the lower block (words after)
const HERO_TOP = 540;
const HERO_FONT = 72;
const HERO_FONT_LAST = 88;
const HERO_EM = 0.42; // Pinyon Script
const GLYPH_STEP = 34;
const MAX_LINES = 2;

export default templateRecipe('template-043', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const heroIdx = b.units.length >= 2 ? accentIndex(b.units) : -1;
    const before = heroIdx >= 0 ? b.units.slice(0, heroIdx) : b.units;
    const after = heroIdx >= 0 ? b.units.slice(heroIdx + 1) : [];
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let kLines: Unit[][] = [];
    let cLines: Unit[][] = [];
    for (; rows <= b.rows + 5; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(measure / (AVG_EM * FONT * f));
      kLines = before.length ? wrapByChars(before, maxChars) : [];
      cLines = after.length ? wrapByChars(after, maxChars) : [];
      if (kLines.length <= MAX_LINES && cLines.length <= MAX_LINES) break;
    }
    const fs = Math.round(FONT * f * c.s);

    // typed glyphs with the caret parked after the last typed one until the next word starts
    const block = (units: Unit[], lines: Unit[][], id: string, bottom: number) => {
      if (!units.length) return '';
      const start = unitDelay(units[0]);
      const lineDivs = lines.map((line, li) => {
        const parts = line.map((u, ui) => {
          const isLastInBlock = u === units[units.length - 1];
          const next = isLastInBlock ? b.cueEndMs : unitDelay(units[units.indexOf(u) + 1]);
          const glyphs = u.spans.map((s) => [...s.text].map((ch, k) => `<span class="g" style="animation-delay:${s.delayMs + k * GLYPH_STEP}ms">${escapeHtml(ch)}</span>`).join('')).join('');
          const d = unitDelay(u);
          return `<span class="u">${glyphs}</span><span class="cur" style="animation-delay:${d}ms;animation-duration:${Math.max(40, next - d)}ms"></span>`;
        });
        return `<div class="cl" id="${id}l${li + 1}">${parts.join('<span class="sp"> </span>')}</div>`;
      }).join('\n      ');
      return `  <div class="pg cap" id="${id}" style="bottom:${c.py(bottom)}px;font-size:${fs}px;animation:cueWin linear forwards;animation-delay:${start}ms;animation-duration:${Math.max(40, b.cueEndMs - start)}ms">\n      ${lineDivs}\n  </div>\n`;
    };
    let heroHtml = '';
    if (heroIdx >= 0) {
      const hero = b.units[heroIdx];
      const text = unitText(hero).toLowerCase();
      const base = b.isLast ? HERO_FONT_LAST : HERO_FONT;
      const font = Math.min(base, (c.refWidth - 2 * 24) / (HERO_EM * text.length)) * f;
      heroHtml = `  <div class="hrow" style="top:${c.py(HERO_TOP)}px;font-size:${Math.round(font * c.s)}px"><span class="hw" id="b${b.n}h" style="animation-delay:${unitDelay(hero)}ms">${escapeHtml(text)}</span></div>\n`;
    }
    return cueDiv(b.n, b.cueDelayMs, b.winMs, block(before, kLines, `b${b.n}k`, BOTTOM_K) + heroHtml + block(after, cLines, `b${b.n}c`, BOTTOM_C));
  });

  const css = `
  .cap { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; text-align:center; z-index:2; font-family:'EB Garamond'; font-weight:600; letter-spacing:0.06em;
         line-height:1.3; color:#F7F0E4; text-shadow:0 ${c.px(2)}px ${c.px(9)}px rgba(4,3,2,0.38), 0 ${c.px(1)}px ${c.px(2)}px rgba(4,3,2,0.3); }
  .cl { display:block; }
  .u { display:inline-block; white-space:pre; }
  .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capG 120ms cubic-bezier(.2,.7,.3,1) forwards; }
  .cur { display:inline-block; width:${c.px(2)}px; height:0.85em; margin-left:${c.px(2)}px; vertical-align:text-bottom; background:#FBF684; opacity:0;
         animation-name:capCur; animation-fill-mode:forwards; animation-timing-function:linear; }
  @keyframes capG { from{opacity:0} to{opacity:1} }
  @keyframes capCur { 0%{opacity:1} 99.9%{opacity:1} 100%{opacity:0} }
  .hrow { position:absolute; left:0; width:${c.W}px; text-align:center; white-space:nowrap; z-index:3; font-family:'Pinyon Script'; font-weight:400; line-height:1.2;
          color:#FBF684; text-shadow:0 ${c.px(3)}px ${c.px(15)}px rgba(4,3,2,0.38), 0 ${c.px(2)}px ${c.px(3)}px rgba(4,3,2,0.3); }
  .hw { display:inline-block; white-space:pre; opacity:0; transform-origin:50% 60%; animation:heroIn 640ms cubic-bezier(.2,.7,.3,1) both; }
  @keyframes heroIn { 0%{opacity:0; transform:scale(0.94)} 100%{opacity:1; transform:scale(1)} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['EB+Garamond:wght@600', 'Pinyon+Script'],
    css,
    body: cues.join('\n'),
  });
});
