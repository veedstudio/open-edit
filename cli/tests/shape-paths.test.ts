// concat-videos and apply-edl cut a clip of another shape with reframe's own code, here on a white square with
// face boxes written for it, the stand-in the reframe tests use. With MediaPipe installed the talking-head fixture
// runs too, and is skipped otherwise unless OPENEDIT_REQUIRE_MEDIAPIPE is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFaces } from '../src/commands/faces.ts';
import { cropFor, shapeChain, type Shaping } from '../src/commands/reframe.ts';
import { FFMPEG } from '../src/config.ts';
import { facesFolder, ownFaces } from '../src/faces/folder.ts';
import { missingDetector } from '../src/faces/mediapipe.ts';
import type { FacesClip } from '../src/faces/page-script.ts';
import { probeSquareSize, probeVideoSpan } from '../src/probe.ts';
import { rotatedCopy, scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/talking-head.mp4', import.meta.url));

const cli = (args: string[], root: string) =>
  spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: root } });

/** `run` with OPEN_EDIT_ROOT at `root` in this process, where the face-box folders are worked out. */
function inRoot<T>(root: string, run: () => T): T {
  const before = process.env.OPEN_EDIT_ROOT;
  process.env.OPEN_EDIT_ROOT = root;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.OPEN_EDIT_ROOT; else process.env.OPEN_EDIT_ROOT = before;
  }
}

// The square's places in a 640x360 clip: left of a 9:16 centre crop (219-421), then right of it after a cut.
const SQUARE = 60;
const LEFT = 40;
const RIGHT = 540;

/** A 640x360 clip, black but for the white square at `first` until `cut` s and at `then` after, with a tone. */
function squareClip(file: string, o: { seconds?: number; cut?: number; first?: number; then?: number; late?: number } = {}): string {
  const { seconds = 2, cut = 1, first = LEFT, then = RIGHT, late = 0 } = o;
  mkdirSync(dirname(file), { recursive: true });
  // drawbox reads its place once, so the jump is two boxes, each drawn for its own stretch.
  const boxes = [[first, `lt(t,${cut})`], [then, `gte(t,${cut})`]]
    .map(([x, when]) => `drawbox=x=${x}:y=150:w=${SQUARE}:h=${SQUARE}:color=white:t=fill:enable='${when}'`).join(',');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds + late}`, '-vf', boxes,
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  if (!late) return file;
  // `late` seconds of sound before the picture starts, as a camera that starts recording sound first leaves it.
  const shifted = file.replace(/\.mp4$/, '-late.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-itsoffset', String(late), '-i', file, '-i', file, '-map', '0:v', '-map', '1:a', '-c', 'copy', shifted]);
  return shifted;
}

/** The boxes faces would write for a squareClip, on the clip's own clock, where faces would write them unless `folder` is given. */
function squareFaces(root: string, video: string, o: { cut?: number; first?: number; then?: number; durationSec?: number; folder?: string } = {}): string {
  const { cut = 1, first = LEFT, then = RIGHT } = o;
  const { start, end } = probeVideoSpan(video);
  const at = (x: number) => [{ x, y: 150, w: SQUARE, h: SQUARE, score: 0.9 }];
  const quarters = (from: number, to: number) => Array.from({ length: Math.round((to - from) * 4) }, (_, i) => from + 0.125 + i / 4);
  const clip = {
    video: realpathSync(video), name: basename(video), width: 640, height: 360, fps: 30, frameRate: '30/1', durationSec: o.durationSec ?? end,
    model: 'blaze_face_full_range', every: 0.25, threshold: 10, confidence: 0.5, textMargin: 0.25,
    shots: [
      { start, end: start + cut, samples: quarters(start, start + cut).map((sec) => ({ sec, faces: at(first) })) },
      { start: start + cut, end, samples: quarters(start + cut, end).map((sec) => ({ sec, faces: at(then) })) },
    ],
  } as unknown as FacesClip;
  const folder = o.folder ?? inRoot(root, () => facesFolder(video));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'faces.json'), JSON.stringify(clip));
  return folder;
}

/** A clip of `size` with a tone: a grey ramp, brighter downwards, so its orientation shows. */
function rampClip(dir: string, name: string, size: string, seconds = 1): string {
  const file = join(dir, name);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-vf', 'geq=lum=Y*255/H:cb=128:cr=128', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  return file;
}

/** Every frame's luma plane, `w` x `h`. */
function lumaFrames(video: string, w: number, h: number): Buffer[] {
  const y = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-vf', 'extractplanes=y', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  assert.equal(y.length % (w * h), 0, `frames of ${w}x${h}`);
  return Array.from({ length: y.length / (w * h) }, (_, n) => y.subarray(n * w * h, (n + 1) * w * h));
}

/** The frames among `frames` where the square is not wholly inside: missing, cut by a side edge, or smaller than `area`. */
function squareMisses(frames: Buffer[], w: number, h: number, area: number): number[] {
  return frames.flatMap((frame, n) => {
    let [x0, x1, count] = [w, -1, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (frame[y * w + x] >= 128) [x0, x1, count] = [Math.min(x0, x), Math.max(x1, x), count + 1];
    return count > area * 0.85 && x0 > 0 && x1 < w - 1 ? [] : [n];
  });
}

// The square as shown in a 9:16 crop scaled to 360x640, and letterboxed whole into 360 px of width.
const CUT_AREA = (SQUARE * 640 / 360) ** 2;
const BOXED_AREA = (SQUARE * 360 / 640) ** 2;
const meanDiff = (a: Buffer, b: Buffer) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;

test('shape: a crop moves on the clock of the range it cuts, and holds still where it does not move', () => {
  const shape = { crop: { w: 202, h: 360, axis: 'x', travel: 438 }, moves: [{ sec: 0, at: 0 }, { sec: 0.9995, at: 438 }, { sec: 3, at: 100 }], how: 'faces', sar: 1 } as Shaping;
  const upright = 'sidedata=mode=delete:type=DISPLAYMATRIX';
  assert.deepEqual(shapeChain(shape, 'r1', { from: 0.5, to: 2 }), {
    filters: [upright, 'sendcmd=f=r1.cmd', 'crop@r1=w=202:h=360:x=0:y=0'],
    script: { file: 'r1.cmd', text: '0.000000 crop@r1 x 0;\n0.499500 crop@r1 x 438;\n' },
  }, 'the place at the start first, then the move half a frame before the cut, nothing past the end');
  assert.deepEqual(shapeChain(shape, 'r2', { from: 1.2, to: 2.5 }), { filters: [upright, 'crop@r2=w=202:h=360:x=438:y=0'] }, 'no move inside the range: no file');
  // Pixels that are not square are made square first; a clip already in the shape is only that.
  const already = { ...shape, how: 'already', moves: [], sar: 4 / 3, width: 1920, height: 1080 } as Shaping;
  assert.deepEqual(shapeChain(already, 'c0'), { filters: [upright, 'scale=1920:1080', 'setsar=1'] });
  assert.equal(cropFor(1078, 1918, 1080 / 1920).travel, 0, 'within the two pixels even sides round to, a clip is in the shape');
});

test('faces folders: every clip has a folder of its own by its real path, and finds only its own boxes there', () => {
  const dir = scratchDir('shape-folders');
  const [a, b] = [squareClip(join(dir, 'a', 'talk.mp4')), squareClip(join(dir, 'b', 'talk.mp4'), { first: RIGHT, then: LEFT })];
  inRoot(dir, () => {
    assert.match(facesFolder(a), /runs[/\\]talk[/\\]faces-[0-9a-f]{8}$/);
    assert.notEqual(facesFolder(a), facesFolder(b), 'two clips of one name never share a folder');
    // The spelling it was given and its real path (/var and /private/var on macOS) are one clip.
    assert.equal(facesFolder(realpathSync(a)), facesFolder(a));
    assert.equal(ownFaces(a), null);
  });
  const folder = squareFaces(dir, a);
  inRoot(dir, () => {
    assert.equal(ownFaces(a), join(folder, 'faces.json'));
    assert.equal(ownFaces(b), null, 'another clip\'s boxes are never b\'s');
  });
});

test('faces folders: boxes in the shared faces.json from before are used for their own clip, and passed over, with a line, for another', () => {
  const dir = scratchDir('shape-folders-shared');
  const a = squareClip(join(dir, 'a', 'talk.mp4'));
  const b = squareClip(join(dir, 'b', 'talk.mp4'), { first: RIGHT, then: LEFT });
  squareFaces(dir, a, { folder: join(dir, 'runs', 'talk') });
  const tall = rampClip(dir, 'tall.mp4', '360x640');
  const own = cli(['concat-videos', '--canvas', '360x640', join(dir, 'a.mp4'), a, tall], dir);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /talk\.mp4 \(640x360\) is cut to the canvas's shape \(360x640\) around its faces \(.*runs.talk.faces\.json\)/);
  const other = cli(['concat-videos', '--canvas', '360x640', join(dir, 'b.mp4'), b, tall], dir);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /from the middle, as reframe cuts it: no face boxes for it \(faces writes them\); .*runs.talk.faces\.json holds another clip's and is not used/);
});

test('faces folders: the clip\'s own folder is read before the shared faces.json, and what it holds is refused when it is not this clip\'s, never passed over', () => {
  const dir = scratchDir('shape-folders-own-first');
  const talk = squareClip(join(dir, 'a', 'talk.mp4'));
  const tall = rampClip(dir, 'tall.mp4', '360x640');
  const join9x16 = (out: string) => cli(['concat-videos', '--canvas', '360x640', join(dir, out), talk, tall], dir);
  mkdirSync(join(dir, 'runs', 'talk'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'talk', 'faces.json'), '{"video": null}');
  inRoot(dir, () => assert.equal(ownFaces(talk), null, 'a shared faces.json naming no clip is no clip\'s'));
  // Boxes from before the clip was cut, in the shared file; fresh ones in its own folder.
  squareFaces(dir, talk, { folder: join(dir, 'runs', 'talk'), durationSec: 5 });
  const folder = squareFaces(dir, talk);
  inRoot(dir, () => assert.equal(ownFaces(talk), join(folder, 'faces.json')));
  const fresh = join9x16('fresh.mp4');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.ok(fresh.stdout.includes(`around its faces (${join(folder, 'faces.json')})`), fresh.stdout);

  writeFileSync(join(folder, 'faces.json'), '{"video": ');
  const torn = join9x16('torn.mp4');
  assert.equal(torn.status, 1);
  assert.match(torn.stderr, /faces-[0-9a-f]{8}.faces\.json: Unexpected end of JSON input: run faces on .*a.talk\.mp4 again, or join with --fit letterbox/);
  squareFaces(dir, squareClip(join(dir, 'b', 'talk.mp4')), { folder });
  const foreign = join9x16('foreign.mp4');
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /faces-[0-9a-f]{8}.faces\.json holds the faces of .*b.talk\.mp4 .*not of .*a.talk\.mp4/);
});

test('faces: a clip that is not there is refused before any folder is made for it', () => {
  const dir = scratchDir('shape-faces-missing');
  const r = cli(['faces', join(dir, 'missing.mp4')], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /video not found: .*missing\.mp4/);
  assert.equal(existsSync(join(dir, 'runs')), false);
});

/** Runs of write-faces.ts on `clips`, all writing at one instant; the folder each printed. */
function writeTogether(root: string, clips: string[]): Promise<string[]> {
  const helper = fileURLToPath(new URL('./helpers/write-faces.ts', import.meta.url));
  const startAt = String(Date.now() + 2000);
  return Promise.all(clips.map((clip) => new Promise<string>((done, fail) => {
    execFile(process.execPath, ['--import', 'tsx', helper, clip, startAt], { env: { ...process.env, OPEN_EDIT_ROOT: root } },
      (error, out) => (error ? fail(error) : done(out.trim())));
  })));
}

test('faces folders: six clips of one name written at one instant each get their own folder, and one clip written four times one whole copy', async () => {
  const dir = scratchDir('shape-folders-race');
  const clips = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => {
    const file = join(dir, name, 'C0001.MP4');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, name);
    return file;
  });
  const folders = await writeTogether(dir, clips);
  assert.equal(new Set(folders).size, 6, `one folder each: ${folders.join(', ')}`);
  inRoot(dir, () => clips.forEach((clip, i) => assert.equal(ownFaces(clip), join(folders[i], 'faces.json'), 'each found there')));
  const same = await writeTogether(dir, [clips[0], clips[0], clips[0], clips[0]]);
  assert.equal(new Set(same).size, 1);
  assert.equal(JSON.parse(readFileSync(join(same[0], 'faces.json'), 'utf8')).video, realpathSync(clips[0]));
  assert.deepEqual(readdirSync(same[0]).sort(), ['faces.js', 'faces.json'], 'whole files, no draft left');
});

test('concat-videos: a landscape clip joined with a portrait one into 9:16 keeps the face inside the crop on every frame', () => {
  const dir = scratchDir('shape-concat');
  const talk = squareClip(join(dir, 'talk.mp4'));
  squareFaces(dir, talk);
  const tall = rampClip(dir, 'tall.mp4', '360x640');
  const out = join(dir, 'joined.mp4');
  const r = cli(['concat-videos', '--canvas', '360x640', out, talk, tall], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /talk\.mp4 \(640x360\) is cut to the canvas's shape \(360x640\) around its faces \(.*faces\.json\), as reframe cuts it/);
  assert.doesNotMatch(r.stdout, /tall\.mp4 .* is cut/, 'the portrait clip is already in the shape');
  const frames = lumaFrames(out, 360, 640);
  assert.ok(frames.length >= 90, `${frames.length} frames`);
  assert.deepEqual(squareMisses(frames.slice(0, 60), 360, 640, CUT_AREA), []);
  // The same clip centre-cropped loses the square on every frame: the check can tell the two apart.
  const centre = join(dir, 'centre.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', talk, '-vf', 'crop=202:360,scale=360:640', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', centre]);
  assert.equal(squareMisses(lumaFrames(centre, 360, 640), 360, 640, CUT_AREA).length, 60);
});

test('concat-videos: a clip whose picture starts after its sound is cut on its picture\'s own clock', () => {
  const dir = scratchDir('shape-concat-late');
  const talk = squareClip(join(dir, 'talk.mp4'), { late: 0.5 });
  assert.ok(Math.abs(probeVideoSpan(talk).start - 0.5) < 0.01, 'the picture starts 0.5 s in');
  squareFaces(dir, talk);
  const out = join(dir, 'joined.mp4');
  const r = cli(['concat-videos', '--canvas', '360x640', out, talk, rampClip(dir, 'tall.mp4', '360x640')], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /talk-late\.mp4 \(640x360\) is cut to the canvas's shape \(360x640\) around its faces/);
  // The crop changes place on the cut's own frame, 1 s into the picture: a crop half a second off misses 15 frames.
  assert.deepEqual(squareMisses(lumaFrames(out, 360, 640).slice(0, 60), 360, 640, CUT_AREA), []);
});

test('concat-videos: two clips of the same name from different folders each follow their own faces', () => {
  const dir = scratchDir('shape-concat-same-name');
  const a = squareClip(join(dir, 'a', 'talk.mp4'));
  const b = squareClip(join(dir, 'b', 'talk.mp4'), { first: RIGHT, then: LEFT });
  const [folderA, folderB] = [squareFaces(dir, a), squareFaces(dir, b, { first: RIGHT, then: LEFT })];
  assert.notEqual(folderA, folderB);
  const out = join(dir, 'joined.mp4');
  const r = cli(['concat-videos', '--canvas', '360x640', out, a, b], dir);
  assert.equal(r.status, 0, r.stderr);
  for (const folder of [folderA, folderB]) assert.ok(r.stdout.includes(`around its faces (${join(folder, 'faces.json')})`), `${folder} in ${r.stdout}`);
  assert.deepEqual(squareMisses(lumaFrames(out, 360, 640).slice(0, 120), 360, 640, CUT_AREA), []);
});

test('concat-videos: with no face boxes a clip of another shape is cut from the middle and says so; --fit letterbox pads it whole', () => {
  const dir = scratchDir('shape-concat-middle');
  const talk = squareClip(join(dir, 'talk.mp4'));
  const tall = rampClip(dir, 'tall.mp4', '360x640');
  const out = join(dir, 'joined.mp4');
  const r = cli(['concat-videos', '--canvas', '360x640', out, talk, tall], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /talk\.mp4 \(640x360\) is cut to the canvas's shape \(360x640\) from the middle, as reframe cuts it: no face boxes for it \(faces writes them\)/);
  assert.equal(squareMisses(lumaFrames(out, 360, 640).slice(0, 60), 360, 640, CUT_AREA).length, 60, 'the middle shows neither place');

  const boxed = join(dir, 'boxed.mp4');
  const l = cli(['concat-videos', '--canvas', '360x640', '--fit', 'letterbox', boxed, talk, tall], dir);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /talk\.mp4 \(640x360\) is letterboxed onto the 360x640 canvas/);
  // The whole 640x360 picture at 360 px wide is 202 px tall, between black bars: the square is in it on every frame.
  const frames = lumaFrames(boxed, 360, 640);
  assert.deepEqual(squareMisses(frames.slice(0, 60), 360, 640, BOXED_AREA), []);
  assert.ok(frames[0].subarray(0, 360 * 200).every((v) => v < 20), 'black above the picture');
});

test('concat-videos and apply-edl: a phone clip stored sideways comes out upright, and a clip already in the shape passes through uncut', () => {
  const dir = scratchDir('shape-phone');
  // Stored 640x360 with a 90 degree rotation tag: shown 360x640, already the canvas's shape.
  const phone = rotatedCopy(rampClip(dir, 'flat.mp4', '640x360'), join(dir, 'phone.mp4'), 90);
  const tall = rampClip(dir, 'tall.mp4', '360x640');
  const out = join(dir, 'joined.mp4');
  const r = cli(['concat-videos', out, phone, tall], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /is cut|letterboxed/, 'both clips are already 9:16 as shown');
  assert.deepEqual(probeSquareSize(out), { width: 360, height: 640, sar: 1 }, 'a portrait canvas from the shown sizes, with no rotation left on it');
  const frames = lumaFrames(out, 360, 640);
  // Each clip is its own picture as ffmpeg shows it upright, frame for frame: nothing cut, padded or turned.
  const [upright] = lumaFrames(phone, 360, 640);
  const [own] = lumaFrames(tall, 360, 640);
  assert.ok(meanDiff(frames[0], upright) < 2, `the phone clip upright: ${meanDiff(frames[0], upright).toFixed(2)}`);
  assert.ok(meanDiff(frames[45], own) < 2, `the portrait clip as it was: ${meanDiff(frames[45], own).toFixed(2)}`);
  // apply-edl's canvas is the phone clip as shown, and its cut is not tagged to be turned again either.
  const list = join(dir, 'edl.json');
  writeFileSync(list, JSON.stringify({ sources: { a: phone }, ranges: [{ source: 'a', start: 0, end: 0.5 }, { source: 'a', start: 0.5, end: 0.9 }] }));
  const cut = join(dir, 'cut.mp4');
  const e = cli(['apply-edl', '--edl', list, '--out', cut], dir);
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(probeSquareSize(cut), { width: 360, height: 640, sar: 1 });
  assert.ok(meanDiff(lumaFrames(cut, 360, 640)[0], upright) < 2, 'the cut shows the phone clip upright');
});

/** An EDL beside its sources. */
function edl(dir: string, name: string, sources: Record<string, string>, ranges: { source: string; start: number; end: number }[]): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ sources, ranges }));
  return file;
}

test('apply-edl: a range from a source of another shape is cut around its faces on the range\'s own clock, or letterboxed when asked', () => {
  const dir = scratchDir('shape-apply-edl');
  // A cut at 3 s, and a range across it from 2.5 s, which the input is opened for at 1 s.
  const talk = squareClip(join(dir, 'talk.mp4'), { seconds: 4, cut: 3 });
  squareFaces(dir, talk, { cut: 3 });
  const tall = rampClip(dir, 'tall.mp4', '360x640', 2);
  // The portrait source comes first and sets the canvas.
  const list = edl(dir, 'edl.json', { a: tall, b: talk }, [{ source: 'a', start: 0, end: 0.5 }, { source: 'b', start: 2.5, end: 3.5 }]);
  const out = join(dir, 'cut.mp4');
  const r = cli(['apply-edl', '--edl', list, '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /source "b" \(640x360\) is cut to the canvas's shape \(360x640\) around its faces \(.*faces\.json\), as reframe cuts it/);
  const frames = lumaFrames(out, 360, 640);
  assert.equal(frames.length, 45);
  assert.deepEqual(squareMisses(frames.slice(15), 360, 640, CUT_AREA), [], 'the crop changes place on the cut\'s frame, 15 frames into the range');

  const boxed = join(dir, 'boxed.mp4');
  const l = cli(['apply-edl', '--edl', list, '--out', boxed, '--fit', 'letterbox'], dir);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /source "b" \(640x360\) is letterboxed onto the canvas/);
  const box = lumaFrames(boxed, 360, 640);
  assert.deepEqual(squareMisses(box.slice(15), 360, 640, BOXED_AREA), []);
  assert.ok(box[20].subarray(0, 360 * 200).every((v) => v < 20), 'black above the whole picture');
  const bad = cli(['apply-edl', '--edl', list, '--out', boxed, '--fit', 'stretch'], dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--fit expects crop or letterbox, got "stretch"/);
});

test('apply-edl: boxes found on this clip before it was replaced are refused, naming every way out, before anything is encoded', () => {
  const dir = scratchDir('shape-apply-edl-stale');
  const talk = squareClip(join(dir, 'talk.mp4'));
  squareFaces(dir, talk, { durationSec: 5 });
  const tall = rampClip(dir, 'tall.mp4', '360x640', 2);
  const out = join(dir, 'x.mp4');
  const r = cli(['apply-edl', '--edl', edl(dir, 'edl.json', { a: tall, b: talk }, [{ source: 'a', start: 0, end: 0.5 }, { source: 'b', start: 0.5, end: 1.5 }]), '--out', out], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds the faces of .*talk\.mp4 \(640x360, 5\.000 s\), not of .*talk\.mp4 \(640x360, 2\.000 s\): run faces on source "b" again, or assemble with --fit letterbox/);
});

test('veed-project: an EDL source of another shape than the canvas is named, since the editor frames it its own way', () => {
  const dir = scratchDir('shape-veed-project');
  const talk = squareClip(join(dir, 'talk.mp4'));
  const tall = rampClip(dir, 'tall.mp4', '360x640', 2);
  edl(dir, 'edl.json', { a: tall, b: talk }, [{ source: 'a', start: 0, end: 0.5 }, { source: 'b', start: 0.5, end: 1.5 }]);
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify({ name: 'p', width: 360, height: 640, duration: 1.5, parts: [{ type: 'edl', file: 'edl.json' }] }));
  // --local makes nothing in VEED: the plan's files are only read.
  const r = cli(['veed-project', plan, '--local', '--work', join(dir, 'veed')], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /source "b" of edl\.json is 640x360, another shape than the 360x640 canvas: the editor lays its ranges full-canvas and frames them its own way, not cut as apply-edl cuts them; reframe it to the canvas's shape first/);
  assert.doesNotMatch(r.stderr, /source "a"/, 'a source in the canvas\'s shape is not named');
});

test('concat-videos: boxes left under a clip\'s name by a file no longer there are named, with the way out, not passed over', () => {
  const dir = scratchDir('shape-moved');
  const before = squareClip(join(dir, 'old', 'talk.mp4'));
  squareFaces(dir, before);
  // The clip is moved after faces ran on it: its boxes still name the old path.
  const moved = join(dir, 'new', 'talk.mp4');
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(before, moved);
  const r = cli(['concat-videos', '--canvas', '360x640', join(dir, 'x.mp4'), moved, rampClip(dir, 'tall.mp4', '360x640')], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runs.talk.faces-[0-9a-f]{8}.faces\.json holds the faces of .*old.talk\.mp4, which is no longer there: if .*new.talk\.mp4 is that clip moved, run faces on .*new.talk\.mp4, or join with --fit letterbox/);
});

test('concat-videos: boxes left by another camera\'s file of the same name, now gone, are passed over with a line', () => {
  const dir = scratchDir('shape-gone');
  // A card's talk.mp4, faced and then taken out; a different talk.mp4 of another length comes in later.
  const card = squareClip(join(dir, 'card', 'talk.mp4'));
  squareFaces(dir, card);
  renameSync(card, join(dir, 'card', 'elsewhere.mp4'));
  const other = squareClip(join(dir, 'other', 'talk.mp4'), { seconds: 3 });
  const r = cli(['concat-videos', '--canvas', '360x640', join(dir, 'x.mp4'), other, rampClip(dir, 'tall.mp4', '360x640')], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /talk\.mp4 \(640x360\) is cut to the canvas's shape \(360x640\) from the middle, as reframe cuts it: no face boxes for it \(faces writes them\); .*runs.talk.faces-[0-9a-f]{8}.faces\.json holds another clip's and is not used/);
});

const noDetector = missingDetector();
if (noDetector && process.env.OPENEDIT_REQUIRE_MEDIAPIPE) throw new Error(`${noDetector}, and OPENEDIT_REQUIRE_MEDIAPIPE is set`);
const detect = noDetector ? `${noDetector} (openedit install-mediapipe)` : false;

test('concat-videos: the talking-head fixture joined with a portrait clip into 9:16 shows one whole face on every sampled frame', { skip: detect }, async () => {
  const dir = scratchDir('shape-concat-fixture');
  const options = { every: 1, threshold: 10, confidence: 0.5, margin: 0.25 };
  // The fixture under two folders, found at the same time, as two cameras' cards with the same file names are.
  const [a, b] = ['a', 'b'].map((name) => {
    const file = join(dir, name, 'talking-head.mp4');
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(FIXTURE, file);
    return file;
  });
  const runs = await Promise.all([a, b].map((file) => new Promise<{ err: string; folder: string }>((done, fail) => {
    execFile(process.execPath, ['--import', 'tsx', CLI, 'faces', file, '--json'], { env: { ...process.env, OPEN_EDIT_ROOT: dir }, maxBuffer: 1 << 26 },
      (error, _out, err) => (error ? fail(error) : done({ err, folder: dirname(/wrote (\S+faces\.json)/.exec(err)![1]) })));
  })));
  assert.notEqual(runs[0].folder, runs[1].folder, 'each run said where it wrote, and they wrote apart');
  runs.forEach((run, i) => assert.equal(JSON.parse(readFileSync(join(run.folder, 'faces.json'), 'utf8')).video, [a, b][i]));
  const out = join(dir, 'joined.mp4');
  const r = cli(['concat-videos', '--canvas', '360x640', out, a, b, rampClip(dir, 'tall.mp4', '360x640')], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/talking-head\.mp4 \(640x360\) is cut to the canvas's shape \(360x640\) around its faces/g)?.length, 2, r.stdout);
  // The fixture's two parts only: the join is 30 fps, and the ramp begins after 20 s of them.
  const length = probeVideoSpan(FIXTURE).end;
  const found = findFaces(out, options);
  const samples = found.shots.flatMap((shot) => shot.samples).filter((s) => s.sec < 2 * length - 0.1);
  assert.ok(samples.length >= 20, `${samples.length} sampled frames`);
  for (const s of samples) {
    assert.equal(s.faces.length, 1, `${s.sec}s: ${s.faces.length} faces in the join`);
    const [f] = s.faces;
    assert.ok(f.x > 0 && f.x + f.w < found.width, `${s.sec}s: the face ${f.x}-${f.x + f.w} touches the edge of the ${found.width} px frame`);
  }
});
