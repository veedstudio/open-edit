import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTimeSpec, parseFrameSpec, parseCrop, frameAt, seekFor, selectFrames, extractFrames, collectImages, sheetImages, frames } from '../src/commands/frames.ts';
import { FFMPEG, FFPROBE } from '../src/config.ts';

/** A deterministic clip; `rate` as ffmpeg takes it, so a rational rate can be exercised. */
function clip(seconds = 4, rate = '24'): string {
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  const p = join(dir, 'src.mp4');
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc=size=160x90:rate=${rate}`, '-t', String(seconds), '-pix_fmt', 'yuv420p', p]);
  return p;
}

function dims(png: string): [number, number] {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png], { encoding: 'utf8' });
  return out.trim().split(',').map(Number) as [number, number];
}

test('frames: a time is seconds, m:ss or h:mm:ss, with or without a trailing s', () => {
  assert.equal(parseTimeSpec('12.5'), 12.5);
  assert.equal(parseTimeSpec('12.5s'), 12.5);
  assert.equal(parseTimeSpec('1:02.5'), 62.5);
  assert.equal(parseTimeSpec('0:01:02.5'), 62.5);
  assert.throws(() => parseTimeSpec('abc'), /not a time/);
  assert.throws(() => parseTimeSpec('1:2:3:4'), /not a time/);
});

test('frames: a frame spec is an index or an inclusive range', () => {
  assert.deepEqual(parseFrameSpec('300'), [300]);
  assert.deepEqual(parseFrameSpec('300-303'), [300, 301, 302, 303]);
  assert.throws(() => parseFrameSpec('303-300'), /backwards/);
  assert.throws(() => parseFrameSpec('1.5'), /not a frame/);
});

test('frames: the frame on screen at t is the last one not after it', () => {
  assert.equal(frameAt(0.5, 24), 12);
  assert.equal(frameAt(0.49, 24), 11);
  // 12/24 computed via a rational fps must not fall to 11 on float noise.
  assert.equal(frameAt(12 / (30000 / 1001), 30000 / 1001), 12);
});

test('frames: the seek lands on the named frame, whatever the rate', () => {
  // ffmpeg emits the first frame whose pts is not before -ss. -copyts keeps the source pts and
  // showinfo prints it (to stderr), so the frame that came out can be identified.
  for (const [rate, fps] of [['24', 24], ['30000/1001', 30000 / 1001], ['25', 25]] as const) {
    const src = clip(2, rate);
    for (const frame of [0, 1, 12, 37]) {
      const { stderr } = spawnSync(FFMPEG, ['-v', 'info', '-ss', String(seekFor(frame, fps)), '-i', src, '-copyts',
        '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = stderr.match(/pts_time:([\d.]+)/);
      assert.ok(m, `showinfo printed a pts for frame ${frame} at ${rate}`);
      assert.equal(Math.round(Number(m[1]) * fps), frame, `seek for frame ${frame} at ${rate} fps`);
    }
  }
});

test('frames: a selection is deduplicated, ordered, and refuses a named moment past the picture', () => {
  assert.deepEqual(selectFrames({ at: ['1.0', '0.5,1'], frame: ['24', '30-31'] }, 24, 4), [12, 24, 30, 31]);
  assert.throws(() => selectFrames({ at: ['5'] }, 24, 4), /past the last frame/);
  assert.throws(() => selectFrames({ frame: ['96'] }, 24, 4), /past the last frame/);
  assert.throws(() => selectFrames({}, 24, 4), /nothing selected/);
});

test('frames: a sweep is clipped to the picture rather than refused', () => {
  // --every 1 on a 4 s clip lands on 4.0, which is past the last frame (95); that is the ordinary
  // case, not a mistake, so it is dropped.
  assert.deepEqual(selectFrames({ every: 1 }, 24, 4), [0, 24, 48, 72]);
  assert.deepEqual(selectFrames({ every: 0.5, from: 1, to: 2 }, 24, 4), [24, 36, 48]);
  // --count samples bin midpoints, so one still is the middle of the span.
  assert.deepEqual(selectFrames({ count: 1 }, 24, 4), [48]);
  assert.deepEqual(selectFrames({ count: 2, from: 0, to: 2 }, 24, 4), [12, 36]);
  assert.throws(() => selectFrames({ every: 1, from: 3, to: 1 }, 24, 4), /before --from/);
});

test('frames: stills are written, named by frame and second, and listed in frames.json', () => {
  const src = clip(3);
  const out = join(mkdtempSync(join(tmpdir(), 'frames-out-')), 'nested', 'dir');
  const plan = extractFrames(src, { at: ['1.5'], frame: ['5'], out });
  assert.deepEqual(plan.stills.map((s) => s.frame), [5, 36]);
  assert.ok(plan.stills[1].path.endsWith('f000036-1.500s.png'));
  for (const s of plan.stills) assert.ok(existsSync(s.path), `${s.path} written`);
  const onDisk = JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8'));
  assert.equal(onDisk.stills.length, 2);
  assert.equal(onDisk.fps, 24);
  assert.equal(onDisk.sheet, undefined);
});

test('frames: crop happens in source pixels before the scale, and the sheet tiles every still', () => {
  const src = clip(2);
  const out = mkdtempSync(join(tmpdir(), 'frames-sheet-'));
  const plan = extractFrames(src, { every: 0.5, out, width: 80, crop: parseCrop('0,0,160,45'), sheet: true, cols: 3 });
  assert.equal(plan.stills.length, 4);
  assert.deepEqual(dims(plan.stills[0].path), [80, 22]);
  assert.ok(plan.sheet);
  assert.deepEqual([plan.sheet!.cols, plan.sheet!.rows, plan.sheet!.tileWidth], [3, 2, 80]);
  // 3 tiles of 80 + 2 gaps of 4 + 2 margins of 4.
  assert.deepEqual(dims(plan.sheet!.path), [256, 56]);
});

test('frames: a single still still makes a sheet', () => {
  const out = mkdtempSync(join(tmpdir(), 'frames-one-'));
  const plan = extractFrames(clip(1), { frame: ['3'], out, sheet: true });
  assert.ok(existsSync(plan.sheet!.path));
  assert.deepEqual([plan.sheet!.cols, plan.sheet!.rows], [1, 1]);
});

test('frames: --crop is refused unless it is four non-negative integers with a size', () => {
  assert.throws(() => parseCrop('0,0,160'), /x,y,w,h/);
  assert.throws(() => parseCrop('0,0,0,45'), /x,y,w,h/);
  assert.throws(() => parseCrop('a,b,c,d'), /x,y,w,h/);
});

/** Pictures of unlike sizes, the way a folder of reference screenshots arrives. */
function pictures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'frames-img-'));
  for (const [name, size] of [['shot-10.png', '200x100'], ['shot-2.png', '90x160'], ['shot-1.png', '120x120']] as const) {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', join(dir, name)]);
  }
  writeFileSync(join(dir, 'notes.txt'), 'not a picture');
  return dir;
}

test('frames --images: a directory gives its pictures in natural order, a file is taken as named, nothing twice', () => {
  const dir = pictures();
  const names = collectImages([dir, join(dir, 'shot-2.png')]).map((p) => p.slice(dir.length + 1));
  assert.deepEqual(names, ['shot-1.png', 'shot-2.png', 'shot-10.png']);
  assert.throws(() => collectImages([join(dir, 'gone.png')]), /does not exist/);
});

test('frames --images: pictures of unlike sizes land on one sheet, each listed with its place and its own size', () => {
  const dir = pictures();
  const out = join(dir, 'out');
  const plan = sheetImages(collectImages([dir]), { out, width: 100 });
  assert.deepEqual(plan.images.map((t) => [t.tile, t.row, t.col, t.width, t.height]), [[1, 1, 1, 120, 120], [2, 1, 2, 90, 160], [3, 2, 1, 200, 100]]);
  // two 100px cells per row and per column, 4px between them
  assert.deepEqual(dims(plan.sheet.path), [204, 204]);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'images.json'), 'utf8')), plan);
  assert.throws(() => sheetImages([], { out }), /no images found/);
});

test('frames --images: a flag that picks a moment in a video is refused rather than ignored', () => {
  assert.equal(frames(['--images', pictures(), '--at', '2']), 2);
});

/** The colour at the middle of a tile on a 2-column sheet of 100px cells with 4px between them. */
function tileColour(sheet: string, tile: number): string {
  const x = ((tile - 1) % 2) * 104 + 50, y = Math.floor((tile - 1) / 2) * 104 + 50;
  const px = execFileSync(FFMPEG, ['-v', 'error', '-i', sheet, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-frames:v', '1', '-']);
  return [...px].map((c) => (c > 200 ? 'F' : c < 60 ? '0' : '-')).join('');
}
const solid = (dir: string, name: string, colour: string, extra: string[] = []) => {
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${colour}:s=80x80:r=5`, ...extra, join(dir, name)]);
  return join(dir, name);
};

test('frames --images: an animation is one tile, and a name with a printf conversion in it is that file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frames-anim-'));
  const anim = solid(dir, 'a.gif', 'red', ['-t', '2']);
  const blue = solid(dir, 'seq%d.png', 'blue', ['-frames:v', '1', '-update', '1']);
  solid(dir, 'seq1.png', 'white', ['-frames:v', '1']);
  const green = solid(dir, 'z.png', 'lime', ['-frames:v', '1']);
  const plan = sheetImages([anim, blue, green], { out: join(dir, 'out'), width: 100, cols: 2 });
  assert.deepEqual([1, 2, 3].map((t) => tileColour(plan.sheet.path, t)), ['F00', '00F', '0F0']);
});

test('frames --images: a picture that is not there exits 2, like a video that is not there', () => {
  assert.equal(frames(['--images', join(tmpdir(), 'no-such-picture.png')]), 2);
});
