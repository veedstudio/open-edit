// The render command end to end, in the pinned headless Chrome: frame counts, pixels at known frames,
// determinism across worker counts, patching, and the failures that must be loud. Skipped when the
// browser is not installed (`openedit install-browser`), unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
// Set where the browser was installed on purpose, so losing that install fails the suite instead of skipping it.
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;
const W = 320;
const H = 180;

function render(args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function page(dir: string, name: string, body: string, style = ''): string {
  const file = join(dir, name);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000}
.box{position:absolute;width:20px;height:20px;background:#fff}
${style}</style></head><body><div id="stage">${body}</div></body></html>`);
  return file;
}

/** Every frame of a video as 8-bit gray. */
function grayFrames(video: string): Buffer[] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  return Array.from({ length: raw.length / (W * H) }, (_, i) => raw.subarray(i * W * H, (i + 1) * W * H));
}

/** The first bright column on a row: where a white box's left edge is. */
function edge(frame: Buffer, row: number): number {
  for (let x = 0; x < W; x++) if (frame[row * W + x] > 128) return x;
  return -1;
}

// An edge of -1 means no box was drawn at all, which must never pass for a box at 0.
const near = (actual: number, expected: number, what: string) => assert.ok(actual >= 0 && Math.abs(actual - expected) <= 1, `${what}: ${actual}, expected ${expected}`);

function hashes(video: string, copy: boolean): string[] {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-map', '0:v:0', ...(copy ? ['-c', 'copy'] : []), '-f', 'framemd5', '-'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

function probe(video: string, entries: string): string {
  return execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim();
}

// A white box that slides 100 px per second.
const CSS_BODY = '<div class="box" id="box" style="top:80px"></div>';
const CSS_STYLE = '#box{animation:slide 3s linear forwards}@keyframes slide{from{left:0}to{left:300px}}';

test('render: a CSS animation lands on the exact frame, and the count is what was asked for', { skip }, () => {
  const dir = scratchDir('render-css');
  const out = join(dir, 'out.mp4');
  const r = render([page(dir, 'css.html', CSS_BODY, CSS_STYLE), '--out', out, '--fps', '30', '--frames', '75', '--workers', '2', '--segment', '1']);
  assert.equal(r.code, 0, r.err);
  assert.equal(probe(out, 'stream=nb_read_packets'), '75');
  assert.equal(probe(out, 'stream=pix_fmt'), 'yuv420p');
  const frames = grayFrames(out);
  for (const i of [0, 15, 31, 45, 74]) near(edge(frames[i], 90), Math.round((100 * i) / 30), `box edge at frame ${i}`);
  assert.match(r.out, /75 frames at 30 fps = 2\.500 s, 320x180/);
  assert.match(r.out, /segments: 3 rendered, 0 reused/);
});

test('render: behind a proxy the page still loads from the loopback server', { skip }, () => {
  const dir = scratchDir('render-proxy');
  // Nothing listens on port 9, so any request sent through the proxy fails, and a remote one fails
  // with the proxy's error only when Chrome was handed the proxy (a direct lookup fails to resolve).
  const body = `${CSS_BODY}<script src="http://proxied.invalid/x.js"></script>`;
  const r = render([page(dir, 'css.html', body, CSS_STYLE), '--out', join(dir, 'out.mp4'), '--frames', '3'], { HTTPS_PROXY: 'http://127.0.0.1:9' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /ERR_PROXY_CONNECTION_FAILED\s+http:\/\/proxied\.invalid\/x\.js/);
  assert.doesNotMatch(r.err, /PROXY\S*\s+\/\S*css\.html/, 'the page itself is not sent through it');
});

// An allow-everything profile is still a sandbox, and Chrome cannot start its own inside one.
const SEATBELT = ['-p', '(version 1)(allow default)'];
const seatbelt = process.platform === 'darwin' && spawnSync('sandbox-exec', [...SEATBELT, '/usr/bin/true']).status === 0;

test('render: inside another macOS sandbox, Chrome runs without its own and says so once', { skip: skip || (!seatbelt && 'needs macOS sandbox-exec') }, () => {
  const dir = scratchDir('render-seatbelt');
  const file = page(dir, 'css.html', CSS_BODY, CSS_STYLE);
  const out = join(dir, 'out.mp4');
  const r = spawnSync('sandbox-exec', [...SEATBELT, process.execPath, '--import', 'tsx', CLI, 'render', file, '--out', out, '--frames', '30', '--workers', '2'],
    { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 worker\(s\)/);
  assert.equal(r.stderr.match(/sandbox cannot start/g)?.length, 1, r.stderr);
  near(edge(grayFrames(out)[15], 90), 50, 'box edge at frame 15');
});

test('render: a rational rate keeps its exact timebase and frame times', { skip }, () => {
  const dir = scratchDir('render-ntsc');
  const out = join(dir, 'out.mp4');
  const r = render([page(dir, 'css.html', CSS_BODY, CSS_STYLE), '--out', out, '--fps', '30000/1001', '--duration', '2']);
  assert.equal(r.code, 0, r.err);
  assert.equal(probe(out, 'stream=r_frame_rate,nb_read_packets'), '30000/1001,60');
  const frames = grayFrames(out);
  near(edge(frames[30], 90), Math.round((100 * 30 * 1001) / 30000), 'box edge at frame 30');
});

// Three boxes driven from requestAnimationFrame: one by the clock, one by a per-frame counter, one by a
// seeded random walk. The last two carry state from frame to frame.
const RAF_BODY = `<div class="box" id="a" style="top:20px"></div><div class="box" id="b" style="top:80px"></div><div class="box" id="c" style="top:140px"></div>
<script>
const a = document.getElementById('a'), b = document.getElementById('b'), c = document.getElementById('c');
let n = 0, walk = 0;
function tick() {
  n++;
  walk += Math.random() * 4;
  a.style.left = (performance.now() / 10) + 'px';
  b.style.left = (n * 3) + 'px';
  c.style.left = Math.round(walk % 280) + 'px';
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script>`;

test('render: a requestAnimationFrame page runs on the virtual clock, and its state matches whatever the worker count', { skip }, () => {
  const dir = scratchDir('render-raf');
  const file = page(dir, 'raf.html', RAF_BODY);
  const one = join(dir, 'one.mp4');
  const three = join(dir, 'three.mp4');
  // 100 frames on three workers cut at frames 33 and 67, inside segments, so two segments are
  // assembled from halves rendered by different workers.
  const r1 = render([file, '--out', one, '--fps', '30', '--frames', '100', '--workers', '1', '--segment', '0.5']);
  assert.equal(r1.code, 0, r1.err);
  const r3 = render([file, '--out', three, '--fps', '30', '--frames', '100', '--workers', '3', '--segment', '0.5']);
  assert.equal(r3.code, 0, r3.err);
  assert.match(r3.out, /3 worker\(s\)/);
  const frames = grayFrames(three);
  for (const i of [0, 20, 44, 90]) {
    near(edge(frames[i], 30), Math.round((100 * i) / 30), `clock box at frame ${i}`);
    near(edge(frames[i], 90), 3 * (i + 1), `counter box at frame ${i}`);
  }
  assert.deepEqual(hashes(three, true), hashes(one, true), 'three workers write the same bytes as one');
});

// One box per row, each driven by a different part of the virtual clock's contract: an awaited __seek
// that counts its calls, a setInterval counter, Date.now from rAF, an element.animate() made at 1 s by a
// timer, a stubbed GSAP timeline, and a CSS animation that __seek starts at 1 s.
const CLOCK_BODY = `<div class="box" id="a" style="top:0"></div><div class="box" id="b" style="top:30px"></div>
<div class="box" id="c" style="top:60px"></div><div class="box" id="d" style="top:90px"></div>
<div class="box" id="e" style="top:120px"></div><div class="box" id="f" style="top:150px"></div>
<script>
const $ = (id) => document.getElementById(id);
let calls = 0, ticks = 0;
window.__seek = async (t) => {
  await Promise.resolve();
  $('a').style.left = (++calls * 3) + 'px';
  if (t >= 1) $('f').classList.add('go');
};
setInterval(() => { $('b').style.left = (++ticks * 10) + 'px'; }, 100);
const start = Date.now();
requestAnimationFrame(function tick() { $('c').style.left = Math.round((Date.now() - start) / 10) + 'px'; requestAnimationFrame(tick); });
setTimeout(() => $('d').animate([{ left: '0px' }, { left: '200px' }], { duration: 1000, fill: 'forwards' }), 1000);
window.gsap = { globalTimeline: { seek(t) { $('e').style.left = Math.round(t * 60) + 'px'; } }, ticker: { lagSmoothing() {} } };
</script>`;
const CLOCK_STYLE = '#f.go{animation:grow 1s linear forwards}@keyframes grow{from{left:0}to{left:200px}}';

test('render: timers, Date, element.animate, an awaited __seek, GSAP and animations __seek starts all follow the virtual clock, whatever the worker count', { skip }, () => {
  const dir = scratchDir('render-clock');
  const file = page(dir, 'clock.html', CLOCK_BODY, CLOCK_STYLE);
  const one = join(dir, 'one.mp4');
  const three = join(dir, 'three.mp4');
  const r1 = render([file, '--out', one, '--frames', '60', '--workers', '1', '--segment', '0.5']);
  assert.equal(r1.code, 0, r1.err);
  // Three workers start at frames 20 and 40, inside segments; each must step __seek through every
  // earlier frame, or its call count starts over.
  const r3 = render([file, '--out', three, '--frames', '60', '--workers', '3', '--segment', '0.5']);
  assert.equal(r3.code, 0, r3.err);
  assert.match(r3.out, /3 worker\(s\)/);
  const frames = grayFrames(three);
  for (const i of [30, 45, 59]) {
    const t = (i * 1000) / 30;
    near(edge(frames[i], 10), 3 * (i + 1), `__seek call count at frame ${i}`);
    near(edge(frames[i], 40), 10 * Math.floor(t / 100), `setInterval ticks at frame ${i}`);
    near(edge(frames[i], 70), Math.round(t / 10), `Date.now at frame ${i}`);
    near(edge(frames[i], 100), Math.round((200 * (t - 1000)) / 1000), `element.animate from 1 s at frame ${i}`);
    near(edge(frames[i], 130), Math.round((t / 1000) * 60), `gsap.globalTimeline.seek at frame ${i}`);
    near(edge(frames[i], 160), Math.round((200 * (t - 1000)) / 1000), `CSS animation __seek started at 1 s, at frame ${i}`);
  }
  assert.deepEqual(hashes(three, true), hashes(one, true), 'three workers write the same bytes as one');
});

// Box A slides from load but __seek places it as a scene that starts at 2 s; box B is made at 2 s by
// __seek, which places it at the page's own clock. Both slide 50 px per second. Box C is placed through
// its start time on the real-time document timeline, and slides 1 px per ms, so any drift shows.
const PLACED_BODY = `<div class="box" id="a" style="top:40px"></div><div class="box" id="b" style="top:120px"></div>
<div class="box" id="c" style="top:80px"></div>
<script>
const kf = [{ left: '0px' }, { left: '200px' }];
const a = document.getElementById('a').animate(kf, { duration: 4000, fill: 'both' });
const c = document.getElementById('c').animate([{ left: '0px' }, { left: '10000px' }], { duration: 10000, fill: 'both' });
let b = null;
window.__seek = (t) => {
  a.currentTime = Math.max(0, t - 2) * 1000;
  if (t >= 2 && !b) b = document.getElementById('b').animate(kf, { duration: 4000, fill: 'both' });
  if (b) b.currentTime = t * 1000;
  c.startTime = document.timeline.currentTime - Math.max(0, t - 2) * 100;
};
</script>`;

test('render: an animation time __seek sets is the time captured, whether the animation is old or __seek made it', { skip }, () => {
  const dir = scratchDir('render-placed');
  const stills = join(dir, 'stills');
  const r = render([page(dir, 'placed.html', PLACED_BODY), '--out', stills, '--stills', '2.5,3.5', '--workers', '2']);
  assert.equal(r.code, 0, r.err);
  for (const [name, t] of [['f000075-2.500s.png', 2.5], ['f000105-3.500s.png', 3.5]] as const) {
    const g = grayPng(join(stills, name));
    near(edge(g, 50), Math.round(50 * (t - 2)), `box __seek placed at t - 2 s, at ${t} s`);
    near(edge(g, 130), Math.round(50 * t), `box __seek made and placed at t, at ${t} s`);
    near(edge(g, 90), Math.round(100 * (t - 2)), `box __seek placed through its start time, at ${t} s`);
  }
});

test('render: two renders of one page are identical frame for frame', { skip }, () => {
  const dir = scratchDir('render-det');
  const file = page(dir, 'raf.html', RAF_BODY);
  const a = render([file, '--out', join(dir, 'a.mp4'), '--frames', '30', '--workers', '2', '--segment', '0.5']);
  const b = render([file, '--out', join(dir, 'b.mp4'), '--frames', '30', '--workers', '2', '--segment', '0.5']);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual(hashes(join(dir, 'a.mp4'), false), hashes(join(dir, 'b.mp4'), false));
});

test('render: a <video> shows the picture for each frame, from a long-GOP source', { skip }, () => {
  const dir = scratchDir('render-video');
  // Frame n of the clip has a bright bar at x = 4n, and keyframes 60 frames apart, so a seek that
  // lands one frame early or late is visible.
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=3,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  const file = page(dir, 'video.html', '<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:320px;height:180px"></video>');
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /all-intra copy of clip\.mp4/);
  const frames = grayFrames(out);
  assert.deepEqual(frames.map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 45 }, (_, i) => i));

  // Stills step through every earlier frame too, so they read the all-intra copy as well.
  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '1.2']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.err, /all-intra copy of clip\.mp4/);
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000036-1.200s.png')), 90) / 4), 36);

  // A copy is kept for the next render, and dropped once its source has changed.
  const media = join(`${out}.render`, 'media');
  const kept = readdirSync(media);
  assert.equal(kept.length, 1);
  const again = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(again.code, 0, again.err);
  assert.doesNotMatch(again.err, /all-intra copy/, 'the kept copy is reused');
  assert.deepEqual(readdirSync(media), kept, 'the same copy, not a new one');
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 45 }, (_, i) => i), 'and it still seeks frame-exact');
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, 'clip.mp4'), later, later);
  const changed = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(changed.code, 0, changed.err);
  assert.match(changed.err, /all-intra copy of clip\.mp4/);
  assert.equal(readdirSync(media).length, 1, 'the stale copy is removed');
});

test('render: a <video preload="none"> is loaded, seeked and given its all-intra copy like any other', { skip }, () => {
  const dir = scratchDir('render-preload');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=2,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  // Still unloaded when the page is ready, so the renderer starts its load itself.
  const file = page(dir, 'lazy.html', '<video src="clip.mp4" preload="none" muted playsinline style="position:absolute;left:0;top:0;width:320px;height:180px"></video>');
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '30']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /failed to load or play/, 'a video that loads is not listed as failed');
  assert.match(r.err, /all-intra copy of clip\.mp4/);
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 30 }, (_, i) => i));
});

test('render: a hidden <video> drawn into a canvas still presents the picture each seek asks for', { skip }, () => {
  const dir = scratchDir('render-hidden-video');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=2,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  // The frame fails when a seeked video presents no new picture, so a hidden one must present too. The
  // bottom canvas is drawn the way the help says to draw a video's own frame.
  const file = page(dir, 'hidden.html', `<video id="v" src="clip.mp4" muted playsinline style="display:none"></video>
<canvas id="c" width="${W}" height="${H / 2}" style="position:absolute;left:0;top:0"></canvas>
<canvas id="s" width="${W}" height="${H / 2}" style="position:absolute;left:0;top:${H / 2}px"></canvas>
<script>
const v = document.getElementById('v'), ctx = document.getElementById('c').getContext('2d'), s = document.getElementById('s').getContext('2d');
requestAnimationFrame(function draw() { ctx.drawImage(v, 0, 0); requestAnimationFrame(draw); });
window.__seek = async () => { if (v.seeking) await new Promise((r) => v.addEventListener('seeked', r, { once: true })); s.drawImage(v, 0, 0); };
</script>`);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '30']);
  assert.equal(r.code, 0, r.err);
  // requestAnimationFrame runs before the frame's seek, so its canvas holds the picture of the frame before.
  const frames = grayFrames(out);
  for (const i of [10, 20, 29]) {
    assert.equal(Math.round(edge(frames[i], H / 4) / 4), i - 1, `canvas drawn from requestAnimationFrame at frame ${i}`);
    assert.equal(Math.round(edge(frames[i], (3 * H) / 4) / 4), i, `canvas drawn in __seek at frame ${i}`);
  }
});

test('render: a patch re-renders only the segments it touches and leaves the rest bit-identical', { skip }, () => {
  const dir = scratchDir('render-patch');
  const file = page(dir, 'css.html', CSS_BODY, CSS_STYLE);
  const out = join(dir, 'out.mp4');
  const full = render([file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1', '--workers', '2']);
  assert.equal(full.code, 0, full.err);
  const before = hashes(out, true);

  // The change shows on every frame, so only the re-rendered segment can carry it.
  writeFileSync(file, readFileSync(file, 'utf8').replace('.box{position:absolute;width:20px;height:20px;background:#fff}', '.box{position:absolute;width:20px;height:40px;background:#fff}'));
  const patch = render([file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1', '--from', '1.2', '--to', '1.5']);
  assert.equal(patch.code, 0, patch.err);
  assert.match(patch.out, /segments: 1 rendered, 2 reused/);
  assert.match(patch.out, /30 rendered frame/);
  const after = hashes(out, true);
  assert.equal(after.length, 90);
  assert.deepEqual(after.slice(0, 30), before.slice(0, 30), 'segment 0 untouched');
  assert.deepEqual(after.slice(60), before.slice(60), 'segment 2 untouched');
  assert.notDeepEqual(after.slice(30, 60), before.slice(30, 60), 'segment 1 re-rendered');
  const frames = grayFrames(out);
  assert.ok(frames[45][115 * W + edge(frames[45], 90) + 5] > 128, 'the taller box is in the patched segment');
  assert.ok(frames[75][115 * W + edge(frames[75], 90) + 5] < 128, 'and not in the reused one');

  const refused = render([file, '--out', out, '--fps', '25', '--frames', '90', '--segment', '1', '--from', '1']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /made differently \(fps "30" → "25"/);

  const fresh = render([file, '--out', join(dir, 'fresh.mp4'), '--frames', '90', '--from', '1']);
  assert.equal(fresh.code, 2);
  assert.match(fresh.err, /nothing to patch/);

  // A lock held by a live process refuses; one left by a process that is gone is taken over.
  const lock = join(`${out}.render`, '.lock');
  writeFileSync(lock, String(process.pid));
  const locked = render([file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1', '--from', '1.2', '--to', '1.5']);
  assert.notEqual(locked.code, 0);
  assert.match(locked.err, new RegExp(`another render \\(pid ${process.pid}\\)`));
  writeFileSync(lock, '2147483646');
  const taken = render([file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1', '--from', '1.2', '--to', '1.5']);
  assert.equal(taken.code, 0, taken.err);
  assert.equal(existsSync(lock), false, 'the lock is released');
  // An empty lock is a render that has not written its PID yet, until it is too old to be one.
  writeFileSync(lock, '');
  const starting = render([file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1', '--from', '1.2', '--to', '1.5']);
  assert.notEqual(starting.code, 0);
  assert.match(starting.err, /another render \(starting\)/);
  const stale = new Date(Date.now() - 20_000);
  utimesSync(lock, stale, stale);
  const late = render([file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1', '--from', '1.2', '--to', '1.5']);
  assert.equal(late.code, 0, late.err);
});

test('render: a patch is refused when the --chrome binary changed since the cached render, its version line alike', {
  skip: skip || (process.platform === 'win32' && 'a shell-script stand-in cannot run on Windows'),
}, () => {
  const dir = scratchDir('render-chrome-build');
  const chrome = join(dir, 'chrome');
  const real = installedChrome(platform!);
  writeFileSync(chrome, `#!/bin/sh\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const out = join(dir, 'out.mp4');
  const args = [page(dir, 'css.html', CSS_BODY, CSS_STYLE), '--out', out, '--frames', '30', '--segment', '0.5', '--chrome', chrome];
  const full = render(args);
  assert.equal(full.code, 0, full.err);
  // The same version line from another build on disk, as a Chrome that updated itself in place prints.
  writeFileSync(chrome, `#!/bin/sh\n# updated\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const patch = render([...args, '--from', '0.5']);
  assert.equal(patch.code, 2, patch.err);
  assert.match(patch.err, /made differently \(browser "[^"(]+ \(\S+, \d+ bytes, modified [^"]+" → "[^"(]+ \(\S+, \d+ bytes/);
});

test('render: a patch whose range comes out blank fails and leaves the output as it was', { skip }, () => {
  const dir = scratchDir('render-blank-patch');
  const file = page(dir, 'css.html', CSS_BODY, CSS_STYLE);
  const drawn = readFileSync(file, 'utf8');
  const out = join(dir, 'out.mp4');
  const args = [file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1'];
  const full = render([...args, '--workers', '2']);
  assert.equal(full.code, 0, full.err);
  const before = createHash('sha256').update(readFileSync(out)).digest('hex');
  const packets = hashes(out, true);

  // An edit that hides everything, as a renamed stylesheet or a stage at opacity 0 would.
  writeFileSync(file, drawn.replace('</style>', '.box{display:none}</style>'));
  const blank = render([...args, '--from', '1.2', '--to', '1.5']);
  assert.equal(blank.code, 1, blank.err);
  assert.match(blank.err, /every re-rendered frame is one flat colour where the render it patches drew: the page drew nothing in the patched range; \S*out\.mp4 was left as it was\. If the range is meant to be empty, render without --from\/--to/);
  assert.equal(createHash('sha256').update(readFileSync(out)).digest('hex'), before, 'the output is byte for byte what it was');

  // The refused segment is not kept, so the next patch renders it again.
  writeFileSync(file, drawn);
  const fixed = render([...args, '--from', '1.2', '--to', '1.5']);
  assert.equal(fixed.code, 0, fixed.err);
  assert.match(fixed.out, /segments: 1 rendered, 2 reused/);
  assert.deepEqual(hashes(out, true), packets, 'the same page renders the same frames');
});

test('render: a patch whose range was already blank may come out blank', { skip }, () => {
  const dir = scratchDir('render-blank-range');
  // The box leaves the stage within the first second, so every later segment is flat black.
  const file = page(dir, 'css.html', CSS_BODY, '#box{animation:slide 3s linear forwards}@keyframes slide{from{left:0}to{left:1000px}}');
  const out = join(dir, 'out.mp4');
  const args = [file, '--out', out, '--fps', '30', '--frames', '90', '--segment', '1'];
  const full = render(args);
  assert.equal(full.code, 0, full.err);
  writeFileSync(file, readFileSync(file, 'utf8').replace('height:20px', 'height:40px'));
  const patch = render([...args, '--from', '1.2', '--to', '1.5']);
  assert.equal(patch.code, 0, patch.err);
  assert.match(patch.out, /segments: 1 rendered, 2 reused/);
});

/** Gray bytes of one PNG. */
function grayPng(png: string): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
}

test('render: a centred stage is captured where it sits in the viewport it is captured from', { skip }, () => {
  const dir = scratchDir('render-centre');
  // A white body around a black stage, so a capture that slips off the stage shows white at an edge.
  const centred = (name: string, w: number, h: number) => {
    const file = join(dir, name);
    writeFileSync(file, `<!doctype html><html><head><style>html,body{margin:0;background:#fff}
body{display:grid;place-items:center;min-height:100vh}
[data-stage]{position:relative;width:${w}px;height:${h}px;background:#000;overflow:hidden}
.box{position:absolute;left:100px;top:80px;width:20px;height:20px;background:#fff}</style></head>
<body><div data-stage><div class="box"></div></div></body></html>`);
    return file;
  };
  const dark = (frame: Buffer, w: number, h: number, what: string) => {
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [0, h >> 1], [w - 1, h >> 1]]) {
      assert.ok(frame[y * w + x] < 64, `${what}: pixel ${x},${y} is the stage's, not the body's`);
    }
  };
  const out = join(dir, 'wide.mp4');
  // Two workers, so the second opens its own Chrome and must be handed the same viewport and clip.
  const r = render([centred('wide.html', W, H), '--out', out, '--frames', '30', '--workers', '2']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /320x180/);
  assert.match(r.out, /2 worker\(s\)/);
  const wide = grayFrames(out);
  for (const i of [0, 29]) {
    const f = wide[i];
    dark(f, W, H, `wide stage, frame ${i}`);
    near(edge(f, 90), 100, `box edge in stage coordinates, frame ${i}`);
  }

  // Sized by the viewport but inside the first one: measured again it changes, so the first measurement stands.
  const loose = join(dir, 'loose.html');
  writeFileSync(loose, `<!doctype html><html><head><style>html,body{margin:0;background:#fff}
[data-stage]{position:absolute;left:10px;top:10px;width:50vw;height:50vh;background:#000;overflow:hidden}
.box{position:absolute;left:100px;top:80px;width:20px;height:20px;background:#fff}</style></head>
<body><div data-stage><div class="box"></div></div></body></html>`);
  const half = render([loose, '--out', join(dir, 'loose'), '--stills', '0']);
  assert.equal(half.code, 0, half.err);
  const h = grayPng(join(dir, 'loose', 'f000000-0.000s.png'));
  assert.equal(h.length, 960 * 540, 'the stage as the 1920x1080 viewport measured it');
  dark(h, 960, 540, 'half-viewport stage');
  assert.ok(h[90 * 960 + 105] > 128, 'the box sits at its stage coordinates');
  // Taller than that viewport and growing with every larger one: there is no viewport to capture it from.
  const grows = join(dir, 'grows.html');
  writeFileSync(grows, '<!doctype html><html><head><style>html,body{margin:0}[data-stage]{width:100vw;height:200vh;background:#000}</style></head><body><div data-stage></div></body></html>');
  const g2 = render([grows, '--out', join(dir, 'grows'), '--stills', '0']);
  assert.equal(g2.code, 2, g2.err);
  assert.match(g2.err, /its size or place follows the viewport/);

  // Taller than the 1920x1080 viewport the stage is first measured in.
  const tall = render([centred('tall.html', 1080, 1920), '--out', join(dir, 'tall'), '--stills', '0']);
  assert.equal(tall.code, 0, tall.err);
  const g = grayPng(join(dir, 'tall', 'f000000-0.000s.png'));
  assert.equal(g.length, 1080 * 1920, 'the still is the stage\'s size');
  dark(g, 1080, 1920, 'tall stage');
  assert.ok(g[90 * 1080 + 105] > 128, 'the box sits at its stage coordinates');

  const odd = render([centred('odd.html', 321, 180), '--out', join(dir, 'odd.mp4'), '--frames', '3']);
  assert.equal(odd.code, 2);
  assert.match(odd.err, /stage is 321x180; H\.264 needs even sides/);
});

test('render: a page that draws nothing fails, naming why', { skip }, () => {
  const dir = scratchDir('render-blank');
  const file = join(dir, 'blank.html');
  // Its stylesheet is missing, which is the kind of cause the failure has to show beside itself.
  writeFileSync(file, '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>');
  const r = render([file, '--out', join(dir, 'out.mp4'), '--width', '320', '--height', '180', '--frames', '10']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /every rendered frame is one flat colour/);
  assert.match(r.err, /failed to load or play before the failure below:\n\s+HTTP 404 .*styles\.css/);
  assert.equal(existsSync(join(dir, 'out.mp4')), false);
});

test('render: a page that throws, or leaves a rejection unhandled, fails with the page\'s own message', { skip }, () => {
  const dir = scratchDir('render-throw');
  const thrown = page(dir, 'throw.html', `${CSS_BODY}<script>let k = 0; requestAnimationFrame(function f() { if (++k === 3) throw new Error('tick three broke'); requestAnimationFrame(f); });</script>`, CSS_STYLE);
  const r1 = render([thrown, '--out', join(dir, 'a.mp4'), '--frames', '20']);
  assert.notEqual(r1.code, 0);
  assert.match(r1.err, /the page threw: .*tick three broke/);
  const rejected = page(dir, 'reject.html', `${CSS_BODY}<script>Promise.reject(new Error('nobody caught this'));</script>`, CSS_STYLE);
  const r2 = render([rejected, '--out', join(dir, 'b.mp4'), '--frames', '20']);
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /nobody caught this/);
  // A library that failed to load makes the page throw while it loads; the failed load is printed too.
  const unloaded = page(dir, 'unloaded.html', `${CSS_BODY}<script src="gsap.min.js"></script><script>gsap.to('#box', { x: 10 });</script>`);
  const r3 = render([unloaded, '--out', join(dir, 'c.mp4'), '--frames', '20']);
  assert.notEqual(r3.code, 0);
  assert.match(r3.err, /HTTP 404 .*gsap\.min\.js/);
  assert.match(r3.err, /the page threw: .*gsap is not defined/);
});

test('render: a missing image or an unplayable video is a warning, and the render still delivers', { skip }, () => {
  const dir = scratchDir('render-warn');
  writeFileSync(join(dir, 'broken.mp4'), 'this is not a video');
  writeFileSync(join(dir, 'broken.woff2'), 'this is not a font');
  writeFileSync(join(dir, 'junk.png'), 'this is not a picture');
  // No width, height or viewBox: an SVG with no size of its own, which draws and must not be listed.
  writeFileSync(join(dir, 'plain.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#fff"/></svg>');
  const file = page(dir, 'warn.html', `${CSS_BODY}<img src="missing.png"><img src="junk.png"><img src="plain.svg"><video src="broken.mp4"></video>
<video><source src="clip.xyz" type="video/x-unknown"></video><video><source src="gone.mp4"></video><video></video><p style="font-family:Broken">text</p>`,
  `${CSS_STYLE}@font-face{font-family:Broken;src:url(broken.woff2) format('woff2')}`);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '10']);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(out));
  assert.match(r.err, /warning: 8 resource\(s\) failed to load or play; the frames were rendered without them/);
  assert.match(r.err, /video <video>: it has no source/, 'a video with nothing to load is not waited on');
  assert.match(r.err, /image \/\S+\/junk\.png could not be loaded or decoded/, 'an image served whole that does not decode');
  assert.doesNotMatch(r.err, /image \S+missing\.png/, 'a failed load is listed once, as that');
  assert.match(r.err, /HTTP 404 .*missing\.png/);
  assert.match(r.err, /video \/\S+\/broken\.mp4 could not be played/, 'named by its file, not its URL');
  assert.match(r.err, /video \/\S+\/clip\.xyz: none of its sources is one Chrome can play/);
  assert.match(r.err, /HTTP 404 .*gone\.mp4/);
  assert.match(r.err, /video \/\S+\/gone\.mp4: none of its sources loaded/, 'a source that did not load is not blamed on its format');
  assert.match(r.err, /font Broken normal normal failed to load/);
});

test('render: a video the page gives its source in __seek is not listed as having none, and plays', { skip }, () => {
  const dir = scratchDir('render-late-source');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=2,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  // Sourceless when the page becomes ready; its source arrives with the first frame.
  const file = page(dir, 'late.html', `<video id="v" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<script>
const v = document.getElementById('v');
window.__seek = () => { if (!v.hasAttribute('src')) v.src = 'clip.mp4'; };
</script>`);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '30', '--workers', '2']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /it has no source|failed to load or play/);
  const frames = grayFrames(out);
  for (const i of [10, 20, 29]) assert.equal(Math.round(edge(frames[i], 90) / 4), i, `video at frame ${i}`);
});

test('render: the page reads only beneath its roots, and a refused file it draws with fails the render with the remedy', { skip }, () => {
  const dir = scratchDir('render-roots');
  const beyond = scratchDir('render-beyond');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=20x20', '-frames:v', '1', join(beyond, 'secret.png')]);
  mkdirSync(join(dir, '.hidden'));
  copyFileSync(join(beyond, 'secret.png'), join(dir, '.hidden', 'pic.png'));
  const outside = page(dir, 'outside.html', `${CSS_BODY}<img src="../${basename(beyond)}/secret.png">`, CSS_STYLE);
  const r = render([outside, '--out', join(dir, 'a.mp4'), '--frames', '5']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /refused 1 file\(s\) the page needs.*\n\s+\S*secret\.png: outside the served roots; --root \S*render-beyond\S* would let the page read it/);
  assert.equal(existsSync(join(dir, 'a.mp4')), false);
  const wider = render([outside, '--out', join(dir, 'b.mp4'), '--frames', '5', '--root', beyond]);
  assert.equal(wider.code, 0, wider.err);
  assert.doesNotMatch(wider.err, /secret\.png/, '--root lets the page read there');

  const hidden = page(dir, 'hidden.html', `${CSS_BODY}<img src=".hidden/pic.png">`, CSS_STYLE);
  const h = render([hidden, '--out', join(dir, 'c.mp4'), '--frames', '5', '--root', dir]);
  assert.equal(h.code, 1, h.err);
  assert.match(h.err, /\S*pic\.png: hidden \(dot\) path refused\n/, 'no --root admits a hidden name, so none is offered');

  // Nothing outside the roots is looked up, so a missing file there is refused like any other, and a hidden
  // folder is not offered as a --root.
  const stale = render([page(dir, 'stale.html', `${CSS_BODY}<img src="../${basename(beyond)}/nope.png">`, CSS_STYLE), '--out', join(dir, 'f.mp4'), '--frames', '5']);
  assert.equal(stale.code, 1, stale.err);
  assert.match(stale.err, /\S*nope\.png: outside the served roots; --root \S*render-beyond\S* would let the page read it\n/);
  mkdirSync(join(beyond, '.cache'));
  copyFileSync(join(beyond, 'secret.png'), join(beyond, '.cache', 'pic.png'));
  const cached = render([page(dir, 'cached.html', `${CSS_BODY}<img src="../${basename(beyond)}/.cache/pic.png">`, CSS_STYLE), '--out', join(dir, 'g.mp4'), '--frames', '5']);
  assert.equal(cached.code, 1, cached.err);
  assert.match(cached.err, /pic\.png: outside the served roots; it sits in a hidden folder, which render does not serve\n/,
    'and no advice to copy it where the page can read it');

  // A frame's document and a text track are drawn by the browser, which gives the page nothing to act on.
  writeFileSync(join(beyond, 'frame.html'), '<p>frame</p>');
  writeFileSync(join(beyond, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n');
  for (const [name, embed, file] of [
    ['framed.html', `<iframe src="../${basename(beyond)}/frame.html"></iframe>`, 'frame.html'],
    ['tracked.html', `<video><track default kind="captions" src="../${basename(beyond)}/captions.vtt"></video>`, 'captions.vtt'],
  ]) {
    const e = render([page(dir, name, `${CSS_BODY}${embed}`, CSS_STYLE), '--out', join(dir, 'e.mp4'), '--frames', '5']);
    assert.equal(e.code, 1, e.err);
    assert.match(e.err, new RegExp(`refused 1 file\\(s\\) the page needs.*\\n\\s+\\S*${file.replace('.', '\\.')}: outside the served roots`));
  }

  // A fetch sees its own 403 and can carry on, so it is only a failed load.
  const fetched = page(dir, 'fetched.html', `${CSS_BODY}<script>fetch('.hidden/pic.png');</script>`, CSS_STYLE);
  const f = render([fetched, '--out', join(dir, 'd.mp4'), '--frames', '5']);
  assert.equal(f.code, 0, f.err);
  assert.match(f.err, /HTTP 403 Hidden \(dot\) path refused .*pic\.png/);
});

test('render: stills render only the named moments, with a contact sheet', { skip }, () => {
  const dir = scratchDir('render-stills');
  const outDir = join(dir, 'stills');
  const sheet = join(dir, 'sheet.jpg');
  const r = render([page(dir, 'css.html', CSS_BODY, CSS_STYLE), '--out', outDir, '--stills', '0.5,1.5', '--sheet', sheet]);
  assert.equal(r.code, 0, r.err);
  const shots = [[join(outDir, 'f000015-0.500s.png'), 50], [join(outDir, 'f000045-1.500s.png'), 150]] as const;
  for (const [png, x] of shots) {
    const gray = execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'format=gray', '-f', 'rawvideo', '-']);
    assert.equal(gray.length, W * H, `${png} is ${W}x${H}`);
    near(edge(gray, 90), x, png);
  }
  assert.deepEqual(readdirSync(outDir).sort(), ['f000015-0.500s.png', 'f000045-1.500s.png'], 'the two stills and nothing else');
  assert.equal(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sheet], { encoding: 'utf8' }).trim(), '1286,360',
    'two tiles scaled to 640 wide, side by side and 6 px apart');
  assert.equal(existsSync(`${outDir}.render`), false, 'no video cache: stills render no video');
});

test('render: --transparent writes ProRes 4444 whose alpha is the page\'s own coverage', { skip }, () => {
  const dir = scratchDir('render-alpha');
  const file = join(dir, 'alpha.html');
  writeFileSync(file, `<!doctype html><html><head><style>html,body{margin:0}#stage{position:relative;width:${W}px;height:${H}px}
.box{position:absolute;left:100px;top:80px;width:40px;height:20px;background:#fff}</style></head><body><div id="stage"><div class="box"></div></div></body></html>`);
  const out = join(dir, 'out.mov');
  const r = render([file, '--out', out, '--frames', '5', '--transparent']);
  assert.equal(r.code, 0, r.err);
  assert.equal(probe(out, 'stream=codec_name,pix_fmt,nb_read_packets'), 'prores,yuva444p12le,5');
  const alpha = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-frames:v', '1', '-vf', 'alphaextract,format=gray', '-f', 'rawvideo', '-']);
  assert.equal(alpha[90 * W + 110], 255, 'opaque where the box is');
  assert.equal(alpha[20 * W + 20], 0, 'clear where nothing is drawn');
  const mp4 = render([file, '--out', join(dir, 'out.mp4'), '--frames', '5', '--transparent']);
  assert.equal(mp4.code, 2);
  assert.match(mp4.err, /needs a \.mov/);
});
