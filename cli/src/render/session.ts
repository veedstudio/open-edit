// One worker: a headless Chrome with the page loaded under the virtual clock, advanced and captured one
// frame at a time. Everything that can go wrong in the page is turned into a named error here, so the
// command above only has to decide what to do with it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, CDPSession, Page, Request } from 'playwright-core';
import { browserProxy } from '../proxy.ts';
import { CHROME_FLAGS, linuxHint } from './browser.ts';
import { runtimeScript, type ReadyInfo } from './page-runtime.ts';
import type { PageServer } from './server.ts';
import { frameTime, type Fps } from './timing.ts';

export interface SessionOptions {
  chrome: string;
  server: PageServer;
  page: string;
  viewport: { width: number; height: number };
  /** Capture this box instead of the whole viewport. */
  clip?: { x: number; y: number; width: number; height: number } | null;
  transparent: boolean;
  /** Selectors that `showLayer(k)` switches between, each drawn alone in place; one page pass serves them all. */
  layers?: string[] | null;
  fps: Fps;
  seed: number;
  epoch: number;
  /** How long any single wait inside the page may take before the render fails. */
  budgetMs: number;
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
}

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
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export class RenderSession {
  info!: ReadyInfo;
  private error: Error | null = null;
  /** The page has been advanced through every frame below this one. */
  private next = 0;
  private inflight = new Set<Request>();
  private idleWaiters: (() => void)[] = [];
  /** URLs whose load failed, each already listed by its own failed-load line. */
  private failedUrls = new Set<string>();

  private clip: SessionOptions['clip'];

  private constructor(private readonly o: SessionOptions, private readonly browser: Browser, private readonly pw: Page, private readonly cdp: CDPSession) {
    this.clip = o.clip ?? null;
  }

  /** Captures this box of the viewport from now on: the page has to load before its stage can be measured. */
  setClip(clip: SessionOptions['clip']): void {
    this.clip = clip ?? null;
  }

  static async open(o: SessionOptions): Promise<RenderSession> {
    const { chromium } = await import('playwright-core');
    const proxy = launchProxy();
    const { browser, context, page } = await withSandbox(async (sandbox) => {
      let browser: Browser;
      try {
        browser = await chromium.launch({
          executablePath: o.chrome, args: CHROME_FLAGS, headless: true, timeout: 60_000, chromiumSandbox: sandbox, proxy,
        });
      } catch (e) {
        throw new Error(`Chrome failed to launch (${o.chrome}):\n  ${firstLines((e as Error).message)}${linuxHint()}`);
      }
      try {
        const context = await browser.newContext({ viewport: o.viewport, deviceScaleFactor: 1 });
        await context.addInitScript(runtimeScript({ seed: o.seed, epoch: o.epoch, num: o.fps.num, den: o.fps.den }));
        if (o.layers?.length) await context.addInitScript(layersScript(o.layers));
        return { browser, context, page: await context.newPage() };
      } catch (e) {
        await browser.close().catch(() => {});
        throw new Error(`Chrome could not open a page (${o.chrome}): ${firstLines((e as Error).message, 2)}`);
      }
    }, { refused: () => sandboxRefused(o.chrome), say: (line) => console.error(`render: ${line}`) });
    try {
      const cdp = await context.newCDPSession(page);
      const s = new RenderSession(o, browser, page, cdp);
      s.watch();
      await s.load();
      return s;
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }

  private name(url: string): string {
    return this.o.server.fileFor(url) ?? url;
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
    page.on('requestfailed', (req) => {
      settle(req);
      this.failedUrls.add(req.url());
      const why = req.failure()?.errorText ?? 'failed';
      if (!/ERR_ABORTED/.test(why) || req.resourceType() !== 'media') this.o.failedLoads.add(`${why}  ${this.name(req.url())}`);
    });
    page.on('response', (res) => {
      if (res.status() < 400) return;
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

  private async load(): Promise<void> {
    const url = this.o.server.urlFor(this.o.page);
    try {
      await this.pw.goto(url, { waitUntil: 'load', timeout: this.o.budgetMs });
    } catch (e) {
      this.check();
      throw new Error(`the page did not load: ${firstLines((e as Error).message, 2)}`);
    }
    this.check();
    if (this.o.transparent) {
      await this.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    try {
      this.info = await this.pw.evaluate(`window.__openedit.ready(${this.o.budgetMs})`) as ReadyInfo;
      this.report(this.info.problems);
    } catch (e) {
      this.check();
      throw new Error(`the page never became ready: ${firstLines((e as Error).message, 2)}`);
    }
    this.check();
  }

  /** Loads the page again from the start, for when what the server answers with has changed. */
  async reload(): Promise<void> {
    this.next = 0;
    await this.load();
  }

  private async idle(i: number): Promise<void> {
    if (!this.inflight.size) return;
    try {
      await deadline(new Promise<void>((ok) => this.idleWaiters.push(ok)), this.o.budgetMs, 'the page\'s requests');
    } catch {
      const stuck = [...this.inflight].map((r) => this.name(r.url()));
      const shown = stuck.slice(0, 3).join(', ') + (stuck.length > 3 ? `, and ${stuck.length - 3} more` : '');
      throw new Error(`frame ${i}: ${stuck.length} request(s) were still loading after ${this.o.budgetMs / 1000} s: ${shown}`);
    }
  }

  private async advance(i: number): Promise<void> {
    const at = `frame ${i} (${frameTime(i, this.o.fps).toFixed(3)} s)`;
    try {
      // Every page is stepped through the frames a worker skips, __seek or not: pages carry state from
      // frame to frame (a scene set up on first entry, a counter, a simulation) even when they declare
      // themselves a function of time, and a jump past that state renders a different picture than a
      // one-worker render would.
      const problems: string[] = [];
      const budget = this.o.budgetMs;
      if (i > this.next) {
        const steps = i - this.next;
        problems.push(...await deadline(this.pw.evaluate(`window.__openedit.preroll(${this.next}, ${i}, ${budget})`) as Promise<string[]>,
          2 * budget + steps * 1000, `stepping through frames ${this.next}-${i - 1}`));
      }
      problems.push(...await deadline(this.pw.evaluate(`window.__openedit.frame(${i}, ${budget})`) as Promise<string[]>, 2 * budget, 'the page'));
      this.report(problems);
    } catch (e) {
      this.check();
      throw new Error(`${at}: ${firstLines((e as Error).message, 3)}`);
    }
    this.next = i + 1;
    await this.idle(i);
    this.check();
  }

  /** The PNG of frame i; a session only steps forward. */
  async capture(i: number): Promise<Buffer> {
    await this.seek(i);
    return this.shoot(`frame ${i}`);
  }

  /** Steps the page to frame i without capturing it; a session only steps forward. */
  async seek(i: number): Promise<void> {
    if (i < this.next) throw new Error(`frame ${i} was asked for after frame ${this.next - 1}; a page only steps forward`);
    await this.advance(i);
  }

  /** The PNG of what the page shows now. */
  async shoot(what: string): Promise<Buffer> {
    const clip = this.clip ? { ...this.clip, scale: 1 } : undefined;
    const shot = await deadline(this.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, ...(clip ? { clip } : {}) }),
      2 * this.o.budgetMs, `the capture of ${what}`);
    this.check();
    return Buffer.from(shot.data, 'base64');
  }

  /** Draws only layer k of the session's `layers` from now on; -1 draws the whole page again. */
  async showLayer(k: number): Promise<void> {
    this.needLayers(k);
    await this.pw.evaluate(`window.__oeLayer(${k})`);
  }

  /** Leaves the page's blended elements out of every layer, and names them with their blend mode. */
  async excludeBlended(): Promise<string[]> {
    this.needLayers();
    return this.pw.evaluate('window.__oeBlended()') as Promise<string[]>;
  }

  /** For each of the session's `layers`, whether one of its elements holds a video now. */
  async layersWithVideo(): Promise<boolean[]> {
    this.needLayers();
    return this.pw.evaluate('window.__oeHasVideo()') as Promise<boolean[]>;
  }

  /**
   * Which of the session's `layers` could paint anything in the current frame (the others are judged empty), and how
   * many elements each matches now. It shows the whole page, and marks each layer's elements the page shows, which is
   * what the next showLayer draws.
   */
  async visibleLayers(): Promise<{ visible: boolean[]; matches: number[] }> {
    this.needLayers();
    return this.pw.evaluate('window.__oeVisible()') as Promise<{ visible: boolean[]; matches: number[] }>;
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
