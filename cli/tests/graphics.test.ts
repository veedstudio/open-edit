// Graphics burned into footage: the search on real ffmpeg clips, the faces command writing what it finds, faces.js
// keeping text off it while it is up, and the review's graphics check confirming a collision on the video's pixels.
// The renders run in the pinned headless Chrome and are skipped when it is not installed (`openedit install-browser`),
// unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { findFaces, findGraphics, readFaces } from '../src/commands/faces.ts';
import { reframe } from '../src/commands/reframe.ts';
import { FFMPEG } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { facesFolder } from '../src/faces/folder.ts';
import type { GraphicBox } from '../src/faces/graphics.ts';
import { facesApi, facesScript } from '../src/faces/page-script.ts';
import { writeAtomic } from '../src/providers/exclusive-files.ts';
import { readRecord, recordPath, type TextRecord } from '../src/render/text-record.ts';
import type { ReviewContext } from '../src/verify/checks.ts';
import { judgeFootage, measureGraphics } from '../src/verify/graphics.ts';
import { stubDetector } from './helpers/face-stub.ts';
import { captureConsoleAsync, scratchDir, withRoot } from './helpers/synth.ts';

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const area = (r: Rect) => r.w * r.h;
const meet = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** A navy plate with white strokes like the letters of a caption, drawn while `enable` holds. */
function plate(r: Rect, enable: string): string {
  const strokes = Array.from({ length: Math.floor((r.w - 20) / 12) }, (_, i) =>
    `drawbox=x=${r.x + 10 + i * 12}:y=${r.y + 8}:w=4:h=${r.h - 16}:color=white:t=fill:enable='${enable}'`);
  return [`drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=0x102a5c:t=fill:enable='${enable}'`, ...strokes].join(',');
}

const LOWER_THIRD = { x: 40, y: 280, w: 400, h: 48 };
const LOGO = { x: 540, y: 20, w: 80, h: 40 };
const STILL_THIRD = { x: 60, y: 290, w: 360, h: 44 };

/** A test pattern the camera pans across, a logo on it throughout, and a lower third from 1.5 to 4.5 s. */
function panning(dir: string): string {
  const out = join(dir, 'panning.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-t', '6', '-vf',
    `scroll=horizontal=0.003:vertical=0.001,${plate(LOWER_THIRD, 'between(t,1.5,4.5)')},${plate(LOGO, '1')}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

/** A locked-off shot: colour bars that never move, a block swinging across them, and a lower third from 2 to 5 s. */
function lockedOff(dir: string): string {
  const out = join(dir, 'locked-off.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptehdbars=s=640x360:r=25', '-f', 'lavfi', '-i', 'color=c=0xc08060:s=90x200:r=25',
    '-t', '8', '-filter_complex', `[0:v][1:v]overlay=x='270+150*sin(t*2.3)':y=60,${plate(STILL_THIRD, 'between(t,2,5)')}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

/** The region found over `truth`: most of it inside, covering most of the truth. */
function regionOver(found: GraphicBox[], truth: Rect): GraphicBox {
  const hit = found.find((g) => meet(g, truth) >= 0.8 * area(truth) && meet(g, truth) >= 0.7 * area(g));
  assert.ok(hit, `no region over ${JSON.stringify(truth)} in ${JSON.stringify(found)}`);
  return hit!;
}

const EXPOSED_THIRD = { x: 60, y: 290, w: 360, h: 44 };

/**
 * A locked-off view of a wall with dark furniture and a block swinging in front of it, the camera's exposure jumping
 * up by 15% at 4 s as it does at a jump cut, and a lower third laid over the picture from 2.5 to 5.5 s.
 */
function exposureJump(dir: string): string {
  const out = join(dir, 'exposure.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc8c8c8:s=640x360:r=25', '-f', 'lavfi', '-i', 'color=c=0x806040:s=60x140:r=25',
    '-t', '8', '-filter_complex', '[0:v]drawbox=x=70:y=230:w=90:h=110:color=0x202020:t=fill,drawbox=x=420:y=250:w=150:h=90:color=0x282828:t=fill,'
      + 'drawbox=x=300:y=40:w=200:h=8:color=0x303030:t=fill[wall];[wall][1:v]overlay=x=\'240+120*sin(t*2.1)\':y=150,'
      + `lutyuv=y='clip(val*1.15,0,255)':enable='gte(t,4)',${plate(EXPOSED_THIRD, 'between(t,2.5,5.5)')}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const STRIPES = { x: 440, y: 40, w: 160, h: 120 };

/** The test pattern panning fast, a patch of slanted stripes held still in frame, and a lower third from 1.5 to 4.5 s. */
function stripedPan(dir: string): string {
  const out = join(dir, 'striped.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-f', 'lavfi', '-i', `color=c=gray:s=${STRIPES.w}x${STRIPES.h}:r=25`,
    '-t', '6', '-filter_complex', "[1:v]format=gray,geq=lum='if(lt(mod(X+Y\\,16)\\,8)\\,40\\,220)',format=yuv420p[stripes];"
      + `[0:v]scroll=horizontal=0.02:vertical=0.01[pan];[pan][stripes]overlay=x=${STRIPES.x}:y=${STRIPES.y},${plate(LOWER_THIRD, 'between(t,1.5,4.5)')}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const dir = scratchDir('graphics');
const PANNING = panning(dir);
const LOCKED = lockedOff(dir);

test('graphics: a logo and a lower third that hold still while the camera pans are found, each for the seconds it is up', () => {
  const { graphics, width, height } = findGraphics(PANNING);
  assert.deepEqual([width, height], [640, 360]);
  for (const g of graphics) assert.ok(overlaps(g, LOGO) || overlaps(g, LOWER_THIRD), `${JSON.stringify(g)} is neither graphic`);
  // The logo may come back as more than one region where its box shifts a little (its plate's edge against the moving
  // picture holds less steadily than its strokes); together they hold most of it throughout.
  for (let t = 0; t <= 6; t += 0.25) {
    assert.ok(graphics.some((g) => g.from <= t && t <= g.to && meet(g, LOGO) >= 0.6 * area(LOGO)), `nothing holds the logo at ${t} s: ${JSON.stringify(graphics)}`);
  }
  const third = regionOver(graphics, LOWER_THIRD);
  assert.ok(third.from >= 1 && third.from <= 1.5, `the lower third comes up at 1.5 s, found from ${third.from}`);
  assert.ok(third.to >= 4.5 && third.to <= 5, `the lower third goes at 4.5 s, found to ${third.to}`);
});

test('graphics: in a locked-off shot the lower third is found, and the scene\'s own still edges are not', () => {
  const { graphics } = findGraphics(LOCKED);
  // The bars' edges hold for the whole shot and the swinging block never settles: neither is a graphic.
  assert.equal(graphics.length, 1, JSON.stringify(graphics));
  const third = regionOver(graphics, STILL_THIRD);
  assert.ok(third.from >= 1.5 && third.from <= 2 && third.to >= 5 && third.to <= 5.5, `found from ${third.from} to ${third.to}, up from 2 to 5 s`);
});

test('graphics: an exposure step at a jump cut within one view is no cut, so the furniture is no graphic and the lower third is', () => {
  const { graphics } = findGraphics(exposureJump(dir));
  assert.equal(graphics.length, 1, JSON.stringify(graphics));
  const third = regionOver(graphics, EXPOSED_THIRD);
  assert.ok(third.from >= 2 && third.from <= 2.5 && third.to >= 5.5 && third.to <= 6, `found from ${third.from} to ${third.to}, up from 2.5 to 5.5 s`);
});

test('graphics: slanted stripes held still in frame are texture, not a graphic; the lower third drawn square to the frame is', () => {
  const { graphics } = findGraphics(stripedPan(dir));
  for (const g of graphics) assert.ok(!overlaps(g, STRIPES), `${JSON.stringify(g)} is on the stripes`);
  regionOver(graphics, LOWER_THIRD);
});

test('faces: the same decode writes the graphics into faces.json and faces.js, and place() keeps text off them while they are up', () => {
  const clip = findFaces(PANNING, { every: 0.25, threshold: 10, confidence: 0.5, margin: 0.25 }, stubDetector(() => []));
  assert.deepEqual(clip.graphics, findGraphics(PANNING).graphics, 'the faces decode and the search alone read the same frames');
  assert.equal(clip.graphicsMargin, 0.01);
  const api = facesApi(JSON.parse(JSON.stringify(clip)));
  const third = regionOver(clip.graphics!, LOWER_THIRD);
  const pad = 0.01 * 360;
  const kept = api.graphics(3).find((g) => overlaps(g, LOWER_THIRD))!;
  for (const [got, want] of [[kept.x, third.x - pad], [kept.y, third.y - pad], [kept.w, third.w + 2 * pad], [kept.h, third.h + 2 * pad]]) {
    assert.ok(Math.abs(got - want) < 1e-9, `kept off ${JSON.stringify(kept)}, the region ${JSON.stringify(third)} and a margin of 1% of 360 px`);
  }
  assert.equal(api.boxes(0.5).filter((b) => overlaps(b, LOWER_THIRD)).length, 0, 'before it comes up, text may sit there');
  assert.equal(api.boxes(5.5).filter((b) => overlaps(b, LOWER_THIRD)).length, 0, 'and after it goes');
  assert.equal(api.boxes(4, 6).filter((b) => overlaps(b, LOWER_THIRD)).length, 1, 'a span it is up for part of is kept off it');
  // A caption laid over the lower third moves the least distance that clears it, and the logo, in the frame.
  const caption = { x: 100, y: 290, w: 300, h: 30 };
  const placed = api.clear(caption, api.boxes(2, 4), { x: 0, y: 0, w: 640, h: 360 });
  assert.equal(placed.clear && placed.moved, true);
  const moved = { ...caption, x: placed.x, y: placed.y };
  for (const b of api.boxes(2, 4)) assert.ok(!overlaps(moved, b), `${JSON.stringify(moved)} still overlaps ${JSON.stringify(b)}`);
  assert.match(facesScript(clip), /"graphics":\[\{/, 'faces.js carries them for the page');
});

/**
 * A record of one text at `box` from `from` to `to` seconds over a 25 fps clip of `frames` frames laid with --footage,
 * its first frame on the video's frame `at`.
 */
function recordOf(footage: string | undefined, frames: number, text: { box: [number, number, number, number]; from: number; to: number }, at = 0): TextRecord {
  const every = 3;
  return {
    version: 1, page: join(dir, 'index.html'), width: 640, height: 360, fps: '25', frames, transparent: false,
    ...(footage ? { footage: { file: footage, frame: at, time: at / 25 } } : {}), framesPerSample: every,
    samples: Array.from({ length: Math.ceil(frames / every) }, (_, k) => {
      const time = (k * every) / 25;
      return {
        frame: k * every, time: Math.round(time * 1000) / 1000,
        texts: time >= text.from && time < text.to
          ? [{ text: 'CAPTION', box: text.box, fontSize: 24, color: [255, 255, 255, 1] as [number, number, number, number], opacity: 1, selector: '#cap' }]
          : [],
      };
    }),
  };
}

/** The footage with `vf` drawn over it, as a render of a page over it would show. */
function renderOver(footage: string, name: string, vf: string): string {
  const out = join(dir, name);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', footage, '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

test('review: text over a burned-in lower third while it is up is found; the same text elsewhere, or before it comes up, passes', async () => {
  await withRoot(join(dir, 'review-root'), async () => {
    // The caption itself, drawn where the record says, so the video differs from the footage only under the text.
    const video = renderOver(LOCKED, 'over.mp4', 'drawbox=x=120:y=296:w=200:h=24:color=white:t=fill:enable=\'between(t,2.5,4)\'');
    const on = await judgeFootage(video, { path: 'over.mp4.text.json', record: recordOf(LOCKED, 200, { box: [120, 296, 200, 24], from: 2.5, to: 4 }) });
    assert.equal(on.verdict, 'found', on.lines.join('\n'));
    assert.match(on.lines[0], /^1 time\(s\) a text sits over a graphic burned into the footage while it is up \(1 found, from .*locked-off\.mp4, searched now\):$/);
    assert.match(on.lines[1], /^"CAPTION" over the graphic at \d+,\d+ \d+x\d+ from 2\.52s to 4\.08s$/);
    const above = await judgeFootage(video, { path: 'r', record: recordOf(LOCKED, 200, { box: [120, 150, 200, 24], from: 2.5, to: 4 }) });
    assert.equal(above.verdict, 'pass', above.lines.join('\n'));
    const before = await judgeFootage(video, { path: 'r', record: recordOf(LOCKED, 200, { box: [120, 296, 200, 24], from: 0, to: 1.5 }) });
    assert.equal(before.verdict, 'pass', before.lines.join('\n'));
  });
});

test('review: footage laid from a later frame is read in its own time, so a text is over the graphic when the clip has it up', async () => {
  await withRoot(join(dir, 'review-root'), async () => {
    // Black for 2 s, then the clip, whose lower third is up from its second 2 to 5: 4 to 7 s of the video.
    const video = renderOver(LOCKED, 'late.mp4', 'tpad=start_duration=2:color=black,drawbox=x=120:y=296:w=200:h=24:color=white:t=fill:enable=\'between(t,4.5,6)\'');
    const late = await judgeFootage(video, { path: 'r', record: recordOf(LOCKED, 250, { box: [120, 296, 200, 24], from: 4.5, to: 6 }, 50) });
    assert.equal(late.verdict, 'found', late.lines.join('\n'));
    assert.match(late.lines[1], /^"CAPTION" over the graphic at \d+,\d+ \d+x\d+ from 4\.56s to 6\.00s$/);
    const early = await judgeFootage(video, { path: 'r', record: recordOf(LOCKED, 250, { box: [120, 296, 200, 24], from: 2.5, to: 3.5 }, 50) });
    assert.equal(early.verdict, 'pass', early.lines.join('\n'));
  });
});

test('review: a band the page lays over the lower third hides it, so text on the band is not over the graphic', async () => {
  await withRoot(join(dir, 'review-root'), async () => {
    const video = renderOver(LOCKED, 'band.mp4', 'drawbox=x=0:y=260:w=640:h=100:color=0x203040:t=fill');
    const report = await judgeFootage(video, { path: 'r', record: recordOf(LOCKED, 200, { box: [120, 296, 200, 24], from: 2.5, to: 4 }) });
    assert.equal(report.verdict, 'pass', report.lines.join('\n'));
    assert.deepEqual(report.skipped, ['1 text(s) over a graphic\'s place where the page covers the footage, so the graphic does not show']);
  });
});

test('review: the graphics faces wrote for the footage are read rather than searched for again; no footage recorded is a skip', async () => {
  const root = join(dir, 'faces-root');
  await withRoot(root, async () => {
    const clip = findFaces(LOCKED, { every: 0.25, threshold: 10, confidence: 0.5, margin: 0.25 }, stubDetector(() => []));
    mkdirSync(facesFolder(LOCKED), { recursive: true });
    writeAtomic(join(facesFolder(LOCKED), 'faces.json'), clip);
    const refuse = () => { throw new Error('searched again'); };
    const record = recordOf(LOCKED, 200, { box: [120, 296, 200, 24], from: 2.5, to: 4 });
    const report = await judgeFootage(LOCKED, { path: 'r', record }, refuse);
    assert.equal(report.verdict, 'found', report.lines.join('\n'));
    assert.match(report.lines[0], /\(1 found, from .*faces-[0-9a-f]{8}[\\/]faces\.json\)/);
    const none = await measureGraphics({ video: LOCKED, textRecord: { path: 'x.text.json', record: recordOf(undefined, 200, { box: [0, 0, 1, 1], from: 0, to: 0 }) } } as ReviewContext);
    assert.equal(none.verdict, 'skipped');
    assert.match(none.skipped[0], /x\.text\.json names no footage and records no <video> on the page/);
  });
});

test('review: a record whose footage is not a path is refused as damaged', () => {
  const file = join(dir, 'bad.text.json');
  for (const footage of [5, LOCKED, { file: LOCKED, frame: -1, time: 0 }]) {
    writeFileSync(file, JSON.stringify({ ...recordOf(LOCKED, 3, { box: [0, 0, 1, 1], from: 0, to: 0 }), footage }));
    assert.throws(() => readRecord(file), /bad\.text\.json is not a text record \(its footage is not a path with the frame and time it starts on\)/);
  }
});

test('reframe and apply-edl carry the graphics of the clips they cut into the faces they write, where a search of their output finds them', async () => {
  const root = join(dir, 'carry-root');
  mkdirSync(root, { recursive: true });
  await withRoot(root, async () => {
    const clip = findFaces(LOCKED, { every: 0.25, threshold: 10, confidence: 0.5, margin: 0.25 }, stubDetector(() => []));
    mkdirSync(facesFolder(LOCKED), { recursive: true });
    writeAtomic(join(facesFolder(LOCKED), 'faces.json'), clip);
    const tall = join(root, 'tall.mp4');
    const r = await captureConsoleAsync(async () => reframe([LOCKED, '--aspect', '9:16', '--out', tall]));
    assert.equal(r.result, 0, r.out);
    const edl = join(root, 'edl.json');
    writeFileSync(edl, JSON.stringify({ sources: { a: LOCKED }, ranges: [{ source: 'a', start: 1, end: 3 }, { source: 'a', start: 3.5, end: 6 }] }));
    const cut = join(root, 'cut.mp4');
    const e = await captureConsoleAsync(() => applyEdl(['--edl', edl, '--out', cut]));
    assert.equal(e.result, 0, e.out);
    // The reframed clip: what the search finds on it is what reframe wrote, moved and scaled with the crop.
    const written = readFaces(join(facesFolder(tall), 'faces.json')).graphics;
    const found = findGraphics(tall).graphics;
    assert.equal(written?.length, 1, JSON.stringify(written));
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.ok(meet(written![0], found[0]) >= 0.9 * Math.max(area(written![0]), area(found[0])), `wrote ${JSON.stringify(written)}, found ${JSON.stringify(found)}`);
    assert.ok(Math.abs(written![0].from - found[0].from) <= 0.25 && Math.abs(written![0].to - found[0].to) <= 0.25, `wrote ${JSON.stringify(written)}, found ${JSON.stringify(found)}`);
    // The cut, at the clip's own size: the graphic in the seconds of each range it is up in, placed where the range plays.
    const [source] = clip.graphics!;
    const onCut = readFaces(join(facesFolder(cut), 'faces.json')).graphics!;
    assert.deepEqual(onCut.map((g) => [g.x, g.y, g.w, g.h]), [[source.x, source.y, source.w, source.h], [source.x, source.y, source.w, source.h]]);
    assert.ok(Math.abs(onCut[0].from - (source.from - 1)) <= 0.05 && onCut[0].to === 2, JSON.stringify(onCut));
    assert.ok(onCut[1].from === 2 && Math.abs(onCut[1].to - (2 + source.to - 3.5)) <= 0.05, JSON.stringify(onCut));
  });
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

function render(args: string[]): void {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr);
}

/** A page of `body` on a 640x360 stage, with `style` and `script`. */
const page = (style: string, body: string, script: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
#stage{position:relative;width:640px;height:360px;overflow:hidden;font:700 16px/1 Helvetica,Arial,sans-serif;color:#fff}
${style}</style></head><body><div id="stage">${body}</div><script>${script}</script></body></html>`;

test('review: over --footage, text on a card or band the page lays over the lower third is not over it, painted nearly opaque or drawn in a canvas', { skip }, async () => {
  await withRoot(join(dir, 'render-root'), async () => {
    // The lower third is up from 2 to 5 s: a caption on a card a canvas draws 90% opaque, then one on the bare footage,
    // then a title on a solid band so wide that its glyphs cover the whole graphic.
    const file = join(dir, 'cards.html');
    writeFileSync(file, page(`.t{position:absolute;visibility:hidden}
#card{left:40px;top:270px}
#cardtext{left:70px;top:300px}
#bare{left:80px;top:300px}
#band{left:0;top:200px;width:640px;height:160px;background:#0a1428}
#band span{position:absolute;left:66px;top:84px;font-size:48px;white-space:nowrap}`,
    '<canvas class="t" id="card" width="420" height="80"></canvas><div class="t" id="cardtext">ON A CARD</div>'
      + '<div class="t" id="bare">BARE CAPTION</div><div class="t" id="band"><span>A TITLE HERE NOW</span></div>',
    `var c = document.getElementById('card').getContext('2d');
c.fillStyle = 'rgba(10,20,40,0.9)';
c.fillRect(0, 0, 420, 80);
window.__seek = function (t) {
  var on = function (id, from, to) { document.getElementById(id).style.visibility = t >= from && t < to ? 'visible' : 'hidden'; };
  on('card', 2.2, 3); on('cardtext', 2.2, 3); on('bare', 3, 3.8); on('band', 3.8, 4.8);
};`));
    const out = join(dir, 'cards.mp4');
    render([file, '--out', out, '--footage', LOCKED, '--fps', '25', '--duration', '5', '--workers', '1']);
    const record = readRecord(recordPath(out));
    const entry = (text: string) => record.samples.flatMap((s) => s.texts).find((e) => e.text === text)!;
    assert.deepEqual(['ON A CARD', 'BARE CAPTION', 'A TITLE HERE NOW'].map((t) => entry(t).backing), [0, 0, 1], 'a canvas is a picture, a band a background');
    const title = entry('A TITLE HERE NOW');
    const third = regionOver(findGraphics(LOCKED).graphics, STILL_THIRD);
    // Half an em around the glyphs is the text's own, so nothing of the graphic is left to compare on the pixels.
    const pad = title.fontSize / 2;
    assert.ok(title.box[0] - pad <= third.x && title.box[0] + title.box[2] + pad >= third.x + third.w && title.box[1] - pad <= third.y
      && title.box[1] + title.box[3] + pad >= third.y + third.h, `the title ${JSON.stringify(title.box)} covers the graphic ${JSON.stringify(third)}`);
    const report = await judgeFootage(out, { path: recordPath(out), record });
    assert.equal(report.verdict, 'found', report.lines.join('\n'));
    assert.equal(report.lines.length, 2, report.lines.join('\n'));
    assert.match(report.lines[1], /^"BARE CAPTION" over the graphic at /);
    assert.deepEqual(report.skipped, ['2 text(s) over a graphic\'s place where the page covers the footage, so the graphic does not show']);
  });
});

test('render and review: a <video> the page plays is recorded with its clip, second and picture box; place() keeps text off its graphics by itself, and the check runs', { skip }, async () => {
  await withRoot(join(dir, 'video-root'), async () => {
    const clip = findFaces(LOCKED, { every: 0.25, threshold: 10, confidence: 0.5, margin: 0.25 }, stubDetector(() => []));
    mkdirSync(facesFolder(LOCKED), { recursive: true });
    writeAtomic(join(facesFolder(LOCKED), 'faces.json'), clip);
    writeFileSync(join(dir, 'faces.js'), facesScript(clip));
    // The clip fills a 4:3 box by cover and is scaled to half, so its picture lies 53 px past the stage's left edge at
    // 426.7x240 and shows only inside the box: nowhere near where a stage-filling clip would have its lower third. The
    // render may play a smaller copy, whose rounded size moves the picture by a fraction of a pixel.
    const file = join(dir, 'played.html');
    writeFileSync(file, page(`#v{position:absolute;left:0;top:0;width:640px;height:480px;object-fit:cover;transform:scale(0.5);transform-origin:0 0}
.cap{position:absolute;left:20px;top:200px;visibility:hidden}
#placed{top:205px}`,
    '<video id="v" src="locked-off.mp4" muted></video><div class="cap" id="stays">STAYS PUT</div><div class="cap" id="placed">PLACED</div>',
    `window.__seek = function (t) {
  var on = t >= 2.5 && t < 4;
  document.getElementById('stays').style.visibility = on ? 'visible' : 'hidden';
  document.getElementById('placed').style.visibility = on ? 'visible' : 'hidden';
  if (on) openeditFaces.place(document.getElementById('placed'), t, t);
};`).replace('<script>', '<script src="faces.js"></script><script>'));
    const out = join(dir, 'played.mp4');
    render([file, '--out', out, '--fps', '25', '--duration', '5', '--workers', '1']);
    const record = readRecord(recordPath(out));
    assert.equal(record.footage, undefined);
    const at3 = record.samples.find((s) => s.time === 3)!;
    assert.equal(at3.videos?.length, 1, JSON.stringify(at3.videos));
    const [video] = at3.videos!;
    assert.equal(video.file, LOCKED);
    assert.ok(Math.abs(video.time - 3) < 0.01, `the clip at ${video.time} s at 3 s of the page`);
    video.box.forEach((v, i) => assert.ok(Math.abs(v - [-53.3, 0, 426.7, 240][i]) <= 0.6, `picture box ${JSON.stringify(video.box)}`));
    assert.deepEqual(video.shown, [0, 0, 320, 240]);

    // The lower third as the page shows it, from the graphic in the clip's pixels.
    const third = regionOver(clip.graphics!, STILL_THIRD);
    const k = 426.7 / 640;
    const onPage = { x: Math.max(0, -53.3 + third.x * k), y: third.y * k, w: -53.3 + (third.x + third.w) * k, h: third.h * k };
    const box = (text: string) => { const b = at3.texts.find((e) => e.text === text)!.box; return { x: b[0], y: b[1], w: b[2], h: b[3] }; };
    assert.ok(overlaps(box('STAYS PUT'), onPage), `${JSON.stringify(box('STAYS PUT'))} sits on the lower third at ${JSON.stringify(onPage)}`);
    assert.ok(!overlaps(box('PLACED'), onPage), `place() left ${JSON.stringify(box('PLACED'))} on the lower third at ${JSON.stringify(onPage)}`);

    const report = await judgeFootage(out, { path: recordPath(out), record });
    assert.equal(report.verdict, 'found', report.lines.join('\n'));
    assert.match(report.lines[0], /^1 time\(s\) a text sits over a graphic burned into the footage while it is up \(1 found, from .*faces-[0-9a-f]{8}[\\/]faces\.json\):$/);
    assert.match(report.lines[1], /^"STAYS PUT" over the graphic at 0,19\d \d+x\d+ from 2\.\d+s to 4\.\d+s$/);
    assert.deepEqual(report.skipped, []);
  });
});
