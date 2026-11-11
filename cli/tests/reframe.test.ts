// The reframe command: the crop's shape, the path it follows through each shot, the encoded clip (on a
// generated gradient, so it runs everywhere), and, when MediaPipe is installed (`openedit
// install-mediapipe`), the talking-head fixture cut to 9:16 around its faces. Without MediaPipe those
// are skipped, unless OPENEDIT_REQUIRE_MEDIAPIPE is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { findFaces, readFaces } from '../src/commands/faces.ts';
import {
  clearOf, cropFor, cropMoves, cropTrack, holdsFor, oneFace, parseAspect, parsePanel, partsOf, pathThrough, placeAt, sendcmdScript, stillPlace,
  tighterCrop, unfitted, type Crop, type Shaping,
} from '../src/commands/reframe.ts';
import { formatNamed } from '../src/commands/safe-zone.ts';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { ownFaces } from '../src/faces/folder.ts';
import { missingDetector } from '../src/faces/mediapipe.ts';
import { probeVideoSpan } from '../src/probe.ts';
import type { FaceBox, FacesClip, Shot } from '../src/faces/page-script.ts';
import { FLAT_RGB, captureConsole, flatClip, probeStream, rotatedCopy, scratchDir, shownRgb } from './helpers/synth.ts';

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

test('reframe: someone in the background found beside the speaker does not stop the speaker being followed', () => {
  // A speaker walking up to the camera, cut from portrait to 16:9, and someone at a desk behind found twice at a
  // quarter of the speaker's height (listed first in one sample): the face travels further than one still crop holds.
  const crop = cropFor(1080, 1920, 16 / 9);
  const speaker = (i: number) => ({ x: 300, y: 400 + 25 * i, w: 220 + 8 * i, h: 220 + 8 * i });
  const behind = { x: 900, y: 1150, w: 100, h: 100 };
  const shot = sampledShot(0.25, Array.from({ length: 28 }, (_, i) => (i === 22 ? [behind, speaker(i)] : i === 23 ? [speaker(i), behind] : [speaker(i)])));
  const track = cropTrack(clipOf([shot], { width: 1080, height: 1920 }), crop);
  const places = shot.samples.map((s) => track(s.sec));
  assert.ok(new Set(places).size > 1, 'followed, not held at one place');
  shot.samples.forEach((s, i) => {
    const f = speaker(i);
    assert.ok(f.y >= places[i] && f.y + f.h <= places[i] + crop.h, `${s.sec} s: face at y ${f.y}-${f.y + f.h}, crop at ${places[i]}-${places[i] + crop.h}`);
  });
  // A second person 0.6 of the first's height, as in an over-the-shoulder two-shot, is still a second person: held.
  const two = sampledShot(0.25, Array.from({ length: 16 }, (_, i) => [face(300 + 30 * i, 100, 300, 300), face(1300, 150, 180, 180)]));
  assert.equal(new Set(placesOf(two)).size, 1);
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

// The bottom half of a 1080x1920 TikTok canvas: TikTok's UI leaves x 52-897 and everything above y 1478 clear.
const BOTTOM_HALF = clearOf({ x: 0, y: 960, w: 1080, h: 960 }, formatNamed('tiktok'))!;

test('reframe: a panel\'s clear part is its share of the canvas the platform\'s UI leaves clear, as measured on each side', () => {
  assert.deepEqual(BOTTOM_HALF, { x0: 52 / 1080, x1: 897 / 1080, y0: 0, y1: 518 / 960 });
  assert.deepEqual(clearOf({ x: 0, y: 0, w: 1080, h: 960 }, formatNamed('tiktok')), { x0: 52 / 1080, x1: 897 / 1080, y0: 240 / 960, y1: 1 });
  assert.equal(clearOf({ x: 0, y: 1500, w: 1080, h: 420 }, formatNamed('tiktok')), null, 'a panel wholly under the caption block');
  assert.deepEqual(parsePanel(' 0, 960, 1080, 960 '), { x: 0, y: 960, w: 1080, h: 960 });
  assert.throws(() => parsePanel('0,960,1080'), /--panel wants x,y,w,h in px of the canvas/);
});

test('reframe: with a clear part a followed face stays inside it at every sample, where the largest crop alone leaves it under the UI', () => {
  const crop = cropFor(1080, 1920, 9 / 8);
  // A speaker bobbing 180 px, sampled four times a second: a 420 px face in the 518 px the bottom half leaves clear.
  const samples = Array.from({ length: 24 }, (_, i) => ({ sec: 0.125 + i * 0.25, faces: [{ x: 330, y: Math.round(480 + 90 * Math.sin(i / 2)), w: 420, h: 420 }] }));
  const clip = clipOf([{ start: 0, end: 6, samples }], { width: 1080, height: 1920 });
  const reach = (clear?: typeof BOTTOM_HALF) => {
    const moves = cropMoves(clip, crop, 30, 6, clear);
    return samples.map(({ sec, faces: [f] }) => ({ top: f.y - placeAt(moves, sec), bottom: f.y + f.h - placeAt(moves, sec) }));
  };
  assert.ok(reach().some((r) => r.bottom > 518), 'framed for the whole panel, the face reaches the caption block');
  for (const [i, r] of reach(BOTTOM_HALF).entries()) {
    assert.ok(r.top >= 0 && r.bottom <= 518, `${samples[i].sec} s: face at ${r.top}-${r.bottom} of the panel, clear part 0-518`);
  }
});

test('reframe: a shot no place of the largest crop keeps clear is cut tighter, by the least that clears its face, and never past a whole face', () => {
  // 640x360 into 9:8: the largest crop is 404x360 and keeps the full height, so a low face cannot be moved up.
  const crop = cropFor(640, 360, 9 / 8);
  const low = shotOf(0, [[face(300, 200, 80, 80)], [face(302, 200, 80, 80)], [face(298, 202, 80, 80)]]);
  const zoom = tighterCrop(low, crop, BOTTOM_HALF)!;
  const clearAt = (h: number, cross: number) => low.samples.every(({ faces: [f] }) => f.y >= cross && f.y + f.h - cross <= BOTTOM_HALF.y1 * h);
  assert.ok(zoom.h < 360 && clearAt(zoom.h, zoom.cross), `${JSON.stringify(zoom)} keeps the face clear`);
  // Two pixels taller, no place across clears it: the least change.
  assert.ok(![...Array(360 - zoom.h - 1).keys()].some((c) => clearAt(zoom.h + 2, c)), 'a crop a step larger would have done');
  // A face taller than the clear part only grows as the crop tightens, so nothing is cut to try.
  assert.equal(tighterCrop(shotOf(0, [[face(250, 100, 200, 200)]]), crop, BOTTOM_HALF), null);
  // A face the largest crop already keeps clear is left as it is.
  assert.equal(tighterCrop(shotOf(0, [[face(300, 20, 80, 80)]]), crop, BOTTOM_HALF), null);
});

test('reframe: a shot held still keeps its faces whole and moves them clear of the UI where one place does both', () => {
  const crop = cropFor(1080, 1920, 9 / 8);
  // Two people side by side, the nearer one's 450 px face low enough that the usual third-of-the-way anchor puts it in the caption block.
  const shot = shotOf(0, [[{ x: 100, y: 600, w: 450, h: 450 }, { x: 650, y: 700, w: 140, h: 140 }]]);
  const plain = stillPlace(shot, crop)!;
  assert.ok(1050 - plain > 518, `without a clear part the face reaches ${1050 - plain} of the panel`);
  const at = stillPlace(shot, crop, [BOTTOM_HALF.y0, BOTTOM_HALF.y1])!;
  assert.ok(at <= 600 && 1050 - at <= 518 && 840 - at <= 518, `held at ${at}: both whole and clear`);
});

test('reframe: --panel cuts to the panel on the brief\'s platform canvas, keeps each face clear of its UI, and a tighter shot loses no frame', () => {
  const dir = scratchDir('reframe-panel');
  const src = gradient(dir);
  writeFileSync(join(dir, 'brief.json'), JSON.stringify({ platform: 'tiktok' }));
  // High in the frame for the first second, low after a cut at 1 s, where only a tighter crop lifts it clear.
  const clip = clipOf([
    { start: 0, end: 1, samples: [0.25, 0.5, 0.75].map((sec) => ({ sec, faces: [{ x: 300, y: 20, w: 80, h: 80 }] })) },
    { start: 1, end: 2, samples: [1.25, 1.5, 1.75].map((sec) => ({ sec, faces: [{ x: 300, y: 200, w: 80, h: 80 }] })) },
  ], { width: 640, height: 360, durationSec: 2, video: src });
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(clip));
  const run = (args: string[], root = dir) => spawnSync(process.execPath, ['--import', 'tsx', CLI, 'reframe', src, '--faces', join(dir, 'faces.json'), ...args],
    { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: root } });
  const out = join(dir, 'panel.mp4');
  const r = run(['--panel', '0,960,1080,960', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /faces are kept inside x 52–897, y 960–1478 of that canvas, clear of the UI/);
  assert.match(r.stdout, /1\.00–2\.00 s is cut tighter/);
  assert.doesNotMatch(r.stdout, /still show one under the UI/);
  assert.match(sizeOf(out), /^1080,960/);
  const frames = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out],
    { encoding: 'utf8' }).trim();
  assert.equal(frames, '60', 'the tighter second is laid over the clip, not dropped');
  // The gradient spans fewer source columns across the frame once the crop is tighter.
  const span = (n: number) => { const [l, rt] = columnsOf(out, [2, 1077], n); return rt - l; };
  assert.ok(span(45) < 0.6 * span(15), `brightness across the frame ${span(15).toFixed(0)} before the cut, ${span(45).toFixed(0)} after`);
  // The faces it writes for the panel, its source's moved with each crop, all lie in the clear part.
  const written = /to (\S+faces\.json) and/.exec(r.stdout)![1];
  for (const s of readFaces(written).shots.flatMap((shot) => shot.samples)) {
    for (const f of s.faces) assert.ok(f.x >= 51 && f.x + f.w <= 898 && f.y + f.h <= 519, `${s.sec} s: ${JSON.stringify(f)}`);
  }
  assert.match(run(['--panel', '0,960,1080,960', '--aspect', '9:16', '--out', out]).stderr, /--aspect 9:16 is not the shape of --panel's 1080x960/);
  assert.match(run(['--panel', '0,960,1080,1000', '--out', out]).stderr, /--panel 0,960,1080,1000 runs off the 1080x1920 canvas of tiktok/);
  const bare = scratchDir('reframe-panel-bare');
  assert.match(run(['--panel', '0,960,1080,960', '--out', join(bare, 'o.mp4')], bare).stderr, /--panel keeps faces clear of the UI of the platform the piece is posted on/);
});

test('reframe: each frame is cut where the crop stands at that frame\'s own time, and a frame just before a cut keeps its shot\'s place', () => {
  // A face crossing the frame at 360 px a second, sampled four times a second: a pan of 12 px a frame mid-way.
  const pan = sampledShot(0.25, Array.from({ length: 16 }, (_, i) => [face(100 + 90 * i)]));
  const clip = clipOf([pan, { start: 4, end: 6, samples: [{ sec: 4.5, faces: [face(200)] }] }]);
  const track = cropTrack(clip, NINE_BY_SIXTEEN);
  const moves = cropMoves(clip, NINE_BY_SIXTEEN, 30, 6);
  const shown = (pts: number) => moves.filter((m) => m.sec <= pts).at(-1)!.at;
  const off = Array.from({ length: 180 }, (_, n) => n).filter((n) => shown(n / 30) !== track(n / 30));
  assert.deepEqual(off, [], `frames cut at another time's place: ${off.slice(0, 5).join(', ')}`);
  assert.ok(new Set(Array.from({ length: 120 }, (_, n) => shown(n / 30))).size > 20, 'the face is followed');
  // A frame of a clip whose rate varies may fall between the last look and the cut: it is still the first shot's.
  assert.equal(shown(4 - 0.005), track(3.99));
  assert.notEqual(track(3.99), track(4));
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

/** A clip of `size` (WxH) whose brightness rises left to right, `seconds` long. */
function wideGradient(dir: string, size: string, seconds = 0.2): string {
  const src = join(dir, `gradient-${size}.mp4`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=30:d=${seconds}`, '-vf', 'geq=lum=X*255/W:cb=128:cr=128',
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
  return src;
}

/** The size and sample aspect of a clip's picture, e.g. `1080,1920,1:1`. */
const sizeOf = (file: string) => execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio',
  '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();

/** The mean stored luma of each named column of one frame of a clip, its first by default. */
function columnsOf(video: string, columns: number[], frame = 0): number[] {
  const [w, h] = sizeOf(video).split(',').map(Number);
  const y = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-vf', `select=eq(n\\,${frame}),extractplanes=y`, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 26 });
  return columns.map((x) => {
    let sum = 0;
    for (let row = 0; row < h; row++) sum += y[row * w + x];
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
  const r = reframe([src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out, '--size', 'native']);
  assert.equal(r.status, 0, r.stderr);
  const left = leftColumns(out);
  assert.equal(left.length, 60);
  // Before the cut the crop sits at 0 (source column 2 is near black); from frame 30 at 438, where the
  // source is 438/640 of full brightness, about 175.
  for (const n of [0, 15, 29]) assert.ok(left[n] < 12, `frame ${n}: ${left[n].toFixed(1)}, expected near black`);
  for (const n of [30, 45, 59]) assert.ok(Math.abs(left[n] - 175) < 10, `frame ${n}: ${left[n].toFixed(1)}, expected about 175`);
  // Scaled to the canvas by default, the moving crop is the same: column 5 of 1080 is source column 1 past the crop's place.
  const canvas = join(dir, 'canvas.mp4');
  assert.equal(reframe([src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', canvas]).status, 0);
  assert.match(sizeOf(canvas), /^1080,1920/);
  assert.ok(columnsOf(canvas, [5], 15)[0] < 12, 'before the cut, near black');
  assert.ok(Math.abs(columnsOf(canvas, [5], 45)[0] - 175) < 10, 'after the cut, about 175');
});

test('reframe: it names the seconds where a face does not fit the crop, a close-up larger than it or a two-shot it cannot hold whole', () => {
  // A close-up wider than the 606 px crop, a lone face that fits, then two people too far apart for one crop.
  const clip = clipOf([
    shotOf(0, [[face(600, 100, 700, 700)], [face(610, 100, 700, 700)]]),
    shotOf(2, [[face(800)], [face(810)]]),
    shotOf(4, [[face(200, 100, 300, 300), face(1400, 100, 280, 280)], [face(200, 100, 300, 300), face(1400, 100, 280, 280)]]),
  ]);
  const shaping = (c: FacesClip): Shaping => ({
    video: c.video, width: 1920, height: 1080, sar: 1, crop: NINE_BY_SIXTEEN, how: 'faces', facesPath: '/f.json', clip: c,
    moves: cropMoves(c, NINE_BY_SIXTEEN, 30, c.durationSec),
  });
  assert.deepEqual(unfitted(shaping(clip)), [{ from: 0, to: 2 }, { from: 4, to: 6 }]);
  // Someone in the background, under half the speaker's height and far outside the crop, is not framed, so not named.
  const behind = clipOf([shotOf(0, [[face(800, 100, 200, 200), face(100, 300, 60, 60)], [face(810, 100, 200, 200), face(100, 300, 60, 60)]])]);
  assert.deepEqual(unfitted(shaping(behind)), []);
  // One sample of a shot stands for the time halfway to its neighbours.
  const once = clipOf([shotOf(0, [[face(800)], [face(600, 100, 700, 700)], [face(810)]])]);
  assert.deepEqual(unfitted(shaping(once)), [{ from: 1, to: 2 }]);
  // Printed in one line; a clip whose faces all fit prints none.
  const dir = scratchDir('reframe-unfit');
  const src = gradient(dir);
  const run = (f: FaceBox) => {
    writeFileSync(join(dir, 'faces.json'), JSON.stringify(clipOf([{ start: 0, end: 2, samples: [0.5, 1.5].map((sec) => ({ sec, faces: [f] })) }],
      { width: 640, height: 360, durationSec: 2, video: src })));
    const r = reframe([src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', join(dir, 'tall.mp4'), '--size', 'native']);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.match(run({ x: 200, y: 50, w: 250, h: 250 }), /reframe: a face does not fit the 202x360 crop at 0\.00–2\.00 s \(larger than it, or beside another face a held shot keeps\)/);
  assert.doesNotMatch(run({ x: 200, y: 50, w: 100, h: 100 }), /does not fit/);
});

test('reframe: with no face boxes it cuts the whole clip from the middle, and says so', () => {
  const dir = scratchDir('reframe-middle');
  const src = gradient(dir);
  const out = join(dir, 'tall.mp4');
  // A workspace of its own, so no faces.json waits at the default place.
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'reframe', src, '--aspect', '9:16', '--out', out, '--size', 'native'],
    { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no face boxes for .*gradient\.mp4 \(faces writes them\), so the crop is cut from the middle/);
  // The middle of 438 px of travel, on an even pixel, is 218: column 2 is source column 220, 220/640 bright.
  for (const [n, v] of leftColumns(out).entries()) assert.ok(Math.abs(v - 88) < 8, `frame ${n}: ${v.toFixed(1)}, expected about 88`);
});

test('reframe: by default a 1920x1080 clip cut to 9:16 comes out at the 1080x1920 platform canvas, the crop scaled up unstretched', () => {
  const dir = scratchDir('reframe-canvas');
  const src = wideGradient(dir, '1920x1080');
  const out = join(dir, 'tall.mp4');
  const r = run(['reframe', src, '--aspect', '9:16', '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1920x1080 → 606x1080 \(9:16\), scaled to 1080x1920/);
  assert.match(sizeOf(out), /^1080,1920(,1:1|,N\/A)?$/);
  // The 606 px crop from the middle (source column 656 on) spread over 1080: output columns 2, 540 and 1077 are source
  // columns 657, 959 and 1260, each X*255/1920 bright. The whole frame squeezed in, or another crop, moves at least one.
  const [left, middle, right] = columnsOf(out, [2, 540, 1077]);
  for (const [got, want] of [[left, 87.3], [middle, 127.4], [right, 167.3]]) {
    assert.ok(Math.abs(got - want) < 4, `column brightness ${got.toFixed(1)}, expected about ${want}`);
  }
});

test('reframe: a 4K clip cut to 9:16 comes out at 1080x1920, and 1:1 and 4:5 at their own platform canvases', () => {
  const dir = scratchDir('reframe-canvases');
  const uhd = join(dir, 'uhd.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=0.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', uhd]);
  const tall = join(dir, 'tall.mp4');
  const r = run(['reframe', uhd, '--aspect', '9:16', '--out', tall], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3840x2160 → 1214x2160 \(9:16\), scaled to 1080x1920/);
  assert.match(sizeOf(tall), /^1080,1920/);
  const hd = wideGradient(dir, '1920x1080');
  for (const [aspect, size] of [['1:1', '1080,1080'], ['4:5', '1080,1350']]) {
    const out = join(dir, `${aspect.replace(':', 'x')}.mp4`);
    assert.equal(run(['reframe', hd, '--aspect', aspect, '--out', out], dir).status, 0);
    assert.match(sizeOf(out), new RegExp(`^${size}`), `${aspect}: ${sizeOf(out)}`);
  }
});

test('reframe: --size names another size of the shape, native keeps the source\'s pixels, and a size of another shape is refused', () => {
  const dir = scratchDir('reframe-size');
  const src = wideGradient(dir, '1920x1080');
  const big = join(dir, 'big.mp4');
  const r = run(['reframe', src, '--aspect', '9:16', '--out', big, '--size', '2160x3840'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /→ 606x1080 \(9:16\), scaled to 2160x3840/);
  assert.match(sizeOf(big), /^2160,3840/);
  const native = join(dir, 'native.mp4');
  const n = run(['reframe', src, '--aspect', '9:16', '--out', native, '--size', 'native'], dir);
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /1920x1080 → 606x1080 \(9:16\), 1 shot/);
  assert.doesNotMatch(n.stdout, /scaled/);
  assert.match(sizeOf(native), /^606,1080/);
  // The same crop, pixel for pixel: column 2 is source column 658.
  assert.ok(Math.abs(columnsOf(native, [2])[0] - 87.4) < 4);
  const other = run(['reframe', src, '--aspect', '9:16', '--out', join(dir, 'x.mp4'), '--size', '1080x1350'], dir);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /--size 1080x1350 is not 9:16: 9:16 is 1080x1920 on the platforms, or 2160x3840 in 4K/);
  const odd = run(['reframe', src, '--aspect', '9:16', '--out', join(dir, 'y.mp4'), '--size', '1081x1920'], dir);
  assert.equal(odd.status, 1);
  assert.match(odd.stderr, /--size wants WxH with even sides, e.g\. 1080x1920, or native; got "1081x1920"/);
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
  assert.match(r.stdout, /is already 9:16 \(1080x1920\), so it is re-encoded upright, uncropped → /, 'at the canvas already, so not scaled again');
  assert.doesNotMatch(r.stdout, /no face boxes/);
  assert.deepEqual([JSON.parse(streamOf(again)).streams[0].width, JSON.parse(streamOf(again)).streams[0].height], [1080, 1920]);
  // 203x360 is 9:16 to within the rounding; H.264 wants even sides, so its last column goes.
  const odd = join(dir, 'odd.mkv');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=203x360:r=30:d=1', '-c:v', 'ffv1', odd]);
  const evened = join(dir, 'evened.mp4');
  const o = run(['reframe', odd, '--aspect', '9:16', '--out', evened, '--size', 'native'], dir);
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
  assert.match(r.stdout, /is already 16:9 \(640x360\), so it is re-encoded upright, uncropped, scaled to 1920x1080/);
  assert.doesNotMatch(r.stdout, /cut from the middle/, 'nothing is cut, so nothing is said about where');
  const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
  assert.equal(probe, '1920,1080,60');
  // A named face file that is missing is refused even here, before anything is encoded.
  const missing = run(['reframe', src, '--aspect', '16:9', '--faces', join(dir, 'none.json'), '--out', join(dir, 'x.mp4')], dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no face boxes at .*none\.json/);
});

test('reframe: a portrait phone clip stored sideways comes out upright, and joins a reframed landscape clip upright', () => {
  const dir = scratchDir('reframe-phone');
  // Stored 640x360 with a 90 degree rotation tag: a 360x640 picture, already 9:16, scaled to the 1080x1920 canvas.
  const flat = join(dir, 'flat.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat]);
  const phone = rotatedCopy(flat, join(dir, 'phone.mp4'), 90);
  const tall = join(dir, 'tall.mp4');
  assert.equal(run(['reframe', phone, '--aspect', '9:16', '--out', tall], dir).status, 0);
  const upright = JSON.parse(streamOf(tall)).streams[0];
  assert.deepEqual([upright.codec_name, upright.width, upright.height, upright.side_data_list], ['h264', 1080, 1920, undefined]);
  // A landscape clip reframed to 9:16, then the two joined: one upright 1080x1920 canvas, no rotation tag.
  const land = join(dir, 'land916.mp4');
  assert.equal(run(['reframe', gradient(dir), '--aspect', '9:16', '--out', land], dir).status, 0);
  const joined = join(dir, 'joined.mp4');
  const r = run(['concat-videos', joined, tall, land], dir);
  assert.equal(r.status, 0, r.stderr);
  const both = JSON.parse(streamOf(joined)).streams[0];
  assert.deepEqual([both.width, both.height, both.side_data_list], [1080, 1920, undefined]);
});

test('reframe: a ProRes .mov already in shape comes out as an H.264 .mp4', () => {
  const dir = scratchDir('reframe-prores');
  const mov = join(dir, 'cam.mov');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=1', '-c:v', 'prores_ks', mov]);
  const out = join(dir, 'cam.mp4');
  const r = run(['reframe', mov, '--aspect', '16:9', '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  const stream = JSON.parse(streamOf(out)).streams[0];
  assert.deepEqual([stream.codec_name, stream.width, stream.height, Number(stream.nb_frames)], ['h264', 1920, 1080, 30]);
});

test('reframe: a clip labelled in part or not at all comes out labelled on all four axes, showing the same colour, and apply-edl assembles it', () => {
  const dir = scratchDir('reframe-colour');
  for (const kind of ['vp8', 'matrix', 'untagged', 'full', 'rgb'] as const) {
    const out = join(dir, `${kind}-tall.mp4`);
    const r = run(['reframe', flatClip(dir, kind), '--aspect', '9:16', '--out', out], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(probeStream(out, 'v:0', 'color_range,color_primaries,color_transfer,color_space'),
      { color_range: 'tv', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' }, kind);
    // Converted with swscale's default rounding the green comes out 4 levels off; relabelled BT.709 rather than converted,
    // a BT.601 picture shows it 21 levels darker.
    const shown = shownRgb(out);
    assert.ok(shown.every((v, i) => Math.abs(v - FLAT_RGB[i]) < 4), `${kind}: shown as ${shown.map((v) => v.toFixed(1))}, made as ${FLAT_RGB}`);
    writeFileSync(join(dir, `${kind}.json`), JSON.stringify({ sources: { a: out }, ranges: [{ source: 'a', start: 0, end: 0.5 }] }));
    captureConsole(() => applyEdl(['--edl', join(dir, `${kind}.json`), '--out', join(dir, `${kind}-cut.mp4`)]));
  }
});

test('reframe: anamorphic footage is cut in the pixels it is shown in, and comes out with square pixels', () => {
  const dir = scratchDir('reframe-anamorphic');
  // 1440x1080 stored with 4:3 pixels: a 1920x1080 picture, brighter to the right.
  const src = join(dir, 'wide.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1440x1080:r=30:d=1', '-vf', 'geq=lum=X*255/W:cb=128:cr=128,setsar=4/3',
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(clipOf([{ start: 0, end: 1, samples: [] }], { width: 1920, height: 1080, durationSec: 1, video: src })));
  const out = join(dir, 'tall.mp4');
  const r = reframe([src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out, '--size', 'native']);
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

/** The faces.json a reader takes for `video` in the workspace `root`, as shots, the joins and reframe itself look it up. */
function facesIn(root: string, video: string): string | null {
  const before = process.env.OPEN_EDIT_ROOT;
  process.env.OPEN_EDIT_ROOT = root;
  try {
    return ownFaces(video);
  } finally {
    if (before === undefined) delete process.env.OPEN_EDIT_ROOT;
    else process.env.OPEN_EDIT_ROOT = before;
  }
}

/** The bounding box of the bright pixels of a luma frame inside `r`, or null when it has none. */
function brightIn(y: Buffer, width: number, height: number, r: { x: number; y: number; w: number; h: number }) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let row = Math.max(0, r.y); row < Math.min(height, r.y + r.h); row++) {
    for (let col = Math.max(0, r.x); col < Math.min(width, r.x + r.w); col++) {
      if (y[row * width + col] < 126) continue;
      [x0, y0, x1, y1] = [Math.min(x0, col), Math.min(y0, row), Math.max(x1, col + 1), Math.max(y1, row + 1)];
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * That each sample's boxes in the faces.json at `path` lie on the white squares drawn in its clip's frame at that time, to
 * within `tol` pixels on every edge, and that nothing else in the frame is white: a box dropped is a face not shown.
 */
function boxesLandOnFaces(path: string, tol: number): number {
  const clip = readFaces(path);
  const { width: w, height: h } = clip;
  const samples = clip.shots.flatMap((shot) => shot.samples);
  const frames = samples.map((s) => Math.round(s.sec * 30));
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', clip.video, '-vf', `select='${frames.map((n) => `eq(n\\,${n})`).join('+')}'`,
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  assert.equal(raw.length, samples.length * w * h, `one ${w}x${h} frame per sample`);
  let boxes = 0;
  for (const [i, sample] of samples.entries()) {
    const y = raw.subarray(i * w * h, (i + 1) * w * h);
    let area = 0;
    for (const b of sample.faces) {
      const seen = brightIn(y, w, h, { x: b.x - 4 * tol, y: b.y - 4 * tol, w: b.w + 8 * tol, h: b.h + 8 * tol });
      assert.ok(seen, `${sample.sec} s: no face drawn near the box ${JSON.stringify(b)}`);
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        assert.ok(Math.abs(seen[k] - b[k]) <= tol, `${sample.sec} s: the box ${JSON.stringify(b)} against the face drawn at ${JSON.stringify(seen)}`);
      }
      area += b.w * b.h;
      boxes++;
    }
    let white = 0;
    for (let k = 0; k < y.length; k++) if (y[k] >= 126) white++;
    assert.ok(Math.abs(white - area) <= 0.03 * Math.max(area, 1000), `${sample.sec} s: ${white} white pixels in the frame, ${area} in its boxes`);
  }
  return boxes;
}

test('reframe: the output gets its own face boxes, moved and scaled with the crop, and they land on the faces in its frames', () => {
  const dir = scratchDir('reframe-own-faces');
  // White squares on black, 640x360: a face pacing right for 2 s (one followed with pans), three faces held at one place
  // for 1 s (one inside the crop, one it cuts through, one it leaves out), then a face larger than the crop for 1 s.
  const src = join(dir, 'squares.mp4');
  const box = (x: number, y: number, w: number, h: number, when: string) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white:t=fill:enable='${when}'`;
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'color=c=white:s=60x60:r=30:d=4',
    '-filter_complex', `[0][1]overlay=x='20+250*t':y=150:eval=frame:enable='lt(t,2)',${box(300, 120, 60, 60, 'gte(t,2)*lt(t,3)')},`
      + `${box(410, 40, 110, 30, 'gte(t,2)*lt(t,3)')},${box(40, 250, 40, 40, 'gte(t,2)*lt(t,3)')},${box(190, 80, 260, 200, 'gte(t,3)')}`,
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
  // Sampled every sixth frame, where the pacing face stands on an even pixel as the overlay draws it.
  const at = (from: number, to: number) => Array.from({ length: (to - from) * 5 }, (_, k) => Number((from + k / 5).toFixed(6)));
  const durationSec = probeVideoSpan(src).end;
  const source = clipOf([
    { start: 0, end: 2, samples: at(0, 2).map((sec) => ({ sec, faces: [{ x: 20 + 250 * sec, y: 150, w: 60, h: 60, score: 0.9 }] })) },
    { start: 2, end: 3, samples: at(2, 3).map((sec) => ({ sec, faces: [face(300, 120, 60, 60), face(410, 40, 110, 30), face(40, 250, 40, 40)] })) },
    { start: 3, end: durationSec, samples: at(3, 4).map((sec) => ({ sec, faces: [face(190, 80, 260, 200)] })) },
  ], { video: src, width: 640, height: 360, durationSec });
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(source));
  const out = join(dir, 'tall.mp4');
  const r = run(['reframe', src, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  // Where faces would write them for the output, and where every reader looks.
  const own = facesIn(dir, out);
  assert.ok(own && existsSync(own.replace(/json$/, 'js')), `no faces.json and faces.js of ${out}: ${r.stdout}`);
  assert.ok(r.stdout.includes(`wrote the faces of tall.mp4, its source's boxes moved with the crop, to ${own} and `), r.stdout);
  const tall = readFaces(own);
  assert.deepEqual([tall.video, tall.width, tall.height], [out, 1080, 1920]);
  assert.deepEqual(tall.shots.map((s) => [s.start, s.samples.map((x) => x.sec)]), source.shots.map((s) => [s.start, s.samples.map((x) => x.sec)]),
    'the shots and sample times are the source\'s');
  const held = tall.shots[1].samples[0].faces;
  assert.equal(held.length, 2, 'the face the crop leaves out is dropped');
  assert.ok(held[1].x + held[1].w === 1080 && held[1].w < 200, `the face the crop cuts through is kept in part: ${JSON.stringify(held[1])}`);
  assert.deepEqual([tall.shots[2].samples[0].faces[0].x, tall.shots[2].samples[0].faces[0].w], [0, 1080], 'a face larger than the crop fills its width');
  // Measured on the encoded frames, where a source pixel is 5.35 of the canvas's: every edge within 2 of them.
  assert.equal(boxesLandOnFaces(own, 2), 10 + 5 * 2 + 5);

  // Reframed again at half the size, a clip already in the shape: nothing is cut, and the output's own boxes are read and scaled.
  const small = join(dir, 'small.mp4');
  const again = run(['reframe', out, '--aspect', '9:16', '--size', '540x960', '--out', small], dir);
  assert.equal(again.status, 0, again.stderr);
  const smallFaces = facesIn(dir, small);
  assert.ok(smallFaces, again.stdout);
  assert.equal(readFaces(smallFaces).width, 540);
  assert.equal(boxesLandOnFaces(smallFaces, 2), 25);

  // Another clip with no boxes written over the same output: none are written, and the old clip's are gone.
  const plain = run(['reframe', gradient(dir), '--aspect', '9:16', '--out', out], dir);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /wrote the faces/);
  assert.equal(facesIn(dir, out), null);
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
  const r = reframe([FIXTURE, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out, '--size', 'native']);
  assert.equal(r.status, 0, r.stderr);
  const tall = findFaces(out, OPTIONS);
  assert.deepEqual([tall.width, tall.height], [202, 360]);
  for (const s of tall.shots.flatMap((shot) => shot.samples)) {
    assert.equal(s.faces.length, 1, `${s.sec}s: ${s.faces.length} faces in the reframed clip`);
    const [f] = s.faces;
    assert.ok(f.x > 0 && f.x + f.w < tall.width, `${s.sec}s: the face ${f.x}-${f.x + f.w} touches the edge of the ${tall.width} px crop`);
  }
});

/** The overlap of two boxes over their union. */
const iou = (a: FaceBox, b: FaceBox) => {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
};

test('reframe: the boxes it writes for the fixture cut to 9:16 are the faces the detector finds on the output', { skip: detect }, () => {
  const dir = scratchDir('reframe-faces-match');
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(findFaces(FIXTURE, OPTIONS)));
  const out = join(dir, 'tall.mp4');
  const r = run(['reframe', FIXTURE, '--aspect', '9:16', '--faces', join(dir, 'faces.json'), '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  const written = readFaces(facesIn(dir, out)!);
  const found = findFaces(out, OPTIONS);
  // Every field faces writes, but the detector's own timings, and the size and length every reader checks against the clip.
  assert.deepEqual(Object.keys(written).sort(), Object.keys(found).filter((k) => k !== 'detector').sort());
  assert.deepEqual([written.width, written.height, written.durationSec], [found.width, found.height, found.durationSec]);
  const samples = written.shots.flatMap((shot) => shot.samples);
  let compared = 0;
  for (const s of found.shots.flatMap((shot) => shot.samples)) {
    const mine = samples.find((x) => Math.abs(x.sec - s.sec) < 0.002);
    if (!mine) continue;
    compared++;
    assert.equal(mine.faces.length, s.faces.length, `${s.sec} s: ${mine.faces.length} boxes written, ${s.faces.length} found`);
    for (const f of s.faces) {
      const best = Math.max(...mine.faces.map((g) => iou(f, g)));
      assert.ok(best >= 0.6, `${s.sec} s: the face found at ${JSON.stringify(f)} overlaps the boxes written by ${best.toFixed(2)} of their union`);
    }
  }
  assert.ok(compared >= 0.9 * samples.length, `${compared} of ${samples.length} samples taken at the same moments`);
});
