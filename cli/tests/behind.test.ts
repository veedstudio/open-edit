// The speaker's layers, the behind check and the cut-out they draw. The arithmetic and the cut-out's alpha run
// everywhere on synthetic cut-outs made by ffmpeg, so no VEED login and no MediaPipe are needed. The page tests need
// the renderer's Chrome, and fail rather than skip under OPENEDIT_REQUIRE_BROWSER; where they say the check equals
// the render, they count the graphic's pixels in render stills with and without the speaker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAR, checkBehind, FAINTEST, summarize, visibleShare, wordShare, type BehindReport, type Measure, type Placed,
} from '../src/commands/behind.ts';
import { scanFrames } from '../src/commands/veed-project.ts';
import { FFMPEG } from '../src/config.ts';
import { alphaInput } from '../src/probe.ts';
import { CHROME_FLAGS, chromePlatform, installedChrome } from '../src/render/browser.ts';
import { longestGop, seekableCopy } from '../src/render/media.ts';
import { startPageServer } from '../src/render/server.ts';
import { speakerScript } from '../src/render/speaker.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// The check and the renders beside it share one media cache, as in any workspace: this file's own, so no other finds its copies.
process.env.OPEN_EDIT_ROOT = scratchDir('behind-workspace');
const W = 320;
const H = 180;
// The speaker: an opaque column from x 150 to 189, the full height, transparent elsewhere.
const COLUMN = '255*between(X,150,189)';
// The speaker steps to the left edge from the sixth frame (0.5 s at 10 fps).
const MOVING = 'if(lt(N,5),255*between(X,150,189),255*between(X,0,39))';

/** A capture of `box`, `inside` throughout, placed where it lies on the canvas. */
const shot = (box: { x: number; y: number; w: number; h: number }, inside = 255): Placed =>
  ({ x: box.x, y: box.y, width: box.w, height: box.h, alpha: new Uint8Array(box.w * box.h).fill(inside) });
const speaker = () => shot({ x: 150, y: 0, w: 40, h: H });
const near = (actual: number, expected: number, slack: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${actual}, expected ${expected} ± ${slack}`);

test('behind: a graphic a fifth behind the speaker is 80% visible, one half behind is 50%', () => {
  assert.equal(visibleShare(shot({ x: 70, y: 10, w: 100, h: 40 }), speaker()), 0.8);
  assert.equal(visibleShare(shot({ x: 150, y: 60, w: 80, h: 40 }), speaker()), 0.5);
  assert.equal(visibleShare(shot({ x: 0, y: 0, w: 100, h: 40 }), speaker()), 1, 'clear of the speaker');
});

test('behind: each pixel weighs by its own alpha, and a half-transparent speaker hides half', () => {
  // Half the graphic opaque and clear of the speaker, half at quarter alpha and wholly behind it.
  const ink = shot({ x: 100, y: 0, w: 90, h: 10 });
  for (let y = 0; y < 10; y++) ink.alpha.fill(64, y * 90 + 50, y * 90 + 90);
  near(visibleShare(ink, speaker())!, (255 * 50) / (255 * 50 + 64 * 40), 1e-9, 'share weighed by alpha');
  near(visibleShare(shot({ x: 0, y: 0, w: 100, h: 10 }), shot({ x: 0, y: 0, w: W, h: H }, 128))!, 127 / 255, 1e-9, 'under a half-transparent speaker');
});

test('behind: a capture fainter than an eighth of full alpha is not weighed at all', () => {
  assert.equal(visibleShare(shot({ x: 0, y: 0, w: 10, h: 10 }, 0), speaker()), null, 'nothing drawn');
  assert.equal(visibleShare(shot({ x: 0, y: 0, w: 10, h: 10 }, FAINTEST - 1), speaker()), null, 'the faint end of a fade');
  assert.equal(visibleShare(shot({ x: 0, y: 0, w: 10, h: 10 }, FAINTEST), speaker()), 1);
});

test('behind: a word is weighed by each of its boxes, over their parts on the canvas, and only where they hold ink', () => {
  const s = speaker();
  assert.equal(wordShare([{ x: 160, y: 10, w: 20, h: 10 }], s, W, H), 0, 'wholly behind');
  assert.equal(wordShare([{ x: 130, y: 10, w: 40, h: 10 }], s, W, H), 0.5);
  assert.equal(wordShare([{ x: -20, y: 10, w: 40, h: 10 }], s, W, H), 1, 'the part off the canvas is not counted');
  assert.equal(wordShare([{ x: 400, y: 10, w: 40, h: 10 }], s, W, H), null, 'none of it on the canvas');
  near(wordShare([{ x: 139.5, y: 10, w: 20, h: 10 }], s, W, H)!, 11 / 21, 1e-9, 'a fractional box rounds outward');
  // A word broken over two lines: its first line clear, its second half behind. Its bounding box would also take in
  // the speaker's whole column between the two.
  near(wordShare([{ x: 250, y: 10, w: 40, h: 10 }, { x: 130, y: 30, w: 40, h: 10 }], s, W, H)!, 0.75, 1e-9, 'two lines');
  const word = { x: 160, y: 10, w: 20, h: 10 };
  assert.equal(wordShare([word], s, W, H, shot(word, FAINTEST - 1)), null, 'a word still fading in, or clipped away, is not weighed');
  assert.equal(wordShare([word, { x: 10, y: 10, w: 20, h: 10 }], s, W, H, shot({ x: 0, y: 0, w: 40, h: 40 })), 1, 'only the letters drawn are weighed');
});

test('behind: the report gives the worst frame, the mean and the least visible word, and fails a frame under the bar', () => {
  const frames: Measure[] = [
    { sec: 1, share: 0.9, words: [{ text: 'ON', share: 1 }, { text: 'AIR', share: 0.95 }] },
    { sec: 2, share: 0.8, words: [{ text: 'ON', share: 0.85 }, { text: 'AIR', share: 0.9 }] },
    { sec: 3, share: 0.85, words: [{ text: 'ON', share: 0.8 }, { text: 'AIR', share: 0.9 }] },
  ];
  const pass = summarize('title', 'ON AIR', frames, BAR);
  assert.deepEqual({ ...pass, mean: Math.round(pass.mean * 1e6) / 1e6 }, {
    name: 'title', text: 'ON AIR', measuredFrames: 3, start: 1, end: 3, worst: { share: 0.8, sec: 2 }, mean: 0.85,
    leastVisibleWord: { text: 'ON', share: 0.8, sec: 3 }, under: null, pass: true,
  });
  const half = summarize('plate', '', frames.map((f) => ({ ...f, share: f.share - 0.35, words: [] })), BAR);
  assert.deepEqual([half.pass, half.leastVisibleWord, half.under], [false, null, { frames: 3, start: 1, end: 3 }]);
  const word = summarize('title', 'ON AIR', [frames[0], { ...frames[1], words: [{ text: 'AIR', share: 0.6 }] }, frames[2]], BAR);
  assert.deepEqual([word.pass, word.worst.share, word.leastVisibleWord, word.under], [false, 0.8, { text: 'AIR', share: 0.6, sec: 2 }, { frames: 1, start: 2, end: 2 }],
    'a graphic mostly visible still fails when one of its words is not');
  assert.throws(() => summarize('none', '', [], BAR), /no measured frame/);
});

/**
 * A VP9 cut-out with alpha at 10 fps: blue, opaque where `alpha` says (the speaker's column by default). Lossless,
 * so the alpha is exact; keyframes `gop` apart; `then` filters it further.
 */
function cutout(dir: string, o: { frames?: number; gop?: number; size?: string; alpha?: string; name?: string; then?: string; rate?: number } = {}): string {
  const file = join(dir, o.name ?? 'cutout.webm');
  const rate = o.rate ?? 10;
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${o.size ?? `${W}x${H}`}:r=${rate}:d=${(o.frames ?? 10) / rate}`, '-filter_complex',
    `[0:v]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${o.alpha ?? COLUMN}'${o.then ? `,${o.then}` : ''}[v]`,
    '-map', '[v]', '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuva420p', '-g', String(o.gop ?? 1), '-auto-alt-ref', '0', '-an', file]);
  return file;
}

/** The cut-out at `file` as ProRes 4444, alpha kept: a .mov Chrome has no decoder for. */
function prores(file: string, out: string): string {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', file, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', out]);
  return out;
}

/** Frame `index` of `file`'s alpha, decoded with `input` before -i. */
const alphaFrame = (file: string, input: string[], index: number): Buffer => execFileSync(FFMPEG, ['-v', 'error', ...input, '-i', file,
  '-vf', `select=eq(n\\,${index}),alphaextract,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });

test('alpha: a VP9 cut-out names libvpx, ProRes 4444 needs nothing named but a copy for Chrome, H.264 and a stale tag have none', () => {
  const dir = scratchDir('behind-alpha');
  const vp9 = cutout(dir);
  assert.deepEqual(alphaInput(vp9), { args: ['-c:v', 'libvpx-vp9'], webm: true });
  const mov = prores(vp9, join(dir, 'cutout.mov'));
  assert.deepEqual(alphaInput(mov), { args: [], webm: false });
  // Ten bits read back as eight, so near the extremes rather than at them.
  const alpha = alphaFrame(mov, [], 0);
  assert.ok(alpha[90 * W + 40] <= 2 && alpha[90 * W + 170] >= 253, `the ProRes copy carries the speaker in its alpha (${alpha[90 * W + 40]}, ${alpha[90 * W + 170]})`);
  const plain = join(dir, 'plain.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:r=10:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', plain]);
  assert.equal(alphaInput(plain), null);
  // Re-encoded without its alpha but tagged as having it, as a remux that kept the container's tags leaves it.
  const stale = join(dir, 'stale.webm');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', vp9, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-metadata:s:v:0', 'alpha_mode=1', stale]);
  assert.equal(alphaInput(stale), null);
});

test('render: the copy of a cut-out keeps its alpha, all-intra, at its own size, at a shown size, and from ProRes', async () => {
  const dir = scratchDir('behind-copy');
  const source = cutout(dir, { frames: 30, gop: 30 });
  const mov = prores(source, join(dir, 'cutout.mov'));
  for (const [file, size, at] of [[source, null, [40, 170]], [source, { width: 160, height: 90 }, [20, 85]], [mov, null, [40, 170]]] as const) {
    const { path } = await seekableCopy(file, join(dir, 'media'), size);
    assert.match(path, /\.webm$/);
    assert.equal(longestGop(path), 1, 'every frame a keyframe');
    const input = alphaInput(path);
    assert.deepEqual(input, { args: ['-c:v', 'libvpx-vp9'], webm: true });
    const width = size?.width ?? W;
    const alpha = alphaFrame(path, input!.args, 17);
    const [beside, on] = at.map((x) => alpha[Math.floor((size?.height ?? H) / 2) * width + x]);
    // Lossy, so near the extremes rather than at them.
    assert.ok(beside <= 8 && on >= 247, `transparent beside the speaker (${beside}), opaque on it (${on})`);
  }
});

const platform = chromePlatform();
const noChrome = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (noChrome && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${noChrome}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = noChrome ?? false;

interface Layers { footage?: string; behind?: string; front?: string; loose?: string }

/** A page whose stage names `cutout`, its content in the three layers. */
function page(dir: string, l: Layers, o: { cutout?: string | null; style?: string; script?: string; stage?: string; name?: string } = {}): string {
  const file = join(dir, o.name ?? 'index.html');
  const named = o.cutout === null ? '' : ` data-cutout="${o.cutout ?? 'cutout.webm'}"`;
  const layer = (k: keyof Layers) => (l[k] === undefined ? '' : `<div data-layer="${k}">${l[k]}</div>`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.g{position:absolute;background:#f00}
.w{position:absolute;top:8px;font:14px/1 monospace;color:#fff}
${o.style ?? ''}</style></head><body><div id="stage" data-stateless${named}${o.stage ?? ''}>
${layer('footage')}${layer('behind')}${layer('front')}${l.loose ?? ''}
</div><script>${o.script ?? ''}</script></body></html>`);
  return file;
}

const FOOTAGE = '<video src="footage.mp4" muted playsinline></video>';
function footage(dir: string): void {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=10:d=2,drawbox=x=0:y=0:w=50:h=50:color=green:t=fill`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'footage.mp4')]);
}

const byName = (report: BehindReport) => Object.fromEntries(report.graphics.map((g) => [g.name, g]));
const render = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } });
const rgbOf = (png: string): Buffer => execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
const at = (rgb: Buffer, x: number, y: number) => [...rgb.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
const isBlue = ([r, , b]: number[]) => b > 200 && r < 60;
const isRed = ([r, g, b]: number[]) => r > 200 && g < 80 && b < 80;
const isGreen = ([r, g, b]: number[]) => g > 200 && r < 60 && b < 60;

/** Render stills at `times` and read each back. */
function stills(file: string, out: string, times: number[]): Buffer[] {
  const r = render([file, '--out', out, '--stills', times.join(','), '--fps', '10']);
  assert.equal(r.status, 0, r.stderr);
  return readdirSync(out).filter((f) => f.endsWith('.png')).sort().map((f) => rgbOf(join(out, f)));
}

/** The share of the page's red that shows in a render, against the same page with no speaker, at each time. */
function rendered(file: string, times: number[]): number[] {
  const red = (rgb: Buffer) => { let n = 0; for (let i = 0; i < rgb.length; i += 3) if (isRed([rgb[i], rgb[i + 1], rgb[i + 2]])) n++; return n; };
  const bare = file.replace(/\.html$/, '-bare.html');
  writeFileSync(bare, readFileSync(file, 'utf8').replace(/ data-cutout="[^"]*"/, ''));
  const laid = stills(file, `${file}.stills`, times).map(red);
  const whole = stills(bare, `${bare}.stills`, times).map(red);
  return laid.map((n, i) => n / whole[i]);
}

test('behind: in Chrome, a graphic about 80% visible passes, one half hidden is reported, and words are weighed one by one', { skip }, async () => {
  const dir = scratchDir('behind-page');
  cutout(dir);
  const file = page(dir, { behind: [
    '<div class="g" data-behind="fifth" style="left:70px;top:10px;width:100px;height:40px"></div>',
    '<div class="g" data-behind="half" style="left:150px;top:60px;width:80px;height:40px"></div>',
    // One word clear of the speaker, one wholly behind it, and one behind it but not shown yet.
    '<div class="g" data-behind="words" style="left:0;top:120px;width:300px;height:50px"><span class="w" style="left:10px">OK</span>'
      + '<span class="w" style="left:156px">HID</span></div>',
    '<div class="g" data-behind="unshown" style="left:0;top:120px;width:300px;height:50px;background:#36c"><span class="w" style="left:10px">OK</span>'
      + '<span class="w" style="left:156px;opacity:0">GONE</span></div>',
    // A word set letter by letter is one word; on only from the sixth frame, so checked over the frames it is on.
    '<div data-behind="letters" style="position:absolute;left:4px;top:62px;font:20px/1 monospace;color:#fff;animation:on 1s steps(1) both">'
      + '<span>A</span><span>B</span><span>C</span></div>',
    // Two elements sharing a name are one graphic; one never drawn is listed as such.
    '<div class="g" data-behind="pair" style="left:0;top:0;width:40px;height:20px"></div>',
    '<div class="g" data-behind="pair" style="left:250px;top:0;width:40px;height:20px"></div>',
    '<div class="g" data-behind="never" style="left:0;top:0;width:40px;height:20px;opacity:0"></div>',
  ].join('\n') }, { style: '@keyframes on{0%{opacity:0}45%{opacity:1}}' });
  const report = await checkBehind(file, { bar: BAR });
  assert.deepEqual([report.checkedFrames, report.width, report.height, report.fps, report.frameRate], [10, W, H, 10, '10']);
  const by = byName(report);
  near(by.fifth.worst.share, 0.8, 0.005, 'fifth');
  assert.deepEqual([by.fifth.measuredFrames, by.fifth.pass], [10, true]);
  near(by.half.worst.share, 0.5, 0.005, 'half');
  assert.deepEqual([by.half.pass, by.half.under?.frames], [false, 10]);
  assert.ok(by.words.worst.share >= BAR, `the words graphic is ${by.words.worst.share} visible as a whole`);
  assert.equal(by.words.leastVisibleWord?.text, 'HID');
  near(by.words.leastVisibleWord!.share, 0, 0.005, 'the hidden word');
  assert.equal(by.words.pass, false);
  assert.deepEqual([by.unshown.pass, by.unshown.leastVisibleWord?.text], [true, 'OK'], 'a word not shown yet is not weighed');
  assert.deepEqual([by.letters.measuredFrames, by.letters.start, by.letters.leastVisibleWord?.text], [5, 0.5, 'ABC']);
  assert.deepEqual([by.pair.pass, report.unseen], [true, ['never']]);
});

test('behind: a word broken over two lines is weighed by its lines, and Chinese by its words', { skip }, async () => {
  const dir = scratchDir('behind-words');
  // The speaker covers the left of the first line only, where the broken word has no letter.
  cutout(dir, { alpha: '255*between(X,0,99)*lt(Y,40)' });
  const file = page(dir, { behind: [
    '<div data-behind="broken" style="position:absolute;left:0;top:10px;width:300px;font:28px/1.2 monospace;color:#fff;word-break:break-all">'
      + '<span style="margin-left:120px"></span>bbbbbbbbbbbbbbbbbbbb</div>',
    '<div data-behind="zh" lang="zh" style="position:absolute;left:180px;top:120px;font:24px/1 sans-serif;color:#fff">你好世界</div>',
  ].join('\n') });
  const by = byName(await checkBehind(file, { bar: BAR }));
  assert.equal(by.broken.leastVisibleWord?.share, 1, 'its bounding box would take in the speaker beside its first line');
  assert.ok(['你好', '世界'].includes(by.zh.leastVisibleWord?.text ?? ''), `a word of the Chinese, not the line: ${by.zh.leastVisibleWord?.text}`);
});

test('layers: the CLI stacks footage, behind, the speaker and front in that order, whatever the page\'s z-index or scripts', { skip }, async () => {
  const dir = scratchDir('behind-layers');
  footage(dir);
  cutout(dir, { alpha: MOVING });
  const file = page(dir, {
    // The footage raised above everything, a graphic raised, one nested in a raised wrapper, one in display:contents.
    footage: '<video src="footage.mp4" muted playsinline style="z-index:999"></video>',
    behind: [
      '<div class="g" data-behind="raised" style="left:150px;top:10px;width:80px;height:40px;z-index:99"></div>',
      '<div style="position:absolute;inset:0;z-index:50"><div class="g" data-behind="nested" style="left:150px;top:60px;width:80px;height:40px;z-index:9"></div></div>',
      '<div style="display:contents"><div class="g" data-behind="contents" style="left:150px;top:110px;width:80px;height:30px;z-index:9"></div></div>',
    ].join('\n'),
    front: '<div style="position:absolute;left:0;top:150px;width:320px;height:20px;background:#0f0;z-index:-5"></div>',
  }, {
    // The page reaches for every video it can find, once loaded and on every frame, and moves, re-times, loops,
    // mirrors, zooms, hides and lowers each: the cut-out is not among them.
    script: 'window.__seek=(t)=>{for(const v of document.querySelectorAll("video")){v.currentTime=1.5;v.loop=true;'
      + 'v.style.setProperty("transform","scale(3) scaleX(-1)","important");v.style.zIndex="-1";v.style.opacity="0"}};'
      + 'document.addEventListener("DOMContentLoaded",()=>{for(const v of document.querySelectorAll("video")){const w=document.createElement("div");'
      + 'w.style.cssText="position:absolute;inset:0;transform:scaleX(-1)";v.parentNode.insertBefore(w,v);w.appendChild(v)}})',
    style: '#stage video{transform:scale(2)!important}@layer x{video{transform:scale(2)!important}}',
  });
  const report = await checkBehind(file, { bar: BAR, duration: 1.5 });
  for (const g of report.graphics) {
    assert.deepEqual(g.under, { frames: 5, start: 0, end: 0.4 }, `${g.name}: under the speaker exactly while it stands over it, then clear, its last frame held`);
  }
  const [early, late] = stills(file, join(dir, 'stills'), [0.2, 0.8]);
  for (const y of [30, 80, 125]) {
    assert.ok(isBlue(at(early, 170, y)), `0.2 s, y ${y}: the speaker over the graphic, got ${at(early, 170, y)}`);
    assert.ok(isRed(at(late, 170, y)), `0.8 s, y ${y}: the graphic over the footage, the speaker gone, got ${at(late, 170, y)}`);
  }
  assert.ok(isGreen(at(early, 170, 160)), 'the front layer stays over the speaker');
});

test('layers: a punch-in on the footage layer carries the speaker with it, as the render shows', { skip }, async () => {
  const dir = scratchDir('behind-punch');
  footage(dir);
  cutout(dir);
  // From 0.5 s the footage layer is scaled 1.5 about the centre: the speaker's column, 150 to 189, spreads to 145 to 204.
  const file = page(dir, { footage: FOOTAGE, behind: '<div class="g" data-behind="g" style="left:100px;top:10px;width:70px;height:40px"></div>' },
    { style: '[data-layer=footage]{animation:z .1s linear .5s both}@keyframes z{from{transform:none}to{transform:scale(1.5)}}' });
  const report = await checkBehind(file, { bar: BAR });
  const truth = rendered(file, [0.2, 0.8]);
  near(report.graphics[0].worst.share, truth[1], 0.02, 'checked against rendered, once punched in');
  near(truth[0], 50 / 70, 0.02, 'before the punch-in');
  near(truth[1], 45 / 70, 0.03, 'after it');
});

test('behind: paint past a graphic\'s own boxes is weighed where it lands: an SVG filter\'s offset copy, a border image\'s outset, a shadow root under a box of no size, a shadow cast from off the canvas', { skip }, async () => {
  const dir = scratchDir('behind-paint');
  cutout(dir);
  const pages = {
    svg: page(dir, { behind: '<svg width="0" height="0" style="position:absolute"><filter id="f" x="-100%" y="0" width="300%" height="100%">'
      + '<feOffset dx="60" in="SourceGraphic" result="o"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="o"/></feMerge></filter></svg>'
      + '<div class="g" data-behind="sf" style="left:60px;top:10px;width:60px;height:40px;filter:url(#f)"></div>' }, { name: 'svg.html' }),
    outset: page(dir, { behind: '<div class="g" data-behind="bo" style="left:60px;top:10px;width:60px;height:40px;background:none;border:10px solid;'
      + 'border-image:linear-gradient(#f00,#f00) 1;border-image-outset:40px"></div>' }, { name: 'outset.html' }),
    shadowRoot: page(dir, { behind: '<x-title data-behind="st" style="position:absolute;left:120px;top:10px;width:0;height:0"><template shadowrootmode="closed">'
      + '<div style="position:absolute;left:0;top:0;width:60px;height:40px;background:#f00"></div></template></x-title>' }, { name: 'shadow-root.html' }),
    offCanvas: page(dir, { behind: '<div class="g" data-behind="oc" style="left:-400px;top:10px;width:60px;height:40px;background:none;box-shadow:550px 0 0 #f00"></div>' },
      { name: 'off-canvas.html' }),
  };
  for (const [name, file] of Object.entries(pages)) {
    const report = await checkBehind(file, { bar: BAR, duration: 0.1 });
    assert.deepEqual(report.unseen, [], `${name}: measured, not taken as undrawn`);
    const share = report.graphics[0].worst.share;
    const truth = rendered(file, [0])[0];
    assert.ok(truth < 0.95, `${name}: the speaker covers some of it in the render (${truth})`);
    near(share, truth, 0.02, `${name}: checked against rendered`);
  }
});

test('layers: the editor hand-off draws each layer alone, without the speaker over it', { skip }, async () => {
  const dir = scratchDir('behind-veed');
  cutout(dir);
  page(dir, {
    behind: '<div class="g" data-behind="g" style="left:100px;top:10px;width:70px;height:40px"></div>',
    front: '<div id="cap" style="position:absolute;left:10px;top:150px;width:60px;height:20px;background:#0f0"></div>',
  });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ name: 'layers', width: W, height: H, fps: 10, duration: 0.5, page: 'index.html',
    parts: [{ type: 'layer', select: '[data-behind=g]' }, { type: 'layer', select: '#cap' }] }));
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'veed-project', join(dir, 'plan.json'), '--local'], { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const layers = join(dir, 'veed', 'layers');
  const frames = join(layers, readdirSync(layers).find((f) => f.startsWith('index-'))!);
  // Each layer's frames hold its element's box and nothing else: no speaker, opaque over x 150 to 189, full height.
  const own = [{ x1: 100, x2: 169, y1: 10, y2: 49 }, { x1: 10, x2: 69, y1: 150, y2: 169 }];
  for (const [k, box] of own.entries()) {
    for (const f of await scanFrames(join(frames, String(k)), 10, 0, 5)) assert.deepEqual({ x1: f.x1, x2: f.x2, y1: f.y1, y2: f.y2 }, box, `layer ${k}`);
  }
});

test('behind: a graphic is measured by all it paints: text past its box, and a shadow spread into the speaker', { skip }, async () => {
  const dir = scratchDir('behind-ink');
  cutout(dir, { alpha: '255*between(X,200,319)' });
  const text = page(dir, { behind: '<div data-behind="t" style="position:absolute;left:10px;top:60px;width:100px;white-space:nowrap;font:bold 40px/1 sans-serif;color:#f00">BIG TITLE HERE</div>' }, { name: 'text.html' });
  const shadow = page(dir, { behind: '<div data-behind="s" style="position:absolute;left:60px;top:60px;width:40px;height:40px;background:#f00;box-shadow:0 0 0 120px #f00"></div>' }, { name: 'shadow.html' });
  for (const file of [text, shadow]) {
    const share = (await checkBehind(file, { bar: BAR, duration: 0.1 })).graphics[0].worst.share;
    const truth = rendered(file, [0])[0];
    assert.ok(truth < 0.95, `the speaker covers some of it in the render (${truth})`);
    near(share, truth, 0.02, `${file}: checked against rendered`);
  }
});

test('layers: a graphic outside the behind layer, a layer that is not the stage\'s child, or a stage that no longer names the cut-out, is refused', { skip }, async () => {
  const dir = scratchDir('behind-refused-layers');
  cutout(dir);
  const outside = page(dir, { behind: '' }, { name: 'outside.html', script: 'setTimeout(()=>{const g=document.createElement("div");g.className="g";g.dataset.behind="g";g.style.cssText="left:0;top:0;width:9px;height:9px";document.getElementById("stage").appendChild(g)},0)' });
  await assert.rejects(checkBehind(outside, { bar: BAR }), /a data-behind graphic lies outside the behind layer/);
  const r = render([outside, '--out', join(dir, 'out.mp4'), '--duration', '0.5', '--fps', '10']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /speaker layer: a data-behind graphic lies outside the behind layer/);
  const nested = page(dir, { loose: '<div><div data-layer="behind"></div></div>' }, { name: 'nested.html' });
  await assert.rejects(checkBehind(nested, { bar: BAR }), /speaker layer: a \[data-layer\] lies inside another element of the stage/);
  const away = page(dir, { behind: '' }, { name: 'away.html', script: 'document.body.insertAdjacentHTML("beforeend","<div data-layer=\\"front\\"></div>")' });
  await assert.rejects(checkBehind(away, { bar: BAR }), /speaker layer: a \[data-layer\] lies outside the stage/);
  const swapped = page(dir, { behind: '' }, { name: 'swapped.html', script: 'window.__seek=()=>{const s=document.getElementById("stage");if(s.dataset.cutout)s.replaceWith(Object.assign(document.createElement("div"),{id:"stage"}))}' });
  await assert.rejects(checkBehind(swapped, { bar: BAR }), /speaker layer: the page replaced its stage with one that does not name the cut-out cutout\.webm/);
});

/** Whether the speaker is drawn in each of a render's stills: its column, below the graphic, shows the cut-out. */
const speakerShown = (file: string, out: string, times: number[]) => stills(file, out, times).map((rgb) => isBlue(at(rgb, 170, 120)));

test('layers: a page that drops the speaker\'s box, rebuilds the stage or replaces it keeps the speaker on every frame, as the check measures it', { skip }, async () => {
  const dir = scratchDir('behind-dropped');
  cutout(dir);
  const g = { behind: '<div class="g" data-behind="g" style="left:100px;top:10px;width:70px;height:40px"></div>' };
  const times = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const pages = {
    // Every frame: the box removed, or the stage's content written again (a framework's render).
    dropped: page(dir, g, { name: 'dropped.html', script: 'window.__seek=()=>{const b=document.querySelector("[data-oe-speaker]");if(b)b.remove()}' }),
    rebuilt: page(dir, g, { name: 'rebuilt.html', script: 'window.__seek=()=>{const s=document.getElementById("stage");s.innerHTML=s.innerHTML}' }),
    // Once, from 0.5 s: the stage itself swapped for a copy of it.
    replaced: page(dir, g, { name: 'replaced.html', script: 'window.__seek=(t)=>{const s=document.getElementById("stage");if(t>=0.5&&!s.dataset.copy){const c=s.cloneNode(true);c.dataset.copy="1";s.replaceWith(c)}}' }),
  };
  for (const [name, file] of Object.entries(pages)) {
    assert.deepEqual(speakerShown(file, join(dir, `${name}.stills`), times), times.map(() => true), `${name}: the speaker in every still`);
    const report = await checkBehind(file, { bar: BAR, duration: 1 });
    assert.deepEqual([report.graphics[0].measuredFrames, Math.round(report.graphics[0].worst.share * 1000), Math.round(report.graphics[0].mean * 1000)], [10, 714, 714], name);
  }
});

test('layers: a page that restyles the speaker\'s box or reaches for its video changes nothing the render or the check shows', { skip }, async () => {
  const dir = scratchDir('behind-reach');
  cutout(dir);
  const file = page(dir, { behind: '<div class="g" data-behind="g" style="left:100px;top:10px;width:70px;height:40px"></div>' }, {
    style: '#stage>div:not([data-layer]){background:#000!important;visibility:hidden!important;content-visibility:hidden!important;opacity:0!important;'
      + 'filter:opacity(0)!important;outline:300px solid #000!important;box-shadow:0 0 0 300px #000!important;transform:scale(3)!important;zoom:3!important;'
      + 'clip-path:inset(50%)!important;mix-blend-mode:multiply!important;max-width:0!important;max-height:0!important}',
    script: 'window.__seek=()=>{const v=window.__oeSpeaker&&window.__oeSpeaker.video;if(v)v.style.opacity="0";'
      + 'const b=document.querySelector("[data-oe-speaker]");if(b)b.style.setProperty("display","none","important")}',
  });
  assert.deepEqual(speakerShown(file, join(dir, 'stills'), [0, 0.5]), [true, true]);
  near((await checkBehind(file, { bar: BAR })).graphics[0].worst.share, 50 / 70, 0.01, 'checked');
  rendered(file, [0, 0.5]).forEach((share) => near(share, 50 / 70, 0.01, 'rendered'));
});

test('layers: a page that wraps or calls every method the runtime gives it cannot hide the speaker from the check or the render', { skip }, async () => {
  const dir = scratchDir('behind-runtime');
  cutout(dir);
  // Each method is wrapped to invert any flag it is passed; on every frame, each one that does not step the page is
  // called with false.
  const file = page(dir, { behind: '<div class="g" data-behind="g" style="left:100px;top:10px;width:70px;height:40px"></div>' }, {
    script: 'const o=window.__openedit;for(const k of Object.keys(o)){const f=o[k];if(typeof f==="function")o[k]=function(...a){return f.apply(this,a.map((x)=>typeof x==="boolean"?!x:x))}}'
      + 'window.__seek=()=>{for(const k of Object.keys(o)){if(!["frame","preroll","ready"].includes(k)&&typeof o[k]==="function")try{o[k](false)}catch{}}}',
  });
  assert.deepEqual(speakerShown(file, join(dir, 'stills'), [0, 0.5]), [true, true]);
  near((await checkBehind(file, { bar: BAR })).graphics[0].worst.share, 50 / 70, 0.01, 'checked');
  rendered(file, [0, 0.5]).forEach((share) => near(share, 50 / 70, 0.01, 'rendered'));
});

test('behind: the page reads the same screen through the check as through the render', { skip }, async () => {
  const dir = scratchDir('behind-screen');
  cutout(dir);
  // The graphic moves as far as the screen the page reads changes from the one it read on load.
  const file = page(dir, { behind: '<div class="g" data-behind="g" style="left:100px;top:10px;width:70px;height:40px"></div>' }, {
    script: 'const w0=screen.width,h0=screen.height;window.__seek=()=>{document.querySelector(".g").style.left=(100+screen.width-w0+screen.height-h0)+"px"}',
  });
  const report = await checkBehind(file, { bar: BAR });
  const g = report.graphics[0];
  assert.deepEqual([g.measuredFrames, Math.round(g.worst.share * 1000), Math.round(g.mean * 1000)], [10, 714, 714]);
  rendered(file, [0, 0.5, 0.9]).forEach((share) => near(share, 50 / 70, 0.01, 'rendered'));
});

test('behind: the report is the same whatever --workers, on a page jumped into and on one stepped through', { skip }, async () => {
  const dir = scratchDir('behind-workers');
  cutout(dir, { frames: 30 });
  // A graphic on only from 1.8 s; and, on a page not marked stateless, one a script moves a pixel a frame into the
  // speaker, which a worker that skipped the frames before its own would place elsewhere.
  const behind = '<div class="g" data-behind="g" style="left:100px;top:10px;width:60px;height:40px"></div>'
    + '<div class="g" data-behind="late" style="left:0;top:100px;width:200px;height:40px;animation:on 3s steps(1) both"></div>';
  const style = '@keyframes on{0%{opacity:0}60%{opacity:1}}';
  const jumped = page(dir, { behind }, { style });
  const stepped = page(dir, { behind }, {
    style, name: 'stepped.html', script: 'let n=0;(function f(){document.querySelector("[data-behind=g]").style.left=(100+n++)+"px";requestAnimationFrame(f)})()',
  });
  writeFileSync(stepped, readFileSync(stepped, 'utf8').replace(' data-stateless', ''));
  for (const f of [jumped, stepped]) {
    const one = await checkBehind(f, { bar: BAR, duration: 3, workers: 1 });
    // How many draws Chrome needed forcing depends on the machine's pace, not on the page.
    const measured = ({ forcedDraws: _, ...r }: BehindReport) => r;
    assert.deepEqual(measured(await checkBehind(f, { bar: BAR, duration: 3, workers: 3 })), measured(one), f);
    assert.deepEqual(one.graphics.map((g) => [g.name, g.measuredFrames]), [['g', 30], ['late', 12]]);
  }
});

test('behind: a stage away from the page\'s corner is measured where it is, and a rate other than the cut-out\'s by time', { skip }, async () => {
  const dir = scratchDir('behind-offset');
  // At 5 fps, the speaker moves at 1 s; stepped at 20 fps, it is read by time, as Chrome shows it.
  cutout(dir, { rate: 5, frames: 10, alpha: 'if(lt(N,5),255*between(X,150,189),255*between(X,0,39))' });
  const file = page(dir, { behind: ['<div class="g" data-behind="fifth" style="left:70px;top:10px;width:100px;height:40px"></div>',
    '<div class="g" data-behind="words" style="left:0;top:120px;width:300px;height:50px"><span class="w" style="left:156px">HID</span></div>'].join('\n') },
  { style: 'body{padding:24px 40px}' });
  const report = await checkBehind(file, { bar: BAR, fps: { num: 20, den: 1 } });
  const by = byName(report);
  assert.deepEqual([report.checkedFrames, report.frameRate], [40, '20']);
  near(by.fifth.worst.share, 0.8, 0.005, 'fifth');
  assert.deepEqual(by.words.under, { frames: 20, start: 0, end: 0.95 }, 'the hidden word is under the speaker for its first second, at 20 fps');
});

test('behind: a cut-out of non-square pixels is measured as Chrome draws it', { skip }, async () => {
  const dir = scratchDir('behind-sar');
  // 160x180 stored, shown 320x180 (each pixel twice as wide): its column at 75-94 lands at 150-189.
  cutout(dir, { size: `160x${H}`, alpha: '255*between(X,75,94)', then: 'setsar=2' });
  const file = page(dir, { behind: '<div class="g" data-behind="fifth" style="left:70px;top:10px;width:100px;height:40px"></div>' });
  near((await checkBehind(file, { bar: BAR })).graphics[0].worst.share, 0.8, 0.02, 'fifth');
});

test('behind: the command prints a line per graphic, exits 1 when one is under the bar or none was measured, and --json says why it refused', { skip }, () => {
  const dir = scratchDir('behind-cli');
  cutout(dir);
  const run = (file: string, ...more: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, 'behind', file, ...more], { encoding: 'utf8', timeout: 120_000 });
  const file = page(dir, { behind: '<div class="g" data-behind="half" style="left:150px;top:60px;width:80px;height:40px"></div>' });
  const r = run(file);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /half: measured on 10 frame\(s\), 0\.000 s to 0\.900 s; visible 50\.0% at worst \(0\.000 s\), 50\.0% on average\. UNDER 75\.0% on 10 of 10 frames/);
  const ok = run(file, '--bar', '0.5');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /passes/);
  const json = run(file, '--json');
  assert.equal(json.status, 1, json.stderr);
  const report = JSON.parse(json.stdout) as BehindReport;
  assert.deepEqual([report.pass, report.graphics[0].pass, report.graphics[0].under?.frames, report.unseen, report.failedLoads], [false, false, 10, [], []]);
  const bad = run(file, '--bar', '1.5', '--json');
  assert.equal(bad.status, 1);
  assert.match((JSON.parse(bad.stdout) as { error: string }).error, /--bar wants a share above 0 and at most 1/);
  const none = run(page(dir, { behind: '<div class="g" data-behind="never" style="left:0;top:0;width:40px;height:20px;opacity:0"></div>' }));
  assert.equal(none.status, 1, 'nothing measured is not a pass');
  assert.match(none.stderr, /never is not drawn .* so it was not checked/);
});

test('behind: a page naming no cut-out, a cut-out with no alpha, missing, HEVC or HDR, is refused with the reason', { skip }, async () => {
  const dir = scratchDir('behind-refused');
  footage(dir);
  cutout(dir);
  const g = { behind: '<div class="g" data-behind="g" style="left:70px;top:10px;width:100px;height:40px"></div>' };
  await assert.rejects(checkBehind(page(dir, g, { cutout: null }), { bar: BAR }), /stage names no cut-out: give it data-cutout/);
  await assert.rejects(checkBehind(page(dir, g, { cutout: 'footage.mp4' }), { bar: BAR }), /footage\.mp4 has no alpha channel/);
  await assert.rejects(checkBehind(page(dir, g, { cutout: 'missing.webm' }), { bar: BAR }), /missing\.webm is not there/);
  cutout(dir, { then: 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc', name: 'hdr.webm' });
  await assert.rejects(checkBehind(page(dir, g, { cutout: 'hdr.webm' }), { bar: BAR }), /hdr\.webm is HDR, and a render draws an HDR video without its alpha/);
  // Only where this ffmpeg can make HEVC at all.
  if (execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx265')) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:r=10:d=1`, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', join(dir, 'hevc.mov')]);
    const hevc = page(dir, g, { cutout: 'hevc.mov', name: 'hevc.html' });
    await assert.rejects(checkBehind(hevc, { bar: BAR }), /hevc\.mov is HEVC, whose alpha Chrome cannot draw here.*convert it to VP9 WebM or ProRes 4444/);
    // A Chrome with a platform HEVC decoder plays it, opaque; one without refuses it, and says how to fix it.
    const r = render([hevc, '--out', join(dir, 'hevc.stills'), '--stills', '0', '--fps', '10']);
    if (r.status !== 0) assert.match(r.stderr, /hevc\.mov could not be played.*it is HEVC, whose alpha Chrome cannot draw here, so convert it to VP9 WebM or ProRes 4444/);
  }
  await assert.rejects(checkBehind(page(dir, { behind: '<div class="g" style="left:70px;top:10px;width:100px;height:40px"></div>' }), { bar: BAR }),
    /no element on index\.html's stage is marked data-behind/);
});

test('layers: a ProRes 4444 cut-out, which Chrome cannot play, is checked and rendered from its VP9 copy, with no failed load left', { skip }, async () => {
  const dir = scratchDir('behind-prores');
  prores(cutout(dir), join(dir, 'cutout.mov'));
  const file = page(dir, { behind: '<div class="g" data-behind="fifth" style="left:70px;top:10px;width:100px;height:40px"></div>' }, { cutout: 'cutout.mov' });
  const report = await checkBehind(file, { bar: BAR });
  near(byName(report).fifth.worst.share, 0.8, 0.01, 'fifth');
  assert.deepEqual(report.failedLoads, [], 'the copy that plays leaves no failed load behind');
  const r = render([file, '--out', join(dir, 'stills'), '--stills', '0.5', '--fps', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /made a VP9 copy/, 'the render plays the VP9 copy the check made');
  assert.doesNotMatch(r.stderr, /failed to load or play/);
  const rgb = rgbOf(join(dir, 'stills', readdirSync(join(dir, 'stills')).find((f) => f.endsWith('.png'))!));
  assert.ok(isBlue(at(rgb, 170, 30)) && isRed(at(rgb, 100, 30)), 'the speaker over the graphic, the graphic beside it');
  // In a workspace of its own, the render makes that copy itself.
  const own = render([file, '--out', join(dir, 'own'), '--stills', '0.5', '--fps', '10'], { OPEN_EDIT_ROOT: scratchDir('behind-prores-own') });
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stderr, /made a VP9 copy of cutout\.mov that keeps its alpha/);
});

test('render: a speaker layer that cannot be played fails the render', { skip }, () => {
  const dir = scratchDir('behind-unplayable');
  writeFileSync(join(dir, 'cutout.webm'), 'not a video');
  const file = page(dir, { behind: '<div class="g" data-behind="g" style="left:70px;top:10px;width:100px;height:40px"></div>' });
  const r = render([file, '--out', join(dir, 'out.mp4'), '--duration', '0.5', '--fps', '10']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the speaker layer's cut-out .*cutout\.webm could not be played/);
});

test('render: a patch refuses a cached render that served videos with alpha differently', { skip }, () => {
  const dir = scratchDir('behind-patch');
  cutout(dir, { frames: 30, gop: 30 });
  const file = page(dir, { behind: '<div class="g" data-behind="g" style="left:70px;top:10px;width:100px;height:40px"></div>' });
  const out = join(dir, 'out.mp4');
  const go = (...more: string[]) => render([file, '--out', out, '--duration', '2', '--fps', '10', ...more]);
  assert.equal(go().status, 0);
  const manifest = join(`${out}.render`, 'manifest.json');
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as { params: { alpha?: string } };
  assert.ok(m.params.alpha, 'the cache records how the alpha video was served');
  delete m.params.alpha;
  writeFileSync(manifest, JSON.stringify(m));
  const patch = go('--from', '0.5', '--to', '1');
  assert.equal(patch.status, 2, patch.stderr);
  assert.match(patch.stderr, /the cached render was made differently \(alpha/);
});

test('layers: speaker.js lays the same layers in an ordinary browser, the cut-out on the page\'s time, not the footage\'s', { skip }, async () => {
  const dir = scratchDir('behind-preview');
  footage(dir);
  // The speaker steps from the middle to the left edge at 1.5 s.
  cutout(dir, { frames: 30, alpha: 'if(lt(N,15),255*between(X,150,189),255*between(X,0,39))' });
  writeFileSync(join(dir, 'speaker.js'), speakerScript());
  // The page starts its footage 1.6 s in; the cut-out, cut from the clip as the page plays it, starts at 0.
  const file = page(dir, { footage: FOOTAGE, behind: '<div class="g" data-behind="g" style="left:70px;top:10px;width:100px;height:40px;z-index:9"></div>',
    front: '<div id="cap"></div>' }, { script: 'document.querySelector("video").currentTime=1.6' });
  writeFileSync(file, readFileSync(file, 'utf8').replace('</body>', '<script src="speaker.js"></script></body>'));
  const { chromium } = await import('playwright-core');
  const server = await startPageServer({ roots: [dir] });
  const browser = await chromium.launch({ executablePath: installedChrome(platform!), args: CHROME_FLAGS });
  try {
    const p = await browser.newPage();
    await p.goto(server.urlFor(file));
    await p.waitForTimeout(600);
    const shot = join(dir, 'preview.png');
    await p.screenshot({ path: shot, clip: { x: 0, y: 0, width: W, height: H } });
    const laid = await p.evaluate(`(() => {
      const box = document.querySelector('[data-oe-speaker]');
      const z = (s) => getComputedStyle(document.querySelector(s)).zIndex;
      return { order: [z('[data-layer=footage]'), z('[data-layer=behind]'), getComputedStyle(box).zIndex, z('[data-layer=front]')],
        reach: [document.querySelectorAll('video').length, box.shadowRoot, typeof window.__oeSpeaker] };
    })()`);
    assert.deepEqual(laid, { order: ['1', '2', '3', '4'], reach: [1, null, 'boolean'] }, 'the page finds its footage, never the cut-out');
    const rgb = rgbOf(shot);
    assert.ok(isBlue(at(rgb, 170, 120)) && !isBlue(at(rgb, 20, 120)), `the speaker where the page's time puts it, not the footage's: ${at(rgb, 170, 120)}, ${at(rgb, 20, 120)}`);
  } finally {
    await browser.close();
    await server.close();
  }
});

test('layers: under render --footage-at, the cut-out shows where the footage does, in register with it frame for frame, as the check measures it', { skip }, async () => {
  const dir = scratchDir('behind-footage-at');
  // The footage's speaker is a white column at x 10n on frame n, for 2 s at 10 fps; the cut-out is that column, in blue.
  const clip = join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=gray:s=${W}x${H}:r=10:d=2,format=yuv420p,geq=lum='if(between(X\\,10*N\\,10*N+9)\\,235\\,128)':cb=128:cr=128`,
    '-frames:v', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  cutout(dir, { frames: 20, alpha: '255*between(X,10*N,10*N+9)' });
  // A graphic behind the speaker over x 0 to 99: the speaker crosses it over the clip's first second.
  const file = page(dir, { footage: '<video src="clip.mp4" muted playsinline></video>',
    behind: '<div class="g" data-behind="g" style="left:0;top:10px;width:100px;height:40px"></div>' },
  { style: 'html,body,#stage{background:transparent}' });
  const out = join(dir, 'out.mp4');
  // Five workers: one picks the cut-out up partway through its run, after render's check of the stateless mark.
  const r = render([file, '--out', out, '--fps', '10', '--duration', '6', '--footage', clip, '--footage-at', '3', '--workers', '5']);
  assert.equal(r.status, 0, r.stderr);
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const frames = Array.from({ length: raw.length / (W * H * 3) }, (_, i) => raw.subarray(i * W * H * 3, (i + 1) * W * H * 3));
  assert.equal(frames.length, 60);
  const isWhite = ([r, g, b]: number[]) => r > 200 && g > 200 && b > 200;
  frames.forEach((rgb, k) => {
    const row = Array.from({ length: W }, (_, x) => at(rgb, x, 120));
    const blue = row.findIndex(isBlue);
    if (k >= 30 && k < 50) {
      assert.equal(blue, 10 * (k - 30), `frame ${k}: the cut-out's speaker at clip frame ${k - 30}`);
      assert.ok(!row.some(isWhite), `frame ${k}: the footage's own speaker left showing beside the cut-out`);
    } else {
      assert.equal(blue, -1, `frame ${k}: no cut-out where the footage is not`);
    }
  });
  // The check steps the page on the same clock: the graphic is under the speaker only over the clip's first second.
  const report = await checkBehind(file, { bar: 0.95, fps: { num: 10, den: 1 }, duration: 6, footageAt: 3 });
  assert.deepEqual(report.graphics[0].under, { frames: 10, start: 3, end: 3.9 });
  near(report.graphics[0].worst.share, 0.9, 0.005, 'a tenth of the graphic behind the speaker');
});
