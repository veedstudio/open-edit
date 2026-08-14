// Captions built from the words the speaker actually said, at the times they actually said them.
//
// The failing film had 1872 real per-word timestamps on disk and used them for nothing but the in and
// out of each cue. The caption itself faded in as a block, once per cue, on a 0.2s opacity ramp that
// was written into the first draft and never touched again — while the same film gave its GRAPHICS a
// per-character stagger. Two hundred and seventeen cues, one position, one ramp, twelve minutes.
//
// A word reveal is not decoration. It is the only thing that ties the type to the voice, and when it
// is missing the captions read as a subtitle track laid over a film rather than as part of it.
//
// The mechanics here come from a delivered sheet that solved this: glyphs arrive at their word's
// verbatim delay plus a small intra-word stagger, with ONE cursor travelling the whole beat rather
// than a cursor per line. The numbers are parameters, not decrees.
//
// LINES ARE BLOCK ELEMENTS. `<br>` does not break a run of `display:inline-block` spans — measured by
// control render, and the cost of not knowing it was 166 frames of `--verify FAIL[bounds]`. Making
// each line its own block is what stops that from being possible to write.
import type { WordTiming } from '../scripts/synth-word-timings.ts';
import { toUnits, paginate, splitLines, escapeHtml, type Unit } from '../recipes/lib.ts';
import type { DesignSystem, Rung } from './system.ts';

export interface CaptionOptions {
  /** The rung captions are set on. Named, so a caption can never quietly take a display size. */
  role?: string;
  /** Characters per page before it splits. Two short lines read faster than one long one. */
  maxChars?: number;
  maxUnits?: number;
  /** Milliseconds between glyphs inside one word. 0 reveals the word whole. */
  glyphStaggerMs?: number;
  /** How long one glyph takes to arrive. */
  popMs?: number;
  /** Distance from the bottom safe edge, in px. */
  bottomPx?: number;
  /** A cursor bar travelling the beat. One for the whole block, never one per line. */
  cursor?: boolean;
  /** How long the last page holds after its final glyph. */
  tailMs?: number;
}

export interface CaptionBlock {
  html: string;
  css: string;
  /** Every reveal delay emitted, in order — so a test can prove they came from the transcript. */
  delaysMs: number[];
  lines: number;
  /** Screens this cue needed. More than one is normal for a long sentence. */
  pages: number;
}

function rung(sys: DesignSystem, role: string): Rung {
  const r = sys.ladder.find((x) => x.role === role);
  if (!r) throw new Error(`captions: the system has no "${role}" rung — ladder is ${sys.ladder.map((x) => x.role).join(', ')}`);
  return r;
}

/** Glyph spans for one unit, each carrying its own absolute delay. */
function glyphs(u: Unit, staggerMs: number): { text: string; delayMs: number }[] {
  const out: { text: string; delayMs: number }[] = [];
  for (const span of u.spans) {
    [...span.text].forEach((ch, i) => out.push({ text: ch, delayMs: span.delayMs + i * staggerMs }));
  }
  return out;
}

/**
 * One caption block for one cue.
 *
 * Every delay is the word's own time from the transcript. Nothing here divides a cue's duration by a
 * word count — that is the even-split the whole pipeline refuses upstream, and reintroducing it at
 * the last step would undo the reason per-word times are mandatory.
 */
export function captionBlock(words: WordTiming[], sys: DesignSystem, opts: CaptionOptions = {}): CaptionBlock {
  const {
    role = 'body',
    maxChars = 42,
    maxUnits = 9,
    glyphStaggerMs = 34,
    popMs = 120,
    bottomPx = sys.spacing.safeY,
    cursor = true,
  } = opts;

  const r = rung(sys, role);
  const units = toUnits(words);
  const pages = paginate(units, maxChars, maxUnits);

  // EVERY page is rendered. Emitting only the first silently dropped the back half of any cue longer
  // than one screen — speech that was transcribed, timed, and then never shown.
  const delaysMs: number[] = [];
  let lines = 0;
  const pageStart = (p: Unit[]) => p[0]?.spans[0]?.delayMs ?? 0;

  const pageHtml = pages.map((page, i) => {
    const [l1, l2] = splitLines(page);
    const pageLines = [l1, l2].filter((l): l is Unit[] => Boolean(l && l.length));
    lines += pageLines.length;

    const pageDelays: number[] = [];
    // Where each unit's cursor hands over to the next. The last one on the page runs to the page's end.
    const flat = pageLines.flat();
    const handover = (u: Unit): number => {
      const at = flat.indexOf(u);
      const nextUnit = flat[at + 1];
      if (nextUnit) return nextUnit.spans[0].delayMs;
      const nextPage = pages[i + 1];
      return nextPage ? pageStart(nextPage) : (u.spans.at(-1)!.delayMs + u.chars * glyphStaggerMs + popMs + (opts.tailMs ?? 600));
    };

    const lineHtml = pageLines.map((line) => {
      const inner = line.map((u) => {
        const spans = glyphs(u, glyphStaggerMs).map((g) => {
          delaysMs.push(g.delayMs);
          pageDelays.push(g.delayMs);
          return `<span class="g" style="animation-delay:${g.delayMs}ms">${escapeHtml(g.text)}</span>`;
        }).join('');
        // A cursor after every unit, each visible only until the next unit takes over. One is lit at
        // any instant, so it reads as a single bar travelling the line — the donor's mechanic. A width
        // or clip-path ramp would also travel (both animate; probes width-keyframes-static and
        // animated-clip-path are REFUTED), but it interpolates LINEARLY, and speech is not linear: it
        // would need a stop per word to follow the real timings, which is what these windows already are.
        const start = u.spans[0].delayMs;
        const cur = cursor
          ? `<span class="cur" style="animation-delay:${start}ms;animation-duration:${Math.max(popMs, handover(u) - start)}ms"></span>`
          : '';
        return `<span class="u">${spans}</span>${cur}`;
      }).join('<span class="sp"> </span>');
      // A block per line. The one construct that cannot be got wrong later.
      return `<div class="cl">${inner}</div>`;
    }).join('');

    const first = pageDelays.length ? Math.min(...pageDelays) : pageStart(page);
    const last = pageDelays.length ? Math.max(...pageDelays) : first;
    const next = pages[i + 1];
    // A page holds until the next one starts speaking; the last holds past its final glyph.
    const until = next ? pageStart(next) : last + popMs + (opts.tailMs ?? 600);
    return `<div class="cap" id="cap${i + 1}" style="animation-delay:${first}ms;animation-duration:${Math.max(popMs, until - first)}ms">${lineHtml}</div>`;
  }).join('');

  const html = pageHtml;

  const css = [
    `.cap{position:absolute;left:${sys.spacing.safeX}px;right:${sys.spacing.safeX}px;bottom:${bottomPx}px;`,
    `opacity:0;animation-name:capPg;animation-fill-mode:forwards;animation-timing-function:linear;`,
    `text-align:center;font-family:${sys.fonts[0]};font-weight:${r.weight};font-size:${r.px}px;`,
    `letter-spacing:${r.trackingEm}em;color:${Object.values(sys.palette)[0]};z-index:2}`,
    `.cl{display:block}`,
    `.u{display:inline-block;white-space:pre}`,
    `.sp{display:inline-block;white-space:pre}`,
    `.g{display:inline-block;opacity:0;animation:capG ${popMs}ms ${sys.motion.easings.standard ?? 'linear'} forwards}`,
    cursor ? `.cur{display:inline-block;width:${Math.round(r.px * 0.08)}px;height:${Math.round(r.px * 0.86)}px;margin-left:${Math.round(r.px * 0.06)}px;vertical-align:text-bottom;background:${Object.values(sys.palette)[1] ?? Object.values(sys.palette)[0]};opacity:0;animation-name:capCur;animation-fill-mode:forwards;animation-timing-function:linear}` : '',
    `@keyframes capG{from{opacity:0}to{opacity:1}}`,
    `@keyframes capPg{0%{opacity:1}99.9%{opacity:1}100%{opacity:0}}`,
    cursor ? `@keyframes capCur{0%{opacity:1}99.9%{opacity:1}100%{opacity:0}}` : '',
  ].filter(Boolean).join('\n');

  return { html, css, delaysMs, lines, pages: pages.length };
}
