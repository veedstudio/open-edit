// The record of on-screen text a video render writes beside its output: boxes and sizes in the video's pixels at
// the sampled frames, kept whole through a patch, never changing what is rendered, and carried by mux-audio.
// The renders run in the pinned headless Chrome and are skipped when it is not installed (`openedit install-browser`),
// unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { muxAudio } from '../src/commands/mux-audio.ts';
import { chromePlatform, installedChrome, resolveChrome } from '../src/render/browser.ts';
import { EPOCH, SEED } from '../src/render/lead.ts';
import { startPageServer } from '../src/render/server.ts';
import { RenderSession } from '../src/render/session.ts';
import { readRecord, recordPath, sampleEvery, type TextEntry, type TextRecord } from '../src/render/text-record.ts';
import { blocksOf } from '../src/verify/captions.ts';
import { SINE, TESTSRC, scratchDir, synthClip } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

function render(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 240_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The stage sits 50 px in and 30 px down the page, so the render captures it through a clip. The caption, inside a
// wrapper scaled 1.5 times, fades in at 0.5 s and slides 60 px (90 px on screen) over the next second.
const caption = (words: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
body{padding:30px 0 0 50px}
#stage{position:relative;width:320px;height:180px;overflow:hidden;background:#123;font:700 20px/1 Helvetica,Arial,sans-serif;color:#fff}
.title{position:absolute;left:12px;top:8px;font-size:14px;color:#ffcc00}
.wrap{position:absolute;left:10px;top:100px;transform:scale(1.5);transform-origin:0 0}
.cap{display:inline-block;animation:in .2s .5s both,move 1s .5s linear both}
@keyframes in{from{opacity:0}to{opacity:1}}
@keyframes move{from{translate:0}to{translate:60px}}
</style></head><body><div id="stage"><div class="title">Title</div><div class="wrap"><div class="cap" id="cap">${words}</div></div></div></body></html>`;

const textOf = (record: TextRecord, frame: number, text: string): TextEntry | undefined =>
  record.samples.find((s) => s.frame === frame)?.texts.find((e) => e.text === text);
const near = (actual: number, expected: number, what: string, slack = 0.6) =>
  assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${actual}, expected ${expected}`);

test('render: the text record follows a caption that fades in and moves, in the video\'s pixels and on its timeline', { skip }, () => {
  const dir = scratchDir('text-record');
  const page = join(dir, 'caption.html');
  writeFileSync(page, caption('Hello there'));
  const out = join(dir, 'out.mp4');
  // Segments of 21 frames over two workers: the second segment is split between them at frame 30.
  const r = render([page, '--out', out, '--fps', '30', '--duration', '2', '--workers', '2', '--segment', '0.7']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /on-screen text: .*out\.mp4\.text\.json, for openedit review/);
  const record = readRecord(recordPath(out));
  assert.deepEqual({ ...record, samples: undefined }, {
    version: 1, page, width: 320, height: 180, fps: '30', frames: 60, transparent: false, framesPerSample: 3, samples: undefined,
  });
  assert.deepEqual(record.samples.map((s) => s.frame), Array.from({ length: 20 }, (_, k) => 3 * k), 'every third frame, both workers\' frames in order');
  assert.deepEqual(record.samples.map((s) => s.time), Array.from({ length: 20 }, (_, k) => Math.round(k * 100) / 1000));

  // The title, placed against the stage and not the page.
  const title = textOf(record, 0, 'Title')!;
  assert.deepEqual([title.box[0], title.fontSize, title.color, title.opacity, title.selector], [12, 14, [255, 204, 0, 1], 1, '#stage>div:nth-child(1)']);
  near(title.box[1], 8, 'title top', 2);

  // Not there before it fades in, then at its place frame by frame, at its scaled size, its box keeping its shape.
  for (const frame of [0, 6, 12]) assert.equal(textOf(record, frame, 'Hello there'), undefined, `no caption at frame ${frame}`);
  const first = textOf(record, 21, 'Hello there')!;
  assert.ok(first.box[3] >= first.fontSize && first.box[3] <= 1.4 * first.fontSize, `caption height ${first.box[3]} for a ${first.fontSize}px font`);
  for (let frame = 21; frame <= 45; frame += 3) {
    const cap = textOf(record, frame, 'Hello there')!;
    near(cap.box[0], 10 + 1.5 * 60 * (frame / 30 - 0.5), `caption left at frame ${frame}`);
    assert.deepEqual([cap.box[1], cap.box[2], cap.box[3]], [first.box[1], first.box[2], first.box[3]], `caption box at frame ${frame}`);
    assert.equal(cap.fontSize, 30);
    assert.equal(cap.selector, '#cap');
  }
  assert.equal(textOf(record, 24, 'Hello there')!.opacity, 1);
  const fading = textOf(record, 18, 'Hello there')!.opacity;
  assert.ok(fading > 0 && fading < 1, `part way through its fade: ${fading}`);
  near(textOf(record, 57, 'Hello there')!.box[0], 100, 'resting where the slide ends');

  // A draft draws at half size: every box and size is half the full render's.
  const draft = join(dir, 'out.draft.mp4');
  const d = render([page, '--out', draft, '--fps', '30', '--duration', '2', '--draft']);
  assert.equal(d.code, 0, d.err);
  const half = readRecord(recordPath(draft));
  assert.deepEqual([half.width, half.height], [160, 90]);
  for (const frame of [0, 30, 57]) {
    for (const text of ['Title', 'Hello there']) {
      const full = textOf(record, frame, text);
      const small = textOf(half, frame, text);
      if (!full) continue;
      full.box.forEach((v, i) => near(small!.box[i], v / 2, `${text} box[${i}] at frame ${frame}`));
      near(small!.fontSize, full.fontSize / 2, `${text} size at frame ${frame}`);
    }
  }
});

// At 0.5 s each of three texts is half shown: one sliding in past the stage's left edge, one widening inside its own
// overflow, one wiped in by an inset() clip-path. The rest are drawn in ways the size and colour must see through.
const EDGES = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:320px;height:180px;overflow:hidden;background:#123;font:700 20px/1 Helvetica,Arial,sans-serif;color:#fff}
#stage>*{position:absolute}
#slide{left:-100px;top:0;animation:slide 1s linear both}
@keyframes slide{to{left:20px}}
#type{left:0;top:30px;width:0;overflow:hidden;white-space:nowrap;animation:type 1s linear both}
@keyframes type{to{width:200px}}
#wipe{left:0;top:60px;animation:wipe 1s linear both}
@keyframes wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
#zoom{left:220px;top:0;zoom:.5;font-size:40px}
#inline{left:220px;top:30px}
#inline span{transform:scale(2)}
#svg{left:220px;top:60px}
#grad{left:0;top:120px;background:linear-gradient(90deg,#f00,#00f);-webkit-background-clip:text;background-clip:text;color:transparent}
#karaoke{left:0;top:150px}
#calc{left:220px;top:150px;clip-path:inset(0px calc(100% - 20px) 0px 0px)}
</style></head><body><div id="stage">
<div id="slide">Sliding</div><div id="type">Typewriter text</div><div id="wipe">Wiped in</div>
<div id="zoom">Zoomed</div><div id="inline">a <span>inline</span></div>
<svg id="svg" width="100" height="40" viewBox="0 0 50 20"><text x="0" y="15" font-size="10" fill="#0f0">SVG</text></svg>
<div id="grad">Gradient <span>child</span></div>
<div id="karaoke"><span>Hello </span><span>world</span></div><div id="calc">Calc</div>
</div></body></html>`;

test('render: text past the stage, its own overflow or a wipe is recorded where it shows, and zoomed, inline, SVG and gradient text as drawn', { skip }, () => {
  const dir = scratchDir('text-record-edges');
  const page = join(dir, 'edges.html');
  writeFileSync(page, EDGES);
  const out = join(dir, 'out.mp4');
  const r = render([page, '--out', out, '--fps', '30', '--duration', '1']);
  assert.equal(r.code, 0, r.err);
  const record = readRecord(recordPath(out));
  const at = (frame: number, id: string) => record.samples.find((s) => s.frame === frame)!.texts.find((e) => e.selector.startsWith(id));
  assert.equal(at(0, '#slide'), undefined, 'wholly left of the stage');
  assert.equal(at(27, '#slide')!.box[0] > 0, true, 'wholly on the stage by 0.9 s');
  assert.equal(at(0, '#type'), undefined, 'inside a box of no width');
  assert.equal(at(0, '#wipe'), undefined, 'wiped out entirely');
  const slide = at(15, '#slide')!;
  const slideWidth = at(27, '#slide')!.box[2];
  assert.equal(slide.box[0], 0, 'cut at the stage\'s edge');
  assert.ok(slide.box[2] < slideWidth, `${slide.box[2]} of ${slideWidth} px shown`);
  near(at(15, '#type')!.box[2], 100, 'typewriter shown to the width of its box', 1);
  // A linear wipe: shown in proportion to its time, 15/27 of what shows at frame 27.
  near(at(15, '#wipe')!.box[2], (at(27, '#wipe')!.box[2] * 15) / 27, 'half wiped in', 1);

  const all = record.samples[0].texts;
  const by = (selector: string) => all.find((e) => e.selector === selector)!;
  assert.equal(by('#zoom').fontSize, 20, 'zoom .5 on a 40px font');
  assert.equal(by('#inline>span:nth-child(1)').fontSize, 20, 'a transform on an inline box does nothing');
  assert.deepEqual([by('#svg>text:nth-child(1)').fontSize, by('#svg>text:nth-child(1)').color], [20, [0, 255, 0, 1]], 'SVG text by its fill and its viewBox');
  assert.deepEqual([by('#grad').color[3], by('#grad>span:nth-child(1)').color[3]], [0, 0], 'gradient text and its span, with no solid fill');
  // Word spans that carry their own trailing space still stand a word apart.
  assert.deepEqual(blocksOf(all.filter((e) => e.selector.startsWith('#karaoke'))).map((b) => b.text), ['Hello world']);
  // A clip-path this reads no shape from clips nothing, rather than leaving a box of no numbers.
  assert.ok(by('#calc').box.every(Number.isFinite));
});

test('render: a patch keeps the record whole, reading again only the segments it renders again', { skip }, () => {
  const dir = scratchDir('text-record-patch');
  const page = join(dir, 'caption.html');
  writeFileSync(page, caption('Hello there'));
  const out = join(dir, 'out.mp4');
  const args = [page, '--out', out, '--fps', '30', '--duration', '2', '--workers', '2', '--segment', '0.5'];
  assert.equal(render(args).code, 0);
  writeFileSync(page, caption('Bonjour'));
  const patch = render([...args, '--from', '1', '--to', '1.4']);
  assert.equal(patch.code, 0, patch.err);
  assert.match(patch.out, /segments: 1 rendered, 3 reused/);
  const words = (frame: number) => readRecord(recordPath(out)).samples.find((s) => s.frame === frame)!.texts.map((e) => e.text).filter((t) => t !== 'Title');
  assert.equal(readRecord(recordPath(out)).samples.length, 20);
  for (const frame of [21, 27, 45, 57]) assert.deepEqual(words(frame), ['Hello there'], `frame ${frame} kept from the first render`);
  for (const frame of [30, 33, 42]) assert.deepEqual(words(frame), ['Bonjour'], `frame ${frame} read again`);

  // A segment cached without its text, as by a version before the record, is rendered again rather than left out.
  rmSync(join(`${out}.render`, 'seg-00000.text.json'));
  const again = render([...args, '--from', '1.5']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /segments: 2 rendered, 2 reused/);
  assert.match(again.err, /also rendering segment\(s\) 0 \(no text cached\) outside --from\/--to again, to record the text they show/);
  assert.equal(readRecord(recordPath(out)).samples.length, 20);
  for (const frame of [30, 42, 45, 57]) assert.deepEqual(words(frame), ['Bonjour'], `frame ${frame} after the second patch`);
  for (const frame of [21, 27]) assert.deepEqual(words(frame), ['Hello there'], `frame ${frame} still from the first render`);
  for (const frame of [0, 12]) assert.deepEqual(words(frame), [], `frame ${frame}, before the caption, read again`);
});

test('render: a transparent render records that its background is not in the video, at the size it draws', { skip }, () => {
  const dir = scratchDir('text-record-alpha');
  const page = join(dir, 'caption.html');
  writeFileSync(page, caption('Hello there').replace('background:#123;', ''));
  const out = join(dir, 'out.mov');
  const r = render([page, '--out', out, '--fps', '30', '--duration', '1', '--transparent', '--scale', '0.45']);
  assert.equal(r.code, 0, r.err);
  const record = readRecord(recordPath(out));
  assert.deepEqual([record.transparent, record.width, record.height], [true, 144, 81]);
  near(textOf(record, 0, 'Title')!.box[0], 12 * 0.45, 'title left at the capture scale');
});

test('render: reading the text between frames leaves every captured frame as it was', { skip }, async () => {
  const dir = scratchDir('text-record-unchanged');
  // A transition started by a class the page toggles, which a style read at the wrong moment would start early.
  const page = join(dir, 'p.html');
  writeFileSync(page, `<!doctype html><style>body{margin:0}#stage{width:96px;height:64px;background:#222;font:16px sans-serif;color:#fff}
#t{transition:opacity .3s,transform .3s;opacity:0;transform:translateY(20px)}#t.on{opacity:1;transform:none}</style>
<div id="stage"><div id="t">Hi</div></div><script>window.__seek=(t)=>document.getElementById('t').classList.toggle('on',t>=0.2)</script>`);
  const server = await startPageServer({ roots: [dir] });
  const chrome = await resolveChrome(undefined);
  const open = () => RenderSession.open({
    chrome, server, page, viewport: { width: 96, height: 64 }, transparent: false, fps: { num: 30, den: 1 },
    seed: SEED, epoch: EPOCH, budgetMs: 60_000, failedLoads: new Set(), refused: new Set(),
  });
  const plain = await open();
  const reading = await open();
  try {
    let read = 0;
    for (let i = 0; i < 18; i++) {
      const a = await plain.capture(i);
      const b = await reading.capture(i);
      read += (await reading.readText()).length;
      assert.ok(a.equals(b), `frame ${i} differs once the text is read between frames`);
    }
    assert.ok(read > 0, 'the text was read');
  } finally {
    await plain.close();
    await reading.close();
    await server.close();
  }
});

test('mux-audio gives its output the record of the picture it copies, and drops one left from another picture', () => {
  const dir = scratchDir('text-record-mux');
  const video = synthClip(dir, 'out.mp4', { video: TESTSRC, seconds: 1 });
  const audio = synthClip(dir, 'voice.m4a', { audio: SINE, seconds: 1 });
  const record = JSON.stringify({ version: 1, page: 'p.html', width: 320, height: 240, fps: '25', frames: 25, transparent: false, framesPerSample: 3, samples: [] });
  writeFileSync(recordPath(video), record);
  const final = join(dir, 'final.mp4');
  assert.equal(muxAudio(['--video', video, '--audio', audio, '--out', final, '--no-loudnorm']), 0);
  assert.equal(readFileSync(recordPath(final), 'utf8'), record);

  // Muxed in place, the record stays, newer than the video as a record must be.
  assert.equal(muxAudio(['--video', final, '--audio', audio, '--out', final, '--no-loudnorm']), 0);
  assert.equal(readFileSync(recordPath(final), 'utf8'), record);
  assert.ok(statSync(recordPath(final)).mtimeMs >= statSync(final).mtimeMs);

  // A record older than its video describes a picture written there before, so it is not carried.
  utimesSync(recordPath(video), new Date(), new Date(Date.now() - 60_000));
  assert.equal(muxAudio(['--video', video, '--audio', audio, '--out', final, '--no-loudnorm']), 0);
  assert.equal(existsSync(recordPath(final)), false, 'a stale record is not carried');

  rmSync(recordPath(video));
  writeFileSync(recordPath(final), record);
  assert.equal(muxAudio(['--video', video, '--audio', audio, '--out', final, '--no-loudnorm']), 0);
  assert.equal(existsSync(recordPath(final)), false, 'a record of the earlier picture does not stay beside the new one');
});

test('the sampling interval is the frame rate\'s nearest whole number of frames to 100 ms', () => {
  assert.equal(sampleEvery({ num: 30, den: 1 }), 3);
  assert.equal(sampleEvery({ num: 30000, den: 1001 }), 3);
  assert.equal(sampleEvery({ num: 25, den: 1 }), 3);
  assert.equal(sampleEvery({ num: 24, den: 1 }), 2);
  assert.equal(sampleEvery({ num: 60, den: 1 }), 6);
  assert.equal(sampleEvery({ num: 5, den: 1 }), 1, 'never less than every frame');
});
