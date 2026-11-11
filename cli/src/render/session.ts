// One worker: a headless Chrome with the page loaded under the virtual clock, advanced and captured one
// frame at a time. Everything that can go wrong in the page is turned into a named error here, so the
// command above only has to decide what to do with it.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, CDPSession, Page, Request } from 'playwright-core';
import { browserProxy } from '../proxy.ts';
import { CHROME_FLAGS, linuxHint } from './browser.ts';
import { givenZone, minText, stylesheet, type Zone } from '../commands/safe-zone.ts';
import { track } from './children.ts';
import { DRAWN_LARGER, runtimeScript, type FrameReport, type RaisedText, type ReadyInfo, type RuntimeConfig, type StageZone } from './page-runtime.ts';
import { SPEAKER_BOX } from './speaker.ts';
import { TEXT_SAMPLER_SCRIPT, type SampledFrame } from './text-sampler.ts';
import { onDisk, type PageServer } from './server.ts';
import { frameTime, type Fps } from './timing.ts';

/**
 * Where a render's time goes, summed over every worker, so a slow render says which of its stages is
 * slow. Each stage is a pure wait from this process's side: the page's own work for a frame (`page`), the replay of
 * the frames before a worker's first (`preroll`), the page's own loads (`loads`), the screenshot
 * (`capture`), the reading of a sampled frame's text for the record (`text`), the launch of Chrome and the page's
 * load and readiness; `encode` is the time a worker was held back by ffmpeg, and `scan` the look at the joined output.
 * `draw` and `prerollDraw` count the draws forced on a stalled step, inside `page` and `preroll`; a preroll steps
 * through many frames at once, so it draws on its way without having stalled. `probe` is the check of a
 * data-stateless mark, and `check` a patch's look at the segments it would reuse, whatever stages each went through.
 */
const STAGES = ['launch', 'load', 'preroll', 'page', 'loads', 'capture', 'text', 'encode', 'copy', 'join', 'scan', 'draw', 'prerollDraw', 'probe', 'check'] as const;
export type Stage = (typeof STAGES)[number];
export type Timings = Record<Stage, { ms: number; n: number }>;

export const newTimings = (): Timings => Object.fromEntries(STAGES.map((s) => [s, { ms: 0, n: 0 }])) as Timings;

/**
 * What a frame leaves Chrome as. A PNG is the exact picture; a JPEG (quality 100, 4:2:0 chroma) is
 * about half the capture time on a busy frame and cannot carry alpha.
 */
export const CAPTURES = ['png', 'jpeg'] as const;
export type Capture = (typeof CAPTURES)[number];

/** Runs `work` and adds its wall time to `stage`, counting `n` units of it. */
export async function timed<T>(t: Timings | undefined, stage: Stage, work: () => Promise<T>, n = 1): Promise<T> {
  if (!t) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    t[stage].ms += performance.now() - started;
    t[stage].n += n;
  }
}

export interface SessionOptions {
  chrome: string;
  server: PageServer;
  page: string;
  /** Shared by every session of a render; absent, nothing is timed. */
  timings?: Timings;
  viewport: { width: number; height: number };
  /** The canvas, once it is settled; before, it is the stage's size, or the viewport's on a page without a stage. */
  canvas?: { width: number; height: number };
  /** Capture this box instead of the whole viewport. */
  clip?: { x: number; y: number; width: number; height: number } | null;
  /** What `capture` returns each frame as (default png). */
  capture?: Capture;
  /** A JPEG capture's quality, 1-100 (default 100). */
  quality?: number;
  /**
   * The size frames are drawn at, as a fraction of the canvas (default 1). Chrome rasterises the page at
   * that size, so a smaller one costs less to draw and capture; the layout is the page's own.
   */
  scale?: number;
  transparent: boolean;
  /**
   * A file ffmpeg lays under the frames: every <video> whose source is this file is stood down before
   * the first frame, so Chrome neither decodes nor seeks it, and however its load went it is not held against the page.
   */
  footage?: string | null;
  /**
   * When set, every <video> outside the elements this selector matches is stood down before the first frame, as
   * footage is: for a check that draws only part of the page.
   */
  videosIn?: string | null;
  /** Where the speaker layer's cut-out shows on the page's clock (see RuntimeConfig); from time 0 to the end by default. */
  cutout?: RuntimeConfig['cutout'];
  /** URLs served from a copy smaller than the source: a frame that draws one larger fails with DrawnLarger. */
  shrunk?: string[];
  /** Selectors that `showLayer(k)` switches between, each drawn alone in place; one page pass serves them all. */
  layers?: string[] | null;
  fps: Fps;
  seed: number;
  epoch: number;
  /** How long any single wait inside the page may take before the render fails. */
  budgetMs: number;
  /** How long Chrome may take to start (default LAUNCH_MS); twice that to start and open a page. */
  launchMs?: number;
  /**
   * Step through every frame before the one asked for even on a page marked data-stateless: the mark was found not
   * to hold (checkStateless in commands/render.ts).
   */
  stepAlways?: boolean;
  /**
   * Where failed loads are collected. One set shared by every session of a render lets the command
   * print them on every exit, a failure included, since a missing script is often what failed it.
   */
  failedLoads: Set<string>;
  /**
   * Files the page needs that the page server refused, each with the --root that would admit it, or the
   * folder render does not serve that it sits in.
   * Shared like failedLoads; any one fails the render, since the refusal is certain and has a remedy.
   */
  refused: Set<string>;
  /** Leaves text under the size floor at the size the page gives it, rather than raising it to the floor. */
  noTextFloor?: boolean;
  /** Where the text raised to the floor is gathered, by element; shared like failedLoads. */
  raised?: Map<string, RaisedText>;
  /**
   * The zone the first session gave a page that links none, for the sessions opened after it to put in from their
   * first load; shared like failedLoads.
   */
  givenZone?: { zone?: Zone };
}

/** The script that puts the zone in a page as it parses, before the page's own scripts run. */
const giveZone = (zone: Zone): string => `window.__openedit.zone(${JSON.stringify(zone.format.shape)}, ${JSON.stringify(stylesheet(zone))});`;

// How often Chrome is made to draw while a page step lasts: far above a healthy frame, far below its budget. A
// preroll spans many frames, so it may draw on its way.
export const DRAW_EVERY_MS = 1000;

// How long Chrome may take to start, as long as any wait inside the page (BUDGET_MS): over ten times the slowest
// launch measured, so only a Chrome that will not start reaches it.
export const LAUNCH_MS = 60_000;

/** What to try when Chrome or the page stops answering: the usual cause is a machine with no CPU or memory to spare. */
const STARVED = 'the machine may be short of CPU or memory: try again with fewer --workers, or once other renders have finished';

// The page's own requests, which receive their 403 and can carry on without the file. Anything else
// refused (a frame's document, a text track, an image) is drawn without it and fails the render.
const PAGE_HANDLED = new Set(['fetch', 'xhr']);

const firstLines = (text: string, n = 6): string => text.split('\n').filter(Boolean).slice(0, n).join('\n  ');

/**
 * Layers of one page, switched by window.__oeLayer(k): everything outside layer k is hidden and the rest keeps the
 * visibility the page gives it, so the layer draws exactly its part of the whole picture. A switch finishes the
 * visibility transitions it starts, since on the virtual clock one would hold a hidden element visible.
 */
export function layersScript(selectors: string[]): string {
  // A layer's root is shown only when the page shows it: __oeVisible marks the ones that are, every frame.
  const css = selectors.map((sel, k) => `html[data-oe-layer="${k}"] *:not(:is(${sel})):not(:is(${sel}) *){visibility:hidden!important}html[data-oe-layer="${k}"] :is(${sel})[data-oe-shown]{visibility:visible}`).join('')
    + 'html[data-oe-layer],html[data-oe-layer] body{background:transparent!important}'
    + 'html[data-oe-layer] [data-oe-blend]{visibility:hidden!important}';
  // Whether an element could paint this frame. It errs toward yes: a margin for shadows and glows past the box, and
  // pseudo-element content, which has no box of its own to measure; a wrong yes costs one capture of an empty frame.
  const paints = `(el)=>{for(let n=el;n&&n.nodeType===1;n=n.parentElement){if(parseFloat(getComputedStyle(n).opacity)===0)return false}`
    + `const all=[el,...el.querySelectorAll('*')];if(!all.some((n)=>getComputedStyle(n).visibility==='visible'))return false;`
    + `const M=256,inView=(r)=>r.width>0&&r.height>0&&r.right>-M&&r.bottom>-M&&r.left<innerWidth+M&&r.top<innerHeight+M;`
    + `const pseudo=(n)=>(n.getClientRects().length||getComputedStyle(n).display==='contents')&&['::before','::after'].some((p)=>!['none','normal'].includes(getComputedStyle(n,p).content));`
    + `return all.some((n)=>inView(n.getBoundingClientRect()))||all.some(pseudo)}`;
  const each = (body: string) => `${JSON.stringify(selectors)}.map((sel)=>[...document.querySelectorAll(sel)]${body})`;
  return `document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.append(s)});`
    + "window.__oeLayer=(k)=>{if(k<0)delete document.documentElement.dataset.oeLayer;else document.documentElement.dataset.oeLayer=String(k);getComputedStyle(document.documentElement).visibility;"
    + "for(const a of document.getAnimations())if(a.transitionProperty==='visibility')a.finish()};"
    + `window.__oeVisible=()=>{delete document.documentElement.dataset.oeLayer;const paints=${paints};`
    + `for(const e of document.querySelectorAll(${JSON.stringify(selectors.join(','))}))e.toggleAttribute('data-oe-shown',getComputedStyle(e).visibility==='visible');`
    + `return {visible:${each('.some(paints)')},matches:${each('.length')}}};`
    + `window.__oeHasVideo=()=>${each(".some((e)=>e.matches('video')||!!e.querySelector('video'))")};`
    // An element blended into what lies under it (mix-blend-mode) has no picture of its own to cut out: drawn as a
    // layer it would lie on the others as a plain veil. It is left out of every layer and named.
    + "window.__oeBlended=()=>[...document.querySelectorAll('body *')].filter((e)=>getComputedStyle(e).mixBlendMode!=='normal').map((e)=>{e.dataset.oeBlend='';return (e.id?'#'+e.id:e.tagName.toLowerCase())+': '+getComputedStyle(e).mixBlendMode});";
}

/**
 * What Chrome prints when its sandbox cannot start: macOS inside another Seatbelt profile, Linux as root
 * (the usual container), and Linux without the user namespaces it builds on.
 */
const SANDBOX_REFUSED = /^.*(sandbox initialization failed|Running as root without --no-sandbox is not supported|No usable sandbox).*$/im;
/** Only this refusal proves an outer sandbox, one that then confines the page in Chrome's place. */
const NESTED_SEATBELT = /sandbox initialization failed/i;

/** Whether Chrome's own sandbox starts where this process runs, asked once and shared by every worker. */
const sandboxState: { starts?: Promise<boolean> } = {};

/**
 * Runs `launch` with Chrome's sandbox, since the page may load anything and the browser is pinned rather
 * than kept patched, or without it where Chrome refuses it. Chrome is asked on its own first, since a
 * renderer that dies under the driver can crash this whole process.
 */
export async function withSandbox<T>(launch: (sandbox: boolean) => Promise<T>, o: {
  /** Chrome's own words when its sandbox cannot start here, else null. */
  refused: () => Promise<string | null>;
  say: (line: string) => void;
  platform?: NodeJS.Platform;
  state?: { starts?: Promise<boolean> };
}): Promise<T> {
  const state = o.state ?? sandboxState;
  if (!state.starts) {
    const reason = o.refused().catch(() => null);
    state.starts = reason.then((r) => r === null);
    const why = await reason;
    if (why !== null) {
      o.say((o.platform ?? process.platform) === 'darwin' && NESTED_SEATBELT.test(why)
        ? 'Chrome\'s own sandbox cannot start inside the sandbox this command runs in; running Chrome without it, confined by the outer one'
        : `Chrome's own sandbox cannot start here (${why}); running Chrome without it, so nothing confines the page`);
    }
  }
  return launch(await state.starts);
}

/** Chrome started on its own, headless, on a blank page: whether it got there, and what it printed. */
function blankPage(chrome: string, sandbox: boolean, timeoutMs: number): Promise<{ ok: boolean; err: string; timedOut: boolean }> {
  const profile = mkdtempSync(join(tmpdir(), 'openedit-chrome-'));
  const args = ['--headless', `--user-data-dir=${profile}`, ...(sandbox ? [] : ['--no-sandbox']), '--dump-dom', 'about:blank'];
  return new Promise<{ ok: boolean; err: string; timedOut: boolean }>((done) => {
    const child = track(spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    let out = '';
    let err = '';
    const finish = (timedOut: boolean) => {
      clearTimeout(timer);
      child.kill();
      done({ ok: /<html/i.test(out), err, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
      // Stops only once the refusal's line is whole, so the reason passed on is never cut short.
      const m = SANDBOX_REFUSED.exec(err);
      if (m && err.length > m.index + m[0].length) finish(false);
    });
    child.on('error', () => finish(false));
    child.on('close', () => finish(false));
  }).finally(() => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A profile Chrome is still writing as it exits is left to the system's temp cleanup.
    }
  });
}

/**
 * Chrome's own words when its sandbox cannot start here, else null; asked outside the driver, which does
 * not pass Chrome's error output on. An unlisted failure counts only if it repeats and Chrome starts without
 * the sandbox, so a one-off crash never turns the sandbox off and a Chrome broken either way keeps it.
 */
export async function sandboxRefused(chrome: string, timeoutMs = 20_000): Promise<string | null> {
  let on = await blankPage(chrome, true, timeoutMs);
  for (let attempt = 0; ; attempt++) {
    const known = SANDBOX_REFUSED.exec(on.err);
    if (known) return tidy(known[0]);
    if (on.ok || on.timedOut) return null;
    if (attempt === 1) break;
    on = await blankPage(chrome, true, timeoutMs);
  }
  const off = await blankPage(chrome, false, timeoutMs);
  if (!off.ok) return null;
  const said = on.err.split('\n').find((l) => /sandbox/i.test(l)) ?? on.err.split('\n').find((l) => /ERROR|FATAL/.test(l));
  return said ? tidy(said) : 'it would not start with it, and starts without it';
}

const tidy = (line: string): string => line.replace(/^\[[^\]]*\]\s*/, '').trim();

/**
 * The proxy option Chrome is launched with, the server and its bypass list alone. The driver sends
 * loopback through a proxy unless the bypass list names it, and the page itself is served on loopback.
 */
export function launchProxy(env: NodeJS.ProcessEnv = process.env): { server: string; bypass: string } | undefined {
  const proxy = browserProxy(env);
  return proxy && { server: proxy.server, bypass: [proxy.bypass, '127.0.0.1'].filter(Boolean).join(',') };
}

/**
 * Every wait inside the page has its own budget; this is the backstop for a call that never answers
 * at all (a wedged renderer), so a render fails by name instead of hanging.
 */
function deadline<T>(work: Promise<T>, ms: number, what: string, hint?: string): Promise<T> {
  return bounded(work, ms, `${what} did not answer within ${Math.round(ms / 1000)} s${hint ? `: ${hint}` : ''}`);
}

/** `work`, or a failure with `message` once `ms` have passed without it settling. */
function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Waits for `work` while calling `draw` every `everyMs` it lasts, since a fresh page can sit undrawn and a video's
 * sought picture is presented only in a drawn frame. A draw in flight is awaited after `work` succeeds, up to
 * `budgetMs`, as it would overlap the frame's own capture, and one that failed is dropped (the frame's own capture
 * must succeed anyway); after `work` fails nothing is captured, so it is thrown at once, naming a draw that failed.
 */
export async function drawWhile<T>(work: Promise<T>, draw: () => Promise<unknown>, everyMs: number, budgetMs: number): Promise<T> {
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const last: { failure: Error | null } = { failure: null };
  const loop = (async () => {
    while (!done) {
      await new Promise<void>((r) => { wake = r; timer = setTimeout(r, everyMs); });
      if (done) break;
      try {
        await draw();
      } catch (e) {
        last.failure = e instanceof Error ? e : new Error(String(e));
      }
    }
  })();
  const stop = () => {
    done = true;
    clearTimeout(timer);
    wake?.();
  };
  let result: T;
  try {
    result = await work;
  } catch (e) {
    stop();
    // On the first line, the one part of a message a failed frame is sure to report.
    if (last.failure && e instanceof Error) e.message = e.message.replace(/^[^\n]*/, (line) => `${line}; forcing Chrome to draw failed too: ${firstLines(last.failure!.message, 1)}`);
    throw e;
  }
  stop();
  await deadline(loop, budgetMs, 'a draw forced on a stalled step');
  return result;
}

/** A frame drew a video larger than the smaller copy it is served from, so the copy cannot show it. */
export class DrawnLarger extends Error {}

/** A box captured at `scale`: each side rounded to the nearest pixel, as Chrome sizes a scaled capture. */
export const drawnSize = (c: { width: number; height: number }, scale: number): { width: number; height: number } =>
  ({ width: Math.round(c.width * scale), height: Math.round(c.height * scale) });

/** A PNG's or a JPEG's size, from its header; null when it is neither. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // A JPEG's size is in its start-of-frame segment: any SOFn but DHT (C4), JPG (C8) and DAC (CC).
  for (let i = 2; i + 9 <= b.length && b[i] === 0xff;) {
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

export class RenderSession {
  info!: ReadyInfo;
  /** The zone given to a page that links none of its own, on its stage; null when the page brings its own or has no stage of a zone's shape. */
  zone: Zone | null = null;
  /** The size text is raised to, in CSS px; 0 when it is left as the page sizes it. */
  floor = 0;
  private error: Error | null = null;
  /** The page has been advanced through every frame below this one, or jumped past them when it is stateless. */
  private next = 0;
  private inflight = new Set<Request>();
  private idleWaiters: (() => void)[] = [];
  /** URLs whose load failed, each already listed by its own failed-load line. */
  private failedUrls = new Set<string>();
  /** Set once the page's data-stateless mark was found not to hold. */
  private stepping = false;
  /** Set once peek() jumped past frames a page without a holding mark must be stepped through; reload() clears it. */
  private peeked = false;

  private clip: SessionOptions['clip'];
  private readonly footage: string | null;
  private shrunk: string[];
  /** The speaker layer's cut-out as the debugging protocol knows it, found by its key; null until looked for. */
  private cutout: number | null = null;

  private constructor(private readonly o: SessionOptions, private readonly browser: Browser, private readonly pw: Page, private readonly cdp: CDPSession,
    private readonly speakerKey: string) {
    this.clip = o.clip ?? null;
    this.footage = o.footage ? onDisk(o.footage) : null;
    this.shrunk = o.shrunk ?? [];
  }

  /** The URLs served from smaller copies, from the page's next load on. */
  serveShrunk(urls: string[]): void {
    this.shrunk = urls;
  }

  get timings(): Timings | undefined {
    return this.o.timings;
  }

  /** Captures this box of the viewport from now on: the page has to load before its stage can be measured. */
  setClip(clip: SessionOptions['clip']): void {
    this.clip = clip ?? null;
  }

  static async open(o: SessionOptions): Promise<RenderSession> {
    const { chromium } = await import('playwright-core');
    const proxy = launchProxy();
    const speakerKey = randomBytes(12).toString('hex');
    const launchMs = o.launchMs ?? LAUNCH_MS;
    const { browser, context, page } = await timed(o.timings, 'launch', () => withSandbox(async (sandbox) => {
      const started = (async () => {
        let browser: Browser;
        try {
          browser = await chromium.launch({
            executablePath: o.chrome, args: CHROME_FLAGS, headless: true, timeout: launchMs, chromiumSandbox: sandbox, proxy,
          });
        } catch (e) {
          if ((e as Error).name === 'TimeoutError') throw new Error(`Chrome did not start within ${launchMs / 1000} s (${o.chrome}): ${STARVED}`);
          throw new Error(`Chrome failed to launch (${o.chrome}):\n  ${firstLines((e as Error).message)}${linuxHint()}`);
        }
        try {
          const context = await browser.newContext({ viewport: o.viewport, deviceScaleFactor: 1 });
          await context.addInitScript(runtimeScript({ seed: o.seed, epoch: o.epoch, num: o.fps.num, den: o.fps.den, captureScale: o.scale ?? 1, speakerKey, cutout: o.cutout ?? { at: 0, until: null } }));
          await context.addInitScript(TEXT_SAMPLER_SCRIPT);
          if (o.layers?.length) await context.addInitScript(layersScript(o.layers));
          if (o.givenZone?.zone) await context.addInitScript(giveZone(o.givenZone.zone));
          return { browser, context, page: await context.newPage() };
        } catch (e) {
          await browser.close().catch(() => {});
          throw new Error(`Chrome could not open a page (${o.chrome}): ${firstLines((e as Error).message, 2)}`);
        }
      })();
      // A Chrome that starts after the render gave up on it is closed, so nothing it started outlives the render.
      // Past the launch's own timeout, so a launch that times out is reported as that.
      return bounded(started, 2 * launchMs, `Chrome did not start and open a page within ${(2 * launchMs) / 1000} s (${o.chrome}): ${STARVED}`)
        .catch((e) => {
          started.then((late) => late.browser.close(), () => {}).catch(() => {});
          throw e;
        });
    }, { refused: () => sandboxRefused(o.chrome), say: (line) => console.error(`render: ${line}`) }));
    try {
      const cdp = await deadline(context.newCDPSession(page), launchMs, 'Chrome\'s debugging session', STARVED);
      const s = new RenderSession(o, browser, page, cdp, speakerKey);
      s.watch();
      await timed(o.timings, 'load', () => s.load());
      return s;
    } catch (e) {
      await deadline(browser.close(), 15_000, 'closing Chrome').catch(() => {});
      throw e;
    }
  }

  private name(url: string): string {
    return this.o.server.fileFor(url) ?? url;
  }

  /** Whether a URL the page asked for is the footage, by the file it names. */
  private isFootage(url: string): boolean {
    if (!this.footage) return false;
    const file = this.o.server.fileFor(url);
    return file !== null && onDisk(file) === this.footage;
  }

  /** Stands down every <video> whose source is the footage, judged by the file each URL names. */
  private async standDown(): Promise<void> {
    const sources = await this.pw.evaluate('window.__openedit.videoSources()') as string[][];
    const flags = sources.map((urls) => urls.some((u) => this.isFootage(u)));
    if (flags.some(Boolean)) await this.pw.evaluate(`window.__openedit.standDown(${JSON.stringify(flags)})`);
  }

  private watch(): void {
    const page = this.pw;
    page.on('pageerror', (err) => {
      this.error ??= err;
    });
    page.on('crash', () => {
      this.error ??= new Error('the page crashed (Chrome ran out of memory, or hit a renderer bug)');
    });
    // Media streams in ranged reads that never go idle while a video is on the page; everything else
    // a frame asks for (a background image, a fetch) is waited for before it is captured.
    const settle = (req: Request) => {
      if (!this.inflight.delete(req) || this.inflight.size) return;
      for (const w of this.idleWaiters.splice(0)) w();
    };
    page.on('request', (req) => {
      // A redirect finishes its first hop by starting the next one.
      const from = req.redirectedFrom();
      if (req.resourceType() !== 'media') this.inflight.add(req);
      if (from) settle(from);
    });
    page.on('requestfinished', settle);
    // A <video> of the footage is stood down whatever the server answered its load with, so neither a
    // refusal of the file nor a failed load of it is held against the page.
    page.on('requestfailed', (req) => {
      settle(req);
      if (this.isFootage(req.url())) return;
      this.failedUrls.add(req.url());
      const why = req.failure()?.errorText ?? 'failed';
      if (!/ERR_ABORTED/.test(why) || req.resourceType() !== 'media') this.o.failedLoads.add(`${why}  ${this.name(req.url())}`);
    });
    page.on('response', (res) => {
      if (res.status() < 400 || this.isFootage(res.url())) return;
      this.failedUrls.add(res.url());
      const file = this.name(res.url());
      const refusal = res.status() === 403 ? this.o.server.refusalFor(res.url()) : null;
      // The page server says in the status text why it refused a file, which is what the reader needs.
      this.o.failedLoads.add(`HTTP ${[res.status(), res.statusText()].filter(Boolean).join(' ')}  ${file}`);
      if (refusal && !PAGE_HANDLED.has(res.request().resourceType())) {
        // No advice to copy a file out of a folder kept from the page: copied beneath a root, a secret would be served.
        const remedy = refusal.root ? `; --root ${refusal.root} would let the page read it`
          : refusal.folder ? `; it sits in ${refusal.folder}, which render does not serve` : '';
        this.o.refused.add(`${file}: ${refusal.reason.toLowerCase()}${remedy}`);
      }
    });
  }

  /** Lists what the page runtime found wrong, except an image whose load already failed and is listed as that. */
  private report(problems: string[]): void {
    for (const p of problems) {
      const image = /^image (\S+) could not be loaded or decoded$/.exec(p);
      if (!image || !this.failedUrls.has(image[1])) this.o.failedLoads.add(this.o.server.named(p));
    }
  }

  /** Fails with the page's own error, or with a refusal ahead of it, since a missing file is what makes a page throw. */
  private check(): void {
    const refused = [...this.o.refused].sort();
    const e = this.error;
    const stack = e?.stack && e.stack !== e.message ? `\n  ${firstLines(e.stack, 8)}` : '';
    if (refused.length) {
      throw new Error(`the page server refused ${refused.length} file(s) the page needs, so the frames would be drawn without them:\n  ${refused.join('\n  ')}`
        + (e ? `\n  and then the page threw: ${e.message}` : ''));
    }
    if (e) throw new Error(`the page threw: ${e.message}${stack}`);
  }

  private async navigate(): Promise<void> {
    const url = this.o.server.urlFor(this.o.page);
    const budget = this.o.budgetMs;
    try {
      await this.pw.goto(url, { waitUntil: 'load', timeout: budget });
    } catch (e) {
      this.check();
      if ((e as Error).name === 'TimeoutError') {
        throw new Error(`the page did not load within ${budget / 1000} s: its load event never fired (a script that never returns, or a file that never `
          + `finishes loading); if it loads in a browser, ${STARVED}`);
      }
      throw new Error(`the page did not load: ${firstLines((e as Error).message, 2)}`);
    }
    this.check();
    if (this.o.transparent) {
      await this.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
  }

  private async load(): Promise<void> {
    await this.navigate();
    // The zone a page is given goes in before its own scripts run, so text it places as it loads is placed in the
    // zone: the first load finds the stage's shape, and the page is loaded again with the zone.
    if (await this.inPage(() => this.dress())) await this.navigate();
    await this.inPage(async () => {
      await this.dress();
      if (this.footage) await this.standDown();
      else if (this.o.videosIn) await this.standDownOutside(this.o.videosIn);
      this.info = await this.pw.evaluate(`window.__openedit.ready(${this.o.budgetMs}, ${this.floor})`) as ReadyInfo;
      this.report(this.info.problems);
      this.noteRaised(this.info.raised);
      if (this.shrunk.length) await this.pw.evaluate(`window.__openedit.shrunk(${JSON.stringify(this.shrunk)})`);
    });
  }

  private async inPage<T>(work: () => Promise<T>): Promise<T> {
    const budget = this.o.budgetMs;
    let result: T;
    try {
      // The page's own waits share one budget (ready() in page-runtime.ts); this backstop is for a Chrome that stops
      // answering altogether, as a frame's is.
      result = await bounded(work(), 2 * budget, `Chrome stopped answering for ${2 * budget / 1000} s while the page loaded its fonts, images and videos: ${STARVED}`);
    } catch (e) {
      this.check();
      throw new Error(`the page never became ready: ${firstLines((e as Error).message, 2)}`);
    }
    this.check();
    return result;
  }

  /**
   * Settles the floor the page's text is raised to, that of the canvas, which until it is settled is the stage's; and
   * gives a page that links no safe-zone stylesheet a zone of its stage's shape, its brief's platform's or the shape's
   * own (givenZone). True when the zone is new to this page, which must then be loaded again for it.
   */
  private async dress(): Promise<boolean> {
    const stage = await this.pw.evaluate('window.__openedit.stageZone()') as StageZone | null;
    this.floor = this.o.noTextFloor ? 0 : minText(this.o.canvas ?? stage ?? this.o.viewport);
    const zone = stage && givenZone(stage, this.o.page);
    this.zone = zone && !stage.linked ? zone : null;
    if (!zone || stage.given) return false;
    // A page that links its own zone but leaves the stage unmarked has its stage marked, so the zone applies.
    if (stage.linked) {
      await this.pw.evaluate(`window.__openedit.zone(${JSON.stringify(zone.format.shape)}, null)`);
      return false;
    }
    if (this.o.givenZone) this.o.givenZone.zone = zone;
    await this.pw.context().addInitScript(giveZone(zone));
    return true;
  }

  /** Each element as it was first raised, by frame, so the list is the same whichever worker reached it first. */
  private noteRaised(raised: RaisedText[]): void {
    for (const r of raised) {
      const had = this.o.raised?.get(r.key);
      if (!had || r.frame < had.frame) this.o.raised?.set(r.key, r);
    }
  }

  /**
   * Loads the page again from the start, for when what the server answers with has changed. What failed to load
   * before is forgotten, as the load lists again whatever still fails: a video swapped for a copy that plays does not.
   */
  async reload(): Promise<void> {
    this.next = 0;
    this.peeked = false;
    this.o.failedLoads.clear();
    this.failedUrls.clear();
    await timed(this.o.timings, 'load', () => this.load());
  }

  private async idle(i: number): Promise<void> {
    if (!this.inflight.size) return;
    try {
      await timed(this.o.timings, 'loads', () => deadline(new Promise<void>((ok) => this.idleWaiters.push(ok)), this.o.budgetMs, 'the page\'s requests'));
    } catch {
      const stuck = [...this.inflight].map((r) => this.name(r.url()));
      const shown = stuck.slice(0, 3).join(', ') + (stuck.length > 3 ? `, and ${stuck.length - 3} more` : '');
      throw new Error(`frame ${i}: ${stuck.length} request(s) were still loading after ${this.o.budgetMs / 1000} s: ${shown}`);
    }
  }

  /**
   * `work`, a step of the page, with Chrome made to draw while it lasts by a capture thrown away; each is counted on
   * `stage`. The capture takes no clip: Chrome restores the page's emulated screen inexactly after a clipped capture,
   * so a clipped draw would change what the page reads as its screen (`screen.width`, `device-width`).
   */
  private drawn<T>(stage: 'draw' | 'prerollDraw', work: Promise<T>): Promise<T> {
    const t = this.o.timings;
    const draw = async () => {
      await this.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      if (t) t[stage].n++;
    };
    return drawWhile(work, draw, DRAW_EVERY_MS, this.o.budgetMs);
  }

  /** The first frame this session can still draw: 0 on a fresh page. */
  get position(): number {
    return this.next;
  }

  /** Whether this session jumps past frames rather than stepping through them: a stateless page whose mark holds. */
  get jumps(): boolean {
    return this.info.stateless && !this.o.stepAlways && !this.stepping;
  }

  /** Steps through every frame from now on, as for a page without the data-stateless mark. */
  stepEveryFrame(): void {
    this.stepping = true;
  }

  private async advance(i: number, step: boolean, jump = false): Promise<void> {
    const at = `frame ${i} (${frameTime(i, this.o.fps).toFixed(3)} s)`;
    try {
      // A page is stepped through the frames a worker skips, __seek or not: pages carry state from
      // frame to frame (a scene set up on first entry, a counter, a simulation), and a jump past that
      // state renders a different picture than a one-worker render would. Only a page that declares
      // itself stateless (data-stateless) is jumped into; render first checks the mark on one frame (probeStateless).
      const budget = this.o.budgetMs;
      if (i > this.next && !jump && (step || !this.jumps)) {
        const steps = i - this.next;
        const stepped = await timed(this.o.timings, 'preroll', () => this.drawn('prerollDraw', deadline(this.pw.evaluate(`window.__openedit.preroll(${this.next}, ${i}, ${budget})`) as Promise<FrameReport>,
          2 * budget + steps * 1000, `stepping through frames ${this.next}-${i - 1}`)), steps);
        this.report(stepped.problems);
        this.noteRaised(stepped.raised);
      }
      const drew = await timed(this.o.timings, 'page', () => this.drawn('draw', deadline(this.pw.evaluate(`window.__openedit.frame(${i}, ${budget})`) as Promise<FrameReport>, 2 * budget, 'the page')));
      this.report(drew.problems);
      this.noteRaised(drew.raised);
    } catch (e) {
      this.check();
      const message = (e as Error).message;
      const grown = new RegExp(`video (\\S+) ${DRAWN_LARGER}`).exec(message);
      if (grown) throw new DrawnLarger(`${at}: video ${this.name(grown[1])} ${DRAWN_LARGER}`);
      throw new Error(`${at}: ${firstLines(message, 3)}`);
    }
    this.next = i + 1;
    await this.idle(i);
    this.check();
  }

  /**
   * Frame i in the session's capture format; a session only steps forward. `step` steps through the frames before it
   * as a page without the data-stateless mark is, even where this session would jump.
   */
  async capture(i: number, step = false, format?: Capture): Promise<Buffer> {
    await this.seek(i, step);
    return this.shoot(`frame ${i}`, format);
  }

  /** Steps the page to frame i without capturing it; a session only steps forward. */
  async seek(i: number, step = false): Promise<void> {
    if (this.peeked) throw new Error(`frame ${i} was asked for on a page peek() jumped into; reload it first`);
    if (i < this.next) throw new Error(`frame ${i} was asked for after frame ${this.next - 1}; a page only steps forward`);
    await this.advance(i, step);
  }

  /**
   * The text and videos the page shows at frame i, reached by a jump whatever its mark says, to compare with what an
   * earlier render read there. A jump past state the page carries can show otherwise than a step would, so a session
   * that jumped where it should have stepped captures no frame until it is reloaded.
   */
  async peek(i: number): Promise<SampledFrame> {
    if (i < this.next) throw new Error(`frame ${i} was asked for after frame ${this.next - 1}; a page only steps forward`);
    if (i > this.next && !this.jumps) this.peeked = true;
    await this.advance(i, false, true);
    return this.readText();
  }

  /** What the page shows now, in the session's capture format unless one is given. */
  async shoot(what: string, format: Capture = this.o.capture ?? 'png'): Promise<Buffer> {
    const scale = this.o.scale ?? 1;
    // A scaled capture needs a box to scale: with no stage clip, the viewport where the page has scrolled
    // it, since a clip is placed on the document, not the view. (The device scale factor would do the
    // same, but the headless shell draws at 1 whatever it is set to.)
    let box = this.clip;
    if (!box && scale !== 1) {
      const { cssVisualViewport: v } = await this.answer(this.cdp.send('Page.getLayoutMetrics'), 'measuring the viewport');
      box = { x: v.pageX, y: v.pageY, ...this.o.viewport };
    }
    const clip = box ? { ...box, scale } : undefined;
    // optimizeForSpeed trades PNG compression for time; Chrome's JPEG encoder ignores it, and even at
    // quality 100 it stores the chroma at half resolution.
    const image = format === 'jpeg' ? { format: 'jpeg' as const, quality: this.o.quality ?? 100 } : { format: 'png' as const, optimizeForSpeed: true };
    const shot = await timed(this.o.timings, 'capture', () => deadline(this.cdp.send('Page.captureScreenshot', { ...image, ...(clip ? { clip } : {}) }),
      2 * this.o.budgetMs, `the capture of ${what}`));
    this.check();
    const frame = Buffer.from(shot.data, 'base64');
    // The encoder and the footage under the page are sized from drawnSize before the first frame; one
    // Chrome draws otherwise would leave an edge of bare footage or a picture the encoder misreads.
    if (box && scale !== 1) {
      const want = drawnSize(box, scale);
      const got = imageSize(frame);
      if (!got || got.width !== want.width || got.height !== want.height) {
        throw new Error(`the capture of ${what} came out ${got ? `${got.width}x${got.height}` : 'unreadable'}, not the ${want.width}x${want.height} that ${box.width}x${box.height} at ${scale} was sized for`);
      }
    }
    return frame;
  }

  /**
   * The text and the videos the page shows now, in the pixels of the frame `shoot` captures: called after the capture,
   * it reads the layout that frame was drawn from.
   */
  async readText(): Promise<SampledFrame> {
    const call = `window.__oeText(${JSON.stringify(this.clip)}, ${this.o.viewport.width}, ${this.o.viewport.height}, ${this.o.scale ?? 1})`;
    return timed(this.o.timings, 'text', () => this.evaluate<SampledFrame>(call, 'reading the page\'s text'));
  }

  /** Draws only layer k of the session's `layers` from now on; -1 draws the whole page again. */
  async showLayer(k: number): Promise<void> {
    this.needLayers(k);
    await this.answer(this.pw.evaluate(`window.__oeLayer(${k})`), `switching to layer ${k}`);
    // The speaker's box pins its own visibility, so the layer switch cannot hide it: it is hidden here for every layer
    // but its own.
    if (this.info.cutout) await this.showCutout(k < 0 || this.o.layers![k] === SPEAKER_BOX);
  }

  /**
   * Shows or hides the speaker layer's cut-out. Through the debugging protocol, as the cut-out lies in a closed shadow
   * root, where it is found by the key the session gave it.
   */
  private async showCutout(on: boolean): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.cutout ??= await this.findCutout();
      try {
        const what = `${on ? 'showing' : 'hiding'} the speaker layer's cut-out`;
        if (on) await this.answer(this.cdp.send('DOM.removeAttribute', { nodeId: this.cutout, name: 'style' }), what);
        else await this.answer(this.cdp.send('DOM.setAttributeValue', { nodeId: this.cutout, name: 'style', value: 'visibility:hidden!important' }), what);
        return;
      } catch (e) {
        // A box a script dropped and the speaker put back is a node the protocol no longer knows: found again, once.
        this.cutout = null;
        if (attempt) throw new Error(`the speaker layer's cut-out could not be ${on ? 'shown' : 'hidden'}: ${firstLines((e as Error).message, 1)}`);
      }
    }
  }

  private async findCutout(): Promise<number> {
    type Node = { nodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };
    const { root } = await this.answer(this.cdp.send('DOM.getDocument', { depth: -1, pierce: true }), 'reading the page\'s elements') as { root: Node };
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      const a = n.attributes ?? [];
      for (let k = 0; k < a.length; k += 2) if (a[k] === 'data-oe-key' && a[k + 1] === this.speakerKey) return n.nodeId;
      stack.push(...(n.children ?? []), ...(n.shadowRoots ?? []));
    }
    throw new Error('the speaker layer\'s cut-out is not on the page');
  }

  /** Leaves the page's blended elements out of every layer, and names them with their blend mode. */
  async excludeBlended(): Promise<string[]> {
    this.needLayers();
    return this.answer(this.pw.evaluate('window.__oeBlended()') as Promise<string[]>, 'finding blended elements');
  }

  /** For each of the session's `layers`, whether one of its elements holds a video now. */
  async layersWithVideo(): Promise<boolean[]> {
    this.needLayers();
    return this.answer(this.pw.evaluate('window.__oeHasVideo()') as Promise<boolean[]>, 'finding the layers\' videos');
  }

  /**
   * Which of the session's `layers` could paint anything in the current frame (the others are judged empty), and how
   * many elements each matches now. It shows the whole page, and marks each layer's elements the page shows, which is
   * what the next showLayer draws.
   */
  async visibleLayers(): Promise<{ visible: boolean[]; matches: number[] }> {
    this.needLayers();
    return this.answer(this.pw.evaluate('window.__oeVisible()') as Promise<{ visible: boolean[]; matches: number[] }>, 'finding the visible layers');
  }

  /**
   * Runs `expression` in the page as it stands and returns its value, for `what`. Fails as a frame does when the
   * page has thrown, now or earlier, or the server refused a file it needs.
   */
  async evaluate<T>(expression: string, what: string): Promise<T> {
    const named = (e: unknown, lines?: number) => {
      const message = lines ? firstLines((e as Error).message, lines) : (e as Error).message;
      return new Error(message.startsWith(what) ? message : `${what}: ${message}`);
    };
    let value: T;
    try {
      value = await deadline(this.pw.evaluate(expression) as Promise<T>, 2 * this.o.budgetMs, what);
    } catch (e) {
      try {
        this.check();
      } catch (page) {
        throw named(page);
      }
      throw named(e, 3);
    }
    try {
      this.check();
    } catch (page) {
      throw named(page);
    }
    return value;
  }

  /** Stands down every <video> outside the elements `keep` matches, as footage is stood down, so no frame seeks it. */
  private async standDownOutside(keep: string): Promise<void> {
    await this.pw.evaluate(`(() => {
      window.__openedit.videoSources();
      window.__openedit.standDown([...document.querySelectorAll('video')].map((v) => !v.closest(${JSON.stringify(keep)})));
    })()`);
  }

  /** A call into Chrome that may take as long as a frame's step, and no longer: a Chrome that stops answering fails it by name. */
  private answer<T>(work: Promise<T>, what: string): Promise<T> {
    return deadline(work, 2 * this.o.budgetMs, what, STARVED);
  }

  private needLayers(k = 0): void {
    const n = this.o.layers?.length ?? 0;
    if (!n) throw new Error('this session was opened without layers');
    if (k >= n || k < -1) throw new Error(`there is no layer ${k}; this session has ${n}`);
  }

  async close(): Promise<void> {
    await deadline(this.browser.close(), 15_000, 'closing Chrome').catch(() => {});
  }
}
