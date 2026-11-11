// Text burned into footage that reframe's crop cuts: which graphics it cuts, the rows and parts an erase covers, and on
// real ffmpeg clips the line that reports the cut, the parts --erase writes for the eraser, and the erased clip it lays
// together once the parts are back (the eraser itself stood in for by ffmpeg, as it runs on fal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { findFaces, readFaces } from '../src/commands/faces.ts';
import { reframe } from '../src/commands/reframe.ts';
import { FFMPEG } from '../src/config.ts';
import {
  bandsOf, cutGraphics, ERASE_PROMPT, ERASER, eraserParts, PART_SEC, prepareErase, quoteFor, quoteOf, quoteSpent, resendQuote, sentFrames, sentSize,
  spendQuote, splittable, type ErasePlan,
} from '../src/faces/erase.ts';
import { facesFolder } from '../src/faces/folder.ts';
import type { GraphicBox } from '../src/faces/graphics.ts';
import { writeAtomic } from '../src/providers/exclusive-files.ts';
import { stubDetector } from './helpers/face-stub.ts';
import { assertConverted, hdrClip, lumaOf } from './helpers/hdr.ts';
import { captureConsoleAsync, countFrames, meanAbsDiff, probeStream, rawFrame, scratchDir, withRoot } from './helpers/synth.ts';

const box = (x: number, w: number, from = 0, to = 2, y = 600, h = 40): GraphicBox => ({ x, y, w, h, from, to });
// A 9:16 crop of 1280x720, 404 px wide, standing at 438 until 3 s and at 0 from then on.
const plan = (graphics: GraphicBox[]) => ({ crop: { w: 404, h: 720, axis: 'x' as const }, moves: [{ sec: 0, at: 438 }, { sec: 3, at: 0 }], graphics });

test('reframe --erase: a graphic is cut when the crop shows part of it, at any place the crop stands while it is up', () => {
  const inside = box(500, 300);
  const across = box(300, 700);
  const outside = box(900, 300);
  // Wholly inside the crop at 438 and wholly outside it at 0.
  const later = box(500, 200, 2, 5);
  // Wholly outside the crop at 438, and gone before the crop at 0 would cut it.
  const gone = box(0, 420, 0, 2.9);
  assert.deepEqual(cutGraphics(plan([inside, across, outside, gone])), [across]);
  assert.deepEqual(cutGraphics(plan([later])), [], 'from 2 s it shows whole, and from 3 s not at all');
  assert.deepEqual(cutGraphics(plan([box(300, 200, 3.5, 5)])), [box(300, 200, 3.5, 5)], 'cut at 0, where the crop stands when it comes up');
  assert.deepEqual(cutGraphics({ ...plan([across]), moves: [] }), [], 'a clip already in the shape is not cut');
  // A shot cut tighter, as --panel cuts one, also leaves rows out: a lower third reaching below them is cut.
  const low = box(500, 100, 0, 2, 620, 40);
  assert.deepEqual(cutGraphics(plan([low])), [], 'whole inside the largest crop');
  assert.deepEqual(cutGraphics({ ...plan([low]), moves: [{ sec: 0, at: 438, zoom: { w: 360, h: 640, cross: 0 } }] }), [low]);
});

test('reframe --erase: the rows to erase are the cut graphics\' rows, padded, joined where they meet, on even rows', () => {
  // 2% of 720 is 14 px of padding.
  assert.deepEqual(bandsOf([box(300, 700, 0, 2, 619, 42)], 720), [{ y: 604, h: 72 }]);
  assert.deepEqual(bandsOf([box(300, 700, 0, 2, 619, 42), box(300, 700, 0, 2, 600, 20), box(0, 100, 0, 2, 20, 30)], 720),
    [{ y: 6, h: 58 }, { y: 586, h: 90 }]);
  assert.deepEqual(bandsOf([box(0, 100, 0, 2, 700, 19)], 720), [{ y: 686, h: 34 }], 'clamped to the frame');
});

test('reframe --erase: the clip goes to the eraser in parts it takes, as equal as whole frames allow, each sent with what follows', () => {
  const parts = eraserParts(721, 24);
  assert.deepEqual(parts.map((p) => [p.first, p.frames]), [[0, 120], [120, 120], [240, 121], [361, 120], [481, 120], [601, 120]]);
  assert.deepEqual([parts[0].name, parts[5].name], ['part-001', 'part-006']);
  assert.deepEqual(eraserParts(60, 30), [{ name: 'part-001', first: 0, frames: 60 }]);
  const odd = eraserParts(1001, 29.97);
  assert.equal(odd.reduce((n, p) => n + p.frames, 0), 1001);
  // Sent with half a second more, under the eraser's 15 s, and never under its 3 s.
  assert.ok(odd.every((p) => sentFrames(p.frames, 29.97) / 29.97 <= PART_SEC + 0.6 && PART_SEC + 0.6 < 15), JSON.stringify(odd));
  assert.equal(sentFrames(240, 24), 252);
  assert.equal(sentFrames(30, 30), 90);
  // The price is each run's seconds, rounded down to whole seconds as fal bills them, at fal's rate: 30 s at 24 fps goes
  // in 5 parts of 6.5 s sent, billed 6 s each, and a part sent again goes as two halves of 3.5 s, billed 3 s each.
  const thirty = eraserParts(720, 24);
  assert.deepEqual(quoteOf(thirty.map((p) => ({ sent: sentFrames(p.frames, 24) })), 24), { seconds: 30, usd: 5.04 });
  assert.deepEqual(resendQuote(thirty, 24), { seconds: 6, usd: 1.01 });
  assert.deepEqual(quoteOf([{ sent: 132 }, { sent: 72 }], 24), { seconds: 8, usd: 1.34 }, '5.5 s is billed as 5, and 3 s as 3');
  // A part that still holds text is cut in two again only from 2 s on.
  assert.deepEqual([48, 47].map((frames) => splittable({ name: 'part-001', first: 0, frames }, 24)), [true, false]);
  // At the clip's own size, unless a side is outside the 720 to 3840 px the eraser takes.
  assert.deepEqual(sentSize(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(sentSize(1080, 1920), { width: 1080, height: 1920 });
  assert.deepEqual(sentSize(640, 360), { width: 1280, height: 720 });
  assert.deepEqual(sentSize(7680, 4320), { width: 3840, height: 2160 });
});

const dir = scratchDir('reframe-erase');
// The plate the clip carries from 2 to 5 s: wider than a 9:16 crop of the frame, so a crop from the middle cuts it.
const PLATE = { x: 60, y: 290, w: 360, h: 44 };

/**
 * A 15 s locked-off shot with a tone: colour bars, a block swinging across them, another sliding through the plate's
 * rows right of it, so each frame of those rows is its own, and a caption plate with letter-like strokes on it.
 */
function captioned(): string {
  const out = join(dir, 'captioned.mp4');
  const on = `enable='between(t,2,5)'`;
  const strokes = Array.from({ length: Math.floor((PLATE.w - 20) / 12) }, (_, i) =>
    `drawbox=x=${PLATE.x + 10 + i * 12}:y=${PLATE.y + 8}:w=4:h=${PLATE.h - 16}:color=white:t=fill:${on}`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptehdbars=s=640x360:r=30', '-f', 'lavfi', '-i', 'color=c=0xc08060:s=90x200:r=30',
    '-f', 'lavfi', '-i', 'color=c=0x30a0e0:s=30x40:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '15', '-filter_complex',
    `[0:v][1:v]overlay=x='270+150*sin(t*2.3)':y=60[a];[a][2:v]overlay=x='450+mod(t*100\\,150)':y=${PLATE.y + 2},`
      + `drawbox=x=${PLATE.x}:y=${PLATE.y}:w=${PLATE.w}:h=${PLATE.h}:color=0x102a5c:t=fill:${on},${strokes.join(',')}`,
    '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  return out;
}

/**
 * What the eraser hands back for a part, made here as it was seen to: at 1920x1080 whatever it was sent, at 24 fps over
 * the same stretch of time, cut to a whole number of 8-frame groups and one more, and here with the plate's area (twice
 * the clip's size in the part sent) painted grey.
 */
function fakeEraser(part: ErasePlan['parts'][number], erases = true): void {
  mkdirSync(part.out, { recursive: true });
  const frames = Math.floor((Math.floor((part.sent * 24) / 30) - 1) / 8) * 8 + 1;
  const paint = erases ? `drawbox=x=${2 * PLATE.x}:y=${2 * PLATE.y}:w=${2 * PLATE.w}:h=${2 * PLATE.h}:color=gray:t=fill,` : '';
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', part.video, '-vf', `${paint}fps=24,trim=end_frame=${frames},scale=1920:1080`,
    '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', join(part.out, 'output.mp4')]);
}

/** `fn` with the environment's `vars` set, or unset where undefined, and put back after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (from: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(from)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  put(vars);
  try {
    return await fn();
  } finally {
    put(before);
  }
}

test('reframe --erase: says what the crop cuts and what erasing it costs, writes the eraser\'s runs only for that price approved, and once they are back reframes the clip with those rows erased', async () => {
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  await withRoot(root, async () => {
    const video = captioned();
    const clip = findFaces(video, { every: 0.25, threshold: 10, confidence: 0.5, margin: 0.25 }, stubDetector(() => []));
    assert.equal(clip.graphics?.length, 1, JSON.stringify(clip.graphics));
    writeAtomic(join(facesFolder(video), 'faces.json'), clip);
    const tall = join(root, 'runs', 'piece', 'tall.mp4');
    mkdirSync(join(root, 'runs', 'piece'), { recursive: true });

    const plain = await captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall]));
    assert.equal(plain.result, 0, plain.out);
    assert.match(plain.out, /the crop cuts text burned into the footage \(subtitles, a lower third: 1 graphic\(s\) faces found, up from [12]\.\d to 5\.\d s, in rows \d+-\d+ of 360\): run this again with --erase/);
    // Three runs of 5.5 s, each billed as 5 s, at $0.168 a second.
    assert.match(plain.out, /erasing them costs about \$2\.52 \(an estimate: 15 s billed, each run in whole seconds, at fal's \$0\.168 per second\), for the user to approve before anything is spent/);

    const first = await captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase']));
    assert.equal(first.result, 0, first.out);
    const folder = readdirSync(join(root, 'runs', 'piece')).find((n) => n.startsWith('tall.erase-'));
    assert.ok(folder, first.out);
    const erase = join(root, 'runs', 'piece', folder);
    const written = JSON.parse(readFileSync(join(erase, 'plan.json'), 'utf8')) as ErasePlan;
    // 450 frames at 30 fps, in three parts, each sent with 15 frames of what follows: the last part's are its last, repeated.
    assert.deepEqual(written.parts.map((p) => [p.first, p.frames, p.sent]), [[0, 150, 165], [150, 150, 165], [300, 150, 165]]);
    assert.deepEqual(written.parts.map((p) => countFrames(p.video)), [165, 165, 165]);
    assert.deepEqual(probeStream(written.parts[0].video, 'v:0', 'width,height'), { width: 1280, height: 720 });
    const [band] = written.bands;
    assert.ok(band.y <= PLATE.y && band.y + band.h >= PLATE.y + PLATE.h && band.h < 2 * PLATE.h, JSON.stringify(written.bands));
    // Before the user said yes to the price, nothing a fal run takes exists, and no run is printed.
    assert.ok(written.parts.every((p) => !existsSync(p.input)) && !readdirSync(erase).some((n) => n.startsWith('jobs')), first.out);
    assert.doesNotMatch(first.out, /fal run/);
    assert.match(first.out, new RegExp(`erasing them with ${ERASER.replace(/\//g, '\\/')} on fal costs about \\$2\\.52 \\(an estimate: 15 s billed`));
    // A part's halves are sent with 15 frames more, and at least 3 s: 2 x 90 frames, billed 3 s each.
    assert.match(first.out, /a second spend of up to \$1\.01 for each part sent again, which needs its own yes/);
    assert.match(first.out, /ask the user to approve about \$2\.52 once, before any part runs\. When they say yes, run openedit reframe \S+ --aspect 9:16 --out \S+ --erase --approve 2\.52:[0-9a-f]{8}: it writes the runs and prints them, once/);
    const yesTo = (out: string) => /--approve (\d+\.\d\d:[0-9a-f]{8})/.exec(out)![1];
    const firstYes = yesTo(first.out);

    const wrong = await captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', '2.31:0badc0de']));
    assert.equal(wrong.result, 1, wrong.out);
    assert.match(wrong.out, /--approve 2\.31:0badc0de is not the price waiting for a yes, so nothing was approved/);
    assert.ok(written.parts.every((p) => !existsSync(p.input)), 'a price the user was never shown approves nothing');
    assert.throws(() => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', '2.52']), /wants the price the user approved and its quote/);
    assert.throws(() => reframe([video, '--aspect', '9:16', '--out', tall, '--approve', firstYes]), /pass it with --erase/);

    // With no fal key and fal's own CLI on PATH, which runs apps rather than a model's input, the openedit fal batch.
    const theirs = join(dir, 'their-fal');
    const ours = join(dir, 'own-fal');
    mkdirSync(theirs, { recursive: true });
    mkdirSync(ours, { recursive: true });
    writeFileSync(join(theirs, 'fal'), '#!/bin/sh\necho "usage: fal [-h] {run,deploy,auth} ..."\n', { mode: 0o755 });
    // The environment's own `fal` says it takes a model and its input, as the help it prints says.
    writeFileSync(join(ours, 'fal'), '#!/bin/sh\necho "  fal run MODEL_ID INPUT_JSON [--out DIR]  run a model and download its outputs" >&2\nexit 1\n', { mode: 0o755 });
    const noKey = (bin: string) => ({ FAL_KEY: undefined, FAL_API_KEY: undefined, OPEN_EDIT_FAL_KEY_FILE: undefined, PATH: `${bin}${delimiter}${process.env.PATH}` });
    const yes = await withEnv(noKey(ours), () => captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', firstYes])));
    assert.equal(yes.result, 0, yes.out);
    assert.match(yes.out, /approved: erasing them with \S+ on fal for \$2\.52/);
    assert.deepEqual(written.parts.map((p) => JSON.parse(readFileSync(p.input, 'utf8'))),
      written.parts.map((p) => ({ video_url: p.video, prompt: ERASE_PROMPT, keep_audio: false })));
    // With no key and the environment's own fal: one run a part, its input the second argument. The fake `fal` is a shell
    // script, which Windows cannot run, and the environments that give their own `fal` run Linux.
    if (process.platform !== 'win32') {
      for (const p of written.parts) assert.ok(yes.out.includes(`reframe:   fal run ${ERASER} @${p.input} --out ${p.out}\n`), yes.out);
    }
    assert.match(yes.out, /Still to erase: every part/);

    // The same yes again, as a replay or a second call at once, approves nothing: each run is printed once.
    const replay = await withEnv(noKey(ours), () => captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', firstYes])));
    assert.equal(replay.result, 1, replay.out);
    assert.match(replay.out, new RegExp(`--approve ${firstYes} was approved already and its runs printed, so it approves nothing again`));
    assert.doesNotMatch(replay.out, /fal run/);

    // A part not back yet had its run printed once: running it again may buy it twice, so it is priced again, under a quote
    // of its own, and its run printed again only for a yes to that.
    fakeEraser(written.parts[0]);
    const half = await withEnv(noKey(theirs), () => captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase'])));
    assert.equal(half.result, 0, half.out);
    assert.match(half.out, /still to erase: part-002, part-003, whose runs were printed when their price was approved: wait for a run that is still going/);
    assert.match(half.out, /running part-002, part-003 again with \S+ on fal costs about \$1\.68 \(an estimate: 10 s billed/);
    assert.match(half.out, /to run them again, ask the user to approve about \$1\.68 once, before any part runs\. When they say yes, run openedit reframe \S+ --aspect 9:16 --out \S+ --erase --approve 1\.68:[0-9a-f]{8}/);
    assert.doesNotMatch(half.out, /fal run/);
    const againYes = yesTo(half.out);
    assert.notEqual(againYes, firstYes);

    const rerun = await withEnv(noKey(theirs), () => captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', againYes])));
    assert.equal(rerun.result, 0, rerun.out);
    const quoteId = againYes.split(':')[1];
    assert.match(rerun.out, new RegExp(`openedit fal run --batch \\S*${folder}[\\\\/]jobs-${quoteId}\\.json'? --out \\S*${folder}'? --run `));
    const jobs = JSON.parse(readFileSync(join(erase, `jobs-${quoteId}.json`), 'utf8')) as { name: string; model: string; input: Record<string, unknown> }[];
    assert.deepEqual(jobs.map((j) => [j.name, j.model, j.input.video_url, j.input.prompt]),
      written.parts.slice(1).map((p) => [p.name, ERASER, p.video, ERASE_PROMPT]));
    assert.match(rerun.out, /Still to erase: part-002, part-003$/m);

    for (const part of written.parts.slice(1)) fakeEraser(part);
    const done = await captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase']));
    assert.equal(done.result, 0, done.out);
    const clean = join(erase, 'captioned.erased.mp4');
    assert.match(done.out, new RegExp(`erased rows ${band.y}-${band.y + band.h} of captioned\\.mp4 in 3 part\\(s\\) and laid them over it → ${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(countFrames(clean), 450, 'every frame of the clip');
    assert.equal(probeStream(clean, 'a:0', 'codec_type').codec_type, 'audio');
    // Compared as shown, in RGB: the erased clip is BT.709, as reframe writes every clip, and this one is coded BT.601.
    const rgb = (file: string, n: number) => rawFrame(file, n, undefined, 'rgb24');
    const rows = (f: Buffer, from: number, to: number, x0 = 0, x1 = 640) =>
      Buffer.concat(Array.from({ length: to - from }, (_, i) => f.subarray(((from + i) * 640 + x0) * 3, ((from + i) * 640 + x1) * 3)));
    const beside = (f: Buffer) => rows(f, band.y, band.y + band.h, 460);
    for (const n of [60, 149, 150, 300]) {
      const [a, b] = [rgb(video, n), rgb(clean, n)];
      // Outside the band, the clip's own picture.
      assert.ok(meanAbsDiff(rows(a, 0, band.y), rows(b, 0, band.y)) < 1.5, `frame ${n} above the band`);
      // Inside it, the eraser's: the plate gone, and beside it the moment the part held then, to within the 24 fps the
      // eraser answers at (the frame or the one before), never a moment further off.
      assert.ok(rows(b, PLATE.y + 4, PLATE.y + PLATE.h - 4, PLATE.x + 4, PLATE.x + PLATE.w - 4).every((v) => Math.abs(v - 128) < 12), `frame ${n} plate`);
      const near = Math.min(...[n - 1, n].map((m) => meanAbsDiff(beside(rgb(video, m)), beside(b))));
      const far = Math.min(...[n - 4, n + 3].map((m) => meanAbsDiff(beside(rgb(video, m)), beside(b))));
      assert.ok(near < 3 && far > 2 * near, `frame ${n} beside the plate: ${near.toFixed(2)} from its own moment, ${far.toFixed(2)} from one further off`);
    }
    // The erased clip's boxes and the reframed clip's carry no graphic the erase took.
    assert.deepEqual(readFaces(join(facesFolder(clean), 'faces.json')).graphics, []);
    assert.ok(existsSync(tall));
    assert.deepEqual(readFaces(join(facesFolder(tall), 'faces.json')).graphics, []);
    assert.doesNotMatch(done.out, /the crop cuts text|the crop still cuts/);

    // An eraser that hands a part back with the text still in it: the erased clip is searched again, the line says which
    // part it is in, and that part is cut in two for the eraser, a second spend asked for on its own: the --approve this
    // call carries was the yes to the first parts, and approves none of the halves.
    fakeEraser(written.parts[0], false);
    const left = await captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', firstYes]));
    assert.equal(left.result, 0, left.out);
    assert.match(left.out, /the crop still cuts text the eraser left \(1 graphic\(s\) found on the erased clip, up from [12]\.\d to 5\.\d s, in rows \d+-\d+ of 360\), in part-001: part-001 is cut in two to send to the eraser again, as part-001a, part-001b/);
    assert.match(left.out, /sending them again with \S+ on fal, a second spend, costs about \$1\.01 \(an estimate: 6 s billed/);
    assert.match(left.out, /ask the user to approve about \$1\.01 once, before any part runs\. When they say yes, run openedit reframe \S+ --aspect 9:16 --out \S+ --erase --approve 1\.01:[0-9a-f]{8}/);
    assert.equal(readFaces(join(facesFolder(tall), 'faces.json')).graphics?.length, 1, 'the reframed clip\'s boxes hold the text that is left');
    const split = JSON.parse(readFileSync(join(erase, 'plan.json'), 'utf8')) as ErasePlan;
    assert.deepEqual(split.parts.map((p) => [p.name, p.first, p.frames]), [['part-001a', 0, 75], ['part-001b', 75, 75], ['part-002', 150, 150], ['part-003', 300, 150]]);
    assert.ok(split.parts.slice(0, 2).every((p) => !existsSync(p.input)), left.out);
    const halvesYes = yesTo(left.out);

    // Neither an earlier yes, replayed, nor one of the same price under another quote approves the halves.
    const key = { FAL_KEY: 'a-key-this-test-never-sends' };
    const stale = await withEnv(key, () => captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', againYes])));
    assert.equal(stale.result, 1, stale.out);
    assert.match(stale.out, /was approved already and its runs printed, so it approves nothing again/);
    assert.ok(split.parts.slice(0, 2).every((p) => !existsSync(p.input)), stale.out);
    const again = await withEnv(key, () => captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase', '--approve', halvesYes])));
    assert.equal(again.result, 0, again.out);
    assert.match(again.out, /approved: erasing part-001a, part-001b with \S+ on fal for \$1\.01/);
    assert.match(again.out, /Still to erase: part-001a, part-001b$/m);
    const halvesJobs = join(erase, `jobs-${halvesYes.split(':')[1]}.json`);
    assert.deepEqual(JSON.parse(readFileSync(halvesJobs, 'utf8')).map((j: { name: string }) => j.name), ['part-001a', 'part-001b']);
    assert.equal(JSON.parse(readFileSync(join(erase, `jobs-${quoteId}.json`), 'utf8')).length, 2, 'an earlier batch is kept as it was');

    for (const half of split.parts.slice(0, 2)) fakeEraser(half);
    const fixed = await captureConsoleAsync(async () => reframe([video, '--aspect', '9:16', '--out', tall, '--erase']));
    assert.equal(fixed.result, 0, fixed.out);
    assert.doesNotMatch(fixed.out, /the crop still cuts/);
    assert.equal(countFrames(clean), 450);
    assert.deepEqual(readFaces(join(facesFolder(tall), 'faces.json')).graphics, []);
  });
});

test('reframe --erase: an HDR clip\'s parts go to the eraser converted to SDR, as every other upload goes, and it says so', () => {
  const hlg = hdrClip(dir, 'hlg.mp4', { transfer: 'arib-std-b67', video: 'testsrc=size=1280x720:rate=25', seconds: 0.4 });
  const said: string[] = [];
  const plan = prepareErase(hlg, { width: 1280, height: 720, sar: 1 }, [{ y: 600, h: 80 }], join(dir, 'hlg.erase'), (l) => said.push(l));
  const [part] = plan.parts;
  assert.deepEqual(probeStream(part.video, 'v:0', 'color_primaries,color_transfer,color_space'), { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
  assertConverted(hlg, 5, lumaOf(part.video, 5, 'video'), { transfer: 'arib-std-b67', width: 1280, tolerance: 1.5, what: 'the part sent' });
  assert.ok(said.some((l) => /^hlg\.mp4 is HDR \(HLG, bt2020\/arib-std-b67\/bt2020nc\): converted to SDR BT\.709/.test(l)), said.join('\n'));
});

test('reframe --erase: a quote approves once, and the same parts priced again, to run them again, get a quote of their own', () => {
  const at = join(dir, 'quotes');
  mkdirSync(at, { recursive: true });
  const parts = eraserParts(240, 24).map((p) => ({ ...p, sent: sentFrames(p.frames, 24), video: '', input: '', out: '' }));
  const quote = quoteFor(at, parts, 24);
  assert.deepEqual(quoteFor(at, parts, 24), quote, 'the same price put twice before a yes is one quote');
  assert.equal(spendQuote(at, quote), true);
  assert.equal(spendQuote(at, quote), false, 'a second approval of it, replayed or at the same time, finds it taken');
  assert.ok(quoteSpent(at, quote.id));
  const next = quoteFor(at, parts, 24);
  assert.equal(next.usd, quote.usd);
  assert.notEqual(next.id, quote.id);
});
