/**
 * template-034 "Countdown board": Archivo Black caps on a left-aligned board, one or two words a line,
 * hard offset shadows; the beat's strongest word pops in on a yellow plate, and the closing call to
 * action lands on red plates at a larger size. When the opening beat announces a count ("three
 * ways"), the beats that follow carry giant red numerals top-right; the source composited them
 * behind the presenter, here they sit on top.
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
  paginate,
  templateRecipe,
  unitDelay,
  unitText,
  wrapByChars,
} from '../../../pipeline/recipes/template-lib.ts';

const FONT = 52;
const CTA_FONT = 72;
const AVG_EM = 0.70; // Archivo Black caps incl. -0.02em tracking
const LEFT = 34;
const WIDTH = 392;
const BOTTOM = 210;
const MAX_LINES = 2;
const MAX_CTA_CHARS = 7; // 392px / (0.70 * 72px)
const NUMERAL_FONT = 340;
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// The count the opening beat announces ("three ways", "5 tips"), else 0.
function announcedCount(words: { w: string }[]): number {
  for (const { w } of words) {
    const t = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (NUMBER_WORDS[t]) return NUMBER_WORDS[t];
    if (/^\d{1,2}$/.test(t) && Number(t) > 1) return Number(t);
  }
  return 0;
}

// Units after the last sentence end, when they are few and short enough for the CTA plates.
function ctaTail(units: Unit[]): number {
  for (let k = units.length - 2; k >= 0 && units.length - 1 - k <= 2; k--) {
    if (/[.!?]$/.test(unitText(units[k]))) {
      const tail = units.slice(k + 1);
      return tail.every((u) => u.chars <= MAX_CTA_CHARS) ? tail.length : 0;
    }
  }
  return 0;
}

export default templateRecipe('template-034', (meta, timings, opts) => {
  const c = canvasFor(meta);
  let wordSeq = 0;

  const count = timings.beats.length > 1 ? announcedCount(timings.beats[0].words) : 0;
  const cues = eachBeat(meta, timings, opts, 'uppercase', (b) => {
    const hl = accentIndex(b.units);
    // beat k (1-based) after the opener carries numeral k - 1 while the count lasts
    const numeral = count && b.n >= 2 && b.n - 1 <= count ? String(b.n - 1) : '';
    const numeralHtml = numeral
      ? `  <div class="idx" id="b${b.n}n" style="font-size:${Math.round((numeral.length > 1 ? NUMERAL_FONT * 0.7 : NUMERAL_FONT) * c.s)}px"><span class="ig" style="animation-delay:${b.cueDelayMs}ms">${numeral}</span></div>\n`
      : '';
    let rows = b.rows;
    let f = 1;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= b.rows + 5; rows++) {
      f = Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor(WIDTH / (AVG_EM * FONT * f));
      // the closing beat's short tail after its last sentence end ("SAVE THIS.") is the CTA page
      const tail = b.isLast ? ctaTail(b.units) : 0;
      const head = tail ? b.units.slice(0, -tail) : b.units;
      pages = head.length ? paginate(head, maxChars * MAX_LINES - 1, 4) : [];
      if (tail) pages.push(b.units.slice(-tail));
      pageLines = pages.map((p, i) => (tail && i === pages.length - 1 ? p.map((u) => [u]) : wrapByChars(p, maxChars)));
      if (pageLines.every((ls) => ls.length <= MAX_LINES && ls.every((l) => l.reduce((a, u) => a + u.chars, 0) + l.length - 1 <= maxChars))) break;
    }
    const fs = Math.round(FONT * f * c.s);
    const ctaFs = Math.round(CTA_FONT * f * c.s);

    const pageDivs = pages.map((page, pi) => {
      const pageId = `b${b.n}p${pi + 1}`;
      const firstDelay = unitDelay(page[0]);
      const endMs = pi + 1 < pages.length ? unitDelay(pages[pi + 1][0]) : b.cueEndMs;
      const lines = pageLines[pi];
      const cta = b.isLast && pi === pages.length - 1 && ctaTail(b.units) > 0;
      const lineDivs = lines.map((line, li) => {
        const spans = line.map((u, ui) => u.spans.map((s) => {
          wordSeq++;
          const plate = cta ? 'cta' : b.units.indexOf(u) === hl ? 'hl' : '';
          const lead = plate && ui === 0 ? (cta ? 'leadC' : 'lead') : '';
          const cls = ['w', plate, lead].filter(Boolean).join(' ');
          return `<span class="${cls}" id="b${b.n}w${wordSeq}" style="animation-delay:${s.delayMs}ms">${escapeHtml(s.text)}</span>`;
        }).join('')).join('');
        return `<div class="${cta ? 'clC' : 'cl'}" id="${pageId}l${li + 1}" style="font-size:${cta ? ctaFs : fs}px">${spans}</div>`;
      }).join('\n      ');
      // each page is its own gate: from its first word to the next page's first word
      return `  <div class="pg board" id="${pageId}" style="animation:cueWin linear forwards;animation-delay:${firstDelay}ms;animation-duration:${Math.max(40, endMs - firstDelay)}ms;">\n      ${lineDivs}\n  </div>`;
    });
    return cueDiv(b.n, b.cueDelayMs, b.winMs, numeralHtml + pageDivs.join('\n'));
  });

  const shadow = `${c.px(3)}px ${c.px(4)}px 0 #101010, 0 ${c.px(3)}px ${c.px(13)}px rgba(25,25,25,0.38), 0 ${c.px(1)}px ${c.px(3)}px rgba(25,25,25,0.3)`;
  const css = `
  .board { left:${c.px(LEFT)}px; bottom:${c.py(BOTTOM)}px; width:${c.px(WIDTH)}px; z-index:2; }
  .cl { display:block; text-align:left; font-family:'Archivo Black'; font-weight:400; letter-spacing:-0.02em; line-height:1; padding:0 0 ${c.px(6)}px; }
  .clC { display:block; text-align:left; font-family:'Archivo Black'; font-weight:400; letter-spacing:-0.03em; line-height:1; padding:0 0 ${c.px(9)}px; }
  .w { display:inline-block; opacity:0; line-height:1; margin-right:0.22em; padding:${c.px(5)}px 0 ${c.px(10)}px; color:#FFFFFF;
       text-shadow:${shadow};
       animation-name:wIn; animation-duration:200ms; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wIn { 0%{opacity:0; transform:translateY(0.3em)} 100%{opacity:1; transform:none} }
  .hl { background:#FFE500; color:#101010; padding:${c.px(5)}px ${c.px(11)}px ${c.px(10)}px; text-shadow:none; box-shadow:${shadow};
        animation-name:wPop; animation-duration:260ms; animation-timing-function:cubic-bezier(.34,1.4,.64,1); }
  @keyframes wPop { 0%{opacity:0; transform:translateY(0.18em) scale(.86)} 100%{opacity:1; transform:none} }
  .cta { background:#FF2E12; color:#101010; padding:${c.px(6)}px ${c.px(13)}px ${c.px(12)}px; text-shadow:none;
         box-shadow:${c.px(4)}px ${c.px(5)}px 0 #101010, 0 ${c.px(3)}px ${c.px(13)}px rgba(25,25,25,0.38), 0 ${c.px(1)}px ${c.px(3)}px rgba(25,25,25,0.3);
         animation-name:wPop; animation-duration:260ms; animation-timing-function:cubic-bezier(.34,1.4,.64,1); }
  .idx { position:absolute; right:${c.px(34)}px; top:${c.py(34)}px; width:${c.px(380)}px; text-align:right; z-index:3; }
  .ig { display:inline-block; opacity:0; line-height:1; padding:0 0 0.06em; font-family:'Archivo Black'; font-weight:400; letter-spacing:-0.045em; color:#FF2E12;
        text-shadow:0 ${c.px(7)}px ${c.px(32)}px rgba(25,25,25,0.38), 0 ${c.px(4)}px ${c.px(7)}px rgba(25,25,25,0.3);
        animation:idxIn 420ms cubic-bezier(.2,.7,.3,1) both; }
  @keyframes idxIn { 0%{opacity:0; transform:translateY(${c.px(26)}px) scale(1.06)} 100%{opacity:1; transform:none} }
  .lead { margin-left:-${c.px(11)}px; }
  .leadC { margin-left:-${c.px(13)}px; }`;

  return docShell({
    canvas: c,
    videoPath: meta.videoPath,
    fonts: ['Archivo+Black'],
    css,
    body: cues.join('\n'),
  });
});
