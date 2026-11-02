// A page step that lasts past DRAW_EVERY_MS makes the session draw (a capture thrown away), so a fresh page that sits
// undrawn cannot hold a video's picture back for the whole budget. The loop is checked on its own with a fake draw;
// in Chrome, what it must never change: the frames a render makes, a failing step's budget, and a clean exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../src/config.ts';
import { chromePlatform, installedChrome, resolveChrome } from '../src/render/browser.ts';
import { EPOCH, SEED } from '../src/render/lead.ts';
import { startPageServer } from '../src/render/server.ts';
import { DRAW_EVERY_MS, drawWhile, newTimings, RenderSession } from '../src/render/session.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SESSION = new URL('../src/render/session.ts', import.meta.url).href;
const SERVER = new URL('../src/render/server.ts', import.meta.url).href;
const BROWSER = new URL('../src/render/browser.ts', import.meta.url).href;
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const EVERY = 40;
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
/** A step that ends when `draws` draws have been made: no clock decides how many come. */
function endsAfter(draws: number, fail?: Error) {
  let made = 0;
  let end!: () => void;
  const work = new Promise<string>((r) => { end = () => r('slow'); });
  const draw = async () => { made++; if (made === draws) end(); if (fail) throw fail; };
  return { work, draw, made: () => made };
}

test('draw: none for a quick step, draws again and again on a slow one, none once it is over, and no timer left', async () => {
  let quick = 0;
  const before = timers();
  assert.equal(await drawWhile(Promise.resolve('quick'), async () => { quick++; }, EVERY, 1000), 'quick');
  assert.equal(quick, 0);
  assert.equal(timers(), before, 'no timer left by a step that ended before its first draw');
  await drawWhile(sleep(EVERY * 1.5), async () => {}, EVERY, 1000);
  assert.equal(timers(), before, 'no timer left by a step that ended between draws');
  const slow = endsAfter(2);
  assert.equal(await drawWhile(slow.work, slow.draw, EVERY, 1000), 'slow');
  await sleep(EVERY * 3);
  assert.equal(slow.made(), 2, 'no draw after the step');
});

test('draw: a draw in flight when the step succeeds is waited for, and one that never answers fails on the budget', { timeout: 10_000 }, async () => {
  const order: string[] = [];
  const slow = () => sleep(EVERY * 4).then(() => { order.push('draw'); });
  await drawWhile(sleep(EVERY * 1.5), slow, EVERY, 1000);
  order.push('step');
  assert.deepEqual(order, ['draw', 'step'], 'the step returns only once its draw has');
  const started = Date.now();
  await assert.rejects(drawWhile(sleep(EVERY * 1.5), () => new Promise(() => {}), EVERY, 300), /a draw forced on a stalled step did not answer within/);
  const took = Date.now() - started;
  assert.ok(took >= 290 && took < 1000, `held to the budget: ${took} ms`);
});

test('draw: a failed draw does not end the loop; a failed step fails at once and names the draw on its first line', async () => {
  const failing = endsAfter(2, new Error('Target closed'));
  await drawWhile(failing.work, failing.draw, EVERY, 1000);
  assert.equal(failing.made(), 2, 'a failed draw does not end the loop');
  const started = Date.now();
  const closed = async () => { throw new Error('Target closed'); };
  const step = sleep(EVERY * 1.5).then(() => { throw new Error('the page did not answer within 6 s\n    at frame (<anonymous>:1:1)'); });
  await assert.rejects(drawWhile(step, closed, EVERY, 10_000), (e: Error) =>
    e.message.split('\n')[0] === 'the page did not answer within 6 s; forcing Chrome to draw failed too: Target closed');
  const odd = sleep(EVERY * 1.5).then(() => { throw new Error('boom'); });
  await assert.rejects(drawWhile(odd, () => Promise.reject('detached'), EVERY, 10_000), /^Error: boom; forcing Chrome to draw failed too: detached$/);
  const never = sleep(EVERY * 1.5).then(() => { throw new Error('boom'); });
  await assert.rejects(drawWhile(never, () => new Promise(() => {}), EVERY, 10_000), /^Error: boom$/, 'not held by a draw that never answers');
  assert.ok(Date.now() - started < 2000, `failed after ${Date.now() - started} ms`);
});

// Longer than DRAW_EVERY_MS, so a draw lands mid-step.
const STALL = DRAW_EVERY_MS + 300;

/**
 * A page with a moving title, a canvas redrawn every frame and a video. `stall` makes frames 1 and 5 take STALL ms:
 * busy (a draw is still in flight when the step ends), or yielding (draws land and finish mid-step). Its stage is set
 * off the viewport's corner, so its captures are clipped, or at the corner, filling the viewport, so they are not. It
 * prints the screen it reads, which a clipped capture changes.
 */
function stallPage(dir: string, stall: 'none' | 'busy' | 'yield', corner = false): string {
  const wait = {
    none: '',
    busy: `const s=real();while(real()-s<${STALL}){}`,
    yield: `const s=real();while(real()-s<${STALL}){await new Promise((r)=>{const c=new MessageChannel();c.port1.onmessage=r;c.port2.postMessage(0)})}`,
  }[stall];
  const file = join(dir, `${stall}${corner ? '-corner' : ''}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}
#stage{position:relative;margin:${corner ? '0' : '12px 20px'};width:320px;height:180px;overflow:hidden;background:#123}
@media (max-device-width:400px){#stage{background:#063}}
#s{position:absolute;right:8px;bottom:8px;font:bold 20px sans-serif;color:#fff}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.t{position:absolute;left:20px;top:40px;font:bold 30px sans-serif;color:#fff;animation:a 2s linear infinite;text-shadow:0 2px 8px #000}
@keyframes a{from{transform:translateX(0)}to{transform:translateX(200px)}}
</style></head><body><div id="stage"><video src="clip.mp4" muted playsinline></video><div class="t">Hello</div>
<canvas id="c" width="320" height="180" style="position:absolute;inset:0"></canvas><div id="s"></div></div>
<script>const real=()=>new Event('x').timeStamp;let n=0;const x=document.getElementById('c').getContext('2d');
(function f(){x.clearRect(0,0,320,180);x.fillStyle='rgba(255,200,0,.6)';x.fillRect((n++*7)%300,140,20,20);x.fillText(String(Math.random()).slice(0,6),120,20);requestAnimationFrame(f)})();
window.__seek=async(t)=>{document.getElementById('s').textContent=screen.width+'x'+screen.height;const i=Math.round(t*10);if(i%4!==1)return;${wait}};
</script></body></html>`);
  return file;
}

/** The stills at `times` on one worker, and how many draws the render says it forced on its frames' own steps. */
function stills(file: string, out: string, times: string): { pngs: Buffer[]; drew: number } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', file, '--out', out, '--stills', times, '--fps', '10', '--workers', '1'],
    { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  return { pngs: readdirSync(out).filter((f) => f.endsWith('.png')).sort().map((f) => readFileSync(join(out, f))), drew: Number(/(\d+) draw\(s\) forced on frames slower than/.exec(r.stdout)?.[1] ?? 0) };
}

test('render: a step slow enough to be drawn mid-way renders byte for byte the frames it renders when fast, stepped or prerolled', { skip }, () => {
  const dir = scratchDir('render-draw');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=10:d=2', '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  const every = '0,0.1,0.2,0.3,0.4,0.5,0.6,0.7';
  const fast = stills(stallPage(dir, 'none'), join(dir, 'none'), every);
  assert.equal(fast.pngs.length, 8);
  // A fresh page may stall its first frame on its own; a healthy page never stalls more.
  assert.ok(fast.drew <= 1, `${fast.drew} draws forced on a page that never stalls`);
  const [fastFirst] = stills(stallPage(dir, 'none'), join(dir, 'none-first'), '0.7').pngs;
  const differ: string[] = [];
  for (const stall of ['busy', 'yield'] as const) {
    const slow = stills(stallPage(dir, stall), join(dir, stall), every);
    assert.equal(slow.pngs.length, 8, `${stall}: every still`);
    assert.ok(slow.drew >= 2, `${stall}: ${slow.drew} draws forced, one at least on each stalled frame`);
    slow.pngs.forEach((png, i) => { if (!png.equals(fast.pngs[i])) differ.push(`${stall} frame ${i}`); });
    // Frames 1 and 5 stall inside one preroll step on the way to frame 7.
    const gap = stills(stallPage(dir, stall), join(dir, `${stall}-gap`), '0,0.7');
    assert.equal(gap.pngs.length, 2);
    if (!gap.pngs[1].equals(fast.pngs[7])) differ.push(`${stall} frame 7 after a preroll`);
    // Drawn before the session's first capture, which is the first to change the screen.
    const first = stills(stallPage(dir, stall), join(dir, `${stall}-first`), '0.7');
    if (!first.pngs[0].equals(fastFirst)) differ.push(`${stall} frame 7 prerolled first`);
  }
  assert.deepEqual(differ, [], 'frames that differ from the render without stalls');
});

test('render: a stalled step leaves the screen an unclipped page reads as it was, so its frames are those it renders when fast', { skip }, () => {
  const dir = scratchDir('render-draw-corner');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=10:d=2', '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  const every = '0,0.1,0.2,0.3,0.4,0.5,0.6';
  const fast = stills(stallPage(dir, 'none', true), join(dir, 'none'), every);
  const slow = stills(stallPage(dir, 'yield', true), join(dir, 'yield'), every);
  assert.ok(slow.drew >= 1, `${slow.drew} draws forced`);
  assert.equal(slow.pngs.length, 7);
  assert.deepEqual(slow.pngs.map((png, i) => png.equals(fast.pngs[i])), Array(7).fill(true), 'stills equal to the render without stalls');
});

test('render: a preroll over stalled frames draws on its way, counted apart from the draws of a frame\'s own step', { skip }, async () => {
  const dir = scratchDir('render-draw-preroll');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=10:d=2', '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  const server = await startPageServer({ roots: [dir] });
  const timings = newTimings();
  const session = await RenderSession.open({
    chrome: await resolveChrome(undefined), server, page: stallPage(dir, 'busy'), viewport: { width: 340, height: 192 }, transparent: false,
    fps: { num: 10, den: 1 }, seed: SEED, epoch: EPOCH, budgetMs: 60_000, failedLoads: new Set(), refused: new Set(), timings,
  });
  try {
    await session.capture(0);
    await session.capture(7);
    assert.ok(timings.prerollDraw.n >= 1, `${timings.prerollDraw.n} draws forced while stepping through frames 1 to 6`);
    assert.ok(timings.draw.n <= 1, `${timings.draw.n} draws forced on frames 0 and 7, which do not stall`);
  } finally {
    await session.close();
    await server.close();
  }
});

test('render: a step that never finishes still fails on its budget, idle or busy, whether its forced draws answer or not', { skip, timeout: 60_000 }, async () => {
  const dir = scratchDir('render-draw-budget');
  const server = await startPageServer({ roots: [dir] });
  const chrome = await resolveChrome(undefined);
  try {
    for (const [stuck, message, from, to] of [
      ['new Promise(()=>{})', /window\.__seek\(0\.1\) did not finish within 3 s/, 3000, 6000],
      ['(()=>{for(;;){}})()', /the page did not answer within 6 s/, 6000, 8500],
    ] as const) {
      const file = join(dir, `${from}.html`);
      writeFileSync(file, `<!doctype html><div id="stage" style="width:64px;height:64px;background:#08f"></div><script>window.__seek=(t)=>t>0?${stuck}:undefined</script>`);
      const session = await RenderSession.open({
        chrome, server, page: file, viewport: { width: 64, height: 64 }, transparent: false, fps: { num: 10, den: 1 },
        seed: SEED, epoch: EPOCH, budgetMs: 3000, failedLoads: new Set(), refused: new Set(),
      });
      try {
        await session.capture(0);
        const started = Date.now();
        await assert.rejects(session.capture(1), (e: Error) => message.test(e.message) && !/forcing Chrome to draw failed/.test(e.message));
        const took = Date.now() - started;
        assert.ok(took >= from - 50 && took < to, `${stuck}: failed after ${took} ms`);
      } finally {
        await session.close();
      }
    }
  } finally {
    await server.close();
  }
});

test('render: a session leaves no timer behind once closed, so its process exits as soon as its work is done', { skip }, () => {
  const dir = scratchDir('render-draw-exit');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="stage" style="width:64px;height:64px;background:#08f"></div>');
  const script = join(dir, 'run.mts');
  writeFileSync(script, `import { RenderSession } from ${JSON.stringify(SESSION)};
import { startPageServer } from ${JSON.stringify(SERVER)};
import { resolveChrome } from ${JSON.stringify(BROWSER)};
const server = await startPageServer({ roots: [${JSON.stringify(dir)}] });
const s = await RenderSession.open({ chrome: await resolveChrome(undefined), server, page: ${JSON.stringify(join(dir, 'index.html'))},
  viewport: { width: 64, height: 64 }, transparent: false, fps: { num: 10, den: 1 }, seed: 1, epoch: 0, budgetMs: 60000,
  failedLoads: new Set(), refused: new Set() });
for (let i = 0; i < 3; i++) await s.capture(i);
await s.close();
await server.close();
console.log(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length);
`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').pop(), '0', 'timers still pending after the session closed');
});
