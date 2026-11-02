// The reframe command: the crop's shape, the path it follows through each shot, the encoded clip (on a
// generated gradient, so it runs everywhere), and, when MediaPipe is installed (`openedit
// install-mediapipe`), the talking-head fixture cut to 9:16 around its faces. Without MediaPipe those
// are skipped, unless OPENEDIT_REQUIRE_MEDIAPIPE is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFaces } from '../src/commands/faces.ts';
import { cropFor, cropMoves, cropTrack, holdsFor, oneFace, parseAspect, partsOf, pathThrough, sendcmdScript, stillPlace, type Crop } from '../src/commands/reframe.ts';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { missingDetector } from '../src/faces/mediapipe.ts';
import type { FaceBox, FacesClip, Shot } from '../src/faces/page-script.ts';
import { rotatedCopy, scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/talking-head.mp4', import.meta.url));
const OPTIONS = { every: 1, threshold: 10, confidence: 0.5, margin: 0.25 };

/** One shot whose samples, a second apart from 0.5 s in, show these faces. */
const shotOf = (start: number, faces: FaceBox[][]): Shot => ({
  start, end: start + faces.length, samples: faces.map((f, i) => ({ sec: start + i + 0.5, faces: f })),
});
const face = (x: number, y = 100, w = 100, h = 100): FaceBox => ({ x, y, w, h });
const clipOf = (shots: Shot[], over: Partial<FacesClip> = {}): FacesClip => ({
  video: '/c.mp4', name: 'c.mp4', width: 1920, height: 1080, fps: 30, frameRate: '30', durationSec: shots.at(-1)!.end,
  model: 'blaze_face_full_range', every: 1, threshold: 10, confidence: 0.5, textMargin: 0.25, shots, ...over,
});
const NINE_BY_SIXTEEN: Crop = cropFor(1920, 1080, 9 / 16);
const reframe = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, 'reframe', ...args], { encoding: 'utf8' });

test('reframe: the crop is the largest of that shape, on even pixels, along the axis that has room', () => {
  assert.equal(parseAspect('9:16'), 9 / 16);
  assert.equal(parseAspect('1x1'), 1);
  assert.throws(() => parseAspect('tall'), /--aspect wants W:H/);
  assert.deepEqual(cropFor(1920, 1080, 9 / 16), { w: 606, h: 1080, axis: 'x', travel: 1314 });
  assert.deepEqual(cropFor(640, 360, 9 / 16), { w: 202, h: 360, axis: 'x', travel: 438 });
  assert.deepEqual(cropFor(1080, 1920, 16 / 9), { w: 1080, h: 606, axis: 'y', travel: 1314 });
  assert.equal(cropFor(1920, 1080, 16 / 9).travel, 0);
  // Within the two pixels even sides round to, a clip is already in the shape: a reframe's own 9:16 of 1080p.
  assert.deepEqual(cropFor(606, 1080, 9 / 16), { w: 606, h: 1080, axis: 'y', travel: 0 });
  assert.deepEqual(cropFor(203, 360, 9 / 16), { w: 202, h: 360, axis: 'x', travel: 0 });
  assert.deepEqual(cropFor(604, 1080, 9 / 16), { w: 604, h: 1072, axis: 'y', travel: 8 }, 'beyond the rounding it is cut');
});

test('reframe: a face that stays inside the crop gets one still hold, centred on it', () => {
  // Detection noise of a few pixels from sample to sample, which a crop that chased it would turn into shake.
  const holds = holdsFor(shotOf(0, [[face(900)], [face(904)], [face(897, 103)], [face(902)]]), NINE_BY_SIXTEEN, 0.25);
  assert.equal(holds.length, 1);
  assert.deepEqual([holds[0].from, holds[0].to], [0.5, 3.5]);
  assert.equal(holds[0].at, 648, 'the mean face centre, 950.75, less half the crop, on an even pixel');
});

test('reframe: between two places the crop eases in and out, with no jolt at either end', () => {
  const holds = [{ from: 0.5, to: 1.5, at: 0 }, { from: 2.5, to: 3.5, at: 900 }];
  const [a, b] = holds;
  const at = pathThrough(holds, 0);
  const frame = 1 / 30;
  assert.equal(at(a.to), a.at);
  assert.equal(at(b.from), b.at);
  const mid = (a.to + b.from) / 2;
  const vMid = at(mid + frame) - at(mid);
  const vStart = at(a.to + frame) - at(a.to);
  const vEnd = at(b.from) - at(b.from - frame);
  assert.ok(Math.abs(vStart) < Math.abs(vMid) / 10 && Math.abs(vEnd) < Math.abs(vMid) / 10,
    `the pan starts and ends slowly (${vStart.toFixed(2)} and ${vEnd.toFixed(2)} px a frame, against ${vMid.toFixed(2)} mid-way)`);
  for (let t = a.to; t < b.from; t += frame) assert.ok(at(t + frame) >= at(t) - 1e-9, 'the pan never turns back');
});

test('reframe: a move between two places takes a second even when the samples are a quarter second apart', () => {
  // Two holds sampled four times a second, the second starting one sample after the first ends.
  const holds = [{ from: 0.125, to: 1.875, at: 0 }, { from: 2.125, to: 3.875, at: 400 }];
  const at = pathThrough(holds, 0);
  const frame = 1 / 30;
  const times = Array.from({ length: 120 }, (_, n) => n * frame);
  const leaves = times.find((t) => at(t) !== 0)!;
  const arrives = times.find((t) => at(t) === 400)!;
  assert.ok(arrives - leaves >= 1 - frame, `the move lasts ${(arrives - leaves).toFixed(2)} s`);
  assert.ok(Math.abs(leaves + arrives - 4) / 2 < frame, 'centred on the gap between the holds');
  for (const t of times.slice(1)) assert.ok(at(t) - at(t - frame) <= 400 * 1.5 / 30 + 1e-9, 'no faster than a one-second ease');
});

test('reframe: a face moving steadily one way gets one even pan, not a stop at every sample', () => {
  // A 202 px crop of a 640 px clip, and a 100 px face that moves 90 px a second: no place keeps two
  // samples in frame, so every sample is a hold of its own.
  const holds = holdsFor(shotOf(0, [0, 1, 2, 3, 4].map((i) => [face(20 + 90 * i)])), cropFor(640, 360, 9 / 16), 0.25);
  assert.deepEqual(holds.map((h) => h.at), [0, 60, 150, 240, 330]);
  const at = pathThrough(holds, 0);
  const steps: number[] = [];
  for (let t = holds[1].from; t < holds[3].from; t += 1 / 30) steps.push(at(t + 1 / 30) - at(t));
  const [slow, fast] = [Math.min(...steps), Math.max(...steps)];
  assert.ok(slow > fast / 2, `between the first and last samples the pan keeps its pace (${slow.toFixed(2)} to ${fast.toFixed(2)} px a frame)`);
});

/** A shot sampled every `every` seconds from half a step in. */
const sampledShot = (every: number, faces: FaceBox[][]): Shot => ({
  start: 0, end: every * faces.length, samples: faces.map((f, i) => ({ sec: every * (i + 0.5), faces: f })),
});
const EIGHT = [0, 1, 2, 3, 4, 5, 6, 7];

/** Where the crop is at each sample of a one-shot clip. */
const placesOf = (shot: Shot) => {
  const track = cropTrack(clipOf([shot]), NINE_BY_SIXTEEN);
  return shot.samples.map((x) => track(x.sec));
};
const framed = (f: FaceBox, at: number) => f.x >= at && f.x + f.w <= at + NINE_BY_SIXTEEN.w;

test('reframe: a shot shows one face only when no sample has two and each overlaps the one before', () => {
  assert.equal(oneFace(sampledShot(0.25, [[face(200)], [face(260)], [], [face(330)]])), true, 'a miss in between does not count');
  assert.equal(oneFace(sampledShot(1, [[face(200)], [face(200), face(900)]])), false);
  assert.equal(oneFace(sampledShot(1, [[face(200)], [face(900)]])), false, 'far from the last one: maybe someone else');
  assert.equal(oneFace(sampledShot(1, [[], []])), true);
});

test('reframe: two people found in turn, never together, hold one still crop', () => {
  const a = face(300, 100, 200, 200);
  const b = face(1300, 100, 200, 200);
  // Strict alternation, and a conversation in blocks of two: equal faces, so the first place along the axis, A's.
  for (const pattern of [EIGHT.map((i) => (i % 2 ? [b] : [a])), EIGHT.map((i) => (Math.floor(i / 2) % 2 ? [b] : [a]))]) {
    const places = placesOf(shotOf(0, pattern));
    assert.equal(new Set(places).size, 1, `one place all shot: ${places}`);
    assert.ok(framed(a, places[0]));
  }
  // In turn for a second each at four samples a second: long enough for a part, but each place comes back.
  const blocks = sampledShot(0.25, Array.from({ length: 32 }, (_, i) => (Math.floor(i / 4) % 2 ? [b] : [a])));
  assert.equal(partsOf(blocks).length, 1);
  assert.equal(new Set(placesOf(blocks)).size, 1);
});

test('reframe: a stranger found alone at the first sample does not open the shot on them', () => {
  const a = face(300, 100, 200, 200);
  const stranger = face(1400, 100, 120, 120);
  const places = placesOf(shotOf(0, EIGHT.map((i) => (i === 0 ? [stranger] : [a]))));
  assert.equal(new Set(places).size, 1);
  assert.ok(framed(a, places[0]), `A is framed from the start: ${places[0]}`);
});

test('reframe: one face pacing across the frame and back is followed, in frame at every sample', () => {
  // A 100 px face from 200 to 900 and back over 4 s, sampled four times a second: each step overlaps the last.
  const xs = [...Array.from({ length: 9 }, (_, i) => 200 + 87.5 * i), ...Array.from({ length: 8 }, (_, i) => 812.5 - 87.5 * i)];
  const shot = sampledShot(0.25, xs.map((x) => [face(Math.round(x))]));
  assert.equal(oneFace(shot), true);
  assert.equal(partsOf(shot).length, 1, 'a walk never splits the shot');
  placesOf(shot).forEach((at, i) => assert.ok(framed(shot.samples[i].faces[0], at), `${shot.samples[i].sec} s: face at ${xs[i]} outside the crop at ${at}`));
});

/** Four seconds of A alone, a dissolve showing both for `both` samples, four seconds of B alone, four a second. */
const dissolve = (both: number) => {
  const a = (i: number) => face(900 - 6 * i, 100, 380, 380);
  const b = (i: number) => face(400 + 3 * i, 120, 340, 340);
  return sampledShot(0.25, [
    ...Array.from({ length: 16 }, (_, i) => [a(i)]),
    ...Array.from({ length: both }, (_, i) => [a(16), b(i)]),
    ...Array.from({ length: 16 }, (_, i) => [b(i)]),
  ]);
};

test('reframe: a dissolve the shot detector missed splits the shot, and each lone face stays in frame', () => {
  const shot = dissolve(2);
  const parts = partsOf(shot);
  assert.equal(parts.length, 2);
  // At the middle of the jump, between the last lone A (3.875 s) and the first lone B (4.625 s).
  assert.equal(parts[1].start, 4.25);
  assert.deepEqual(parts.map((p) => p.samples.length), [16, 16], 'the samples showing both belong to neither part');
  const places = placesOf(shot);
  shot.samples.forEach((x, i) => {
    if (x.faces.length === 1) assert.ok(framed(x.faces[0], places[i]), `${x.sec} s: lone face outside the crop at ${places[i]}`);
  });
  // The crop changes once, at the split, like at a cut.
  assert.deepEqual(cropMoves(clipOf([shot]), NINE_BY_SIXTEEN, 30, shot.end).map((m) => m.sec), [0, 4.2495]);
});

test('reframe: two faces seen together for more than a second are two people in one shot, held still', () => {
  const shot = dissolve(6);
  assert.equal(partsOf(shot).length, 1);
  assert.equal(new Set(placesOf(shot)).size, 1);
});

test('reframe: a face found alone far off for less than a second is not a part of its own', () => {
  const a = face(300, 100, 200, 200);
  const far = face(1400, 100, 200, 200);
  // Three samples of the far face in the middle of A, then nothing comes back to it: still too short to split.
  const shot = sampledShot(0.25, Array.from({ length: 16 }, (_, i) => (i >= 6 && i < 9 ? [far] : [a])));
  assert.equal(partsOf(shot).length, 1);
});

test('reframe: in a shot with a bystander the crop holds where the most face is, and a face that runs off is not followed', () => {
  // A at 200 for 4 s, a bystander once, then a face at 1400 for 4 s: more than one face, so one still place.
  const a = face(200);
  const bystander = face(1600);
  const b = face(1400);
  const shot = shotOf(0, [[a], [a, bystander], [a], [a], [b], [b], [b], [b]]);
  const places = placesOf(shot);
  assert.equal(new Set(places).size, 1, 'no panning in a shot with more than one face');
  // 400 px of A against 400 of B plus 100 of the bystander, who fits beside B: B and the bystander.
  assert.ok(framed(b, places[0]) && framed(bystander, places[0]) && !framed(a, places[0]), `still place ${places[0]}`);
});

test('reframe: a big face passing for 2 s does not outweigh a presenter on screen all 8 s', () => {
  const presenter = face(200, 100, 200, 200);
  const passer = face(1300, 50, 500, 500);
  const shot = shotOf(0, EIGHT.map((i) => (i === 3 || i === 4 ? [presenter, passer] : [presenter])));
  // Heights: the presenter 8 x 200, the passer-by 2 x 500.
  assert.equal(stillPlace(shot, NINE_BY_SIXTEEN), 0);
  assert.ok(placesOf(shot).every((at) => framed(presenter, at)));
});

test('reframe: a tight two-shot whose larger face is missed once stays on it, sampled at the default four a second', () => {
  // A 300-600 (the larger), B 850-1100, too far apart for one crop; over 6 s A is missed once.
  const a = face(300, 100, 300, 300);
  const b = face(850, 100, 250, 250);
  const shot = sampledShot(0.25, Array.from({ length: 24 }, (_, i) => (i === 9 ? [b] : [a, b])));
  const places = placesOf(shot);
  assert.equal(new Set(places).size, 1);
  assert.ok(framed(a, places[0]), `A framed: ${places[0]}`);
});

test('reframe: a face found once in place of the presenter, far off, is not chased', () => {
  // The round-two case: A in every sample but one, where only B is found.
  const a = face(300, 100, 200, 200);
  const b = face(1400, 100, 120, 120);
  const places = placesOf(shotOf(0, EIGHT.map((i) => (i === 2 ? [b] : [a]))));
  assert.equal(new Set(places).size, 1);
  assert.ok(framed(a, places[0]));
});

test('reframe: a shot with no face between two shots with faces is cut from the middle', () => {
  const clip = clipOf([shotOf(0, [[face(200)], [face(200)]]), shotOf(2, [[], []]), shotOf(4, [[face(1500)], [face(1500)]])]);
  assert.deepEqual(cropMoves(clip, NINE_BY_SIXTEEN, 30, 6), [{ sec: 0, at: 0 }, { sec: 1.9995, at: 656 }, { sec: 3.9995, at: 1248 }]);
});

test('reframe: a face larger than the crop is centred, and a shot with no face is cut from the middle', () => {
  const holds = holdsFor(shotOf(0, [[face(700, 100, 800, 800)]]), NINE_BY_SIXTEEN, 0.25);
  assert.equal(holds[0].at, 798, 'face centre 1100 less half the crop, 797, on an even pixel');
  assert.equal(pathThrough([], 656)(3), 656);
  assert.deepEqual(cropMoves(clipOf([shotOf(0, [[], []])]), NINE_BY_SIXTEEN, 30, 2), [{ sec: 0, at: 656 }]);
});

test('reframe: a tall clip cut wider moves the crop down, with the face a third of the way down it', () => {
  const crop = cropFor(1080, 1920, 16 / 9);
  const holds = holdsFor(shotOf(0, [[{ x: 400, y: 600, w: 200, h: 200 }]]), crop, 0.1);
  assert.equal(holds[0].at, 498, 'face centre 700 less a third of the 606 px crop');
  const moves = cropMoves(clipOf([shotOf(0, [[{ x: 400, y: 600, w: 200, h: 200 }]])], { width: 1080, height: 1920 }), crop, 30, 1);
  assert.equal(sendcmdScript(moves, crop.axis), '0.000000 crop y 498;\n');
});

test('reframe: the crop is still within each shot and changes place just before a cut\'s first frame', () => {
  const clip = clipOf([shotOf(0, [[face(200)], [face(203)]]), shotOf(2, [[face(1500)], [face(1497)], [face(1502)]])]);
  assert.deepEqual(cropMoves(clip, NINE_BY_SIXTEEN, 30, 5), [{ sec: 0, at: 0 }, { sec: 1.9995, at: 1246 }]);
  // faces stores a cut at its first frame's time, 6.973633 s for frame 209 at 30000/1001: that frame must get
  // the new place and frame 208 the old one, whatever the frame rate.
  const late = clipOf([shotOf(0, [[face(200)]]), { ...shotOf(6.973633, [[face(1500)]]), start: 6.973633 }]);
  const track = cropTrack(late, NINE_BY_SIXTEEN);
  const moves = cropMoves(late, NINE_BY_SIXTEEN, 30000 / 1001, 8);
  const shown = (pts: number) => moves.filter((m) => m.sec <= pts).at(-1)!.at;
  assert.equal(shown(209 * 1001 / 30000), track(7));
  assert.equal(shown(208 * 1001 / 30000), track(1));
  assert.notEqual(track(7), track(1));
});

test('reframe: it refuses face boxes it was named but cannot find, or found on another clip or another cut of it', () => {
  const dir = scratchDir('reframe-refuse');
  const run = (faces: string) => reframe([FIXTURE, '--aspect', '9:16', '--faces', faces, '--out', join(dir, 'o.mp4')]);
  const none = run(join(dir, 'missing.json'));
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no face boxes at .*missing\.json: run npx @veedstudio\/openedit-cli faces .* first, or leave out --faces to cut from the middle/);
  writeFileSync(join(dir, 'other.json'), JSON.stringify(clipOf([shotOf(0, [[face(10)]])])));
  const other = run(join(dir, 'other.json'));
  assert.equal(other.status, 1);
  assert.match(other.stderr, /holds the faces of \/c\.mp4 \(1920x1080, 1\.000 s\), not of .*talking-head\.mp4 \(640x360, 10\.010 s\): run faces on .* again, or name its faces\.json with --faces/);
  const same = { width: 640, height: 360, video: FIXTURE };
  writeFileSync(join(dir, 'shorter.json'), JSON.stringify(clipOf([shotOf(0, [[face(10)], [face(10)]])], same)));
  const shorter = run(join(dir, 'shorter.json'));
  assert.equal(shorter.status, 1);
  assert.match(shorter.stderr, /\(640x360, 2\.000 s\), not of .*\(640x360, 10\.010 s\)/);
  // Same size and length, another file: a/output.mp4 and b/output.mp4 are not the same clip.
  writeFileSync(join(dir, 'twin.json'), JSON.stringify(clipOf([{ ...shotOf(0, [[face(10)]]), end: 10.01 }], { ...same, video: '/elsewhere/talking-head.mp4', durationSec: 10.01 })));
  const twin = run(join(dir, 'twin.json'));
  assert.equal(twin.status, 1);
  assert.match(twin.stderr, /holds the faces of \/elsewhere\/talking-head\.mp4/);
});

/** A 2 s 640x360 clip whose brightness rises left to right, so a crop's left column says where the crop was. */
function gradient(dir: string): string {
  const src = join(dir, 'gradient.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=2', '-vf', 'geq=lum=X*255/W:cb=128:cr=128',
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
  return src;
}

/** The mean stored luma of column 2 of each frame of a 202x360 clip. */
function leftColumns(video: string): number[] {
  // The luma plane as stored, so no range conversion moves the values.
  const y = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-vf', 'extractplanes=y', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const [w, h] = [202, 360];
  assert.equal(y.length % (w * h), 0, 'frames 202x360');
  return Array.from({ length: y.length / (w * h) }, (_, n) => {
    let sum = 0;
    for (let row = 0; row < h; row++) sum += y[n * w * h + row * w + 2];
    return sum / h;
  });
}

test('reframe: the encoded clip shows the crop each shot\'s face asked for, switching on the cut', () => {
  const dir = scratchDir('reframe-gradient');
  const src = gradient(dir);
  // A face on the left for the first second, on the right after the cut at 1 s.
  const clip = clipOf([
    { start: 0, end: 1, samples: [{ sec: 0.5, faces: [{ x: 40, y: 100, w: 60, h: 60 }] }] },
    { start: 1, end: 2, samples: [{ sec: 1.5, faces: [{ x: 540, y: 100, w: 60, h: 60 }] }] },
  ], { width: 640, height: 360, durationSec: 2, video: src });
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(clip));
  const out = join(dir, 'tall.mp4');
  const r = reframe([src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const left = leftColumns(out);
  assert.equal(left.length, 60);
  // Before the cut the crop sits at 0 (source column 2 is near black); from frame 30 at 438, where the
  // source is 438/640 of full brightness, about 175.
  for (const n of [0, 15, 29]) assert.ok(left[n] < 12, `frame ${n}: ${left[n].toFixed(1)}, expected near black`);
  for (const n of [30, 45, 59]) assert.ok(Math.abs(left[n] - 175) < 10, `frame ${n}: ${left[n].toFixed(1)}, expected about 175`);
});

test('reframe: with no face boxes it cuts the whole clip from the middle, and says so', () => {
  const dir = scratchDir('reframe-middle');
  const src = gradient(dir);
  const out = join(dir, 'tall.mp4');
  // A workspace of its own, so no faces.json waits at the default place.
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'reframe', src, '--aspect', '9:16', '--out', out],
    { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no face boxes for .*gradient\.mp4 \(faces writes them\), so the crop is cut from the middle/);
  // The middle of 438 px of travel, on an even pixel, is 218: column 2 is source column 220, 220/640 bright.
  for (const [n, v] of leftColumns(out).entries()) assert.ok(Math.abs(v - 88) < 8, `frame ${n}: ${v.toFixed(1)}, expected about 88`);
});

const run = (args: string[], root: string) =>
  spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: root } });
const streamOf = (file: string) => execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name,width,height,nb_frames:stream_side_data=rotation', '-of', 'json', file], { encoding: 'utf8' });

test('reframe: its own output reframed again to the same shape is already in it, and an odd side loses one pixel', () => {
  const dir = scratchDir('reframe-again');
  const tall = join(dir, 'tall.mp4');
  assert.equal(run(['reframe', gradient(dir), '--aspect', '9:16', '--out', tall], dir).status, 0);
  const again = join(dir, 'again.mp4');
  const r = run(['reframe', tall, '--aspect', '9:16', '--out', again], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is already 9:16 \(202x360\), so it is re-encoded upright, uncropped/);
  assert.doesNotMatch(r.stdout, /no face boxes/);
  assert.deepEqual([JSON.parse(streamOf(again)).streams[0].width, JSON.parse(streamOf(again)).streams[0].height], [202, 360]);
  // 203x360 is 9:16 to within the rounding; H.264 wants even sides, so its last column goes.
  const odd = join(dir, 'odd.mkv');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=203x360:r=30:d=1', '-c:v', 'ffv1', odd]);
  const evened = join(dir, 'evened.mp4');
  const o = run(['reframe', odd, '--aspect', '9:16', '--out', evened], dir);
  assert.equal(o.status, 0, o.stderr);
  assert.match(o.stdout, /is already 9:16 \(203x360\), so it is re-encoded upright, to even pixels \(202x360\)/);
  const stream = JSON.parse(streamOf(evened)).streams[0];
  assert.deepEqual([stream.codec_name, stream.width, stream.height], ['h264', 202, 360]);
});

test('reframe: a clip already in the asked shape is re-encoded the same way, uncropped, and the run succeeds', () => {
  const dir = scratchDir('reframe-same');
  const src = gradient(dir);
  const out = join(dir, 'same.mp4');
  const r = run(['reframe', src, '--aspect', '16:9', '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is already 16:9 \(640x360\), so it is re-encoded upright, uncropped/);
  assert.doesNotMatch(r.stdout, /cut from the middle/, 'nothing is cut, so nothing is said about where');
  const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
  assert.equal(probe, '640,360,60');
  // A named face file that is missing is refused even here, before anything is encoded.
  const missing = run(['reframe', src, '--aspect', '16:9', '--faces', join(dir, 'none.json'), '--out', join(dir, 'x.mp4')], dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no face boxes at .*none\.json/);
});

test('reframe: a portrait phone clip stored sideways comes out upright, and joins a reframed landscape clip upright', () => {
  const dir = scratchDir('reframe-phone');
  // Stored 640x360 with a 90 degree rotation tag: a 360x640 picture, already 9:16.
  const flat = join(dir, 'flat.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat]);
  const phone = rotatedCopy(flat, join(dir, 'phone.mp4'), 90);
  const tall = join(dir, 'tall.mp4');
  assert.equal(run(['reframe', phone, '--aspect', '9:16', '--out', tall], dir).status, 0);
  const upright = JSON.parse(streamOf(tall)).streams[0];
  assert.deepEqual([upright.codec_name, upright.width, upright.height, upright.side_data_list], ['h264', 360, 640, undefined]);
  // A landscape clip reframed to 9:16, then the two joined: one upright 360x640 canvas, no rotation tag.
  const land = join(dir, 'land916.mp4');
  assert.equal(run(['reframe', gradient(dir), '--aspect', '9:16', '--out', land], dir).status, 0);
  const joined = join(dir, 'joined.mp4');
  const r = run(['concat-videos', joined, tall, land], dir);
  assert.equal(r.status, 0, r.stderr);
  const both = JSON.parse(streamOf(joined)).streams[0];
  assert.deepEqual([both.width, both.height, both.side_data_list], [360, 640, undefined]);
});

test('reframe: a ProRes .mov already in shape comes out as an H.264 .mp4', () => {
  const dir = scratchDir('reframe-prores');
  const mov = join(dir, 'cam.mov');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=1', '-c:v', 'prores_ks', mov]);
  const out = join(dir, 'cam.mp4');
  const r = run(['reframe', mov, '--aspect', '16:9', '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  const stream = JSON.parse(streamOf(out)).streams[0];
  assert.deepEqual([stream.codec_name, stream.width, stream.height, Number(stream.nb_frames)], ['h264', 640, 360, 30]);
});


test('reframe: anamorphic footage is cut in the pixels it is shown in, and comes out with square pixels', () => {
  const dir = scratchDir('reframe-anamorphic');
  // 1440x1080 stored with 4:3 pixels: a 1920x1080 picture, brighter to the right.
  const src = join(dir, 'wide.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1440x1080:r=30:d=1', '-vf', 'geq=lum=X*255/W:cb=128:cr=128,setsar=4/3',
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(clipOf([{ start: 0, end: 1, samples: [] }], { width: 1920, height: 1080, durationSec: 1, video: src })));
  const out = join(dir, 'tall.mp4');
  const r = reframe([src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1920x1080 → 606x1080/);
  const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
  assert.match(probe, /^606,1080(,1:1|,N\/A)?$/, `square pixels: ${probe}`);
  // The middle of the shown picture: display column 658 is stored column 493.5, 493.5/1440 bright, about 87.
  const y = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-frames:v', '1', '-vf', 'extractplanes=y', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  let sum = 0;
  for (let row = 0; row < 1080; row++) sum += y[row * 606 + 2];
  assert.ok(Math.abs(sum / 1080 - 87) < 8, `left column ${(sum / 1080).toFixed(1)}, expected about 87`);
});

const noDetector = missingDetector();
if (noDetector && process.env.OPENEDIT_REQUIRE_MEDIAPIPE) throw new Error(`${noDetector}, and OPENEDIT_REQUIRE_MEDIAPIPE is set`);
const detect = noDetector ? `${noDetector} (openedit install-mediapipe)` : false;

/** Each sampled face of the clip that does not lie wholly inside the crop at its time. */
function misses(clip: FacesClip, crop: Crop, at: (t: number) => number): string[] {
  return clip.shots.flatMap((shot) => shot.samples.flatMap((s) => s.faces
    .filter((f) => f.x < at(s.sec) || f.x + f.w > at(s.sec) + crop.w)
    .map((f) => `${s.sec}s: face ${f.x}-${f.x + f.w} outside crop ${at(s.sec)}-${at(s.sec) + crop.w}`)));
}

test('reframe: the landscape fixture cut to 9:16 keeps the face inside the crop on every sampled frame', { skip: detect }, () => {
  const clip = findFaces(FIXTURE, OPTIONS);
  const crop = cropFor(clip.width, clip.height, 9 / 16);
  assert.deepEqual(misses(clip, crop, cropTrack(clip, crop)), []);
  // The same check fails a centre crop, which cuts both speakers: the test can tell the two apart.
  assert.ok(misses(clip, crop, () => crop.travel / 2).length >= 8);

  // And in the encoded clip: the detector finds one whole face on every sampled frame, clear of the edges.
  const dir = scratchDir('reframe');
  const out = join(dir, 'tall.mp4');
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(clip));
  const r = reframe([FIXTURE, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const tall = findFaces(out, OPTIONS);
  assert.deepEqual([tall.width, tall.height], [202, 360]);
  for (const s of tall.shots.flatMap((shot) => shot.samples)) {
    assert.equal(s.faces.length, 1, `${s.sec}s: ${s.faces.length} faces in the reframed clip`);
    const [f] = s.faces;
    assert.ok(f.x > 0 && f.x + f.w < tall.width, `${s.sec}s: the face ${f.x}-${f.x + f.w} touches the edge of the ${tall.width} px crop`);
  }
});
