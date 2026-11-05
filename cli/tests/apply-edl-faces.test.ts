// apply-edl writes the cut's faces from its sources', where faces would write the cut's. Real encodes, because the
// boxes have to land where the cut's own frames show the faces, which only a cut that was made and looked at again
// can say. MediaPipe runs on the talking-head fixture when it is installed, and is skipped otherwise unless
// OPENEDIT_REQUIRE_MEDIAPIPE is set.
//   Run:  node --import tsx tests/apply-edl-faces.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { findFaces, notFacesOf, readFaces } from '../src/commands/faces.ts';
import { facesFolder, facesPathFor, ownFaces } from '../src/faces/folder.ts';
import { missingDetector } from '../src/faces/mediapipe.ts';
import { facesApi, type FaceBox, type FacesClip, type Rect, type Shot } from '../src/faces/page-script.ts';
import { probeSquareSize, probeVideoSpan } from '../src/probe.ts';
import { writeAtomic } from '../src/providers/exclusive-files.ts';
import { brightBox, stubDetector } from './helpers/face-stub.ts';
import { SINE, captureConsoleAsync, scratchDir, synthClip } from './helpers/synth.ts';

const root = scratchDir('edl-faces');
// Paths go into a pattern as written: a Windows path's backslashes would otherwise read as escapes.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The workspace every faces folder is found under, for the whole file.
process.env.OPEN_EDIT_ROOT = root;
const inputs = join(root, 'inputs');
mkdirSync(inputs, { recursive: true });
mkdirSync(join(root, 'runs', 'piece'), { recursive: true });

let n = 0;
async function cut(edl: object, out: string, flags: string[] = []): Promise<string> {
  const path = join(root, 'runs', 'piece', `edl-${n++}.json`);
  writeFileSync(path, JSON.stringify(edl));
  const { out: log } = await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out, ...flags]));
  return log;
}

/** The boxes in `video`'s own faces folder, found as every reader finds them, and checked to be that clip's as it is now. */
function facesOf(video: string): FacesClip {
  const path = ownFaces(video);
  assert.equal(path, facesPathFor(video), `no faces where faces writes them for ${video}`);
  const clip = readFaces(path!);
  assert.equal(notFacesOf(clip, video, probeSquareSize(video), probeVideoSpan(video).end), null);
  return clip;
}

const box = (i: number): FaceBox => ({ x: 10 + 100 * i, y: 20, w: 50, h: 60, score: 0.9 });
const [A, B, C, D, E, F] = [0, 1, 2, 3, 4, 5].map(box);

const durationOf = (video: string) => probeVideoSpan(video).end;
const known = synthClip(inputs, 'known.mp4', { video: 'testsrc=size=640x360:rate=25', audio: SINE, seconds: 4 });
const plain = synthClip(inputs, 'plain.mp4', { video: 'testsrc=size=640x360:rate=25', audio: SINE, seconds: 2 });
const backdrop = synthClip(inputs, 'backdrop.mp4', { video: 'color=c=0x202020:s=360x640:r=25', audio: SINE, seconds: 2 });
/** Two shots, cut at 2 s, each sampled three times, every sample's one box told apart by where it is. */
const knownFaces = (video: string): FacesClip => ({
  video, name: 'known.mp4', width: 640, height: 360, fps: 25, frameRate: '25', durationSec: durationOf(video),
  model: 'blaze_face_full_range', every: 0.5, threshold: 10, confidence: 0.5, textMargin: 0.25,
  shots: [
    { start: 0, end: 2, samples: [{ sec: 0.5, faces: [A] }, { sec: 1, faces: [B] }, { sec: 1.5, faces: [C] }] },
    { start: 2, end: durationOf(video), samples: [{ sec: 2.5, faces: [D] }, { sec: 3, faces: [E] }, { sec: 3.5, faces: [F] }] },
  ],
});
writeAtomic(facesPathFor(known), knownFaces(known));

/** Out of the page helpers' own realm, where arrays are another Array. */
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const roundedEnds = (shots: Shot[]) => shots.map((s) => ({ ...s, end: Math.round(s.end * 1e3) / 1e3 }));

await test('a cut of ranges from a clip with known boxes holds each box at its time on the cut, a sped range\'s scaled', async () => {
  const out = join(root, 'runs', 'piece', 'known-cut.mp4');
  const log = await cut({
    sources: { known, plain },
    ranges: [
      { source: 'known', start: 1, end: 3 },
      { source: 'known', start: 0.4, end: 1.2, speed: 0.5 },
      { source: 'plain', start: 0, end: 1 },
      { source: 'known', start: 1.92, end: 2.6 },
    ],
  }, out);
  const clip = facesOf(out);
  assert.equal(clip.video, out);
  assert.match(log, new RegExp(`the cut's faces, its sources' boxes moved onto it -> ${escaped(join(facesFolder(out), 'faces.js'))}`));
  assert.match(log, /faces has not run on source "plain", so the cut's faces over its range\(s\) 2 \(3\.60-4\.60s\) are unknown/);
  assert.ok(existsSync(join(facesFolder(out), 'faces.js')));
  assert.deepEqual(roundedEnds(clip.shots), [
    // 1-3 s at 1x from 0 s: the source's cut at 2 s lands at 1 s, and the sample on the range's out-point is not played.
    { start: 0, end: 1, samples: [{ sec: 0, faces: [B] }, { sec: 0.5, faces: [C] }] },
    { start: 1, end: 2, samples: [{ sec: 1.5, faces: [D] }] },
    // 0.4-1.2 s at half speed from 2 s: each second of the source plays two.
    { start: 2, end: 3.6, samples: [{ sec: 2.2, faces: [A] }, { sec: 3.2, faces: [B] }] },
    // No boxes for its source: unknown, not without a face.
    { start: 3.6, end: 4.6, samples: [], unknown: true },
    // Two frames of the first shot that hold no sample take its nearest, so they do not read as faceless.
    { start: 4.6, end: 4.68, samples: [{ sec: 4.6, faces: [C] }] },
    { start: 4.68, end: 5.28, samples: [{ sec: 5.18, faces: [D] }] },
  ]);
  assert.ok(!JSON.stringify(clip.shots).includes(JSON.stringify(E)) && !JSON.stringify(clip.shots).includes(JSON.stringify(F)));
  assert.equal(clip.textMargin, 0.25);
  // What place() keeps text off at 0.7 s of the cut is the source's at 1.7 s.
  assert.deepEqual(json(facesApi(clip).boxes(0.7)), json(facesApi(knownFaces(known)).boxes(1.7)));
});

await test('a source of another shape: its boxes are moved through the letterbox apply-edl pads it into', async () => {
  const tall = synthClip(inputs, 'tall.mp4', { video: 'testsrc=size=360x640:rate=25', audio: SINE, seconds: 2 });
  const face = { x: 90, y: 100, w: 180, h: 180, score: 0.8 };
  writeAtomic(facesPathFor(tall), {
    ...knownFaces(known), video: tall, name: 'tall.mp4', width: 360, height: 640, durationSec: durationOf(tall),
    shots: [{ start: 0, end: durationOf(tall), samples: [{ sec: 0.5, faces: [face] }] }],
  });
  const out = join(root, 'runs', 'piece', 'boxed.mp4');
  await cut({ sources: { known, tall }, ranges: [{ source: 'known', start: 0, end: 1 }, { source: 'tall', start: 0, end: 1 }] }, out, ['--fit', 'letterbox']);
  const shots = facesOf(out).shots;
  // 360x640 fitted whole into 640x360: scaled by 360/640 and centred, 218.75 px in from the left.
  assert.deepEqual(shots.at(-1)!.samples, [{ sec: 1.5, faces: [{ x: 269, y: 56, w: 101, h: 101, score: 0.8 }] }]);
});

await test('with no boxes for any source nothing is written, and those found on the file the cut replaced are removed', async () => {
  const out = join(root, 'runs', 'piece', 'known-cut.mp4');
  const dir = facesFolder(out);
  assert.ok(existsSync(join(dir, 'faces.json')));
  // Boxes found on another file than the source is now are not used either.
  writeAtomic(facesPathFor(plain), { ...knownFaces(known), video: plain, durationSec: 9 });
  const log = await cut({ sources: { plain }, ranges: [{ source: 'plain', start: 0, end: 1 }] }, out);
  assert.match(log, new RegExp(`no faces of the cut were written: source "plain"'s face boxes are not used: [^\\n]*holds the faces of ${escaped(plain)} \\(640x360, 9\\.000 s\\)`));
  assert.match(log, new RegExp(`the boxes in ${escaped(dir)}, found on the file this cut replaced, are removed`));
  assert.ok(!existsSync(join(dir, 'faces.json')) && !existsSync(join(dir, 'faces.js')));
});

const OPTIONS = { every: 0.25, threshold: 10, confidence: 0.5, margin: 0 };
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });
const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/**
 * Faces run on the cut against the boxes apply-edl moved onto it: every shot faces finds starts where one of the
 * moved shots does, and every face it finds lies within what place() would keep text off at that moment, which is
 * the moved samples on either side of it, no more than `slack` pixels out and no more than `wider` times its area.
 */
function assertAsFound(found: FacesClip, moved: FacesClip, slack: number, wider: number): void {
  const frame = 1.5 / found.fps;
  for (const shot of found.shots.slice(1)) {
    assert.ok(moved.shots.some((s) => Math.abs(s.start - shot.start) <= frame), `faces finds a shot at ${shot.start} s that the moved boxes do not start`);
  }
  const api = facesApi(moved);
  for (const sample of found.shots.flatMap((s) => s.samples)) {
    const kept = api.boxes(sample.sec);
    if (!sample.faces.length) {
      assert.equal(kept.length, 0, `no face at ${sample.sec} s, but the moved boxes keep text off ${JSON.stringify(kept)}`);
      continue;
    }
    for (const face of sample.faces) {
      const around = kept.find((k) => inside(face, grow(k, slack)));
      assert.ok(around, `the face at ${sample.sec} s, ${JSON.stringify(face)}, is not within the moved boxes ${JSON.stringify(kept)}`);
      assert.ok(around.w * around.h <= wider * face.w * face.h, `at ${sample.sec} s the moved box ${JSON.stringify(around)} is far larger than the face ${JSON.stringify(face)}`);
    }
  }
}

await test('faces run on the cut finds its faces where apply-edl moved them, through a crop that follows them, a letterbox and both speeds', async () => {
  // A white square for a face, moving right at 30 px/s, on black, then on grey and lower after a cut at 3 s.
  const mover = synthClip(inputs, 'mover.mp4', {
    video: 'color=c=black:s=640x360:r=25:d=3[a];color=c=0x606060:s=640x360:r=25:d=3[b];[a][b]concat=n=2:v=1:a=0[bg];' +
      'color=c=white:s=60x60:r=25:d=6[sq];[bg][sq]overlay=x=\'100+30*t\':y=\'if(lt(t,3),120,200)\':shortest=1',
    audio: SINE, seconds: 6,
  });
  const detector = stubDetector((_, path) => brightBox(path));
  for (const video of [mover, backdrop]) writeAtomic(facesPathFor(video), findFaces(video, OPTIONS, detector));
  const edl = {
    sources: { backdrop, mover },
    ranges: [
      { source: 'backdrop', start: 0, end: 1 },
      { source: 'mover', start: 1, end: 4 },
      { source: 'mover', start: 4, end: 5, speed: 0.5 },
      { source: 'mover', start: 0.5, end: 1.5, speed: 2 },
    ],
  };
  for (const fit of ['crop', 'letterbox']) {
    const out = join(root, 'runs', 'piece', `mover-${fit}.mp4`);
    const log = await cut(edl, out, ['--fit', fit]);
    if (fit === 'crop') assert.match(log, /source "mover" \(640x360\) is cut to the canvas's shape \(360x640\) around its faces/);
    // A range's first frames come before its first sample, by half a step of the source's: the square moves up to
    // 30 x 0.125 px of the source from there, 6.7 px on the 9:16 canvas.
    const found = findFaces(out, OPTIONS, detector);
    // The join onto the square at 1 s, the source's own cut at 3 s and the join from grey back to black at 6 s.
    assert.deepEqual(found.shots.map((shot) => shot.start), [0, 1, 3, 6]);
    assertAsFound(found, facesOf(out), 8, 1.6);
  }
});

const FIXTURE = fileURLToPath(new URL('./fixtures/talking-head.mp4', import.meta.url));
const noDetector = missingDetector();
if (noDetector && process.env.OPENEDIT_REQUIRE_MEDIAPIPE) throw new Error(`${noDetector}, and OPENEDIT_REQUIRE_MEDIAPIPE is set`);

await test('on the talking-head fixture, MediaPipe finds each speaker on the cut where apply-edl moved their boxes', { skip: noDetector ? `${noDetector} (openedit install-mediapipe)` : false }, async () => {
  const options = { ...OPTIONS, margin: 0.25 };
  writeAtomic(facesPathFor(FIXTURE), findFaces(FIXTURE, options));
  const backdrop = synthClip(inputs, 'backdrop-ntsc.mp4', { video: 'color=c=0x202020:s=360x640:r=30000/1001', audio: SINE, seconds: 2 });
  const out = join(root, 'runs', 'piece', 'interview.mp4');
  // Cut to the backdrop's 9:16 around the speakers, across both of the fixture's cuts, at both speeds.
  await cut({
    sources: { backdrop, th: FIXTURE },
    ranges: [
      { source: 'backdrop', start: 0, end: 1 },
      { source: 'th', start: 1, end: 4 },
      { source: 'th', start: 7.5, end: 9, speed: 0.5 },
      { source: 'th', start: 4.5, end: 6.5, speed: 2 },
    ],
  }, out);
  const moved = facesOf(out);
  const found = findFaces(out, options);
  // The detector's own box for one face changes size with the picture's scale, so it is matched by overlap.
  const overlap = (a: Rect, b: Rect) => {
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (w * h) / (a.w * a.h + b.w * b.h - w * h);
  };
  let compared = 0;
  // The backdrop's second has no boxes moved onto it: faces never ran on it.
  for (const sample of found.shots.flatMap((s) => s.samples).filter((x) => x.sec >= 1)) {
    const shot = moved.shots.find((s) => s.start <= sample.sec && sample.sec < s.end)!;
    const near = shot.samples.reduce((a, b) => (Math.abs(b.sec - sample.sec) < Math.abs(a.sec - sample.sec) ? b : a));
    assert.equal(sample.faces.length, 1);
    assert.ok(overlap(sample.faces[0], near.faces[0]) >= 0.7, `at ${sample.sec} s faces finds ${JSON.stringify(sample.faces[0])} and the moved box is ${JSON.stringify(near.faces[0])}`);
    compared++;
  }
  assert.ok(compared >= 20, `only ${compared} samples compared`);
});
