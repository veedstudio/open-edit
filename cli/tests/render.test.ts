// The render command end to end, in the pinned headless Chrome: frame counts, pixels at known frames,
// determinism across worker counts, patching, and the failures that must be loud. Skipped when the
// browser is not installed (`openedit install-browser`), unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { cpuCount, defaultWorkers, MIN_FRAMES_PER_WORKER } from '../src/commands/render.ts';
import { facesScript } from '../src/faces/page-script.ts';
import { readRecord, recordPath } from '../src/render/text-record.ts';
import { assertConverted, hdr10Data, hdrClip, lumaOf, type Transfer } from './helpers/hdr.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
// Set where the browser was installed on purpose, so losing that install fails the suite instead of skipping it.
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;
const W = 320;
const H = 180;

/** The workspace a render writes its copies under: beside its --out, so a test finds only the copies it made. */
function renderEnv(args: string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const at = args.indexOf('--out');
  return { ...process.env, ...(at >= 0 ? { OPEN_EDIT_ROOT: dirname(resolve(args[at + 1])) } : {}), ...env };
}

function render(args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 240_000, env: renderEnv(args, env) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** render(), without waiting for it: renders started together run at the same time. */
function renderAsync(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { env: renderEnv(args, env) });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => done({ code, out, err }));
  });
}

function page(dir: string, name: string, body: string, style = '', stageAttrs = ''): string {
  const file = join(dir, name);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000}
.box{position:absolute;width:20px;height:20px;background:#fff}
${style}</style></head><body><div id="stage"${stageAttrs ? ` ${stageAttrs}` : ''}>${body}</div></body></html>`);
  return file;
}

const STATELESS = 'data-stateless';
const PREROLL = /preroll: \d+ earlier frame\(s\) stepped through/;

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
  // A picture that opens on something and moves throughout has nothing said about it.
  assert.match(r.out, /picture scanned in \d+\.\d s/);
  assert.doesNotMatch(r.out, /picture: /);
});

/** Frame 0 of a video as yuv420p planes. */
function yuvPlanes(video: string): { y: Buffer; u: Buffer; v: Buffer } {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  assert.equal(raw.length, (W * H * 3) / 2);
  return { y: raw.subarray(0, W * H), u: raw.subarray(W * H, W * H + (W * H) / 4), v: raw.subarray(W * H + (W * H) / 4) };
}

const meanAbsDiff = (a: Buffer, b: Buffer): number => a.reduce((sum, x, i) => sum + Math.abs(x - b[i]), 0) / a.length;

test('render: --capture jpeg lands on the exact frames, in the PNG path\'s colours, and is refused where a JPEG cannot serve', { skip }, () => {
  const dir = scratchDir('render-jpeg');
  // A saturated background: a JPEG read with the wrong matrix would shift it by a dozen levels.
  const file = page(dir, 'css.html', CSS_BODY, `${CSS_STYLE}#stage{background:#c8321e}`);
  const out = join(dir, 'jpeg.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '75', '--workers', '2', '--segment', '1', '--capture', 'jpeg']);
  assert.equal(r.code, 0, r.err);
  assert.equal(probe(out, 'stream=pix_fmt,nb_read_packets'), 'yuv420p,75');
  const frames = grayFrames(out);
  for (const i of [0, 15, 31, 45, 74]) near(edge(frames[i], 90), Math.round((100 * i) / 30), `box edge at frame ${i}`);
  assert.match(r.out, /segments: 3 rendered, 0 reused/);

  const exact = join(dir, 'png.mp4');
  const p = render([file, '--out', exact, '--fps', '30', '--frames', '75', '--workers', '2', '--segment', '1']);
  assert.equal(p.code, 0, p.err);
  const a = yuvPlanes(exact);
  const b = yuvPlanes(out);
  for (const plane of ['y', 'u', 'v'] as const) {
    const diff = meanAbsDiff(a[plane], b[plane]);
    assert.ok(diff < 1.5, `${plane} plane differs from the PNG render by ${diff.toFixed(2)} levels on average`);
  }
  for (const plane of ['u', 'v'] as const) {
    assert.ok(Math.abs(a[plane][5 * (W / 2) + 5] - b[plane][5 * (W / 2) + 5]) <= 2, `${plane} of the flat background matches the PNG render`);
  }

  // The cache records the capture, so a patch after switching is refused as made differently.
  const patch = render([file, '--out', out, '--fps', '30', '--frames', '75', '--segment', '1', '--from', '1']);
  assert.equal(patch.code, 2, patch.err);
  assert.match(patch.err, /made differently \(capture "jpeg" → "png"; encoder /);
  const same = render([file, '--out', out, '--fps', '30', '--frames', '75', '--segment', '1', '--from', '1', '--capture', 'jpeg']);
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /segments: 2 rendered, 1 reused/);

  const alpha = render([file, '--out', join(dir, 'a.mov'), '--frames', '3', '--transparent', '--capture', 'jpeg']);
  assert.equal(alpha.code, 2);
  assert.match(alpha.err, /--transparent keeps the page's alpha, which a JPEG cannot carry/);
  const stills = render([file, '--out', join(dir, 'stills'), '--stills', '0.5', '--capture', 'jpeg']);
  assert.equal(stills.code, 2);
  assert.match(stills.err, /--stills writes PNG files; --capture jpeg applies to a video/);
  assert.equal(existsSync(join(dir, 'stills')), false);
  const webp = render([file, '--out', join(dir, 'w.mp4'), '--frames', '3', '--capture', 'webp']);
  assert.equal(webp.code, 2);
  assert.match(webp.err, /--capture must be png or jpeg, not "webp"/);
});

/** Every frame of a video as 8-bit gray, at its own size. */
function grayFramesOf(video: string, w: number, h: number): Buffer[] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  return Array.from({ length: raw.length / (w * h) }, (_, i) => raw.subarray(i * w * h, (i + 1) * w * h));
}

test('render: --draft draws the same motion at half the size, its settings are recorded for a patch, and each can be set alone', { skip }, () => {
  const dir = scratchDir('render-draft');
  const file = page(dir, 'css.html', CSS_BODY, CSS_STYLE);
  const out = join(dir, 'out.draft.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '75', '--workers', '2', '--segment', '1', '--draft']);
  assert.equal(r.code, 0, r.err);
  assert.equal(probe(out, 'stream=width,height,pix_fmt,nb_read_packets'), '160,90,yuv420p,75');
  assert.match(r.out, /75 frames at 30 fps = 2\.500 s, 160x90 \(the 320x180 canvas at 0\.5\)/);
  assert.match(r.out, /draft: jpeg q80 capture, x264 ultrafast CRF 28; render without --draft for the deliverable/);
  // The layout is the page's own, drawn smaller: the box sits at half its place on the canvas.
  const frames = grayFramesOf(out, W / 2, H / 2);
  for (const i of [0, 15, 45, 74]) {
    const x = frames[i].subarray(45 * (W / 2), 46 * (W / 2)).findIndex((v) => v > 128);
    assert.ok(Math.abs(x - Math.round((100 * i) / 30) / 2) <= 1, `box edge at frame ${i}: ${x}`);
  }

  // A patch keeps the draft's settings; one that drops a setting is refused, naming it.
  const same = render([file, '--out', out, '--fps', '30', '--frames', '75', '--segment', '1', '--from', '1', '--draft']);
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /segments: 2 rendered, 1 reused/);
  const full = render([file, '--out', out, '--fps', '30', '--frames', '75', '--segment', '1', '--from', '1', '--draft', '--scale', '1']);
  assert.equal(full.code, 2, full.err);
  assert.match(full.err, /made differently \(scale 0\.5 → 1; encoder /);

  // An override: full size, still the draft's capture and encode.
  const sized = render([file, '--out', join(dir, 'full.draft.mp4'), '--fps', '30', '--frames', '15', '--draft', '--scale', '1']);
  assert.equal(sized.code, 0, sized.err);
  assert.equal(probe(join(dir, 'full.draft.mp4'), 'stream=width,height'), '320,180');
  // One setting without --draft, and a scale that leaves an odd side, which is cropped to even.
  const odd = render([file, '--out', join(dir, 'odd.mp4'), '--fps', '30', '--frames', '15', '--scale', '0.45']);
  assert.equal(odd.code, 0, odd.err);
  assert.equal(probe(join(dir, 'odd.mp4'), 'stream=width,height'), '144,80');
  assert.match(odd.out, /144x80 \(the 320x180 canvas at 0\.45\)/);
  assert.doesNotMatch(odd.out, /draft:/);
  // ProRes keeps the odd side H.264 crops.
  const alpha = render([file, '--out', join(dir, 'odd.mov'), '--fps', '30', '--frames', '5', '--scale', '0.45', '--transparent']);
  assert.equal(alpha.code, 0, alpha.err);
  assert.equal(probe(join(dir, 'odd.mov'), 'stream=width,height'), '144,81');
  // An odd canvas is refused only unscaled: scaled, it is cropped after it is drawn.
  const oddCanvas = render([file, '--out', join(dir, 'canvas.draft.mp4'), '--fps', '30', '--frames', '5', '--width', '321', '--height', '181', '--draft']);
  assert.equal(oddCanvas.code, 0, oddCanvas.err);
  assert.equal(probe(join(dir, 'canvas.draft.mp4'), 'stream=width,height'), '160,90');
  // A scale that leaves no picture is refused before a frame is drawn.
  const tiny = render([file, '--out', join(dir, 'tiny.mp4'), '--fps', '30', '--frames', '5', '--width', '10', '--height', '10', '--scale', '0.1']);
  assert.equal(tiny.code, 2, tiny.err);
  assert.match(tiny.err, /--scale 0\.1 leaves the 10x10 canvas 0x0, and a video needs at least 2x2: give a larger --scale/);
});

test('render: a scaled capture of a page with no stage shows where the page has scrolled, as the full-size one does', { skip }, () => {
  const dir = scratchDir('render-scaled-scroll');
  // Black above, white below with a black box in its corner (a flat frame is refused as drawing nothing);
  // each frame scrolls to the white half.
  const file = join(dir, 'scroll.html');
  writeFileSync(file, `<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head><body>
<div style="height:${H}px;background:#000"></div><div style="height:${H}px;background:#fff"><div style="width:20px;height:20px;background:#000"></div></div>
<script>window.__seek = () => window.scrollTo(0, ${H});</script></body></html>`);
  for (const scale of ['1', '0.5']) {
    const out = join(dir, `out-${scale}.mp4`);
    const r = render([file, '--out', out, '--fps', '30', '--frames', '3', '--width', String(W), '--height', String(H), '--scale', scale]);
    assert.equal(r.code, 0, r.err);
    const s = Number(scale);
    for (const f of grayFramesOf(out, W * s, H * s)) {
      // Below the box's rows, all white; the box itself in the corner.
      assert.ok(f.subarray(30 * s * W * s).every((v) => v > 200), `at --scale ${scale} the frame shows the scrolled-to white half`);
      assert.ok(f[4 * W * s + 4] < 50,`at --scale ${scale} the box sits in the corner`);
    }
  }
});

test('render: under --capture jpeg a page that draws nothing still fails, naming why', { skip }, () => {
  const dir = scratchDir('render-jpeg-blank');
  const file = join(dir, 'blank.html');
  writeFileSync(file, '<!doctype html><html><head><style>html,body{margin:0;background:#246}</style></head><body></body></html>');
  const r = render([file, '--out', join(dir, 'out.mp4'), '--width', '320', '--height', '180', '--frames', '10', '--capture', 'jpeg']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /every rendered frame is one flat colour: the page drew nothing/);
  assert.equal(existsSync(join(dir, 'out.mp4')), false);
  // A page that fades in from black draws nothing on its first frames; the segment is still drawn.
  const fade = page(dir, 'fade.html', CSS_BODY, '#stage{animation:in 1s linear both}@keyframes in{from{opacity:0}to{opacity:1}}');
  const f = render([fade, '--out', join(dir, 'fade.mp4'), '--fps', '30', '--frames', '20', '--capture', 'jpeg']);
  assert.equal(f.code, 0, f.err);
  assert.equal(probe(join(dir, 'fade.mp4'), 'stream=nb_read_packets'), '20');
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
  assert.match(r3.out, PREROLL, 'a page not marked stateless is stepped through the frames before each worker\'s first');
  const frames = grayFrames(three);
  for (const i of [0, 20, 44, 90]) {
    near(edge(frames[i], 30), Math.round((100 * i) / 30), `clock box at frame ${i}`);
    near(edge(frames[i], 90), 3 * (i + 1), `counter box at frame ${i}`);
  }
  assert.deepEqual(hashes(three, true), hashes(one, true), 'three workers write the same bytes as one');
});

// A CSS animation running from load, and a box __seek places from t: nothing carried between frames.
const STATELESS_BODY = `${CSS_BODY}<div class="box" id="p" style="top:140px"></div>
<script>window.__seek = (t) => { document.getElementById('p').style.left = Math.round(t * 60) + 'px'; };</script>`;

test('render: a page marked data-stateless renders the same on 1 and 3 workers, and no worker steps through earlier frames', { skip }, () => {
  const dir = scratchDir('render-stateless');
  const file = page(dir, 'stateless.html', STATELESS_BODY, CSS_STYLE, STATELESS);
  const one = join(dir, 'one.mp4');
  const three = join(dir, 'three.mp4');
  const r1 = render([file, '--out', one, '--fps', '30', '--frames', '100', '--workers', '1', '--segment', '0.5']);
  assert.equal(r1.code, 0, r1.err);
  const r3 = render([file, '--out', three, '--fps', '30', '--frames', '100', '--workers', '3', '--segment', '0.5']);
  assert.equal(r3.code, 0, r3.err);
  assert.match(r3.out, /3 worker\(s\)/);
  assert.doesNotMatch(r3.out, PREROLL, 'the workers jumped to frames 33 and 67 without stepping through the frames before them');
  const frames = grayFrames(three);
  // The first frame of each worker, where a jump that lost the animation's start or __seek's placement would show.
  for (const i of [0, 33, 67, 89]) {
    near(edge(frames[i], 90), Math.round((100 * i) / 30), `CSS animation at frame ${i}`);
    near(edge(frames[i], 150), Math.round((60 * i) / 30), `__seek-placed box at frame ${i}`);
  }
  assert.deepEqual(hashes(three, true), hashes(one, true), 'three workers write the same bytes as one');
});

test('render: the data-stateless check runs under a JPEG capture and a draft as under PNG', { skip }, () => {
  const dir = scratchDir('render-stateless-jpeg');
  const file = page(dir, 'stateless.html', STATELESS_BODY, CSS_STYLE, STATELESS);
  for (const [out, flags] of [['jpeg.mp4', ['--capture', 'jpeg']], ['quick.draft.mp4', ['--draft']]] as const) {
    const r = render([file, '--out', join(dir, out), '--fps', '30', '--frames', '100', '--workers', '3', '--segment', '0.5', ...flags]);
    assert.equal(r.code, 0, `${flags.join(' ')}: ${r.err}`);
    assert.match(r.out, /data-stateless mark checked in [\d.]+ s/, flags.join(' '));
  }
});

test('render: a page marked data-stateless that carries state between frames is caught on one frame and renders as one worker would', { skip }, () => {
  // A rAF counter, and a page whose __seek counts its calls and whose timers accumulate: each draws its first skipped
  // frame otherwise when jumped to, so the render says what differs there and steps every worker through the frames before its own.
  const dir = scratchDir('render-stateless-wrong');
  const counter = page(dir, 'counter.html', RAF_BODY, '', STATELESS);
  const c1 = render([counter, '--out', join(dir, 'c1.mp4'), '--fps', '30', '--frames', '100', '--workers', '1', '--segment', '0.5']);
  assert.equal(c1.code, 0, c1.err);
  assert.doesNotMatch(c1.err, /marked data-stateless, but/, 'one worker from frame 0 skips nothing, so there is nothing to check');
  const c3 = render([counter, '--out', join(dir, 'c3.mp4'), '--fps', '30', '--frames', '100', '--workers', '3', '--segment', '0.5']);
  assert.equal(c3.code, 0, c3.err);
  assert.match(c3.err, /render: the page is marked data-stateless, but frame 33 \(1\.100 s\) comes out differently when jumped to than after stepping through the 30 frame\(s\) before it \([\d.]+% of its pixels, within \d+x\d+ at \d+,\d+; twice\): it draws more than the time into a frame, so every worker steps through the frames before its own/);
  assert.match(c3.out, PREROLL, 'the workers stepped through the frames before their own');
  assert.match(c3.out, /data-stateless mark checked in [\d.]+ s/);
  assert.deepEqual(hashes(join(dir, 'c3.mp4'), true), hashes(join(dir, 'c1.mp4'), true), 'three workers write the same bytes as one');

  const clock = page(dir, 'clock.html', CLOCK_BODY, CLOCK_STYLE, STATELESS);
  const k1 = render([clock, '--out', join(dir, 'k1.mp4'), '--frames', '60', '--workers', '1', '--segment', '0.5']);
  assert.equal(k1.code, 0, k1.err);
  const k3 = render([clock, '--out', join(dir, 'k3.mp4'), '--frames', '60', '--workers', '3', '--segment', '0.5']);
  assert.equal(k3.code, 0, k3.err);
  assert.match(k3.err, /marked data-stateless, but frame 20 \(0\.667 s\) comes out differently when jumped to/);
  assert.deepEqual(hashes(join(dir, 'k3.mp4'), true), hashes(join(dir, 'k1.mp4'), true), 'three workers write the same bytes as one');
  // Stills skip every frame before their own, so the probe runs on the first, whatever the worker count.
  const stills = render([counter, '--out', join(dir, 'stills'), '--stills', '1.5,3', '--workers', '2']);
  assert.equal(stills.code, 0, stills.err);
  assert.match(stills.err, /marked data-stateless, but frame 45 \(1\.500 s\) comes out differently when jumped to than after stepping through the 30 frame\(s\) before it/);
  const unmarked = render([page(dir, 'counter-unmarked.html', RAF_BODY), '--out', join(dir, 'unmarked'), '--stills', '1.5,3', '--workers', '2']);
  assert.equal(unmarked.code, 0, unmarked.err);
  for (const f of ['f000045-1.500s.png', 'f000090-3.000s.png']) {
    assert.ok(readFileSync(join(dir, 'stills', f)).equals(readFileSync(join(dir, 'unmarked', f))), `${f} is what the unmarked page draws`);
  }
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

  // Stills step through every earlier frame too, so they read the all-intra copy as well: the one the render made.
  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '1.2']);
  assert.equal(s.code, 0, s.err);
  assert.doesNotMatch(s.err, /all-intra copy/, 'the render\'s copy is reused');
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000036-1.200s.png')), 90) / 4), 36);

  // A copy is kept for the next render, a file touched but not changed keeps it, and one whose bytes change gets a new one.
  const kept = copiesIn(dir);
  assert.equal(kept.length, 1);
  const again = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(again.code, 0, again.err);
  assert.doesNotMatch(again.err, /all-intra copy/, 'the kept copy is reused');
  assert.deepEqual(copiesIn(dir), kept, 'the same copy, not a new one');
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 45 }, (_, i) => i), 'and it still seeks frame-exact');
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, 'clip.mp4'), later, later);
  const touched = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(touched.code, 0, touched.err);
  assert.doesNotMatch(touched.err, /all-intra copy/, 'its bytes are what they were');
  barClip(dir, 'clip.mp4', { frames: 90, gop: 50 });
  const changed = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(changed.code, 0, changed.err);
  assert.match(changed.err, /all-intra copy of clip\.mp4/);
  assert.match(changed.err, /media cache .*runs\/\.media: 2 copies, 0\.0 GB/, 'the render says what the cache holds');
  assert.equal(copiesIn(dir).length, 2, 'the old copy stays until the cache needs its room');
});

test('render: stills into two directories, and a video render after them, share one copy of the source, and a changed source gets its own', { skip }, () => {
  const dir = scratchDir('render-shared-copy');
  barClip(dir, 'clip.mp4', { frames: 90 });
  const file = page(dir, 'video.html', '<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:320px;height:180px"></video>');
  const first = render([file, '--out', join(dir, 'stills-a'), '--stills', '1.2']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /made an all-intra copy of clip\.mp4/);
  const [copy] = copiesIn(dir);
  assert.equal(copiesIn(dir).length, 1);
  const inode = statSync(copy).ino;

  const second = render([file, '--out', join(dir, 'stills-b'), '--stills', '0.5,2']);
  assert.equal(second.code, 0, second.err);
  assert.doesNotMatch(second.err, /all-intra copy/, 'another stills directory finds the copy');
  assert.deepEqual(copiesIn(dir), [copy]);
  assert.equal(statSync(copy).ino, inode, 'the copy was not made again');
  assert.equal(Math.round(edge(grayPng(join(dir, 'stills-b', 'f000060-2.000s.png')), 90) / 4), 60);
  assert.ok(!existsSync(join(dir, 'stills-a.render')) && !existsSync(join(dir, 'stills-b.render')), 'no copy kept beside the stills');

  const out = join(dir, 'out.mp4');
  const video = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(video.code, 0, video.err);
  assert.doesNotMatch(video.err, /all-intra copy/, 'a video render finds the copy the stills made');
  assert.equal(statSync(copy).ino, inode);
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 45 }, (_, i) => i));

  // Another picture in the same file: the bar one frame later, so a still from the old copy would show.
  barClip(dir, 'clip.mp4', { frames: 90, from: 1 });
  const changed = render([file, '--out', join(dir, 'stills-a'), '--stills', '1.2']);
  assert.equal(changed.code, 0, changed.err);
  assert.match(changed.err, /made an all-intra copy of clip\.mp4/);
  assert.equal(copiesIn(dir).length, 2);
  assert.equal(Math.round(edge(grayPng(join(dir, 'stills-a', 'f000036-1.200s.png')), 90) / 4), 37, 'the still shows the new picture');
});

test('render: two stills renders at once into different directories leave one whole copy, and both land on the exact frame', { skip }, async () => {
  const dir = scratchDir('render-copy-race');
  barClip(dir, 'clip.mp4', { frames: 90 });
  const file = page(dir, 'video.html', '<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:320px;height:180px"></video>');
  const [a, b] = await Promise.all([
    renderAsync([file, '--out', join(dir, 'stills-a'), '--stills', '1.2']),
    renderAsync([file, '--out', join(dir, 'stills-b'), '--stills', '2']),
  ]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const cache = join(dir, 'runs', '.media');
  const [copy] = copiesIn(dir);
  assert.deepEqual(readdirSync(cache).filter((n) => n !== 'versions'), [basename(copy)], 'one copy, and nothing half-written beside it');
  assert.equal(probe(copy, 'stream=nb_read_packets'), '90', 'the copy is whole');
  assert.equal(Math.round(edge(grayPng(join(dir, 'stills-a', 'f000036-1.200s.png')), 90) / 4), 36);
  assert.equal(Math.round(edge(grayPng(join(dir, 'stills-b', 'f000060-2.000s.png')), 90) / 4), 60);
});

test('render: a stateless page with a <video> seeks straight to each worker\'s first frame, and a late still steps through nothing', { skip }, () => {
  const dir = scratchDir('render-stateless-video');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=3,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  const file = page(dir, 'video.html', '<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:320px;height:180px"></video>', '', STATELESS);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2 worker\(s\)/);
  assert.doesNotMatch(r.out, PREROLL);
  // The second worker's first frame is a seek from 0 straight to its time, and must wait for that picture.
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 45 }, (_, i) => i));

  // In a workspace of their own, so the stills make the copy the render already made in this one.
  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '2.5,1.2', '--workers', '2'], { OPEN_EDIT_ROOT: scratchDir('render-stateless-stills') });
  assert.equal(s.code, 0, s.err);
  assert.match(s.err, /all-intra copy of clip\.mp4/, 'the still is frame-exact only from the copy');
  assert.doesNotMatch(s.out, PREROLL, 'a still at 2.5 s steps through none of the 75 frames before it');
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000036-1.200s.png')), 90) / 4), 36);
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000075-2.500s.png')), 90) / 4), 75);
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

test('render: a <video> __seek places away from the page time shows that picture, never the one the renderer sought first', { skip }, () => {
  const dir = scratchDir('render-placed-video');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=2,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  // Each frame the renderer first seeks the video to the page time (past the 2 s clip, its last
  // picture), then __seek moves it far from there. Only the picture of __seek's time may be captured.
  const file = page(dir, 'placed.html', `<video id="v" src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<script>
const v = document.getElementById('v');
window.__seek = (t) => { const target = ((Math.round(t * 30) * 7) % 50 + 0.5) / 30; if (Math.abs(v.currentTime - target) > 1e-4) v.currentTime = target; };
</script>`);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '150', '--workers', '2']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 150 }, (_, i) => (i * 7) % 50));
});

/** A clip twice the stage's size, frame n carrying a bright bar at x = 4n, with the keyframes `gop` apart. */
function bigClip(dir: string, gop: number): string {
  const clip = join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${2 * W}x${2 * H}:r=30:d=3,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', String(gop), '-pix_fmt', 'yuv420p', clip]);
  return clip;
}

/** The copies in the media cache of renders whose --out is in `dir`, oldest first. */
function copiesIn(dir: string): string[] {
  const cache = join(dir, 'runs', '.media');
  if (!existsSync(cache)) return [];
  return readdirSync(cache).filter((n) => /^[0-9a-f]{20}\.(mp4|webm)$/.test(n)).map((n) => join(cache, n)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

const sizeOf = (copy: string) => probe(copy, 'stream=width,height');

/** The one copy in the media cache of renders in `dir`, and its size. */
function theCopy(dir: string): { path: string; size: string } {
  const copies = copiesIn(dir);
  assert.equal(copies.length, 1, `one copy: ${copies.join(', ')}`);
  return { path: copies[0], size: sizeOf(copies[0]) };
}

/** The size of the copy a render in `dir` used last: a copy found is marked used, one made is new. */
const lastUsedSize = (dir: string) => sizeOf(copiesIn(dir).at(-1)!);

test('render: a <video> shown at half its size is served from a copy at the shown size, and still lands on the exact frame', { skip }, () => {
  const dir = scratchDir('render-shown-size');
  bigClip(dir, 60);
  const out = join(dir, 'out.mp4');
  // Covering the stage: the picture is drawn at half size, so the bar at x = 4n lands at 2n.
  const cover = page(dir, 'cover.html', `<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;object-fit:cover"></video>`);
  const r = render([cover, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /all-intra copy of clip\.mp4 at 320x180 \(shown at that size; the source is 640x360, with keyframes up to \d+ frames apart\)/);
  assert.equal(theCopy(dir).size, '320,180');
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 2)), Array.from({ length: 45 }, (_, i) => i));

  // Keyframes close together: a copy is still worth it for the size alone.
  const short = scratchDir('render-shown-size-short');
  bigClip(short, 10);
  const plain = page(short, 'plain.html', `<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>`);
  const stills = join(short, 'stills');
  const s = render([plain, '--out', stills, '--stills', '1']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.err, /all-intra copy of clip\.mp4 at 320x180 \(shown at that size; the source is 640x360\) for frame-exact seeks/);
  assert.equal(theCopy(short).size, '320,180');
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000030-1.000s.png')), 90) / 2), 30);

  // Drawn at full size now (the stage clips it): a full-size copy is served in place of the small one.
  writeFileSync(cover, readFileSync(cover, 'utf8').replace(`width:${W}px;height:${H}px;object-fit:cover`, `width:${2 * W}px;height:${2 * H}px`));
  const full = render([cover, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(full.code, 0, full.err);
  assert.match(full.err, /all-intra copy of clip\.mp4 \(keyframes up to \d+ frames apart\)/);
  assert.equal(lastUsedSize(dir), '640,360');
  assert.deepEqual(copiesIn(dir).map(sizeOf), ['320,180', '640,360'], 'the small copy stays until the cache needs its room');
  assert.deepEqual(grayFrames(out).map((f) => Math.round(edge(f, 90) / 4)), Array.from({ length: 45 }, (_, i) => i));
});

test('render: under --scale a <video> is copied at the size it is captured at, and is not taken for one drawn larger', { skip }, () => {
  const dir = scratchDir('render-scaled-video');
  bigClip(dir, 60);
  const out = join(dir, 'out.mp4');
  // Shown at half its size on a canvas captured at half (as PNG, which keeps a one-pixel bar sharp): a quarter of the source's pixels, so the bar at x = 4n lands at n.
  const cover = page(dir, 'cover.html', `<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;object-fit:cover"></video>`);
  const r = render([cover, '--out', out, '--fps', '30', '--frames', '30', '--workers', '2', '--segment', '1', '--scale', '0.5']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /all-intra copy of clip\.mp4 at 160x90/);
  assert.doesNotMatch(r.err, /rendering again from full-size copies/);
  assert.equal(theCopy(dir).size, '160,90');
  grayFramesOf(out, W / 2, H / 2).forEach((f, i) => {
    const x = f.subarray(45 * (W / 2), 46 * (W / 2)).findIndex((v) => v > 128);
    near(x, i, `the bar at frame ${i}`);
  });
});

/** Draws the video `v` into a canvas over the whole stage, at the source's own size. */
const CANVAS_OF_V = `<canvas id="c" width="${W}" height="${H}" style="position:absolute;left:0;top:0"></canvas>
<script>
const v = document.getElementById('v'), c = document.getElementById('c').getContext('2d');
window.__seek = async () => { if (v.seeking) await new Promise((r) => v.addEventListener('seeked', r, { once: true })); c.drawImage(v, 0, 0); };
</script>`;

test('render: a hidden <video> keeps a full-size copy, since a canvas may draw it at full size', { skip }, () => {
  const dir = scratchDir('render-hidden-size');
  bigClip(dir, 60);
  const file = page(dir, 'hidden.html', `<video id="v" src="clip.mp4" muted playsinline style="display:none"></video>
${CANVAS_OF_V}`);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '30']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /all-intra copy of clip\.mp4 \(keyframes up to \d+ frames apart\)/);
  assert.equal(theCopy(dir).size, '640,360');
  const frames = grayFrames(out);
  for (const i of [10, 20, 29]) assert.equal(Math.round(edge(frames[i], 90) / 4), i, `canvas drawn at the source's size at frame ${i}`);
});

test('render: a <video> off the viewport or a few pixels across keeps a full-size copy, since it may only feed a canvas', { skip }, () => {
  for (const [name, box] of [['offscreen', `left:-${W}px;top:0;width:${W / 2}px;height:${H / 2}px`], ['tiny', 'left:0;top:0;width:4px;height:4px']] as const) {
    const dir = scratchDir(`render-canvas-source-${name}`);
    bigClip(dir, 60);
    const file = page(dir, `${name}.html`, `<video id="v" src="clip.mp4" muted playsinline style="position:absolute;${box}"></video>
${CANVAS_OF_V}`);
    const out = join(dir, 'out.mp4');
    const r = render([file, '--out', out, '--frames', '30']);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.equal(theCopy(dir).size, '640,360', name);
    const frames = grayFrames(out);
    for (const i of [10, 20, 29]) assert.equal(Math.round(edge(frames[i], 90) / 4), i, `${name}: canvas drawn at the source's size at frame ${i}`);
  }
});

test('render: one file under two URLs gets one copy, sized for the URL that needs the most', { skip }, () => {
  const dir = scratchDir('render-one-file-two-urls');
  bigClip(dir, 60);
  // Drawn into a canvas from a hidden element under one URL, and shown at a quarter of its size under another.
  const file = page(dir, 'two.html', `<video id="v" src="clip.mp4#t=0" muted playsinline style="display:none"></video>
<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W / 2}px;height:${H / 2}px"></video>
${CANVAS_OF_V}`);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '30']);
  assert.equal(r.code, 0, r.err);
  assert.equal(theCopy(dir).size, '640,360');
  const frames = grayFrames(out);
  for (const i of [10, 20, 29]) assert.equal(Math.round(edge(frames[i], 90) / 4), i, `canvas drawn at the source's size at frame ${i}`);
});

/** Frame 36's bar, drawn from the source at half size, is two full-white pixels; from a quarter-size copy it is a blur. */
const sharpAt36 = (still: string) => { const g = grayPng(still); return g[90 * W + 72] > 230 && g[90 * W + 73] > 230; };

// A quarter of the clip's size on load, the whole stage (half the clip's size) from 1 s on.
const GROWING = `<video id="v" src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W / 2}px;height:${H / 2}px"></video>
<script>
const v = document.getElementById('v');
window.__seek = (t) => { const k = Math.min(1, t); v.style.width = (${W / 2} + ${W / 2} * k) + 'px'; v.style.height = (${H / 2} + ${H / 2} * k) + 'px'; };
</script>`;
const RETRIED = /is drawn larger than the copy made at the size the page showed it on load; rendering again from full-size copies/;

test('render: a <video> the page grows past the size it showed on load is rendered again from a full-size copy', { skip }, () => {
  const dir = scratchDir('render-grown-size');
  bigClip(dir, 60);
  const file = page(dir, 'grow.html', GROWING);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /all-intra copy of clip\.mp4 at 160x90/);
  assert.match(r.err, RETRIED);
  assert.equal(lastUsedSize(dir), '640,360', 'the second attempt served the full-size copy');
  const frames = grayFrames(out);
  for (const i of [30, 37, 44]) assert.equal(Math.round(edge(frames[i], 90) / 2), i, `the whole stage at frame ${i}`);

  // A patch shrinks the copy again, steps into the growth on its way to the range, and retries the same way.
  const before = hashes(out, true);
  const patch = render([file, '--out', out, '--fps', '30', '--frames', '45', '--segment', '1', '--from', '1.0', '--to', '1.4']);
  assert.equal(patch.code, 0, patch.err);
  assert.match(patch.err, RETRIED);
  assert.match(patch.out, /segments: 1 rendered, 1 reused/);
  assert.equal(lastUsedSize(dir), '640,360');
  assert.deepEqual(copiesIn(dir).map(sizeOf), ['160,90', '640,360'], 'both copies found again, neither made again');
  assert.deepEqual(hashes(out, true), before, 'the patched segment is the one the full-size copy made');

  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '1.2']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.err, RETRIED);
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000036-1.200s.png')), 90) / 2), 36);
  assert.ok(sharpAt36(join(stills, 'f000036-1.200s.png')), 'drawn from the source, not the small copy the first attempt loaded');

  // The same file under another URL, given to a second video once the page runs, is the same small copy.
  const other = page(dir, 'other.html', `<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W / 2}px;height:${H / 2}px"></video>
<video id="w" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<script>
const w = document.getElementById('w');
window.__seek = (t) => { if (t >= 1 && !w.hasAttribute('src')) w.src = 'clip.mp4#full'; };
</script>`);
  const o = render([other, '--out', join(dir, 'other.mp4'), '--fps', '30', '--frames', '45']);
  assert.equal(o.code, 0, o.err);
  assert.match(o.err, RETRIED);
});

test('render: a grown <video> with keyframes close together is served from its own file on the second attempt', { skip }, () => {
  const dir = scratchDir('render-grown-short-gop');
  bigClip(dir, 10);
  const file = page(dir, 'grow.html', GROWING);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /all-intra copy of clip\.mp4 at 160x90/);
  assert.match(r.err, RETRIED);
  assert.doesNotMatch(r.err, /could not be played|failed to load/);
  assert.deepEqual(copiesIn(dir).map(sizeOf), ['160,90'], 'no copy is made at full size: the second attempt serves the file itself');
  const frames = grayFrames(out);
  for (const i of [30, 37, 44]) assert.equal(Math.round(edge(frames[i], 90) / 2), i, `the whole stage at frame ${i}`);

  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '1.2']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.err, RETRIED);
  assert.equal(Math.round(edge(grayPng(join(stills, 'f000036-1.200s.png')), 90) / 2), 36);
  assert.ok(sharpAt36(join(stills, 'f000036-1.200s.png')), 'drawn from the source, not the small copy the first attempt loaded');
});

test('render: a video render names a first frame that makes a poor cover and a still held past its words, and a patch only near what it re-rendered', { skip }, () => {
  const dir = scratchDir('render-picture');
  // A fade in from black over the first second, then a card of six words that comes up at 2 s and holds to the end.
  const style = `${CSS_STYLE}#stage{background:#4a6a8a}
#card{position:absolute;inset:0;background:#f0e0c8;color:#222;font:bold 28px sans-serif;padding:20px;opacity:0;animation:show .1s linear 2s forwards}
@keyframes show{to{opacity:1}}
#fade{position:absolute;inset:0;background:#000;animation:fade 1s linear forwards}
@keyframes fade{to{opacity:0}}`;
  const file = page(dir, 'card.html', `${CSS_BODY}<div id="card">See you at the grand opening</div><div id="fade"></div>`, style, STATELESS);
  const out = join(dir, 'out.mp4');
  const args = [file, '--out', out, '--fps', '30', '--duration', '8', '--segment', '1'];
  const notes = (r: { out: string }) => r.out.split('\n').filter((line) => line.startsWith('  picture: '));
  const COVER = /^ {2}picture: frame 0 is blank, flat black, fading in until (0\.9\d|1\.0\d) s; platforms show it as the cover$/;
  // Each one-second segment is encoded on its own, so a keyframe nudges the held card every second without unfreezing it.
  const CARD = /^ {2}picture: frozen 2\.[01]-8\.0 s \(5\.[89] s, over the 4\.2 s its 6 words allow\)$/;

  const full = render(args);
  assert.equal(full.code, 0, full.err);
  const said = notes(full);
  assert.equal(said.length, 2, said.join('\n'));
  assert.match(said[0], COVER);
  assert.match(said[1], CARD);

  // Re-rendering the opening looks at the first frame, and not at the card well after it.
  const opening = render([...args, '--from', '0', '--to', '1']);
  assert.equal(opening.code, 0, opening.err);
  assert.equal(notes(opening).length, 1);
  assert.match(notes(opening)[0], COVER);
  // Re-rendering part of the card measures the whole of it, and leaves the first frame alone.
  const card = render([...args, '--from', '6', '--to', '7']);
  assert.equal(card.code, 0, card.err);
  assert.equal(notes(card).length, 1);
  assert.match(notes(card)[0], CARD);
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
  const late = `<video id="v" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<script>
const v = document.getElementById('v');
window.__seek = () => { if (!v.hasAttribute('src')) v.src = 'clip.mp4'; };
</script>`;
  const file = page(dir, 'late.html', late);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--frames', '30', '--workers', '2']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /it has no source|failed to load or play/);
  const frames = grayFrames(out);
  for (const i of [10, 20, 29]) assert.equal(Math.round(edge(frames[i], 90) / 4), i, `video at frame ${i}`);

  // Marked stateless, the second worker's first frame (15) is the one the source arrives in: the video
  // is put at that frame's time, not left at 0 the way it was on frame 0.
  const jumped = page(dir, 'late-stateless.html', late, '', STATELESS);
  const j = render([jumped, '--out', join(dir, 'jumped.mp4'), '--frames', '30', '--workers', '2']);
  assert.equal(j.code, 0, j.err);
  assert.doesNotMatch(j.out, PREROLL);
  assert.doesNotMatch(j.err, /it has no source|failed to load or play/);
  const jf = grayFrames(join(dir, 'jumped.mp4'));
  for (const i of [0, 14, 15, 16, 29]) assert.equal(Math.round(edge(jf[i], 90) / 4), i, `video at frame ${i}`);

});

test('render: a video a scene gives its source to and places at 0 shows its first picture on the frame it arrives', { skip }, () => {
  const dir = scratchDir('render-late-scene');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=30:d=2,format=yuv420p,geq=lum='if(between(X\\,4*N\\,4*N+3)\\,235\\,16)':cb=128:cr=128`,
    '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  // The scene starts at frame 10: the page's 0 is a placement like any other, so the scene's first frame
  // shows the clip's first picture, on one worker's run and on a second worker that jumps in at 15.
  const shown = `<video id="v" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<script>
const v = document.getElementById('v');
window.__seek = (t) => {
  const k = Math.round(t * 30) - 10;
  if (k < 0) return;
  if (!v.hasAttribute('src')) v.src = 'clip.mp4';
  v.currentTime = k === 0 ? 0 : k / 30 + 1e-4;
};
</script>`;
  // The same scene drawn into a canvas from a video with no box, which still has to present its picture.
  const drawn = `<video id="v" muted playsinline style="display:none"></video>
<canvas id="c" width="${W}" height="${H}" style="position:absolute;left:0;top:0"></canvas>
<script>
const v = document.getElementById('v'), c = document.getElementById('c').getContext('2d');
const settled = (name) => new Promise((r) => v.addEventListener(name, r, { once: true }));
window.__seek = async (t) => {
  const k = Math.round(t * 30) - 10;
  if (k < 0) return;
  if (!v.hasAttribute('src')) { v.src = 'clip.mp4'; await settled('loadeddata'); }
  const seeked = settled('seeked');
  v.currentTime = k === 0 ? 0 : k / 30 + 1e-4;
  await seeked;
  c.drawImage(v, 0, 0);
};
</script>`;
  for (const [name, body, attrs] of [['shown.html', shown, ''], ['shown-stateless.html', shown, STATELESS], ['drawn.html', drawn, ''], ['drawn-stateless.html', drawn, STATELESS]] as const) {
    const s = render([page(dir, name, body, '', attrs), '--out', join(dir, `${name}.mp4`), '--frames', '30', '--workers', '2']);
    assert.equal(s.code, 0, `${name}: ${s.err}`);
    assert.doesNotMatch(s.err, /presented no picture/);
    const sf = grayFrames(join(dir, `${name}.mp4`));
    assert.equal(edge(sf[9], 90), -1, `${name}: nothing before the scene`);
    for (const i of [10, 11, 15, 20, 29]) assert.equal(Math.round(edge(sf[i], 90) / 4), i - 10, `${name}: clip frame ${i - 10} at frame ${i}`);
  }
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

/** A clip whose frame n has a bright bar at x = scale·(n + from), `bar` px wide, with keyframes `gop` (60) frames apart. */
function barClip(dir: string, name: string, o: { frames: number; width?: number; height?: number; scale?: number; bar?: number; gop?: number; from?: number; rate?: string }): string {
  const file = join(dir, name);
  const { width = W, height = H, scale = 4, bar = 4, gop = 60, from = 0, rate = '30' } = o;
  const x = `${scale}*(N+${from})`;
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${width}x${height}:r=${rate},format=yuv420p,geq=lum='if(between(X\\,${x}\\,${x}+${bar - 1})\\,235\\,16)':cb=128:cr=128`,
    '-frames:v', String(o.frames), '-c:v', 'libx264', '-g', String(gop), '-pix_fmt', 'yuv420p', file]);
  return file;
}

// No background anywhere, so the footage shows through; the <video> is what a browser preview plays.
const CLEAR = 'html,body,#stage{background:transparent}';
const OVER_FOOTAGE = `<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<div class="box" style="left:200px;top:80px"></div><div style="position:absolute;left:250px;top:150px;width:40px;height:20px;background:rgba(255,255,255,.5)"></div>`;

/** The footage's frame index on row 20, where only its bar is drawn. */
const footageFrame = (frame: Buffer) => Math.round(edge(frame, 20) / 4);

test('render: --footage lays the page over the clip in ffmpeg, frame-exact across segments and workers, with the page\'s <video> stood down', { skip }, () => {
  const dir = scratchDir('render-footage');
  const clip = barClip(dir, 'clip.mp4', { frames: 45 });
  const file = page(dir, 'over.html', OVER_FOOTAGE, CLEAR);
  const out = join(dir, 'out.mp4');
  // Two segments (30 + 15 frames), and two workers cut inside the first, so a segment assembled from
  // two workers' frames and a whole one each start where the footage does.
  const r = render([file, '--out', out, '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1', '--footage', clip]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readRecord(recordPath(out)).footage, { file: clip, frame: 0, time: 0 }, 'the text record names the clip under the page, for the review\'s graphics check');
  assert.match(r.out, /2 worker\(s\), segments: 2 rendered/);
  assert.doesNotMatch(r.err, /all-intra|failed to load|no source|warning/, 'the stood-down video is neither copied nor reported');
  assert.equal(probe(out, 'stream=pix_fmt,nb_read_packets'), 'yuv420p,45');
  const frames = grayFrames(out);
  assert.deepEqual(frames.map(footageFrame), Array.from({ length: 45 }, (_, i) => i), 'footage frame n under page frame n');
  for (const i of [0, 29, 30, 44]) {
    assert.ok(frames[i][90 * W + 210] > 200, `the page's box over the footage at frame ${i}`);
    // Straight alpha: half white over the footage's black is mid-grey; premultiplied read as straight would be far darker.
    const half = frames[i][160 * W + 270];
    assert.ok(Math.abs(half - 128) <= 6, `half-transparent box at frame ${i}: ${half}`);
  }
  const one = render([file, '--out', join(dir, 'one.mp4'), '--fps', '30', '--frames', '45', '--workers', '1', '--segment', '1', '--footage', clip]);
  assert.equal(one.code, 0, one.err);
  assert.deepEqual(hashes(out, true), hashes(join(dir, 'one.mp4'), true), 'two workers write the same bytes as one');
  const jumped = render([page(dir, 'over-stateless.html', OVER_FOOTAGE, CLEAR, STATELESS), '--out', join(dir, 'jumped.mp4'), '--fps', '30', '--frames', '45', '--workers', '2', '--segment', '1', '--footage', clip]);
  assert.equal(jumped.code, 0, jumped.err);
  assert.doesNotMatch(jumped.out, PREROLL);
  assert.deepEqual(hashes(join(dir, 'jumped.mp4'), true), hashes(out, true), 'a stateless page jumps in over the same footage frames');

  // A patch reuses the untouched segment, and is refused once the footage has changed, or is not given.
  const before = hashes(out, true);
  const patch = render([file, '--out', out, '--fps', '30', '--frames', '45', '--segment', '1', '--footage', clip, '--from', '0.2', '--to', '0.4']);
  assert.equal(patch.code, 0, patch.err);
  assert.match(patch.out, /segments: 1 rendered, 1 reused/);
  assert.deepEqual(hashes(out, true), before, 'the same page over the same footage renders the same frames');
  const without = render([file, '--out', out, '--fps', '30', '--frames', '45', '--segment', '1', '--from', '0.2', '--to', '0.4']);
  assert.equal(without.code, 2);
  assert.match(without.err, /made differently \(footage "\S*clip\.mp4 \([^"]+" → undefined/);
  const later = new Date(Date.now() + 5000);
  utimesSync(clip, later, later);
  const changed = render([file, '--out', out, '--fps', '30', '--frames', '45', '--segment', '1', '--footage', clip, '--from', '0.2', '--to', '0.4']);
  assert.equal(changed.code, 2);
  assert.match(changed.err, /made differently \(footage "\S*clip\.mp4 \(\d+ bytes, modified [^"]+" → "\S*clip\.mp4 \(\d+ bytes, modified/);
});

/** Each frame's time in seconds, in display order. */
function frameTimes(video: string): number[] {
  const [n, d] = probe(video, 'stream=time_base').split('/').map(Number);
  return execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', video], { encoding: 'utf8' })
    .trim().split('\n').map((t) => (Number(t) * n) / d).sort((a, b) => a - b);
}

test('render: over 24000/1001 footage every frame of the joined video is one frame after the last, across every segment join', { skip }, () => {
  const dir = scratchDir('render-footage-joins');
  const clip = barClip(dir, 'clip.mp4', { frames: 72, rate: '24000/1001' });
  const out = join(dir, 'out.mp4');
  // Three 1 s segments on two workers: two joins, where ffmpeg 7 set each next segment a frame early.
  const r = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', out, '--fps', '24000/1001', '--frames', '72', '--segment', '1', '--workers', '2', '--footage', clip]);
  assert.equal(r.code, 0, r.err);
  const times = frameTimes(out);
  assert.equal(times.length, 72);
  const off = times.map((t, i) => ({ i, t })).filter(({ i, t }) => Math.abs(t - (i * 1001) / 24000) > 1e-4);
  assert.deepEqual(off.slice(0, 2), [], `frames off their time: ${off.slice(0, 2).map(({ i, t }) => `frame ${i} at ${t.toFixed(4)} s`).join(', ')}`);
  assert.equal(Number(probe(out, 'stream=duration')).toFixed(3), '3.003');
  assert.deepEqual(grayFrames(out).map(footageFrame), Array.from({ length: 72 }, (_, i) => i), 'footage frame n under page frame n');
});

test('render: --footage without --fps or --duration renders at the clip\'s exact rate for every frame it holds, and says so', { skip }, () => {
  const dir = scratchDir('render-footage-defaults');
  const clip = barClip(dir, 'clip.mp4', { frames: 50, rate: '30000/1001' });
  const out = join(dir, 'out.mp4');
  const r = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', out, '--footage', clip, '--segment', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /render: --fps 30000\/1001 and --frames 50 \(1\.668 s\) from the footage clip\.mp4/);
  assert.equal(probe(out, 'stream=r_frame_rate,nb_read_packets'), '30000/1001,50');
  assert.deepEqual(grayFrames(out).map(footageFrame), Array.from({ length: 50 }, (_, i) => i));
  // A length given is kept, with the rate still the clip's; a rate given must be the clip's.
  const short = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', join(dir, 'short.mp4'), '--footage', clip, '--duration', '1']);
  assert.equal(short.code, 0, short.err);
  assert.match(short.err, /render: --fps 30000\/1001 from the footage clip\.mp4/);
  assert.equal(probe(join(dir, 'short.mp4'), 'stream=r_frame_rate,nb_read_packets'), '30000/1001,30');
  const wrong = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', join(dir, 'wrong.mp4'), '--footage', clip, '--fps', '30']);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /the footage runs at 30000\/1001 fps and --fps is 30: pass --fps 30000\/1001, the footage's own rate, or leave --fps out/);
});

test('render: without --workers a page that jumps to its frames, or plays no video for Chrome, gets a worker per CPU, and one that seeks a <video> the default', { skip }, () => {
  const dir = scratchDir('render-workers');
  const cpus = cpuCount();
  // Enough frames for a worker per CPU, and for more workers than the default.
  const frames = MIN_FRAMES_PER_WORKER * Math.max(cpus, defaultWorkers() + 1);
  const workers = (r: { out: string }) => Number(/(\d+) worker\(s\)/.exec(r.out)?.[1]);
  const jumps = render([page(dir, 'css.html', CSS_BODY, CSS_STYLE, STATELESS), '--out', join(dir, 'css.mp4'), '--frames', String(frames)]);
  assert.equal(jumps.code, 0, jumps.err);
  assert.equal(workers(jumps), cpus, jumps.out);
  const clip = barClip(dir, 'clip.mp4', { frames });
  const over = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', join(dir, 'over.mp4'), '--footage', clip]);
  assert.equal(over.code, 0, over.err);
  assert.equal(workers(over), cpus, 'the page\'s only <video> is the footage, which Chrome never plays');
  const seeks = render([page(dir, 'video.html', OVER_FOOTAGE, CLEAR), '--out', join(dir, 'video.mp4'), '--frames', String(frames)]);
  assert.equal(seeks.code, 0, seeks.err);
  assert.equal(workers(seeks), Math.min(defaultWorkers(), Math.floor(frames / MIN_FRAMES_PER_WORKER)), 'each worker steps its <video> through every earlier frame');
});

test('render: OPENEDIT_CHROME names the browser when --chrome is not given, and --chrome wins over it', {
  skip: skip || (process.platform === 'win32' && 'a shell-script stand-in cannot run on Windows'),
}, () => {
  const dir = scratchDir('render-chrome-env');
  const chrome = join(dir, 'chrome');
  writeFileSync(chrome, `#!/bin/sh\nexec "${installedChrome(platform!)}" "$@"\n`, { mode: 0o755 });
  const out = join(dir, 'out.mp4');
  const file = page(dir, 'css.html', CSS_BODY, CSS_STYLE);
  const r = render([file, '--out', out, '--frames', '3'], { OPENEDIT_CHROME: chrome });
  assert.equal(r.code, 0, r.err);
  const manifest = JSON.parse(readFileSync(join(`${out}.render`, 'manifest.json'), 'utf8')) as { params: { browser: string } };
  assert.ok(manifest.params.browser.includes(`(${chrome}, `), `the cache records the build OPENEDIT_CHROME named: ${manifest.params.browser}`);
  const gone = render([file, '--out', out, '--frames', '3'], { OPENEDIT_CHROME: join(dir, 'nope') });
  assert.notEqual(gone.code, 0);
  assert.match(gone.err, /OPENEDIT_CHROME \S*nope is not a file/);
  const flag = render([file, '--out', out, '--frames', '3', '--chrome', join(dir, 'flag')], { OPENEDIT_CHROME: chrome });
  assert.match(flag.err, /--chrome \S*flag is not a file/);
});

test('render: a --footage draft lays the half-size page over the footage scaled to match, frame-exact, captured as PNG', { skip }, () => {
  const dir = scratchDir('render-footage-draft');
  const clip = barClip(dir, 'clip.mp4', { frames: 30 });
  const out = join(dir, 'out.draft.mp4');
  const r = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', out, '--fps', '30', '--frames', '30', '--workers', '2', '--segment', '1', '--footage', clip, '--draft']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /draft: png capture, x264 ultrafast CRF 28/);
  assert.equal(probe(out, 'stream=width,height,nb_read_packets'), '160,90,30');
  const frames = grayFramesOf(out, W / 2, H / 2);
  frames.forEach((f, i) => {
    const x = f.subarray(10 * (W / 2), 11 * (W / 2)).findIndex((v) => v > 128);
    assert.ok(Math.abs(x - 2 * i) <= 1, `footage frame ${i} under page frame ${i}: bar at ${x}`);
  });
  assert.ok(frames[5][45 * (W / 2) + 105] > 200, 'the page\'s box over the footage, at half its place');
});

test('render: --footage counts from the video\'s own first frame when an audio stream starts before it', { skip }, () => {
  const dir = scratchDir('render-footage-offset');
  const video = barClip(dir, 'video.mp4', { frames: 45 });
  // The video starts 0.1 s into the file, three frames after the audio, and a seek counts from the file's start.
  const clip = join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-itsoffset', '0.1', '-i', video, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', clip]);
  const file = page(dir, 'over.html', OVER_FOOTAGE, CLEAR);
  const out = join(dir, 'out.mp4');
  const r = render([file, '--out', out, '--fps', '30', '--frames', '45', '--segment', '1', '--footage', clip]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(grayFrames(out).map(footageFrame), Array.from({ length: 45 }, (_, i) => i), 'the second segment starts on footage frame 30');
  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '1.2', '--footage', clip]);
  assert.equal(s.code, 0, s.err);
  near(edge(grayPng(join(stills, 'f000036-1.200s.png')), 20), 4 * 36, 'footage frame 36 under the still');
});

test('render: --footage stills are laid over the footage\'s frame, scaled to fill a canvas of another size', { skip }, () => {
  const dir = scratchDir('render-footage-stills');
  // Twice the canvas, with the bar at 8n and 8 px wide, so scaled to fill it sits at 4n and 4 px wide.
  const clip = barClip(dir, 'clip.mp4', { frames: 45, width: 2 * W, height: 2 * H, scale: 8, bar: 8 });
  const file = page(dir, 'over.html', OVER_FOOTAGE, CLEAR);
  const stills = join(dir, 'stills');
  const r = render([file, '--out', stills, '--stills', '0.5,1.2', '--workers', '2', '--footage', clip]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /all-intra|failed to load|no source|warning/);
  for (const [name, n] of [['f000015-0.500s.png', 15], ['f000036-1.200s.png', 36]] as const) {
    const png = join(stills, name);
    assert.equal(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', png], { encoding: 'utf8' }).trim(), `${W},${H},rgb24`);
    const g = grayPng(png);
    near(edge(g, 20), 4 * n, `footage frame ${n} under the still`);
    assert.ok(g[90 * W + 210] > 200, 'the page over it');
  }
  // A moment the page draws nothing in is still a still: the footage is in it.
  const bare = render([page(dir, 'bare.html', OVER_FOOTAGE.split('\n')[0], CLEAR), '--out', join(dir, 'bare'), '--stills', '0.5', '--footage', clip]);
  assert.equal(bare.code, 0, bare.err);
  near(edge(grayPng(join(dir, 'bare', 'f000015-0.500s.png')), 20), 4 * 15, 'footage frame 15 alone');
  // Past the footage's last frame the page is laid over black, as the video render lays it.
  const past = render([file, '--out', stills, '--stills', '1.7', '--footage', clip, '--frames', '60']);
  assert.equal(past.code, 0, past.err);
  const after = grayPng(join(stills, 'f000051-1.700s.png'));
  assert.equal(edge(after, 20), -1, 'no footage past its last frame');
  assert.ok(after[90 * W + 210] > 200 && after[20 * W + 100] < 8, 'the page over black');
});

/** Every frame of a video as 8-bit gray, in the order stored, whatever their timestamps say. */
function storedFrames(video: string): Buffer[] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-fps_mode', 'passthrough', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  return Array.from({ length: raw.length / (W * H) }, (_, i) => raw.subarray(i * W * H, (i + 1) * W * H));
}

/** Seconds into a file at which its sound first reaches half its loudest, read from its first audio stream. */
function soundOnset(file: string): number {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const peak = samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  return samples.findIndex((x) => Math.abs(x) >= peak / 2) / 48000;
}

// A title card that covers the stage before the footage, captions over it, and an end card over black after it.
const AROUND_FOOTAGE = `<video src="clip.mp4" muted playsinline style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<div id="title" style="position:absolute;inset:0;background:#333"><div class="box" style="left:20px;top:80px"></div></div>
<div id="cap" style="position:absolute;left:150px;top:60px;width:40px;height:40px;background:#fff"></div>
<div id="end" class="box" style="left:280px;top:150px"></div>
<script src="faces.js"></script>
<script>
const show = (id, on) => { document.getElementById(id).style.display = on ? 'block' : 'none'; };
window.__seek = (t) => {
  show('title', t < 3); show('cap', t >= 3 && t < 13); show('end', t >= 13);
  // faces.js counts in the clip's time: the page's, less the moment the clip starts at.
  if (t >= 3 && t < 13) openeditFaces.place(document.getElementById('cap'), t - 3);
};
window.__seek(0);
</script>`;

test('render: --footage-at lays a shorter clip on the piece\'s timeline, with the page\'s cards before and after it, and mux-audio its sound from the same frame', { skip }, () => {
  const dir = scratchDir('render-footage-at');
  // 10 s at 10 fps: frame n has a bar at x = 3n, and the sound is silent but for a tone from 2.0 s, under frame 20.
  const clip = join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:r=10:d=10,format=yuv420p,geq=lum='if(between(X\\,3*N\\,3*N+2)\\,235\\,16)':cb=128:cr=128`,
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t\\,2\\,2.2)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=10",
    '-frames:v', '100', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
  // A face the caption's spot holds from 4 s to 6 s of the clip, and nowhere else.
  writeFileSync(join(dir, 'faces.js'), facesScript({
    video: clip, name: 'clip.mp4', width: W, height: H, fps: 10, frameRate: '10', durationSec: 10, model: 'stub', every: 1, threshold: 10,
    confidence: 0.5, textMargin: 0,
    shots: [{ start: 0, end: 4, samples: [] }, { start: 4, end: 6, samples: [{ sec: 4, faces: [{ x: 120, y: 40, w: 80, h: 100 }] }, { sec: 5.9, faces: [{ x: 120, y: 40, w: 80, h: 100 }] }] },
      { start: 6, end: 10, samples: [] }],
  }));
  const file = page(dir, 'around.html', AROUND_FOOTAGE, CLEAR, STATELESS);
  const out = join(dir, 'out.mp4');
  // 2 s segments: wholly before the footage, starting on it, inside it, ending inside one, and wholly after it.
  const r = render([file, '--out', out, '--fps', '10', '--duration', '16', '--workers', '2', '--footage', clip, '--footage-at', '3']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /footage clip\.mp4 under 3\.000-13\.000 s; the page is over black at 0\.000-3\.000 s and 13\.000-16\.000 s/);
  assert.equal(probe(out, 'stream=nb_read_packets'), '160');
  const frames = storedFrames(out);
  frames.forEach((f, i) => {
    if (i >= 30 && i < 130) near(edge(f, 20), 3 * (i - 30), `footage frame ${i - 30} under page frame ${i}`);
    else assert.equal(edge(f, 20), -1, `no footage at page frame ${i}`);
  });
  for (const i of [0, 29]) assert.ok(frames[i][20 * W + 300] === 51 && frames[i][90 * W + 30] > 200, `the title card at frame ${i}`);
  for (const i of [130, 159]) assert.ok(frames[i][20 * W + 100] < 8 && frames[i][160 * W + 290] > 200, `the end card over black at frame ${i}`);
  // At 4.5 s the clip is at 1.5 s, with no face: the caption stays put. At 8 s it is at 5 s, and the caption clears the face.
  assert.ok(frames[45][80 * W + 170] > 200 && frames[45][80 * W + 220] < 128, 'the caption where the page put it');
  assert.ok(frames[80][80 * W + 170] < 128 && frames[80][80 * W + 220] > 200, 'the caption moved clear of the face');
  const record = JSON.parse(readFileSync(`${out}.text.json`, 'utf8'));
  assert.deepEqual(record.footage, { file: clip, frame: 30, time: 3 });

  // The clip's own sound, laid on by mux-audio, starts with its first frame: the tone under frame 20 of the clip is at 5 s.
  const final = join(dir, 'final.mp4');
  const mux = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'mux-audio', '--video', out, '--audio', clip, '--out', final], { encoding: 'utf8' });
  assert.equal(mux.status, 0, mux.stderr);
  assert.match(mux.stdout, /clip\.mp4 is the footage the render laid from 3\.000 s; its sound starts there too/);
  const onset = soundOnset(final);
  assert.ok(Math.abs(onset - 5) < 0.003, `the tone starts at ${onset.toFixed(4)} s, under the frame the clip drew it with`);
  near(edge(storedFrames(final)[50], 20), 3 * 20, 'clip frame 20 at 5 s');
  // Another track, a copy of the clip included, is laid from the start as before.
  const other = join(dir, 'other.mp4');
  copyFileSync(clip, other);
  const plain = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'mux-audio', '--video', out, '--audio', other, '--out', join(dir, 'plain.mp4')], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /is the footage/);
  assert.ok(Math.abs(soundOnset(join(dir, 'plain.mp4')) - 2) < 0.003, 'another track keeps its own timing');

  // Stills land on the same frames: the title card, the footage under its caption, and the end card.
  const stills = join(dir, 'stills');
  const s = render([file, '--out', stills, '--stills', '1,8,14', '--fps', '10', '--footage', clip, '--footage-at', '3']);
  assert.equal(s.code, 0, s.err);
  assert.equal(grayPng(join(stills, 'f000010-1.000s.png'))[20 * W + 300], 51, 'the title card');
  near(edge(grayPng(join(stills, 'f000080-8.000s.png')), 20), 3 * 50, 'clip frame 50 at 8 s');
  assert.equal(edge(grayPng(join(stills, 'f000140-14.000s.png')), 20), -1, 'no footage after it');

  // A patch keeps the footage where it was, and a cache laid with it elsewhere is refused.
  const patch = render([file, '--out', out, '--fps', '10', '--duration', '16', '--footage', clip, '--footage-at', '3', '--from', '0.5', '--to', '1']);
  assert.equal(patch.code, 0, patch.err);
  assert.match(patch.out, /segments: 1 rendered, 7 reused/);
  const moved = render([file, '--out', out, '--fps', '10', '--duration', '16', '--footage', clip, '--footage-at', '4', '--from', '0.5', '--to', '1']);
  assert.equal(moved.code, 2);
  assert.match(moved.err, /made differently \(footageAt 30 → 40\)/);
  const late = render([file, '--out', join(dir, 'late.mp4'), '--fps', '10', '--duration', '16', '--footage', clip, '--footage-at', '16']);
  assert.equal(late.code, 2);
  assert.match(late.err, /--footage-at 16 is at or past the end \(16\.000 s\), so the footage would never show/);
  const alone = render([file, '--out', join(dir, 'alone.mp4'), '--duration', '16', '--footage-at', '3']);
  assert.equal(alone.code, 2);
  assert.match(alone.err, /--footage-at says when the --footage clip starts; give --footage too/);
  // Without --duration the piece runs on to the clip's last frame, wherever the clip starts.
  const whole = join(dir, 'whole.mp4');
  const taken = render([file, '--out', whole, '--footage', clip, '--footage-at', '3']);
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.err, /--fps 10 and --frames 130 \(13\.000 s\) from the footage clip\.mp4/);
  assert.equal(probe(whole, 'stream=nb_read_packets'), '130');
});

test('render: footage that ends before the render is followed by the page over black, frame-exact at 30000/1001', { skip }, () => {
  const dir = scratchDir('render-footage-short');
  const clip = join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', barClip(dir, 'bars.mp4', { frames: 20 }), '-r', '30000/1001', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const out = join(dir, 'out.mp4');
  // 0.5 s segments of 15 frames: the second ends the footage five frames in, the third has none.
  const r = render([page(dir, 'over.html', OVER_FOOTAGE, CLEAR), '--out', out, '--fps', '30000/1001', '--frames', '45', '--segment', '0.5', '--footage', clip]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /footage clip\.mp4 under 0\.000-0\.667 s; the page is over black at 0\.667-1\.502 s/);
  const frames = storedFrames(out);
  assert.equal(frames.length, 45);
  frames.forEach((f, i) => {
    if (i < 20) near(edge(f, 20), 4 * i, `footage frame ${i}`);
    else assert.equal(edge(f, 20), -1, `no footage at frame ${i}`);
    assert.ok(f[90 * W + 210] > 200, `the page's box at frame ${i}`);
  });
});

/** A page with a transparent `w` x `h` stage and a small dim mark in its corner, so it draws something over the footage. */
function markPage(dir: string, w: number, h: number): string {
  const file = join(dir, 'mark.html');
  writeFileSync(file, `<!doctype html><html><head><style>html,body,#stage{margin:0;background:transparent}#stage{position:relative;width:${w}px;height:${h}px}
.mark{position:absolute;left:0;top:0;width:8px;height:8px;background:#444}</style></head><body><div id="stage"><div class="mark"></div></div></body></html>`);
  return file;
}

test('render: --footage of another shape than the stage is refused with the reframe command that cuts it', { skip }, () => {
  const dir = scratchDir('render-footage-shape');
  // 16:9 footage under a 9:16 stage: cut here, the page's preview and faces.js would see another picture.
  const clip = barClip(dir, 'talk.mp4', { frames: 30, width: 640, height: 360 });
  const out = join(dir, 'out.mp4');
  const r = render([markPage(dir, 180, 320), '--out', out, '--fps', '30', '--frames', '30', '--footage', clip]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /the footage talk\.mp4 is 640x360 as shown and the stage 180x320, another shape: cut it to the stage's shape first with npx @veedstudio\/openedit-cli reframe "\S*talk\.mp4" --aspect 9:16 --out <file>, and make that file the page's footage/);
  assert.equal(existsSync(out), false);
});

test('render: a phone clip stored sideways under a stage of its shown shape is laid upright, with no rotation left on it', { skip }, () => {
  const dir = scratchDir('render-footage-phone');
  // Stored 320x180 with a 90 degree rotation tag: shown 180x320, the stage's shape.
  const flat = barClip(dir, 'flat.mp4', { frames: 15, width: 320, height: 180 });
  const phone = join(dir, 'phone.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-display_rotation', '90', '-i', flat, '-c', 'copy', phone]);
  const out = join(dir, 'out.mp4');
  const r = render([markPage(dir, 180, 320), '--out', out, '--fps', '30', '--frames', '15', '--footage', phone]);
  assert.equal(r.code, 0, r.err);
  assert.equal(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim(), '180,320');
  const gray = (file: string) => execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const [got, upright] = [gray(out), gray(phone)];
  assert.equal(got.length, upright.length, 'frames of the shown size');
  const off = got.reduce((sum, v, i) => sum + Math.abs(v - upright[i]), 0) / got.length;
  assert.ok(off < 3, `the footage as ffmpeg shows it upright: ${off.toFixed(2)} levels off`);
});

test('render: under --footage a page that paints over the whole frame fails, since the footage would never show', { skip }, () => {
  const dir = scratchDir('render-footage-opaque');
  const clip = barClip(dir, 'clip.mp4', { frames: 10 });
  const out = join(dir, 'out.mp4');
  // The default page: a black stage, as a page written for a browser preview often has.
  const r = render([page(dir, 'opaque.html', OVER_FOOTAGE), '--out', out, '--frames', '10', '--footage', clip]);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /every rendered frame is opaque, so the footage never shows: the page paints a background over it/);
  assert.equal(existsSync(out), false);
});

/**
 * HDR clips at the canvas size: HLG with every frame a keyframe, so only its HDR can be the reason for a copy;
 * PQ with HDR10 boxes; and HLG tagged on its transfer alone, below 720 lines, where an untagged matrix is read
 * as BT.601 unless the conversion is accounted for.
 */
function hdrClips(dir: string): [string, string, Transfer][] {
  const video = `testsrc=size=${W}x${H}:rate=30`;
  return [
    ['hlg', hdrClip(dir, 'hlg.mp4', { transfer: 'arib-std-b67', video, gop: 1, audio: null }), 'arib-std-b67'],
    ['pq', hdrClip(dir, 'pq.mp4', { transfer: 'smpte2084', video, hdr10: true, audio: null }), 'smpte2084'],
    ['partial', hdrClip(dir, 'partial.mp4', { transfer: 'arib-std-b67', video, tags: 'transfer', audio: null }), 'arib-std-b67'],
  ];
}

const OVER_CLIP = (clip: string) => OVER_FOOTAGE.replace('clip.mp4', basename(clip));
// Left of anything OVER_FOOTAGE draws.
const FOOTAGE_ONLY = 180;

test('render: HDR footage under --footage comes out SDR, tagged bt709, without HDR10 metadata, in video and stills', { skip }, () => {
  const dir = scratchDir('render-hdr-footage');
  for (const [kind, clip, transfer] of hdrClips(dir)) {
    const out = join(dir, `${kind}-render.mp4`);
    const file = page(dir, `${kind}.html`, OVER_CLIP(clip), CLEAR);
    const r = render([file, '--out', out, '--fps', '30', '--frames', '15', '--footage', clip]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`the footage ${kind}\\.mp4 is HDR \\((HLG|PQ), [\\w ()-]+/[\\w-]+/[\\w ()-]+\\): converted to SDR BT\\.709`));
    assert.doesNotMatch(r.err, /all-intra|SDR copy/, 'the stood-down <video> is not copied');
    assert.equal(probe(out, 'stream=color_primaries,color_transfer,color_space'), 'bt709,bt709,bt709');
    assert.deepEqual([hdr10Data(out, 'stream'), hdr10Data(out, 'frame')], [[], []]);
    const check = { transfer, width: W, columns: FOOTAGE_ONLY, tolerance: 2 };
    for (const i of [0, 14]) assertConverted(clip, i, lumaOf(out, i, 'video'), { ...check, what: `${kind} frame ${i}` });
    const stills = join(dir, `${kind}-stills`);
    const s = render([file, '--out', stills, '--stills', '0.5', '--footage', clip]);
    assert.equal(s.code, 0, s.err);
    assertConverted(clip, 15, lumaOf(join(stills, 'f000015-0.500s.png'), 0, 'still'), { ...check, what: `${kind} still` });
  }
});

test('render: an HDR <video> on the page is served from an SDR copy, so Chrome never tone-maps it its own way', { skip }, () => {
  const dir = scratchDir('render-hdr-video');
  // Pin quality so compression noise does not obscure the differences between the tone-mapping curves.
  const encode = ['--crf', '15'];
  for (const [kind, clip, transfer] of hdrClips(dir).slice(0, 2)) {
    const out = join(dir, `${kind}-render.mp4`);
    const file = page(dir, `${kind}.html`, OVER_CLIP(clip).split('\n')[0]);
    const r = render([file, '--out', out, '--fps', '30', '--frames', '15', '--segment', '0.25', ...encode]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`${kind}\\.mp4 is HDR \\(${kind.toUpperCase()}, `));
    assert.match(r.err, new RegExp(`made an SDR copy of ${kind}\\.mp4 \\(it is HDR\\), all-intra for frame-exact seeks`));
    assert.equal(probe(out, 'stream=color_space'), 'bt709');
    assert.deepEqual([hdr10Data(out, 'stream'), hdr10Data(out, 'frame')], [[], []]);
    const check = { transfer, width: W, columns: FOOTAGE_ONLY, tolerance: 2.5 };
    for (const i of [0, 14]) assertConverted(clip, i, lumaOf(out, i, 'video'), { ...check, what: `${kind} frame ${i}` });
    const stills = join(dir, `${kind}-stills`);
    const s = render([file, '--out', stills, '--stills', '0.5']);
    assert.equal(s.code, 0, s.err);
    assertConverted(clip, 15, lumaOf(join(stills, 'f000015-0.500s.png'), 0, 'still'), { ...check, what: `${kind} still` });

    // A cache made before page videos were converted holds segments Chrome tone-mapped itself: a patch is refused.
    const manifest = join(`${out}.render`, 'manifest.json');
    const cached = JSON.parse(readFileSync(manifest, 'utf8'));
    delete cached.params.sdr;
    writeFileSync(manifest, JSON.stringify(cached));
    const patch = render([file, '--out', out, '--fps', '30', '--frames', '15', '--segment', '0.25', '--from', '0.1', '--to', '0.2', ...encode]);
    assert.equal(patch.code, 2, patch.err);
    assert.match(patch.err, /made differently \(sdr undefined → "scale=in_color_matrix=bt2020,/);
  }
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
