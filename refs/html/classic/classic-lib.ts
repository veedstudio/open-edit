/**
 * Shared generator for the "classic" preset ports (VEED subtitle presets ->
 * .wv documents). Specs mirror subtitle-preset-engine defaults.json semantics:
 * sizes/positions are canvas-width/height fractions, everything else is em.
 * Calibrated against reference renders in agentic-preset-generator
 * (tmp/renders/classic-port): anchor = (x*W, y*H) block-centered,
 * line pitch = lineHeight * fontPx.
 */
import {
  type RecipeGenerator,
  type RecipeOptions,
  type RecipeOutput,
  type RunMeta,
  type Unit,
  demotionFor,
  escapeHtml,
  manifestFor,
  paginate,
  splitLines,
  winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTiming, WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

export type ClassicAnim =
  | 'none'
  | 'karaoke'
  | 'colourHighlight'
  | 'highlight'
  | 'dropIn'
  | 'floatInBottom'
  | 'flipClock'
  | 'fadeInPre';

export interface AspectValue {
  pt: number;
  ls: number;
}

export interface ClassicSpec {
  id: string;
  /** css2 families query, e.g. "Poppins:wght@600" */
  googleFamily: string;
  fontStack: string;
  weight: number;
  italic?: boolean;
  color: string;
  /** line pitch in em (lineHeight; e12 uses measured glyphheight pitch) */
  pitchEm: number;
  letterSpacingEm: number;
  casing: 'none' | 'uppercase' | 'lowercase';
  anim: ClassicAnim;
  /** colourHighlight only */
  highlightColor?: string;
  outline?: { sizeEm: number; color: string };
  shadow?: { blurEm: number; dxEm: number; dyEm: number; color: string };
  /** per-line bars; perWord = each word carries its own dimmable segment (ali) */
  bg?: { color: string; padEm: number; radiusEm: number; perWord?: boolean };
  /** frosted plate behind the whole page (emphasisTwelve) */
  plate?: { tint: string; blurEm: number; radiusEm: number; padXEm: number; padTopEm: number; padBottomEm: number };
  /** measured average glyph advance (em, post-casing) for line splitting */
  avgCharEm: number;
  sizeFrac?: number | AspectValue;
  wrapFrac?: number | AspectValue;
  yFrac?: number | AspectValue;
  maxLines?: number;
}

const DEMOTE_STEP = 0.92;
const MAX_UNITS_PER_PAGE = 24;

function frac(v: number | AspectValue | undefined, fallback: number, portrait: boolean): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number') return v;
  return portrait ? v.pt : v.ls;
}

function cssColor(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length === 8) {
    const a = parseInt(h.slice(6, 8), 16) / 255;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${+a.toFixed(3)})`;
  }
  return `#${h}`;
}

function applyCasing(w: string, casing: ClassicSpec['casing']): string {
  if (casing === 'uppercase') return w.toUpperCase();
  if (casing === 'lowercase') return w.toLowerCase();
  return w;
}

/** lib.toUnits with the VEED leading-"-" glue but caller-controlled casing. */
export function toUnitsCased(words: WordTiming[], casing: ClassicSpec['casing']): Unit[] {
  const units: Unit[] = [];
  for (const wt of words) {
    const text = applyCasing(wt.w, casing);
    if (text.startsWith('-') && units.length > 0) {
      const prev = units[units.length - 1];
      prev.spans.push({ text, delayMs: wt.delayMs });
      prev.chars += text.length;
    } else {
      units.push({ spans: [{ text, delayMs: wt.delayMs }], chars: text.length });
    }
  }
  return units;
}

function splitIntoLines(units: Unit[], maxChars: number): Unit[][] {
  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let load = 0;
  for (const u of units) {
    const add = u.chars + (line.length > 0 ? 1 : 0);
    if (line.length > 0 && load + add > maxChars) {
      lines.push(line);
      line = [u];
      load = u.chars;
    } else {
      line.push(u);
      load += add;
    }
  }
  if (line.length > 0) lines.push(line);
  if (lines.length === 2) {
    const [a, b] = splitLines(units);
    if (b) {
      const load = (l: Unit[]) => l.reduce((acc, u) => acc + u.chars, 0) + l.length - 1;
      if (load(a) <= maxChars && load(b) <= maxChars) return [a, b];
    }
  }
  return lines;
}

function textShadowCss(spec: ClassicSpec, fontPx: number): string {
  const layers: string[] = [];
  if (spec.outline) {
    const r = Math.max(1, Math.round(spec.outline.sizeEm * fontPx));
    const d = Math.max(1, Math.round(spec.outline.sizeEm * fontPx * 0.71));
    const c = cssColor(spec.outline.color);
    layers.push(
      `${r}px 0 0 ${c}`, `-${r}px 0 0 ${c}`, `0 ${r}px 0 ${c}`, `0 -${r}px 0 ${c}`,
      `${d}px ${d}px 0 ${c}`, `-${d}px ${d}px 0 ${c}`, `${d}px -${d}px 0 ${c}`, `-${d}px -${d}px 0 ${c}`,
    );
  }
  if (spec.shadow && spec.shadow.blurEm > 0) {
    const s = spec.shadow;
    layers.push(
      `${Math.round(s.dxEm * fontPx)}px ${Math.round(s.dyEm * fontPx)}px ${Math.round(s.blurEm * fontPx)}px ${cssColor(s.color)}`,
    );
  }
  return layers.length ? `text-shadow:${layers.join(', ')};` : '';
}

function wordAnimCss(spec: ClassicSpec): string {
  switch (spec.anim) {
    case 'karaoke':
      return `.w{opacity:.5;animation-name:kIn;animation-timing-function:linear;animation-fill-mode:forwards;}
@keyframes kIn{to{opacity:1}}`;
    case 'highlight':
      return `.w{opacity:.5;animation-name:hlOn;animation-timing-function:linear;animation-fill-mode:none;}
@keyframes hlOn{0%,94%{opacity:1}100%{opacity:.5}}`;
    case 'colourHighlight':
      return `.w{animation-name:chOn;animation-timing-function:linear;animation-fill-mode:none;}
@keyframes chOn{0%{color:${cssColor(spec.color)}}10%{color:${cssColor(spec.highlightColor ?? spec.color)}}88%{color:${cssColor(spec.highlightColor ?? spec.color)}}100%{color:${cssColor(spec.color)}}}`;
    case 'dropIn':
      return `.w{opacity:0;animation-name:dIn;animation-timing-function:cubic-bezier(.16,1,.3,1);animation-fill-mode:both;}
@keyframes dIn{from{opacity:0;transform:translateY(-.12em) scale(1.5)}to{opacity:1;transform:translateY(0) scale(1)}}`;
    case 'floatInBottom':
      return `.w{opacity:0;animation-name:fIn;animation-timing-function:cubic-bezier(.16,1,.3,1);animation-fill-mode:both;}
@keyframes fIn{from{opacity:0;transform:translateY(.6em)}to{opacity:1;transform:translateY(0)}}`;
    case 'fadeInPre':
      return `.w{opacity:0;animation-name:aIn;animation-timing-function:cubic-bezier(.55,.085,.68,.53);animation-fill-mode:both;}
@keyframes aIn{from{opacity:0}to{opacity:1}}`;
    case 'flipClock':
      return `.w{opacity:.5;animation-name:kIn;animation-timing-function:linear;animation-fill-mode:forwards;}
@keyframes kIn{to{opacity:1}}
.flip{animation-name:flipIn;animation-timing-function:cubic-bezier(.16,1,.3,1);animation-fill-mode:both;transform-origin:center;}
@keyframes flipIn{from{opacity:0;transform:scaleY(.1)}to{opacity:1;transform:scaleY(1)}}`;
    case 'none':
      return '';
  }
}

function generate(spec: ClassicSpec, meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}): RecipeOutput {
  const W = meta.width;
  const H = meta.height;
  const portrait = H >= W;
  const demote = opts.demote ?? {};

  const sizeFrac = frac(spec.sizeFrac, 0.048, portrait);
  const wrapFrac = frac(spec.wrapFrac, 0.8, portrait);
  const yFrac = frac(spec.yFrac, 0.85, portrait);
  const maxLines = spec.maxLines ?? 3;
  const baseFontPx = sizeFrac * W;

  const bg = spec.bg;
  const perWordBar = !!bg?.perWord;

  const cues: string[] = [];
  let wordSeq = 0;

  for (let bi = 0; bi < timings.beats.length; bi++) {
    const beat = timings.beats[bi];
    if (beat.words.length === 0) continue;
    const n = beat.i;
    const cueDelay = beat.cueDelayMs;
    const winMs = winMsFor(timings.beats, bi, meta.durationSec);
    const cueEnd = cueDelay + winMs;

    const baseDemote = demotionFor(
      demote,
      ...Object.keys(demote).filter((k) => new RegExp(`^b${n}([a-z]|$)`).test(k)),
    );

    const units = toUnitsCased(beat.words, spec.casing);

    let rows = baseDemote;
    let fontPx = 0;
    let maxChars = 0;
    let pages: Unit[][] = [];
    let pageLines: Unit[][][] = [];
    for (; rows <= baseDemote + 4; rows++) {
      fontPx = baseFontPx * Math.pow(DEMOTE_STEP, rows);
      maxChars = Math.floor((wrapFrac * W * 0.97) / (spec.avgCharEm * fontPx));
      pages = paginate(units, Math.floor(maxChars * maxLines * 0.88), MAX_UNITS_PER_PAGE);
      pageLines = pages.map((p) => splitIntoLines(p, maxChars));
      if (pageLines.every((ls) => ls.length <= maxLines)) break;
    }

    const fs = Math.round(fontPx);
    const pitch = spec.pitchEm * fontPx;
    const emH = 0.97 * fontPx;
    const avgWinMs = winMs / beat.words.length;
    const karaokeRamp = Math.round(Math.min(150, Math.max(60, 0.1 * avgWinMs)));

    const pageDivs: string[] = [];
    for (let pi = 0; pi < pages.length; pi++) {
      const lines = pageLines[pi];
      const pageId = `b${n}p${pi + 1}`;
      const firstDelay = pages[pi][0].spans[0].delayMs;
      const nextStart = pi + 1 < pages.length ? pages[pi + 1][0].spans[0].delayMs : null;

      const blockH = (lines.length - 1) * pitch + emH;
      const top0 = yFrac * H - blockH / 2;

      const flat = pages[pi];
      const lineDivs: string[] = [];
      for (let li = 0; li < lines.length; li++) {
        const lineId = `${pageId}l${li + 1}`;
        const top = Math.round(top0 + li * pitch);
        const spans: string[] = [];
        for (let ui = 0; ui < lines[li].length; ui++) {
          const u = lines[li][ui];
          const inner = u.spans
            .map((s) => {
              wordSeq++;
              const delay = s.delayMs;
              const nextIdx = flat.indexOf(u);
              let winEnd = cueEnd;
              for (let k = nextIdx + 1; k < flat.length; k++) {
                if (flat[k].spans[0].delayMs > delay) { winEnd = flat[k].spans[0].delayMs; break; }
              }
              if (u.spans.indexOf(s) < u.spans.length - 1) winEnd = Math.min(winEnd, u.spans[u.spans.indexOf(s) + 1].delayMs);
              const wordWin = Math.max(120, winEnd - delay);
              let a = '';
              switch (spec.anim) {
                case 'karaoke':
                  a = `animation-delay:${delay}ms;animation-duration:${karaokeRamp}ms;`;
                  break;
                case 'flipClock':
                  a = `animation-delay:${delay}ms;animation-duration:${karaokeRamp}ms;`;
                  break;
                case 'highlight':
                case 'colourHighlight':
                  a = `animation-delay:${delay}ms;animation-duration:${Math.round(Math.max(200, wordWin))}ms;`;
                  break;
                case 'dropIn':
                  a = `animation-delay:${delay}ms;animation-duration:${Math.round(Math.min(420, Math.max(250, Math.min(0.8 * wordWin, cueEnd - delay))))}ms;`;
                  break;
                case 'floatInBottom':
                  a = `animation-delay:${delay}ms;animation-duration:${Math.round(Math.min(360, Math.max(220, Math.min(0.6 * wordWin, cueEnd - delay))))}ms;`;
                  break;
                case 'fadeInPre':
                  a = `animation-delay:${Math.max(cueDelay, delay - 200)}ms;animation-duration:200ms;`;
                  break;
                case 'none':
                  break;
              }
              const style = a ? ` style="${a}"` : '';
              return `<span class="w" id="b${n}w${wordSeq}"${style}>${escapeHtml(s.text)}</span>`;
            })
            .join('');
          spans.push(inner);
        }
        let content: string;
        if (perWordBar) {
          content = spans
            .map((s, i) => {
              let x = s.replaceAll('class="w"', 'class="w wb"');
              if (i === 0) x = x.replace('class="w wb"', 'class="w wb brL"');
              if (i === spans.length - 1) {
                const at = x.lastIndexOf('class="w wb');
                x = `${x.slice(0, at)}class="w wb brR${x.slice(at + 'class="w wb'.length)}`;
              }
              return x;
            })
            .join('');
        } else if (bg) {
          content = `<span class="bar">${spans.join('&#160;')}</span>`;
        } else {
          content = spans.join('&#160;');
        }
        lineDivs.push(
          `<div class="ln" id="${lineId}" data-node-role="text" style="top:${top}px;font-size:${fs}px;">${content}</div>`,
        );
      }

      let inner = lineDivs.join('\n    ');
      if (spec.plate) {
        const p = spec.plate;
        const maxLineChars = Math.max(...lines.map((l) => l.reduce((a, u) => a + u.chars, 0) + l.length - 1));
        const lineW = maxLineChars * spec.avgCharEm * fontPx;
        const plateW = Math.round(lineW + 2 * p.padXEm * fontPx);
        const plateTop = Math.round(top0 - p.padTopEm * fontPx);
        const plateH = Math.round(blockH + (p.padTopEm + p.padBottomEm) * fontPx);
        const plateLeft = Math.round(W / 2 - plateW / 2);
        inner =
          `<div class="plate" style="left:${plateLeft}px;top:${plateTop}px;width:${plateW}px;height:${plateH}px;` +
          `border-radius:${Math.round(p.radiusEm * fontPx)}px;"></div>\n    ` + inner;
      }
      if (spec.anim === 'flipClock') {
        const flipDur = Math.round(Math.min(0.7 * winMs, 1000));
        inner = `<div class="flip" style="animation-delay:${cueDelay}ms;animation-duration:${flipDur}ms;">\n    ${inner}\n    </div>`;
      }

      let pgAnim = '';
      if (pi > 0 && nextStart !== null) {
        pgAnim = `animation:pgOn 40ms linear ${firstDelay}ms forwards, pgOff 40ms linear ${nextStart - 40}ms forwards;`;
      } else if (pi > 0) {
        pgAnim = `animation:pgOn 40ms linear ${firstDelay}ms forwards;`;
      } else if (nextStart !== null) {
        pgAnim = `opacity:1;animation:pgOff 40ms linear ${nextStart - 40}ms forwards;`;
      } else {
        pgAnim = 'opacity:1;';
      }
      pageDivs.push(`  <div class="pg" id="${pageId}" style="z-index:1;${pgAnim}">\n    ${inner}\n  </div>`);
    }

    cues.push(
      `<div class="cue" id="cue${n}" style="z-index:${10 + n};animation-delay:${cueDelay}ms;animation-duration:${winMs}ms;">\n${pageDivs.join('\n')}\n</div>`,
    );
  }

  const barCss = bg
    ? perWordBar
      ? `.wb{background:${cssColor(bg.color)};padding:${bg.padEm}em .3em;}
.brL{border-radius:${bg.radiusEm}em 0 0 ${bg.radiusEm}em;padding-left:.45em;}
.brR{border-radius:0 ${bg.radiusEm}em ${bg.radiusEm}em 0;padding-right:.45em;}
.brL.brR{border-radius:${bg.radiusEm}em;}`
      : `.bar{display:inline-block;background:${cssColor(bg.color)};padding:${bg.padEm}em ${(1.5 * bg.padEm).toFixed(3)}em;${bg.radiusEm > 0 ? `border-radius:${bg.radiusEm}em;` : ''}}`
    : '';

  const plateCss = spec.plate
    ? `.plate{position:absolute;z-index:1;background:${spec.plate.tint};backdrop-filter:blur(${Math.round(spec.plate.blurEm * baseFontPx)}px);}`
    : '';

  const wv = `<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${spec.googleFamily}&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; position:relative; overflow:hidden; font-family:${spec.fontStack}; }
  .vid { position:absolute; inset:0; width:${W}px; height:${H}px; object-fit:cover; z-index:0; }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0; animation:cueWin linear forwards; }
  .pg { position:absolute; inset:0; opacity:0; }
  @keyframes pgOn { to{opacity:1} }
  @keyframes pgOff { to{opacity:0} }
  .ln { position:absolute; left:0; right:0; z-index:2; text-align:center; line-height:1.2;
        color:${cssColor(spec.color)}; font-weight:${spec.weight};${spec.italic ? ' font-style:italic;' : ''}
        letter-spacing:${spec.letterSpacingEm}em; ${textShadowCss(spec, baseFontPx)} }
  .w { display:inline-block; }
${wordAnimCss(spec)}
${barCss}
${plateCss}
</style>
<video class="vid" src="${meta.videoPath}" muted></video>
${cues.join('\n')}
`;

  return { wv, manifest: manifestFor(meta) };
}

export function classicRecipe(spec: ClassicSpec): RecipeGenerator {
  return {
    refId: `classic/${spec.id}`,
    generate: (meta, timings, opts) => generate(spec, meta, timings, opts ?? {}),
  };
}
