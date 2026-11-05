// How much of each graphic laid behind the speaker stays visible.
//
//   openedit behind <page.html> [--fps N|N/D] [--duration <sec>] [--bar 0.75] [--workers N] [--json]
//
// The layering is the CLI's: the stage names the speaker's cut-out (data-cutout), the page fills the footage, behind
// and front layers, and every render draws the cut-out in a layer of its own between behind and front
// (cli/src/render/speaker.ts). What that cannot settle is how much of each graphic the speaker leaves showing, frame
// by frame: this measures it, on the same page as a render, from what Chrome draws. Each frame, the page is stepped on
// the render's clock, the speaker's layer and each graphic are captured alone with alpha, and the share of what the
// graphic paints that the speaker leaves showing is weighed, with each of its words by its own boxes. A check, not a
// render step: it reports over every frame a graphic is on, where a render step would see only its worker's frames,
// and a patch only part of the piece.
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { hdrKind } from '../hdr.ts';
import { codecOf, colourTagsOf, probeFrameRate, videoDurationOf } from '../probe.ts';
import { resolveChrome } from '../render/browser.ts';
import { parseRate } from '../render/footage.ts';
import { BUDGET_MS, EPOCH, openLead, SEED, type SessionBase } from '../render/lead.ts';
import { alphaInputOf, longestGop, MAX_GOP, seekableCopy } from '../render/media.ts';
import { alphaOf } from '../render/png.ts';
import { startPageServer } from '../render/server.ts';
import { DRAW_EVERY_MS, newTimings, type RenderSession } from '../render/session.ts';
import { SPEAKER_BOX } from '../render/speaker.ts';
import { fpsLabel, framesForDuration, frameTime, parseFps, splitContiguous, workersFor, type Fps } from '../render/timing.ts';
import { defaultWorkers, MIN_FRAMES_PER_WORKER, pageRoots, runWorkers } from './render.ts';

// The share of a graphic, and of each of its words, the speaker must leave showing on every frame. Three
// quarters keeps a graphic mostly whole and, covered from one side, hides about one letter of an average word.
export const BAR = 0.75;

// A capture whose strongest pixel is fainter than this (the faint start or end of a fade, or a graphic this faint
// throughout) is not weighed: at so few levels of alpha its parts round apart (a plate to 0 while its text rounds
// to 1), so the share would weigh only some of it. A part of a word with none of the graphic's ink at this
// strength in it (not yet revealed, or clipped away) is not weighed either.
export const FAINTEST = 32;

export const usage = {
  summary: 'How much of each graphic behind the speaker\'s cut-out stays visible, frame by frame',
  positionals: '<page.html>',
  flags: {
    fps: { type: 'string', value: 'N|N/D', help: 'Frame rate to step the page at, as render --fps (default: the cut-out\'s own)' },
    duration: { type: 'string', value: '<sec>', help: 'Length to check, as render --duration (default: to the cut-out\'s end)' },
    'footage-at': { type: 'string', value: '<sec>', help: 'When the footage, and so the cut-out, starts on the page\'s clock, as render --footage-at (default 0)' },
    bar: { type: 'string', value: '<share>', help: `Share of each graphic, and of each word in it, that must stay visible on every frame: above 0, at most 1 (default ${BAR})` },
    json: { type: 'boolean', help: 'Print the report as JSON, shares from 0 to 1 (a refusal too, as {"error": ...})' },
    workers: { type: 'string', value: 'N', help: `Parallel Chrome instances, each checking a contiguous run of frames, as render --workers (default ${defaultWorkers()} here)` },
    root: { type: 'string', multiple: true, value: '<dir>', help: 'Also let the page read files beneath this directory, as render --root does' },
  },
  notes: [
    'The page\'s stage names the speaker\'s cut-out, <div id="stage" data-cutout="cutout.webm">, and holds its content',
    'in three layers it fills: <div data-layer="footage"> (the footage, filling it cover-fit), <div data-layer="behind">',
    '(graphics behind the speaker, each marked data-behind="name") and <div data-layer="front"> (captions, small text).',
    'Every render fills the stage with each layer, stacks them in that order whatever the page\'s z-index, and draws the',
    'cut-out cover-fit over the whole stage in a layer of its own between behind and front, on the page\'s clock from',
    '--footage-at (0 unless given) and hidden before it, past its last frame showing that frame; a transform on the',
    'footage layer moves the speaker\'s layer with it, one on the footage\'s own <video> does not. Each graphic is checked, as drawn, on every',
    'frame it is on screen in: the share of what it paints that the speaker leaves showing, and the share of each',
    'word\'s boxes. It passes when both stay at or above the bar on every one of those frames. A frame where it is',
    'drawn fainter than an eighth of full opacity (the faint start or end of a fade) is not weighed, and neither is a',
    'part of a word with no ink that strong. Exits 1 when a graphic is under the bar, when no graphic could be',
    'measured, or when the check cannot run (it says why).',
  ].join('\n'),
} satisfies Usage;

/** A box on the canvas, in pixels from its top left. */
export interface Box { x: number; y: number; w: number; h: number }
/** A capture of part of the canvas: its alpha, `width` by `height`, placed at x, y. */
export interface Placed { x: number; y: number; width: number; height: number; alpha: Uint8Array }

/** A capture's alpha at a canvas pixel: 0 outside it. */
function at(p: Placed, x: number, y: number): number {
  const ix = x - p.x;
  const iy = y - p.y;
  return ix >= 0 && iy >= 0 && ix < p.width && iy < p.height ? p.alpha[iy * p.width + ix] : 0;
}

/** The share of a capture's ink the speaker leaves showing, each pixel weighed by its alpha; null when nothing is drawn at FAINTEST or stronger. */
export function visibleShare(ink: Placed, speaker: Placed): number | null {
  let all = 0;
  let seen = 0;
  let peak = 0;
  for (let y = 0; y < ink.height; y++) {
    for (let x = 0, p = y * ink.width; x < ink.width; x++, p++) {
      const a = ink.alpha[p];
      if (!a) continue;
      if (a > peak) peak = a;
      all += a;
      seen += a * (255 - at(speaker, ink.x + x, ink.y + y));
    }
  }
  return peak >= FAINTEST ? seen / (all * 255) : null;
}

/** The part of a box on a canvas, in whole pixels grown outward, or null when none of it is. */
function onCanvas(box: Box, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w));
  const y1 = Math.min(height, Math.ceil(box.y + box.h));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * The share of a word's boxes (a word broken over two lines has two, a word of letters set one by one has one a
 * letter) the speaker leaves showing, over their parts on the canvas and, when `ink` is given, only those holding
 * ink at FAINTEST or stronger; null when none count.
 */
export function wordShare(boxes: Box[], speaker: Placed, width: number, height: number, ink?: Placed): number | null {
  let open = 0;
  let area = 0;
  for (const box of boxes) {
    const r = onCanvas(box, width, height);
    if (!r) continue;
    let o = 0;
    let peak = ink ? 0 : 255;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        o += 255 - at(speaker, x, y);
        if (ink && peak < FAINTEST) peak = Math.max(peak, at(ink, x, y));
      }
    }
    if (peak < FAINTEST) continue;
    open += o;
    area += (r.x1 - r.x0) * (r.y1 - r.y0) * 255;
  }
  return area ? open / area : null;
}

/** One measured frame of one graphic: its time, the share of it showing, and the share of each of its words. */
export interface Measure { sec: number; share: number; words: { text: string; share: number }[] }

export interface GraphicReport {
  /** Its data-behind value: every element carrying it is this graphic. */
  name: string;
  /** Its text content, white space collapsed and cut at 60 characters, to tell it apart; hidden text included. */
  text: string;
  /** Frames it was measured on; those between where it is off screen or faint are not counted. */
  measuredFrames: number;
  /** The first and last of them, in seconds. */
  start: number;
  end: number;
  worst: { share: number; sec: number };
  mean: number;
  /** The word least visible on any measured frame, or null when no word of it was measured. */
  leastVisibleWord: { text: string; share: number; sec: number } | null;
  /** The measured frames on which it or one of its words is under the bar, and the first and last of them; null when it passes. */
  under: { frames: number; start: number; end: number } | null;
  pass: boolean;
}

/** Every measured frame of one graphic, summed up against the bar. */
export function summarize(name: string, text: string, measures: Measure[], bar: number): GraphicReport {
  if (!measures.length) throw new Error(`${name} has no measured frame to sum up`);
  let worst = measures[0];
  let word: GraphicReport['leastVisibleWord'] = null;
  let sum = 0;
  const failing: number[] = [];
  for (const m of measures) {
    sum += m.share;
    if (m.share < worst.share) worst = m;
    let low = m.share < bar;
    for (const w of m.words) {
      if (!word || w.share < word.share) word = { text: w.text, share: w.share, sec: m.sec };
      if (w.share < bar) low = true;
    }
    if (low) failing.push(m.sec);
  }
  return {
    name, text, measuredFrames: measures.length, start: measures[0].sec, end: measures.at(-1)!.sec,
    worst: { share: worst.share, sec: worst.sec }, mean: sum / measures.length, leastVisibleWord: word,
    under: failing.length ? { frames: failing.length, start: failing[0], end: failing.at(-1)! } : null,
    pass: failing.length === 0,
  };
}

const pct = (share: number) => `${(100 * share).toFixed(1)}%`;
// Rounded up, so a time copied into render --stills at the same rate lands on the frame it names, not the one before.
const sec = (t: number) => `${(Math.ceil(t * 1000 - 1e-6) / 1000).toFixed(3)} s`;

function describe(r: GraphicReport, bar: number): string {
  const text = r.text ? ` "${r.text}"` : '';
  const w = r.leastVisibleWord;
  const word = w ? `; least visible word "${w.text}" ${pct(w.share)} (${sec(w.sec)})` : '';
  const verdict = r.under
    ? `UNDER ${pct(bar)} on ${r.under.frames} of ${r.measuredFrames} frames, ${sec(r.under.start)} to ${sec(r.under.end)}: move it, or shrink or shift it until it passes`
    : 'passes';
  return `${r.name}${text}: measured on ${r.measuredFrames} frame(s), ${sec(r.start)} to ${sec(r.end)}; visible ${pct(r.worst.share)} at worst `
    + `(${sec(r.worst.sec)}), ${pct(r.mean)} on average${word}. ${verdict}`;
}

/** What the page says of one graphic in a frame: its text, and each word's boxes in canvas pixels. */
interface Look {
  text: string;
  words: { text: string; boxes: Box[] }[];
}

// Installed in the page once it has loaded. A graphic is named by its data-behind value (else its id, else its tag
// and classes), so one a script rebuilds every frame keeps its name, and elements sharing a name are one graphic.
const PAGE_SOURCE = String.raw`(() => {
  if (window.__oeBehind) return;
  const stage = () => document.querySelector('#stage') || document.querySelector('[data-stage]');
  const nameOf = (el) => el.getAttribute('data-behind') || (el.id ? '#' + el.id
    : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => '.' + c).join(''));
  const of = (name) => [...document.querySelectorAll('[data-behind]')].filter((el) => nameOf(el) === name);
  const shown = (n, root) => {
    for (let e = n; e; e = e === root ? null : e.parentElement) if (parseFloat(getComputedStyle(e).opacity) === 0) return false;
    return getComputedStyle(n).visibility === 'visible';
  };
  // Every text node of a graphic, into open shadow roots.
  function textNodes(el) {
    const found = [];
    (function walk(n) {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) found.push(c);
        else if (c.nodeType === 1) { if (c.shadowRoot) walk(c.shadowRoot); walk(c); }
      }
    })(el);
    return el.shadowRoot ? [...found, ...textNodes(el.shadowRoot)] : found;
  }
  // A block boundary ends a word even with no space in the text: a kicker and a title in two divs are two words.
  const blockOf = (n) => { let e = n.parentElement; while (e && /^inline/.test(getComputedStyle(e).display)) e = e.parentElement; return e; };
  function words(el, x, y) {
    const nodes = [];
    let text = '', block = null;
    for (const n of textNodes(el)) {
      const b = blockOf(n);
      if (block && b !== block) text += '\n';
      block = b;
      nodes.push({ n, at: text.length });
      text += n.data;
    }
    const lang = el.closest('[lang]')?.lang || undefined;
    const out = [], range = document.createRange();
    for (const s of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) {
      if (!s.isWordLike) continue;
      const boxes = [], end = s.index + s.segment.length;
      for (const { n, at } of nodes) {
        const a = Math.max(s.index, at), b = Math.min(end, at + n.data.length);
        if (a >= b || !n.parentElement || !shown(n.parentElement, el)) continue;
        range.setStart(n, a - at);
        range.setEnd(n, b - at);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) boxes.push({ x: r.left - x, y: r.top - y, w: r.width, h: r.height });
      }
      if (boxes.length) out.push({ text: s.segment, boxes });
    }
    return out;
  }
  window.__oeBehind = {
    // The opacity the stage and what holds it lay on the whole picture: it fades the speaker and the graphics
    // together, so it is no part of how much the speaker hides.
    shared() { let o = 1; for (let e = stage(); e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; },
    // Each graphic's name, once, in the order the page holds them.
    names: () => [...new Set([...document.querySelectorAll('[data-behind]')].filter((el) => stage()?.contains(el)).map(nameOf))],
    dark: (name) => of(name).every((el) => {
      for (let n = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) === 0) return true;
      return false;
    }),
    mark(name) {
      for (const el of document.querySelectorAll('[data-oe-behind]')) el.removeAttribute('data-oe-behind');
      for (const el of of(name)) el.setAttribute('data-oe-behind', '');
    },
    look(name, x, y) {
      const els = of(name);
      return {
        text: els.map((el) => el.textContent || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 60),
        words: els.flatMap((el) => words(el, x, y)),
      };
    },
  };
})()`;

export interface BehindReport {
  page: string;
  /** The cut-out the page's stage names, which the speaker's layer draws. */
  cutout: string;
  bar: number;
  fps: number;
  /** The rate the page was stepped at, e.g. 30000/1001: the one to render at (--fps). */
  frameRate: string;
  width: number;
  height: number;
  /** Frames of the page checked: --duration's, else to the cut-out's end. */
  checkedFrames: number;
  graphics: GraphicReport[];
  /** Graphics found on the page that were not drawn at FAINTEST or stronger in any frame checked. */
  unseen: string[];
  /** Files the page could not load or play: the graphics were measured without them. */
  failedLoads: string[];
  /** Draws forced on steps that ran past DRAW_EVERY_MS: a frame's own, and a preroll's through the frames before it. */
  forcedDraws: { frames: number; prerolls: number };
  /** Every graphic measured passed, and at least one was measured. */
  pass: boolean;
}

/** The layers a session draws one at a time: the graphic being measured, and the speaker. */
const GRAPHIC = 0;
const SPEAKER = 1;

export async function checkBehind(pageArg: string, o: { bar: number; fps?: Fps; duration?: number; footageAt?: number; roots?: string[]; workers?: number }): Promise<BehindReport> {
  if (!(o.bar > 0 && o.bar <= 1)) throw new Error(`the bar is a share above 0 and at most 1, not ${o.bar}`);
  const page = resolve(pageArg);
  if (!existsSync(page) || !statSync(page).isFile()) throw new Error(`${pageArg} is not a file`);
  const { roots, notes } = pageRoots(page, o.roots ?? []);
  for (const line of notes) console.error(`behind: ${line}`);
  const chrome = await resolveChrome(undefined, (line) => console.error(line));
  const server = await startPageServer({ roots });
  const failedLoads = new Set<string>();
  const refused = new Set<string>();
  const timings = newTimings();
  const givenZone = {};
  // On a frame, as render lays the footage from --footage-at.
  const footageAt = (fps: Fps) => frameTime(framesForDuration(o.footageAt ?? 0, fps), fps);
  const base = (fps: Fps): SessionBase => ({
    chrome, server, page, transparent: true, capture: 'png', footage: null, layers: ['[data-oe-behind]', SPEAKER_BOX], fps, seed: SEED,
    // Only the speaker and the graphics are drawn, so no other video of the page need be decoded; the cut-out is not
    // the page's, and stays.
    videosIn: '[data-behind]',
    cutout: { at: footageAt(fps), until: null },
    epoch: EPOCH, budgetMs: BUDGET_MS, failedLoads, refused, timings, givenZone,
  });
  let session: RenderSession | null = null;
  try {
    let fps = o.fps ?? { num: 30, den: 1 };
    let opened = await openLead(base(fps));
    session = opened.lead;
    const named = session.info.cutout;
    if (!session.info.stage) throw new Error(`${basename(page)} has no stage (#stage or [data-stage]) to lay the speaker over`);
    if (!named) throw new Error(`${basename(page)}'s stage names no cut-out: give it data-cutout="<file>", the background-removed clip`);
    const cutout = server.fileFor(named.url);
    if (!cutout || !existsSync(cutout)) throw new Error(`the stage's cut-out ${cutout ?? named.url} is not there`);
    const input = alphaInputOf(cutout);
    if (!input && codecOf(cutout) === 'hevc') {
      throw new Error(`${basename(cutout)} is HEVC, whose alpha Chrome cannot draw here, so a render could not lay the speaker over the graphics: convert it to VP9 WebM or ProRes 4444`);
    }
    if (!input) throw new Error(`${basename(cutout)} has no alpha channel, so it cannot say where the speaker is: data-cutout takes the cut-out, background-removal's output`);
    // A render converts an HDR video to SDR in its copy, which keeps no alpha: the cut-out would cover every graphic.
    if (hdrKind(colourTagsOf(cutout))) throw new Error(`${basename(cutout)} is HDR, and a render draws an HDR video without its alpha: cut the speaker out with background-removal, which sends an HDR clip's SDR copy`);
    // Stepped at the cut-out's own rate unless told otherwise, opened again when that is not the rate guessed.
    const own = parseRate(probeFrameRate(cutout).rate);
    if (!o.fps && (own.num !== fps.num || own.den !== fps.den)) {
      await session.close();
      session = null;
      fps = own;
      opened = await openLead(base(fps));
      session = opened.lead;
    }
    // Served as a render serves it, from the same cache: from an all-intra copy when its keyframes are far apart, or
    // when Chrome cannot play its alpha as it is.
    if (!input.webm || longestGop(cutout) > MAX_GOP) {
      server.substitute(cutout, (await seekableCopy(cutout)).path);
      await session.reload();
    }
    if (!session.info.cutout?.playable) throw new Error(`the speaker layer's cut-out ${basename(cutout)} could not be played, so a render would not lay it over the graphics`);
    const { width, height, clip } = opened.canvas;
    const origin = { x: clip?.x ?? 0, y: clip?.y ?? 0 };
    const total = framesForDuration(o.duration ?? footageAt(fps) + videoDurationOf(cutout), fps);
    if (total < 1) throw new Error(`--duration ${o.duration} holds no frame at ${fpsLabel(fps)} fps`);

    /** Measures `frames`, a contiguous run, on its own session: what each graphic showed, and every name listed. */
    const measureRun = async (s: RenderSession, frames: number[], stop: () => boolean) => {
      const measures = new Map<string, { text: string; list: Measure[] }>();
      const found = new Set<string>();
      let shared = 1;
      // Of the whole canvas, the session's own clip, as a full-size render captures: a capture of any other area would
      // change what the page reads as its screen for the rest of the session.
      const shoot = async (layer: number, what: string): Promise<Placed> => {
        await s.showLayer(layer);
        let shot = alphaOf(await s.shoot(what, 'png'));
        // A video shown again by a layer switch can be shot before its picture is drawn again; such a shot comes out empty.
        for (let retry = 0; layer === SPEAKER && retry < 2 && !shot.alpha.some(Boolean); retry++) {
          await new Promise((r) => setTimeout(r, 40));
          shot = alphaOf(await s.shoot(what, 'png'));
        }
        if (shot.width !== width || shot.height !== height) throw new Error(`${what} was captured at ${shot.width}x${shot.height}, not ${width}x${height}`);
        if (shared < 1 && shared > 0) for (let p = 0; p < shot.alpha.length; p++) shot.alpha[p] = Math.min(255, Math.round(shot.alpha[p] / shared));
        return { x: 0, y: 0, width, height, alpha: shot.alpha };
      };
      await s.evaluate(PAGE_SOURCE, 'installing the graphics\' helper');
      for (const i of frames) {
        if (stop()) break;
        await s.showLayer(-1);
        await s.seek(i);
        const names = await s.evaluate<string[]>('window.__oeBehind.names()', `frame ${i}: listing the graphics`);
        const on: { name: string; look: Look }[] = [];
        for (const name of names) {
          found.add(name);
          // Only an opacity of 0 on a graphic or an ancestor rules its paint out for certain; its boxes say nothing sure
          // of where it paints (shadows, filters, a shadow root's content), so the capture decides.
          if (await s.evaluate<boolean>(`window.__oeBehind.dark(${JSON.stringify(name)})`, `frame ${i}: ${name}`)) continue;
          const look = await s.evaluate<Look>(`window.__oeBehind.look(${JSON.stringify(name)}, ${origin.x}, ${origin.y})`, `frame ${i}: ${name}`);
          on.push({ name, look });
        }
        if (!on.length) continue;
        shared = await s.evaluate<number>('window.__oeBehind.shared()', `frame ${i}: the stage's opacity`);
        // The speaker first, while its picture is the one just drawn.
        const speaker = await shoot(SPEAKER, `frame ${i}: the speaker`);
        // Each graphic is captured and weighed wherever it paints: no estimate of where that is decides it for it.
        for (const { name, look } of on) {
          const said = `frame ${i}: ${name}`;
          await s.evaluate(`window.__oeBehind.mark(${JSON.stringify(name)})`, said);
          await s.visibleLayers();
          const ink = await shoot(GRAPHIC, `${said} alone`);
          const share = visibleShare(ink, speaker);
          if (share === null) continue;
          const words = look.words.flatMap((w) => {
            const ws = wordShare(w.boxes, speaker, width, height, ink);
            return ws === null ? [] : [{ text: w.text, share: ws }];
          });
          let entry = measures.get(name);
          if (!entry) measures.set(name, entry = { text: look.text, list: [] });
          entry.list.push({ sec: frameTime(i, fps), share, words });
        }
      }
      return { measures, found };
    };

    // Run on workers as a render is, each over a contiguous run of frames; merged in frame order.
    const runs = splitContiguous(Array.from({ length: total }, (_, i) => i), workersFor(total, o.workers ?? defaultWorkers(), MIN_FRAMES_PER_WORKER));
    const results: Awaited<ReturnType<typeof measureRun>>[] = [];
    const lead = session;
    session = null;
    await runWorkers(base(fps), opened.canvas, lead, {
      groups: runs.map((_, k) => [k]),
      run: async (s, k, stop) => { results[k] = await measureRun(s, runs[k], stop); },
    });
    const measures = new Map<string, { text: string; list: Measure[] }>();
    const found = new Set<string>();
    for (const r of results) {
      for (const name of r.found) found.add(name);
      for (const [name, m] of r.measures) {
        const entry = measures.get(name);
        if (entry) entry.list.push(...m.list);
        else measures.set(name, { text: m.text, list: [...m.list] });
      }
    }
    if (!found.size) throw new Error(`no element on ${basename(page)}'s stage is marked data-behind in any frame checked: mark each graphic that goes behind the speaker`);
    const graphics = [...measures].map(([name, m]) => summarize(name, m.text, m.list, o.bar));
    return {
      page, cutout, bar: o.bar, fps: fps.num / fps.den, frameRate: fpsLabel(fps), width, height, checkedFrames: total, graphics,
      unseen: [...found].filter((n) => !measures.has(n)),
      failedLoads: [...failedLoads].sort(),
      forcedDraws: { frames: timings.draw.n, prerolls: timings.prerollDraw.n },
      pass: graphics.length > 0 && graphics.every((g) => g.pass),
    };
  } finally {
    await session?.close();
    await server.close();
  }
}

export async function behind(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('behind', usage, argv);
  const [page] = positionals;
  if (!page || positionals.length > 1) {
    console.error(usageLine('behind', usage));
    return 2;
  }
  const started = Date.now();
  let report: BehindReport;
  try {
    const bar = numberFlag('bar', values.bar, BAR, (n) => n > 0 && n <= 1, 'a share above 0 and at most 1');
    const duration = values.duration === undefined ? undefined : numberFlag('duration', values.duration, 1, (n) => n > 0, 'seconds above 0');
    const fps = values.fps === undefined ? undefined : parseFps(values.fps);
    const footageAt = values['footage-at'] === undefined ? undefined : numberFlag('footage-at', values['footage-at'], 1, (n) => Number.isFinite(n) && n >= 0, 'seconds');
    const workers = numberFlag('workers', values.workers, defaultWorkers(), (n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more');
    report = await checkBehind(page, { bar, fps, duration, footageAt, roots: values.root, workers });
  } catch (e) {
    if (!values.json) throw e;
    console.log(JSON.stringify({ error: (e as Error).message }, null, 2));
    return 1;
  }
  if (report.failedLoads.length) {
    console.error(`behind: warning: ${report.failedLoads.length} resource(s) failed to load or play; the graphics were measured without them:`);
    for (const line of report.failedLoads) console.error(`  ${line}`);
  }
  for (const name of report.unseen) {
    console.error(`behind: warning: ${name} is not drawn (or only fainter than an eighth of full opacity) in any frame checked, so it was not checked`);
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.pass ? 0 : 1;
  }
  console.log(`behind: ${report.graphics.length} graphic(s) measured behind the speaker on ${basename(report.page)}, under ${basename(report.cutout)} `
    + `(${report.checkedFrames} frames at ${report.frameRate} fps, ${report.width}x${report.height}); the bar is ${pct(report.bar)} of each graphic and of each word, on every frame`);
  for (const g of report.graphics) console.log(`  ${describe(g, report.bar)}`);
  if (!report.graphics.length) console.log('  no graphic was drawn in any frame checked, so none was measured');
  const { frames, prerolls } = report.forcedDraws;
  const forced = frames + prerolls ? `; draws forced on steps slower than ${DRAW_EVERY_MS / 1000} s: ${frames} on frames, ${prerolls} on prerolls` : '';
  console.log(`  took ${((Date.now() - started) / 1000).toFixed(1)} s${forced}`);
  return report.pass ? 0 : 1;
}
