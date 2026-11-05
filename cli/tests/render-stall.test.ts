// A render that stops making progress: Chrome that never starts, a page that stops answering, an ffmpeg that never
// finishes, and the signal that stops it all. Each must end by name, bounded, and take only its own processes with it.
// Skipped when the browser is not installed (`openedit install-browser`), unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { EPOCH, SEED } from '../src/render/lead.ts';
import { startPageServer } from '../src/render/server.ts';
import { newTimings, RenderSession } from '../src/render/session.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const chrome = platform ? installedChrome(platform) : '';
const missing = platform && existsSync(chrome) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`${what} within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A process and every process below it, from the system's process table. */
function tree(root: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const out = [root];
  for (let k = 0; k < out.length; k++) for (const [pid, ppid] of rows) if (ppid === out[k] && !out.includes(pid)) out.push(pid);
  return out;
}

async function session(dir: string, html: string, o: { chrome?: string; budgetMs: number }): Promise<RenderSession> {
  const page = join(dir, 'page.html');
  writeFileSync(page, html);
  const server = await startPageServer({ roots: [dir] });
  try {
    return await RenderSession.open({
      chrome: o.chrome ?? chrome, server, page, viewport: { width: 320, height: 180 }, transparent: false, fps: { num: 30, den: 1 },
      seed: SEED, epoch: EPOCH, budgetMs: o.budgetMs, failedLoads: new Set(), refused: new Set(), timings: newTimings(),
    });
  } finally {
    await server.close();
  }
}

test('render: a page that stops answering once loaded fails at its readiness, naming the stage and what to try', { skip, timeout: 90_000 }, async () => {
  const dir = scratchDir('render-stall-ready');
  // Loaded, then its renderer never yields again, as one wedged under a starved machine does.
  const html = `<!doctype html><html><body><div id="stage" style="width:320px;height:180px"></div><script>
addEventListener('load', () => { const c = new MessageChannel(); c.port1.onmessage = () => { for (;;) {} }; c.port2.postMessage(0); });
</script></body></html>`;
  const started = Date.now();
  await assert.rejects(session(dir, html, { budgetMs: 2_000 }),
    /the page never became ready: Chrome stopped answering for 4 s while the page loaded its fonts, images and videos: the machine may be short of CPU or memory: try again with fewer --workers/);
  assert.ok(Date.now() - started < 40_000, `failed after ${Date.now() - started} ms`);
});

test('render: a Chrome that never starts fails at its launch, naming the stage, and is not left running once the render exits', { skip, timeout: 90_000 }, async () => {
  const dir = scratchDir('render-stall-launch');
  // Answers the sandbox check as the real one does, then hangs where the driver waits for it to start.
  const fake = join(dir, 'chrome');
  const pidFile = join(dir, 'chrome.pid');
  writeFileSync(fake, `#!/bin/sh
for a in "$@"; do [ "$a" = "--dump-dom" ] && exec "${chrome}" "$@"; done
echo $$ > "${pidFile}"
exec sleep 300
`);
  chmodSync(fake, 0o755);
  // In a process of its own, which exits once the open has failed, as render does.
  const script = join(dir, 'open.mts');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
const { startPageServer } = await import(${JSON.stringify(fileURLToPath(new URL('../src/render/server.ts', import.meta.url)))});
const { newTimings, RenderSession } = await import(${JSON.stringify(fileURLToPath(new URL('../src/render/session.ts', import.meta.url)))});
writeFileSync(${JSON.stringify(join(dir, 'page.html'))}, '<!doctype html><p>x</p>');
const server = await startPageServer({ roots: [${JSON.stringify(dir)}] });
try {
  await RenderSession.open({ chrome: ${JSON.stringify(fake)}, server, page: ${JSON.stringify(join(dir, 'page.html'))}, viewport: { width: 320, height: 180 },
    transparent: false, fps: { num: 30, den: 1 }, seed: 1, epoch: 0, budgetMs: 60000, launchMs: 3000, failedLoads: new Set(), refused: new Set(), timings: newTimings() });
  console.log('opened');
} catch (e) {
  console.log(e.message);
}
process.exit(0);
`);
  const started = Date.now();
  const said = execFileSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 60_000 });
  assert.match(said, new RegExp(`Chrome did not start within 3 s \\(${fake.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\): the machine may be short of CPU or memory`));
  assert.ok(Date.now() - started < 30_000, `failed after ${Date.now() - started} ms`);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await until(`the Chrome that never started (pid ${pid}) outlived the render`, () => !alive(pid), 5_000);
});

test('render: a signal stops a render whose ffmpeg hangs, at once, with its Chrome and ffmpeg, and leaves other Chromes running', { skip, timeout: 120_000 }, async () => {
  const dir = scratchDir('render-stall-signal');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-frames:v', '60', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  writeFileSync(join(dir, 'page.html'), `<!doctype html><html><head><style>html,body{margin:0;background:transparent}
#stage{position:relative;width:320px;height:180px}#b{position:absolute;left:10px;top:10px;width:40px;height:40px;background:#fff}</style></head>
<body><div id="stage"><div id="b"></div></div></body></html>`);
  // An ffmpeg that never finishes laying a still over the footage, as one did on a stand machine; everything else is the real one.
  const mark = join(dir, 'hung.pid');
  const fake = join(dir, 'ffmpeg');
  writeFileSync(fake, `#!/bin/sh
for a in "$@"; do last="$a"; done
if [ "$last" = "pipe:1" ]; then echo $$ > "${mark}"; exec sleep 300; fi
exec "${FFMPEG}" "$@"
`);
  chmodSync(fake, 0o755);
  const profile = mkdtempSync(join(tmpdir(), 'open-edit-bystander-'));
  const bystander = spawn(chrome, ['--headless', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const r = spawn(process.execPath, ['--import', 'tsx', CLI, 'render', join(dir, 'page.html'), '--footage', join(dir, 'clip.mp4'), '--stills', '0.5,1',
    '--workers', '1', '--out', join(dir, 'stills')], { env: { ...process.env, OPEN_EDIT_ROOT: dir, OPENEDIT_FFMPEG: fake, OPENEDIT_FFPROBE: FFPROBE }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  r.stderr.on('data', (d) => { err += d; });
  const exited = new Promise<number | null>((done) => r.on('exit', (code) => done(code)));
  let family: number[] = [];
  try {
    await until(`the render never reached its ffmpeg (${err.trim()})`, () => existsSync(mark) && readFileSync(mark, 'utf8').trim() !== '', 60_000);
    family = tree(r.pid!);
    assert.ok(family.length > 3, `the render runs Chrome and ffmpeg below it: ${family.join(' ')}`);
    assert.ok(family.includes(Number(readFileSync(mark, 'utf8'))), 'the hung ffmpeg is the render\'s');
    r.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<'hung'>((done) => setTimeout(() => done('hung'), 10_000))]);
    assert.equal(code, 143, `the render ${code === 'hung' ? 'ignored the signal' : `exited ${code}`}`);
    await until(`processes the render started outlived it: ${family.filter(alive).join(' ')}`, () => !family.some(alive), 10_000);
    assert.ok(alive(bystander.pid!), 'a Chrome the render did not start is still running');
  } finally {
    r.kill('SIGKILL');
    for (const pid of family) if (alive(pid)) process.kill(pid, 'SIGKILL');
    bystander.kill('SIGKILL');
  }
});

test('render: a signal stops a render while it makes a seekable copy, at once, with the copy\'s ffmpeg', { skip, timeout: 120_000 }, async () => {
  const dir = scratchDir('render-stall-copy');
  // Keyframes 300 frames apart, so the page's video is served from an all-intra copy.
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-frames:v', '1800', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '300', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  writeFileSync(join(dir, 'page.html'), `<!doctype html><html><head><style>html,body{margin:0}#stage,video{width:320px;height:180px}</style></head>
<body><div id="stage"><video src="clip.mp4" muted></video></div></body></html>`);
  // The real ffmpeg throughout; the copy reads its source at the source's own pace, so it lasts a minute on any machine.
  const mark = join(dir, 'copy.pid');
  const fake = join(dir, 'ffmpeg');
  writeFileSync(fake, `#!/bin/sh
for a in "$@"; do last="$a"; done
case "$last" in *.tmp) echo $$ > "${mark}"; exec "${FFMPEG}" -re "$@";; esac
exec "${FFMPEG}" "$@"
`);
  chmodSync(fake, 0o755);
  const out = join(dir, 'out.mp4');
  const media = join(dir, 'runs', '.media');
  const r = spawn(process.execPath, ['--import', 'tsx', CLI, 'render', join(dir, 'page.html'), '--duration', '1', '--workers', '1', '--out', out],
    { env: { ...process.env, OPEN_EDIT_ROOT: dir, OPENEDIT_FFMPEG: fake, OPENEDIT_FFPROBE: FFPROBE }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  r.stderr.on('data', (d) => { err += d; });
  const exited = new Promise<number | null>((done) => r.on('exit', (code) => done(code)));
  const copying = () => existsSync(media) && readdirSync(media).some((f) => f.endsWith('.tmp') && statSync(join(media, f)).size > 0);
  let family: number[] = [];
  try {
    await until(`the render never started its copy (${err.trim()})`, () => existsSync(mark) && copying(), 60_000);
    family = tree(r.pid!);
    assert.ok(family.includes(Number(readFileSync(mark, 'utf8'))), 'the copy\'s ffmpeg is the render\'s');
    r.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<'hung'>((done) => setTimeout(() => done('hung'), 10_000))]);
    assert.equal(code, 143, `the render ${code === 'hung' ? 'ignored the signal' : `exited ${code}`}`);
    await until(`processes the render started outlived it: ${family.filter(alive).join(' ')}`, () => !family.some(alive), 10_000);
    assert.ok(!existsSync(out), 'no video was written');
  } finally {
    r.kill('SIGKILL');
    for (const pid of family) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});
