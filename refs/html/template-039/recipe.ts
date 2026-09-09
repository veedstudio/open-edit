/**
 * template-039 "Headline stack": heavy italic Jost caps, every word on a square red plate with an
 * offset black shadow box, stacked left from mid-frame; the beat's strongest word stamps in at 1.37x
 * black-on-yellow, and a number takes the giant bleed plate.
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

const AVG_EM = 0.64; // Jost 900 italic caps
const MARGIN = 26;
const TOP = 520;
const GAP = 9;
const MAX_LINES = 2;
const RUNG = {
  rc: { font: 54, padX: 20 },
  rh: { font: 74, padX: 28 },
  rb: { font: 118, padX: 44 },
};
type Rung = keyof typeof RUNG;

export default templateRecipe('template-039', (meta, timings, opts) => {
  const c = canvasFor(meta);
  const measure = c.refWidth - 2 * MARGIN;
  let wordSeq = 0;

  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const heroIdx = accentIndex(b.units);
    const rungOf = (u: Unit): Rung => (b.units.indexOf(u) !== heroIdx ? 'rc' : /\d/.test(unitText(u)) ? 'rb' : 'rh');
    const plateW = (u: Unit, f: number) => (u.chars * AVG_EM * RUNG[rungOf(u)].font + RUNG[rungOf(u)].padX) * f;
    let rows = b.rows;
    let f = 1;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 4; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      pages = paginate(b.units, Math.floor(22 * f), 5);
      pageLines = pages.map((p) => wrapByWidth(p, measure, (u) => plateW(u, f), GAP));
      if (pageLines.every((ls) => ls.length <= MAX_LINES && ls.every((l) => l.reduce((a, u) => a + plateW(u, f), 0) + GAP * (l.length - 1) <= measure))) break;
    }
    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const nextStart = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : null;
      const lines = pageLines[pi].map((line, li) => {
        const spans = line.map((u, ui) => u.spans.map((s) => {
          wordSeq++;
          const r = rungOf(u);
          const cls = ['w', r, r === 'rb' && ui === 0 ? 'bleed' : ''].filter(Boolean).join(' ');
          return `<span class="${cls}" id="b${b.n}w${wordSeq}" style="font-size:${Math.round(RUNG[r].font * f * c.s)}px;animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join('')).join('');
        return `<div class="ln" id="${pageId}l${li + 1}">${spans}</div>`;
      }).join('\n      ');
      return `  <div class="pg stack" id="${pageId}" style="${pageGateStyle(pi, firstDelay, nextStart)}">\n      ${lines}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, pageDivs.join('\n'));
  });

  const css = `
  .stack { left:${c.px(MARGIN)}px; right:${c.px(MARGIN)}px; top:${c.py(TOP)}px; z-index:2; font-family:'Jost'; font-style:italic; font-weight:900; text-align:left; }
  .ln { display:block; line-height:1; padding-bottom:${c.px(GAP)}px; }
  .w { display:inline-block; vertical-align:bottom; margin-right:${c.px(GAP)}px; opacity:0; animation-fill-mode:forwards; white-space:pre; transform-origin:left center; }
  .bleed { margin-left:-${c.px(MARGIN)}px; }
  .rc { letter-spacing:-0.015em; padding:${c.px(4)}px ${c.px(10)}px ${c.px(6)}px; background:#FF1F0F; color:#FFFFFF; box-shadow:${c.px(5)}px ${c.px(5)}px 0 #0A0A0A;
        animation-name:wIn; animation-duration:130ms; animation-timing-function:cubic-bezier(.16,.84,.3,1); }
  .rh { letter-spacing:-0.025em; padding:${c.px(6)}px ${c.px(14)}px ${c.px(9)}px; background:#E9FF00; color:#0A0A0A; box-shadow:${c.px(7)}px ${c.px(7)}px 0 #0A0A0A;
        animation-name:hIn; animation-duration:210ms; animation-timing-function:cubic-bezier(.34,1.3,.64,1); }
  .rb { letter-spacing:-0.035em; padding:${c.px(9)}px ${c.px(22)}px ${c.px(14)}px; background:#E9FF00; color:#0A0A0A; box-shadow:${c.px(11)}px ${c.px(11)}px 0 #0A0A0A;
        animation-name:hIn; animation-duration:300ms; animation-timing-function:cubic-bezier(.34,1.3,.64,1); }
  @keyframes wIn { from{opacity:0; transform:translateY(0.24em)} to{opacity:1; transform:none} }
  @keyframes hIn { from{opacity:0; transform:scale(0.8)} to{opacity:1; transform:none} }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Jost:ital,wght@1,900'],
    css,
    body: cues.join('\n'),
  });
});
