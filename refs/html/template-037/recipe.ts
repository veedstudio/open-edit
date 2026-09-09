/**
 * template-037 "Interrupt": a poster per page. Cool-white Plex Mono sentence words rise in above and
 * below; the beat's strongest word interrupts between them as huge dark Anton knocked out of a sharp
 * colour block that wipes open from the page's side. Pages alternate left / right; the block is red,
 * ice-blue every third beat. The source composited nothing behind the presenter here.
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
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 18;
const AVG_EM = 0.68; // Plex Mono 0.6em + 0.08em tracking
const LEFT = 34;
const WIDTH = 412;
const TOP_A = 520;
const TOP_HERO = 561;
const TOP_B = 690;
const HERO_FONT = 114;
const HERO_EM = 0.5; // Anton caps
const HERO_PAD = 14;

const lineChars = (l: Unit[]) => l.reduce((a, u) => a + u.chars, 0) + Math.max(0, l.length - 1);

export default templateRecipe('template-037', (meta, timings, opts) => {
  const c = canvasFor(meta);
  let wordSeq = 0;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    for (; rows <= b.rows + 5; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(WIDTH / (AVG_EM * FONT * f));
      pages = paginate(b.units, maxChars * 2, 9);
      // every page splits at its hero into ONE line above and ONE below
      const fits = pages.every((p) => {
        const h = accentIndex(p);
        return lineChars(p.slice(0, h)) <= maxChars && lineChars(p.slice(h + 1)) <= maxChars;
      });
      if (fits) break;
    }
    const fs = Math.round(FONT * f * c.s);
    const side = b.n % 2 === 1 ? 'left' : 'right';
    const colour = b.n % 3 === 0 ? 'sIce' : 'sRed';

    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const h = accentIndex(page);
      const hero = page[h];
      const heroText = unitText(hero).replace(/[.,!?;:]+$/, '');
      const heroFont = Math.min(HERO_FONT, (WIDTH - 2 * HERO_PAD) / (HERO_EM * heroText.length)) * f;
      const pageSide = pi % 2 === 0 ? side : side === 'left' ? 'right' : 'left';
      const line = (units: Unit[], id: string, top: number) => units.length
        ? `<div class="ml" id="${id}" style="top:${c.py(top)}px;font-size:${fs}px;text-align:${pageSide}">${units.map((u) => u.spans.map((s) => {
          wordSeq++;
          return `<span class="w" id="b${b.n}w${wordSeq}" style="animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join('')).join(' ')}</div>`
        : '';
      const heroDiv = `<div class="hero" style="top:${c.py(TOP_HERO)}px;text-align:${pageSide}"><span class="sw ${colour} ${pageSide === 'left' ? 'wipeL' : 'wipeR'}" style="animation-delay:${unitDelay(hero)}ms"><span class="hw" id="${pageId}h" style="font-size:${Math.round(heroFont * c.s)}px">${escapeHtml(heroText)}</span></span></div>`;
      return `  <div class="pg poster" id="${pageId}" style="${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${line(page.slice(0, h), `${pageId}a`, TOP_A)}\n      ${heroDiv}\n      ${line(page.slice(h + 1), `${pageId}b`, TOP_B)}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const css = `
  .poster { inset:0; }
  .ml { position:absolute; left:${c.px(LEFT)}px; width:${c.px(WIDTH)}px; z-index:2; font-family:'IBM Plex Mono'; font-weight:600;
        letter-spacing:0.08em; line-height:1.3; color:#E6F1F7; white-space:nowrap;
        text-shadow:0 ${c.px(2)}px ${c.px(9)}px rgba(11,11,14,0.52), 0 ${c.px(1)}px ${c.px(2)}px rgba(11,11,14,0.40); }
  .w { display:inline-block; opacity:0; animation-name:wIn; animation-duration:220ms; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wIn { 0%{opacity:0; transform:translateY(${c.px(9)}px)} 100%{opacity:1; transform:translateY(0)} }
  .hero { position:absolute; left:${c.px(LEFT)}px; width:${c.px(WIDTH)}px; z-index:3; }
  .sw { display:inline-block; padding:${c.px(2)}px ${c.px(HERO_PAD)}px; }
  .wipeL { clip-path:polygon(0% 0%, 0% 0%, 0% 100%, 0% 100%); animation-name:wipeL; animation-duration:190ms; animation-timing-function:cubic-bezier(.16,1,.3,1); animation-fill-mode:both; }
  .wipeR { clip-path:polygon(100% 0%, 100% 0%, 100% 100%, 100% 100%); animation-name:wipeR; animation-duration:190ms; animation-timing-function:cubic-bezier(.16,1,.3,1); animation-fill-mode:both; }
  @keyframes wipeL { 0%{clip-path:polygon(0% 0%, 0% 0%, 0% 100%, 0% 100%)} 100%{clip-path:polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)} }
  @keyframes wipeR { 0%{clip-path:polygon(100% 0%, 100% 0%, 100% 100%, 100% 100%)} 100%{clip-path:polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)} }
  .sRed { background:#FF2D00; }
  .sIce { background:#00E5FF; }
  .hw { display:inline-block; font-family:'Anton'; font-weight:400; line-height:0.8; letter-spacing:0.01em; padding:0.08em 0 0.06em; color:#0B0B0E; white-space:nowrap; }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Anton', 'IBM+Plex+Mono:wght@600'],
    css,
    body: cues.join('\n'),
  });
});
