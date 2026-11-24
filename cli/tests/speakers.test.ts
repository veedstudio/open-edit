// faces --speakers: a speakers file (the shots, each face's track and who is speaking) mapped into faces.json. The
// mapper runs on small made-up files; the command runs on the talking-head fixture with real ffmpeg and no detector,
// and reframe and apply-edl's box-moving code are run on what it writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faces, facesFromSpeakers, findFaces, readFaces } from '../src/commands/faces.ts';
import { cropFor, cropMoves } from '../src/commands/reframe.ts';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { ANALYSIS_ENV, AnalysisFailed, analysisNamed, runAnalysis, sendable, whyNotSent } from '../src/faces/analysis.ts';
import type { Spawn } from '../src/faces/mediapipe.ts';
import { facesOnCut, type CutPicture, type RangeOnCut } from '../src/faces/onto-cut.ts';
import { facesApi, facesScript, type FacesClip } from '../src/faces/page-script.ts';
import { shotSizeOf } from '../src/faces/shot-size.ts';
import {
  asFaceBox, facesAt, notSpeakersOf, readSpeakers, shotBounds, showRuns, SPEAKERS_BYTES, SPEAKERS_MODEL, SpeakersRefused, SpeakersUnread, type ClipMeasure, type SpeakersFile,
  type SpeakersFrame, type SpeakersShot, type SpeakersTrack,
} from '../src/faces/speakers.ts';
import { probeVideoSpan } from '../src/probe.ts';
import type { Http } from '../src/providers/fal.ts';
import { runCommand, shownLine, type Ran, type Runner } from '../src/providers/fal-command.ts';
import { falRoute, type FalRoute } from '../src/providers/fal-route.ts';
import { stubDetector } from './helpers/face-stub.ts';
import { scratchDir } from './helpers/synth.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/talking-head.mp4', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const HD = { width: 1920, height: 1080 };
const ms = (t: number) => Number(t.toFixed(3));
// What the page code hands back is made in its own context, so it is compared as JSON.
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
type Box = SpeakersFrame['bbox'];
/** A box of a file as a sample holds it, where all of it is inside the frame: the span the detector draws, on whole pixels. */
function seen(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const box = asFaceBox({ x, y, w, h });
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
}

/** A track with a frame every 1/`fps` s from `start` up to `end`, each frame's box and flag from its time and number. */
function track(id: number, start: number, end: number, fps: number, at: (t: number, n: number) => { bbox: Box; speaking?: boolean }): SpeakersTrack {
  const frames: SpeakersFrame[] = [];
  for (let n = Math.round(start * fps); n / fps < end - 1e-9; n++) frames.push({ t: ms(n / fps), speaking: false, ...at(n / fps, n) });
  return { id, start: ms(start), end: ms(end), frames };
}
const still = (bbox: Box, speaking = false) => () => ({ bbox, speaking });
const shot = (start: number, end: number, tracks: SpeakersTrack[], show: number[][] = [tracks.length ? [tracks[0].id] : []]): SpeakersShot => ({
  start, end, tracks, suggested: show.map((ids, i) => ({ start: ms(start + ((end - start) * i) / show.length), end: ms(start + ((end - start) * (i + 1)) / show.length), show: ids })),
});
const fileOf = (shots: SpeakersShot[], over: Partial<SpeakersFile> = {}): SpeakersFile =>
  ({ version: 1, duration: shots.at(-1)?.end ?? 1, ...HD, first_frame: 0, shots, ...over });
const measured = (file: SpeakersFile, over: Partial<ClipMeasure> = {}): ClipMeasure =>
  ({ width: file.width, height: file.height, start: 0, end: file.duration, frame: 1 / 30, container: file.duration, ...over });
const FILES = scratchDir('speakers');
let files = 0;
/** `file` as a speakers.json in a folder of its own. */
function written(file: object): string {
  const dir = join(FILES, String(files++));
  mkdirSync(dir);
  writeFileSync(join(dir, 'speakers.json'), JSON.stringify(file));
  return join(dir, 'speakers.json');
}

test('speakers: a lone face is one box a sample, the median of its jittering frames, and speaking when most of them are', () => {
  // The box jitters by 12 px from frame to frame, one frame finds it far off, and the flag drops for a frame.
  const lone = track(0, 0, 2, 30, (t, n) => ({ bbox: [n === 18 ? 900 : n % 2 ? 606 : 594, 360, 300, 340], speaking: t >= 0.5 && t < 1 && n !== 18 }));
  const one = shot(0, 2, [lone]);
  // The quarter second around 0.625 s holds frames 15 to 22: four at 606, three at 594 and the stray.
  assert.deepEqual(facesAt(one, 0.625, 0.125, HD), [{ ...seen(606, 360, 300, 340), track: 0, speaking: true }]);
  // Around 1.5 s, frames 42 to 48: four at 594 and three at 606.
  assert.deepEqual(facesAt(one, 1.5, 0.125, HD), [{ ...seen(594, 360, 300, 340), track: 0, speaking: false }]);
  // One frame's flag is not a speaker: frame 15 alone speaks in the quarter second around 0.4 s.
  assert.equal(facesAt(one, 0.4, 0.125, HD)[0].speaking, false);
  assert.deepEqual(showRuns(one), [{ start: 0, end: 2, tracks: [0] }]);
  // A box over the frame's edge is cut at it, and one wholly outside is dropped, as a detection is.
  const edge = shot(0, 2, [track(0, 0, 2, 30, still([1800, 900, 300, 340])), track(1, 0, 2, 30, still([2000, 0, 50, 50]))]);
  assert.deepEqual(facesAt(edge, 1, 0.125, HD), [{ x: 1779, y: 851, w: 141, h: 229, track: 0, speaking: false }]);
});

test('speakers: a box of the file is widened about its centre, made taller and raised to the span the detector draws', () => {
  assert.deepEqual(seen(100, 200, 100, 100), { x: 93, y: 186, w: 114, h: 108 });
  const { x, w } = asFaceBox({ x: 100, y: 200, w: 100, h: 100 });
  assert.ok(Math.abs(x + w / 2 - 150) < 1e-9, 'the centre across stays where the file has it');
});

test('speakers: three faces in a shot are three boxes, each on its track, and a run names the top and the bottom one to show', () => {
  const three = shot(5, 8, [
    track(0, 5, 8, 30, still([200, 300, 240, 280])),
    track(1, 5, 8, 30, still([840, 320, 230, 270])),
    track(2, 5, 8, 30, still([1480, 310, 250, 290], true)),
    // Someone who comes into the shot halfway through it.
    track(3, 6.5, 8, 30, still([20, 600, 150, 170])),
  ], [[2], [2, 0]]);
  assert.deepEqual(facesAt(three, 6, 0.125, HD), [
    { ...seen(200, 300, 240, 280), track: 0, speaking: false },
    { ...seen(840, 320, 230, 270), track: 1, speaking: false },
    { ...seen(1480, 310, 250, 290), track: 2, speaking: true },
  ]);
  assert.deepEqual(facesAt(three, 7, 0.125, HD).map((f) => f.track), [0, 1, 2, 3]);
  assert.deepEqual(showRuns(three), [{ start: 5, end: 6.5, tracks: [2] }, { start: 6.5, end: 8, tracks: [2, 0] }]);
  // A track's end is the first instant it is gone, and its first frame can read half a millisecond late.
  assert.deepEqual(facesAt(three, 8, 0.125, HD), []);
  assert.deepEqual(facesAt(three, 6.4996, 0.125, HD).map((f) => f.track), [0, 1, 2, 3]);
});

test('speakers: a transition between two shots with faces is split at its middle, one beside a shot with none goes whole to the face\'s shot, and a sample in it shows no face', () => {
  const a = shot(0, 2, [track(0, 0, 2, 30, still([100, 100, 200, 200]))]);
  const b = shot(2.5, 4, [track(0, 2.5, 4, 30, still([900, 100, 200, 200]))]);
  const c = shot(4, 6, []);
  const file = fileOf([a, b, c]);
  assert.deepEqual(shotBounds(file, 6.02), [0, 2.25, 4, 6.02], 'as many shots, none leaving time out, the last to the clip\'s end');
  assert.deepEqual(facesAt(a, 2.1, 0.125, HD), [], 'the first shot\'s half of the transition');
  assert.deepEqual(facesAt(b, 2.4, 0.125, HD), [], 'and the second\'s');
  assert.equal(facesAt(b, 2.5, 0.125, HD).length, 1);
  // A fade between a shot with a face and one with none stays with the face, which is on screen through it.
  const out = shot(6.5, 8, []);
  const back = shot(8.4, 10, [track(0, 8.4, 10, 30, still([100, 100, 200, 200]))]);
  assert.deepEqual(shotBounds(fileOf([a, b, c, out, back]), 10), [0, 2.25, 4, 6.25, 8, 10], 'two shots without a face split theirs');
  assert.deepEqual(shotBounds(fileOf([a, out, back]), 10), [0, 6.5, 8, 10], 'the fade out to the first, the fade in to the last');
});

test('speakers: a picture that starts after the clock does opens its first shot at 0, and the file is held to that start', () => {
  const late = fileOf([shot(1, 3, [track(0, 1, 3, 30, still([100, 100, 200, 200]))]), shot(3, 5, [])], { first_frame: 1, duration: 5 });
  assert.deepEqual(shotBounds(late, 5), [0, 3, 5]);
  assert.equal(notSpeakersOf(late, measured(late, { start: 1 })), null);
  assert.match(notSpeakersOf(late, measured(late)) ?? '', /puts its first frame at 1\.000 s where this clip's is at 0\.000 s, so its times are on another clock/);
  // The file's times are used unshifted, so half a frame off is already another frame: 20 ms at 30 frames a second is, 10 ms is not.
  assert.match(notSpeakersOf({ ...late, first_frame: 1.02 }, measured(late, { start: 1 })) ?? '', /puts its first frame at 1\.020 s where this clip's is at 1\.000 s/);
  assert.equal(notSpeakersOf({ ...late, first_frame: 1.01 }, measured(late, { start: 1 })), null);
  assert.equal(notSpeakersOf({ ...late, first_frame: 1.02 }, measured(late, { start: 1, frame: 1 / 24 })), null, 'half of a longer frame');
  // A nominal rate that is a timebase makes half a frame less than the file's own rounding to the millisecond, which is still allowed.
  assert.equal(notSpeakersOf({ ...late, first_frame: 1.0004 }, measured(late, { start: 1, frame: 1 / 90000 })), null);
  assert.match(notSpeakersOf({ ...late, first_frame: 1.002 }, measured(late, { start: 1, frame: 1 / 90000 })) ?? '', /on another clock/);
  // What a file calls the clip's length may be the picture's own, or the container's, which a longer sound stretches.
  assert.equal(notSpeakersOf({ ...late, duration: 4 }, measured(late, { start: 1, container: 5.4 })), null);
  assert.equal(notSpeakersOf({ ...late, duration: 5.4 }, measured(late, { start: 1, container: 5.4 })), null);
  assert.equal(notSpeakersOf({ ...late, duration: 5.4 }, measured(late, { start: 1, container: null })) === null, false);
});

test('speakers: a 60 fps clip analysed at 30 is read between its analysed frames', () => {
  // A face moving 300 px a second, found on every other frame of the clip.
  const moving = shot(0, 2, [track(0, 0, 2, 30, (t, n) => ({ bbox: [Math.round(100 + 300 * t), 400, 200, 240], speaking: n >= 30 }))]);
  const between = 1 + 1 / 60;
  // A span with no analysed frame in it: in proportion between the frames at 1.000 and 1.033 s.
  assert.deepEqual(facesAt(moving, between, 0.01, HD), [{ ...seen(405, 400, 200, 240), track: 0, speaking: true }]);
  // The quarter second around it holds four frames before and four after, and comes to the same place.
  assert.deepEqual(facesAt(moving, between, 0.125, HD), [{ ...seen(405, 400, 200, 240), track: 0, speaking: true }]);
  // On an analysed frame, that frame; between a silent frame and a speaking one, not speaking.
  assert.deepEqual(facesAt(moving, 1, 0.01, HD), [{ ...seen(400, 400, 200, 240), track: 0, speaking: true }]);
  assert.deepEqual(facesAt(moving, 1 - 1 / 60, 0.01, HD), [{ ...seen(395, 400, 200, 240), track: 0, speaking: false }]);
  // Past its last analysed frame and before its end, the track holds that frame.
  assert.deepEqual(facesAt(moving, 2 - 1 / 60, 0.01, HD).map((f) => f.x), [seen(690, 400, 200, 240).x]);
});

test('speakers: a file for another clip, of another version, or without what faces reads is refused in words', () => {
  const file = fileOf([shot(0, 6, [track(0, 0, 6, 30, still([100, 100, 200, 200]))])]);
  assert.equal(notSpeakersOf(file, measured(file)), null);
  assert.equal(notSpeakersOf(file, measured(file, { end: 6.03, container: null })), null, 'a clip measured a frame apart is the same clip');
  assert.match(notSpeakersOf(file, measured(file, { width: 640, height: 360 })) ?? '', /is for a clip 1920x1080 and 6\.000 s long, not this one, 640x360 and 6\.000 s long/);
  assert.match(notSpeakersOf(file, measured(file, { end: 10.01, container: 10.01 })) ?? '', /is for a clip 1920x1080 and 6\.000 s long, not this one, 1920x1080 and 10\.010 s long/);
  const past = fileOf([shot(0, 3, []), shot(5.98, 6, [])]);
  assert.match(notSpeakersOf(past, measured(past, { end: 5.97 })) ?? '', /has a shot from 5\.980 s, past this clip's end at 5\.970 s/);

  assert.deepEqual(readSpeakers(written({ ...file, fps: 30, analysis_fps: 30, more: 'unread' })).shots.length, 1, 'fields faces does not read are passed over');
  assert.throws(() => readSpeakers(written({ ...file, version: 2 })), (e: Error) => e instanceof SpeakersRefused && /speakers\.json is a speakers file of version 2, and faces reads version 1$/.test(e.message));
  const refused = (broken: object, why: RegExp) => assert.throws(() => readSpeakers(written(broken)),
    (e: Error) => e instanceof SpeakersRefused && /is not a speakers file faces can read/.test(e.message) && why.test(e.message));
  refused([], /not an object/);
  // A truncated answer, or a kept file damaged on disk, is refused as a file, not thrown as a parse error.
  const cut = written(file);
  writeFileSync(cut, readFileSync(cut, 'utf8').slice(0, 200));
  assert.throws(() => readSpeakers(cut), (e: Error) => e instanceof SpeakersRefused && /is not a speakers file faces can read \(not JSON\)/.test(e.message));
  assert.throws(() => readSpeakers(join(FILES, 'absent.json')), (e: Error) => !(e instanceof SpeakersRefused) && /ENOENT/.test(e.message), 'a file that is not there is not a refusal of it');
  refused({ shots: [] }, /no version/);
  refused({ ...file, width: undefined }, /no width, height or duration/);
  refused({ ...file, first_frame: undefined }, /no first_frame/);
  // A file with no shot would map to a clip with no face in it, and no detector would have looked.
  refused({ ...file, shots: [] }, /no shots/);
  refused({ ...file, shots: [shot(0, 3, []), shot(2, 6, [])] }, /a shot that starts before the one ahead of it ends/);
  refused({ ...file, shots: [shot(3, 6, []), shot(0, 3, [])] }, /a shot that starts before the one ahead of it ends/);
  refused({ ...file, shots: [{ ...file.shots[0], suggested: [{ start: 0, end: 6, show: [4] }] }] }, /shot 1 of 1: a suggested run .* showing a track the shot does not have/);
  // Runs out of order, or overlapping, would lose one of them when the shot is framed.
  refused({ ...file, shots: [{ ...file.shots[0], suggested: [{ start: 3, end: 6, show: [0] }, { start: 0, end: 3, show: [] }] }] }, /shot 1 of 1: a suggested run that starts before the one ahead of it ends/);
  refused({ ...file, shots: [{ ...file.shots[0], suggested: [{ start: 0, end: 4, show: [0] }, { start: 3, end: 6, show: [] }] }] }, /a suggested run that starts before the one ahead of it ends/);
  const [first, second, ...rest] = file.shots[0].tracks[0].frames;
  const framed = (frames: SpeakersFrame[]) => ({ ...file, shots: [{ ...file.shots[0], tracks: [{ ...file.shots[0].tracks[0], frames }] }] });
  refused(framed([second, first, ...rest]), /track 0 has a frame .* not after the frame ahead of it/);
  refused(framed([first, { ...second, t: first.t }, ...rest]), /track 0 has a frame .* not after the frame ahead of it/);
  refused(framed([]), /track 0 has no frames/);
});

test('speakers: a file with a sliver shot or more tracks in a shot than faces maps is refused before any frame is read', () => {
  const { spawn, ran } = ffmpegOnly();
  const sized = (shots: SpeakersShot[]) => written({ version: 1, duration: 10.01, width: 640, height: 360, first_frame: 0, shots });
  const fails = (shots: SpeakersShot[], why: RegExp) => assert.throws(() => facesFromSpeakers(FIXTURE, sized(shots), { every: 1, margin: 0.25 }, spawn),
    (e: Error) => e instanceof SpeakersRefused && why.test(e.message));
  fails(Array.from({ length: 800 }, (_, k) => shot(ms(k * 0.005), ms((k + 1) * 0.005), [])), /has a shot from 0\.000 to 0\.005 s, shorter than one frame of this clip/);
  const crowd = (n: number, start: number, end: number) => Array.from({ length: n }, (_, id) => track(id, start, end, 30, still([10, 10, 50, 50])));
  fails([shot(0, 1, crowd(101, 0, 1)), shot(1, 10.01, [])], /has 101 tracks in the shot from 0\.000 s, and faces maps at most 100 a shot/);
  assert.throws(() => facesFromSpeakers(FIXTURE, sized([shot(0, 1, crowd(101, 0, 1)), shot(1, 10.01, [])]), { every: 1, margin: 0.25 }, spawn), (e: SpeakersRefused) => e.another === false);
  assert.throws(() => facesFromSpeakers(FIXTURE, sized([shot(0, 0.005, []), shot(0.005, 10.01, [])]), { every: 1, margin: 0.25 }, spawn), (e: SpeakersRefused) => e.another === true);
  // A shot said to run far past the clip buys no more tracks: the cap does not grow with what the file says.
  fails([shot(0, 1e9, crowd(101, 0, 1))], /has 101 tracks in the shot from 0\.000 s/);
  assert.equal(ran.length, 0);
  // Thirty tracks in a second, a hundred in a shot, and three in a shot of one frame (a cutaway to a group) are a clip's.
  const frame = 1001 / 30000;
  const group = Array.from({ length: 3 }, (_, id): SpeakersTrack => ({ id, start: 5, end: ms(5 + frame), frames: [{ t: 5.005, bbox: [10 + 100 * id, 10, 50, 50], speaking: false }] }));
  const mapped = facesFromSpeakers(FIXTURE, sized([shot(0, 1, crowd(30, 0, 1)), shot(1, 5, crowd(100, 1, 5)), shot(5, ms(5 + frame), group), shot(ms(5 + frame), 10.01, [])]),
    { every: 1, margin: 0.25 }, spawn);
  assert.deepEqual(mapped.shots.map((s) => Math.max(...s.samples.map((x) => x.faces.length))), [30, 100, 3, 0]);
  // A last shot that says it ends long after the clip ends where the clip does.
  assert.equal(facesFromSpeakers(FIXTURE, sized([shot(0, 1e9, crowd(5, 0, 10))]), { every: 1, margin: 0.25 }, spawn).shots[0].end, 10.01);
});

test('speakers: however many short shots a file names, the clip is read twice and no oftener, and shots that do not follow one another are refused unread', () => {
  // Sixty shots of five frames each: every one is sampled too few times by the grid, and each is asked for frames of its own.
  const frame = 1001 / 30000;
  const many = Array.from({ length: 60 }, (_, k) => shot(ms(k * 5 * frame), k === 59 ? 10.01 : ms((k + 1) * 5 * frame), []));
  const { spawn, ran } = ffmpegOnly();
  const clip = facesFromSpeakers(FIXTURE, written({ version: 1, duration: 10.01, width: 640, height: 360, first_frame: 0, shots: many }), { every: 1, margin: 0.25 }, spawn);
  assert.equal(ran.length, 2, 'the grid, and one read of every frame\'s time');
  assert.equal(clip.shots.length, 60);
  for (const s of clip.shots) {
    assert.ok(s.samples.length >= 4, `${s.start}-${s.end} s has ${s.samples.length} sample(s)`);
    assert.ok(s.samples[0].sec - s.start <= frame / 2, `${s.start}-${s.end} s is first sampled at ${s.samples[0].sec} s, past its own first frame`);
    for (const x of s.samples) assert.ok(x.sec >= s.start && x.sec < s.end, `${x.sec} s lies outside ${s.start}-${s.end} s`);
  }
  // A shot whose first frame lies exactly where it is asked for keeps that frame: 3.004 s is the fixture's frame 90 to the tick.
  const exact = facesFromSpeakers(FIXTURE, written({ version: 1, duration: 10.01, width: 640, height: 360, first_frame: 0,
    shots: [shot(0, 3.004, []), shot(3.004, 3.17, []), shot(3.17, 10.01, [])] }), { every: 1, margin: 0.25 }, ffmpegOnly().spawn);
  assert.ok(exact.shots[1].samples[0].sec - 3.004 <= frame / 2, `the shot from 3.004 s is first sampled at ${exact.shots[1].samples[0].sec} s, a frame past its own first`);
  // At a thousand frames a second a shot of a tenth of a microsecond is a frame long by the file's rounding, and the one after it can start before it.
  const fast = join(FILES, 'fast.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=1000', '-t', '0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fast]);
  const tangled = written({ version: 1, duration: probeVideoSpan(fast).end, width: 64, height: 36, first_frame: 0,
    shots: [shot(0, 0.1, []), { start: 0.1, end: 0.1000001, tracks: [], suggested: [] }, shot(0.0995, 0.2, [])] });
  const read = ffmpegOnly();
  assert.throws(() => facesFromSpeakers(fast, tangled, { every: 0.05, margin: 0.25 }, read.spawn), (e: Error) => e instanceof SpeakersRefused && /has shots that do not follow one another on this clip/.test(e.message));
  assert.equal(read.ran.length, 0);
});

test('speakers: shots no frame could be read from are named, eight of them and how many more', () => {
  // Eighteen shots of half a second, of which a grid of four seconds samples two; the read of the frame times comes back empty.
  const shots = Array.from({ length: 18 }, (_, k) => shot(ms(Math.floor(k / 2) + (k % 2) * 0.5), k === 17 ? 10.01 : ms(Math.floor((k + 1) / 2) + ((k + 1) % 2) * 0.5), []));
  const spawn = ((cmd: string, args: string[], opts: object) => (args.some((a) => a.includes('showinfo@more'))
    ? { status: 0, signal: null, stdout: '', stderr: '[showinfo@more @ 0x1] config in time_base: 1/30000, frame_rate: 30000/1001\n' }
    : spawnSync(cmd, args, opts))) as unknown as Spawn;
  assert.throws(() => facesFromSpeakers(FIXTURE, written({ version: 1, duration: 10.01, width: 640, height: 360, first_frame: 0, shots }), { every: 4, margin: 0.25 }, spawn),
    (e: Error) => /no frame could be read from (\d+\.\d{3}-\d+\.\d{3} s, ){7}\d+\.\d{3}-\d+\.\d{3} s and 8 more shots of /.test(e.message) && !/( s, ){8}/.test(e.message));
});

/** A speakers file for the talking-head fixture: its three shots, one face in each, a frame for every frame of the clip. */
function fixtureFile(over: (shots: SpeakersShot[]) => SpeakersShot[] = (shots) => shots): string {
  const fps = 30000 / 1001;
  const boxes: Box[] = [[100, 50, 80, 100], [300, 60, 90, 110], [200, 40, 100, 120]];
  const cuts = [0, 74, 245, 300];
  const shots = boxes.map((bbox, k) => {
    const [start, end] = [cuts[k] / fps, cuts[k + 1] / fps];
    return shot(ms(start), ms(end), [track(0, start, end, fps, (_, n) => ({ bbox, speaking: n % 3 > 0 }))]);
  });
  return written({ version: 1, duration: 10.01, width: 640, height: 360, fps: ms(fps), analysis_fps: ms(fps), first_frame: 0, shots: over(shots) });
}

/** ffmpeg and nothing else: a detector started here fails the test. */
function ffmpegOnly(): { spawn: Spawn; ran: string[][] } {
  const ran: string[][] = [];
  const spawn = ((cmd: string, args: string[], opts: object) => {
    assert.equal(cmd, FFMPEG, `faces started ${cmd}`);
    ran.push(args);
    return spawnSync(cmd, args, opts);
  }) as unknown as Spawn;
  return { spawn, ran };
}

test('faces --speakers: the fixture gets the file\'s shots and boxes on the frames faces samples anyway, with no detector and no scene detection', () => {
  const { spawn, ran } = ffmpegOnly();
  const clip = facesFromSpeakers(FIXTURE, fixtureFile(), { every: 1, margin: 0.25 }, spawn);
  assert.deepEqual(clip.shots.map((s) => [s.start, s.end]), [[0, 2.469], [2.469, 8.175], [8.175, 10.01]]);
  assert.deepEqual([clip.model, clip.threshold, clip.confidence, clip.detector, clip.textMargin], [SPEAKERS_MODEL, undefined, undefined, undefined, 0.25]);
  assert.match(SPEAKERS_MODEL, /^speakers-file-v1-mapping-\d+$/, 'the file\'s version and the mapping\'s own revision');
  assert.ok(!ran.flat().some((arg) => /scdet|\.png/.test(arg)), 'no cut is looked for and no still written');
  // With every shot sampled often enough by the grid, the clip is decoded once: no shot asks for frames of its own.
  const once = ffmpegOnly();
  facesFromSpeakers(FIXTURE, fixtureFile(), { every: 0.25, margin: 0.25 }, once.spawn);
  assert.equal(once.ran.length, 1);

  // The same frames as faces samples with its own cuts, a shot's first frame read at the file's rounded start.
  const own = findFaces(FIXTURE, { every: 1, threshold: 10, confidence: 0.5, margin: 0.25 }, stubDetector(() => [[10, 20, 30, 40]]));
  assert.deepEqual(clip.shots.map((s) => s.samples.length), own.shots.map((s) => s.samples.length));
  clip.shots.forEach((s, k) => s.samples.forEach((x, i) => {
    assert.ok(Math.abs(x.sec - own.shots[k].samples[i].sec) < 0.001, `${x.sec} s is not faces' own sample at ${own.shots[k].samples[i].sec} s`);
    assert.ok(x.sec >= s.start && x.sec < s.end, `${x.sec} s lies outside ${s.start}-${s.end} s`);
  }));
  assert.deepEqual(clip.graphics, own.graphics, 'the graphics are found on the same grey frames');

  const boxes = [seen(100, 50, 80, 100), seen(300, 60, 90, 110), seen(200, 40, 100, 120)];
  clip.shots.forEach((s, k) => {
    for (const x of s.samples) assert.deepEqual(x.faces, [{ ...boxes[k], track: 0, speaking: true }], `${x.sec} s`);
    assert.deepEqual(s.show, [{ start: s.start, end: s.end, tracks: [0] }]);
  });

  // What it writes reads back as any faces.json, and a page gets it whole.
  const path = join(FILES, 'faces.json');
  writeFileSync(path, JSON.stringify(clip));
  assert.deepEqual(readFaces(path), JSON.parse(JSON.stringify(clip)));
  assert.equal(facesApi(clip).boxes(0, 2).length, 1);
  assert.deepEqual(json(facesApi(clip).clips[clip.video].shots[1].show), clip.shots[1].show);
});

test('faces --speakers: a transition the file leaves out of both shots is split between them, and its samples show no face', () => {
  // The second shot's first half second belongs to no shot of the file.
  const gap = fixtureFile(([a, b, c]) => [a, { ...b, start: 2.969, tracks: b.tracks.map((t) => ({ ...t, start: 2.969, frames: t.frames.filter((f) => f.t >= 2.969) })) }, c]);
  const clip = facesFromSpeakers(FIXTURE, gap, { every: 0.25, margin: 0.25 }, ffmpegOnly().spawn);
  assert.deepEqual(clip.shots.map((s) => s.start), [0, 2.719, 8.175]);
  const faceless = clip.shots.flatMap((s) => s.samples.filter((x) => !x.faces.length).map((x) => x.sec));
  assert.ok(faceless.length >= 2 && faceless.every((sec) => sec >= 2.469 && sec < 2.969), `samples without a face at ${faceless.join(', ')} s`);
});

test('faces --speakers: a clip whose picture starts after its sound has each moving box at its own second', () => {
  // The fixture's picture a second after an 11 s tone, so its frames run from 1 s and its first frame is at 1 s.
  const late = join(FILES, 'late.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-itsoffset', '1', '-i', FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=11',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', late]);
  // One face across the whole picture, 20 px a second to the right, timed on that clock.
  const x = (t: number) => 100 + 20 * t;
  const file = written({ version: 1, duration: 11.01, width: 640, height: 360, first_frame: 1, shots: [
    shot(1, 11.01, [track(0, 1, 11.01, 30000 / 1001, (t) => ({ bbox: [Math.round(x(t)), 100, 80, 100] }))]),
  ] });
  const clip = facesFromSpeakers(late, file, { every: 1, margin: 0.25 }, ffmpegOnly().spawn);
  assert.deepEqual(clip.shots.map((s) => [s.start, s.end]), [[0, 11.01]], 'the shot opens at 0, where a player shows the first frame');
  const { samples } = clip.shots[0];
  assert.ok(samples.length >= 10 && samples[0].sec >= 1, `sampled from the first frame: ${samples.map((s) => s.sec).join(', ')}`);
  for (const sample of samples.slice(1, -1)) {
    const want = seen(x(sample.sec), 100, 80, 100).x;
    assert.ok(Math.abs(sample.faces[0].x - want) <= 1, `at ${sample.sec} s the box is at ${sample.faces[0].x}, and the face at ${want}`);
  }
  // The same file read against a clip whose picture starts at 0 is on another clock.
  assert.throws(() => facesFromSpeakers(FIXTURE, written({ ...JSON.parse(readFileSync(file, 'utf8')), duration: 10.01 }), { every: 1, margin: 0.25 }),
    (e: Error) => e instanceof SpeakersRefused && /so its times are on another clock/.test(e.message));
});

test('faces --speakers: a speakers file made for another clip stops the command before any frame is read', () => {
  const { spawn, ran } = ffmpegOnly();
  const other = written(fileOf([shot(0, 6, [])]));
  // The refusal names what is wrong and leaves the remedy to whoever passed the file.
  assert.throws(() => facesFromSpeakers(FIXTURE, other, { every: 1, margin: 0.25 }, spawn),
    (e: Error) => e instanceof SpeakersRefused && /speakers\.json is for a clip 1920x1080 and 6\.000 s long, not this one, 640x360 and 10\.010 s long$/.test(e.message));
  assert.throws(() => facesFromSpeakers(FIXTURE, join(FILES, 'none.json'), { every: 1, margin: 0.25 }, spawn), /no speakers file at .*none\.json/);
  assert.equal(ran.length, 0);
});

/**
 * faces run in this process on a workspace of its own with no MediaPipe, and what it printed to each stream; `live`
 * gets each line of stdout as it is printed.
 */
async function runFaces(root: string, args: string[], deps: object = {}, live: string[] = []): Promise<{ out: string; err: string; result: number | string }> {
  const before = { ...process.env };
  const [log, error] = [console.log, console.error];
  const err: string[] = [];
  Object.assign(process.env, { OPEN_EDIT_ROOT: root, OPENEDIT_STATE_DIR: join(root, 'state') });
  console.log = (...a: unknown[]) => { live.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try {
    const result = await faces(args, deps).then((code): number | string => code, (e: Error) => e.message);
    return { out: live.join('\n'), err: err.join('\n'), result };
  } finally {
    [console.log, console.error] = [log, error];
    for (const key of ['OPEN_EDIT_ROOT', 'OPENEDIT_STATE_DIR']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test('faces --speakers: each refusal ends in the way on that fits it, and a file too large, a folder or a pipe is never opened', async () => {
  const root = scratchDir('speakers-refused');
  const made = fixtureFile();
  assert.equal((await runFaces(root, [FIXTURE, '--out', join(root, 'named'), '--speakers', made])).result, 0);
  // Each refusal ends in the way on that fits it. Another clip's file: name this clip's, or go without.
  const handed = async (file: string) => String((await runFaces(root, [FIXTURE, '--out', join(root, 'named'), '--speakers', file])).result);
  const both = /: name the speakers file made for .*talking-head\.mp4 as it is now, or leave out --speakers, and faces finds the shots and the faces itself$/;
  const without = /[^,] leave out --speakers, and faces finds the shots and the faces itself$/;
  const fields = JSON.parse(readFileSync(made, 'utf8')) as SpeakersFile;
  assert.match(await handed(written({ ...fields, width: 1920, height: 1080 })), both);
  // One past what faces maps is past it whoever it was made for: its version, its tracks, its size.
  for (const [file, why] of [
    [written({ ...fields, version: 2 }), /is a speakers file of version 2, and faces reads version 1:/],
    [written({ ...fields, shots: [shot(0, 10.01, Array.from({ length: 101 }, (_, id) => track(id, 0, 1, 30, still([10, 10, 50, 50]))))] }), /has 101 tracks in the shot from 0\.000 s, and faces maps at most 100 a shot:/],
  ] as const) {
    const said = await handed(file);
    assert.match(said, why);
    assert.match(said, without);
    assert.doesNotMatch(said, /name the speakers file made for/);
  }
  // A file larger than any speakers file is refused by its size, before it is opened: here it holds nothing to parse.
  const huge = written({});
  truncateSync(huge, SPEAKERS_BYTES + 1);
  const large = await handed(huge);
  assert.match(large, /speakers\.json is 32\.0 MB, and faces reads a speakers file of at most 32 MB: leave out --speakers/);
  assert.doesNotMatch(large, /name the speakers file made for|not JSON/);
  assert.throws(() => readSpeakers(huge), (e: Error) => e instanceof SpeakersRefused && !e.another);
  // A folder, or a pipe that would never end, is not opened, and is no refusal of a file: nothing is said of going without one.
  const folder = join(root, 'a-folder.json');
  mkdirSync(folder);
  const things = [folder];
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [join(root, 'a-pipe.json')]);
    things.push(join(root, 'a-pipe.json'));
  }
  for (const thing of things) {
    const said = await handed(thing);
    assert.match(said, /cannot be read \(it is not a file\)$/);
    assert.doesNotMatch(said, /leave out --speakers/);
    assert.throws(() => readSpeakers(thing), (e: Error) => e instanceof SpeakersUnread && !(e instanceof SpeakersRefused));
  }
});

test('faces --speakers: the command runs with no MediaPipe installed, and reframe cuts by what it wrote and carries each track, speaker and run to its output', () => {
  const root = scratchDir('speakers-cli');
  const bare = join(root, 'state');
  mkdirSync(bare);
  const env = { ...process.env, OPEN_EDIT_ROOT: root, OPENEDIT_STATE_DIR: bare, OPENEDIT_FFMPEG: FFMPEG, OPENEDIT_FFPROBE: FFPROBE };
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', env });
  const speakers = fixtureFile();

  const without = run(['faces', FIXTURE, '--out', join(root, 'own')]);
  assert.notEqual(without.status, 0);
  assert.match(without.stderr, /MediaPipe is not installed/);
  // The usage says so of both ways to a speakers file, the hosted analysis's answer included.
  const help = run(['faces', '--help']);
  assert.match(`${help.stdout}${help.stderr}`.replace(/\s+/g, ' '),
    /Needs MediaPipe \(install-mediapipe\), except where the shots and the faces come from a speakers file: one named with --speakers, or the one a hosted analysis answers with\./);
  const steered = run(['faces', FIXTURE, '--speakers', speakers, '--threshold', '5']);
  assert.notEqual(steered.status, 0);
  assert.match(steered.stderr, /--threshold steers the cuts and the faces that faces finds itself, and with --speakers both come from the file: leave it out, or leave out --speakers/);
  const both = run(['faces', FIXTURE, '--speakers', speakers, '--local']);
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /--local finds the shots and the faces here, and --speakers takes them from a file: pass one of the two/);
  // A file that is not there says so, with what to do about it.
  const absent = run(['faces', FIXTURE, '--speakers', join(root, 'absent.json')]);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /no speakers file at .*absent\.json: name the speakers file made for .*talking-head\.mp4 as it is now, or leave out --speakers, and faces finds the shots and the faces itself/);
  // A file for another clip is refused with what to do about it, which only the caller that was passed the file can say.
  const others = run(['faces', FIXTURE, '--speakers', written(fileOf([shot(0, 6, [])]))]);
  assert.notEqual(others.status, 0);
  assert.match(others.stderr, /is for a clip 1920x1080 and 6\.000 s long, not this one, 640x360 and 10\.010 s long: name the speakers file made for .*talking-head\.mp4 as it is now, or leave out --speakers/);

  const made = run(['faces', FIXTURE, '--speakers', speakers, '--out', join(root, 'boxes')]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /faces: 3 shot\(s\) of talking-head\.mp4 \(640x360, 10\.010s\), \d+ sampled frame\(s\), faces on \d+/);
  assert.match(made.stdout, /shots and faces from the speakers file .*speakers\.json: 3 track\(s\) sampled, a face speaking on \d+ sampled frame\(s\); MediaPipe not run/);
  const boxes = join(root, 'boxes', 'faces.json');
  assert.ok(existsSync(boxes) && readFileSync(join(root, 'boxes', 'faces.js'), 'utf8').includes('"speaking":true'));
  const source = readFaces(boxes);

  const out = join(root, 'tall.mp4');
  const cut = run(['reframe', FIXTURE, '--aspect', '9:16', '--faces', boxes, '--out', out]);
  assert.equal(cut.status, 0, cut.stderr);
  assert.match(cut.stdout, /wrote the faces of tall\.mp4, its source's boxes moved with the crop, to (.*faces\.json) and /);
  const tall = readFaces(/moved with the crop, to (.*faces\.json) and /.exec(cut.stdout)![1]);
  assert.deepEqual([tall.width, tall.height, tall.model, tall.threshold], [1080, 1920, SPEAKERS_MODEL, undefined]);
  assert.deepEqual(tall.shots.map((s) => s.show), source.shots.map((s) => s.show));
  const all = tall.shots.flatMap((s) => s.samples.flatMap((x) => x.faces));
  assert.ok(all.length > 0 && all.every((f) => f.track === 0 && f.speaking === true), JSON.stringify(all.slice(0, 3)));
  // Followed as one face a shot: every box whole inside the 9:16 picture.
  assert.ok(all.every((f) => f.x > 0 && f.x + f.w < 1080), 'a face the crop followed is cut by it');
});

test('faces.json: one written before speakers files reads everywhere as before, and what a speakers file adds changes nothing a reader does', () => {
  const samples = (from: number, boxes: { x: number; y: number; w: number; h: number; score: number }[]) =>
    [0.5, 1.5, 2.5, 3.5].map((t) => ({ sec: from + t, faces: boxes }));
  const old: FacesClip = {
    video: '/media/clip.mp4', name: 'clip.mp4', width: 1920, height: 1080, fps: 30, frameRate: '30', durationSec: 8,
    model: 'blaze_face_full_range', every: 1, threshold: 10, confidence: 0.5, textMargin: 0.25,
    shots: [
      { start: 0, end: 4, samples: samples(0, [{ x: 300, y: 300, w: 200, h: 240, score: 0.9 }]) },
      { start: 4, end: 8, samples: samples(4, [{ x: 200, y: 300, w: 220, h: 270, score: 0.9 }, { x: 1400, y: 320, w: 210, h: 250, score: 0.8 }]) },
    ],
  };
  const path = join(FILES, 'old-faces.json');
  writeFileSync(path, JSON.stringify(old));
  assert.deepEqual(readFaces(path), old);

  const newer: FacesClip = {
    ...old,
    shots: old.shots.map((s, k) => ({
      ...s,
      samples: s.samples.map((x) => ({ ...x, faces: x.faces.map((f, i) => ({ ...f, track: i, speaking: i === 1 })) })),
      show: k === 0 ? [{ start: 0, end: 4, tracks: [0] }] : [{ start: 4, end: 6, tracks: [1] }, { start: 6, end: 8, tracks: [1, 0] }],
    })),
  };
  // Text placement and a shot's size read the boxes alone.
  assert.deepEqual(json(facesApi(newer).boxes(0, 8)), json(facesApi(old).boxes(0, 8)));
  assert.ok(facesScript(old).length < facesScript(newer).length && !facesScript(old).includes('"track"'));
  for (const k of [0, 1]) assert.deepEqual(shotSizeOf(newer.shots[k].samples, 1080), shotSizeOf(old.shots[k].samples, 1080));
  // A box's track and flag alone change nothing in reframe's crop. Its runs of whom to show do: the second shot,
  // held on the larger face on the left without them, is framed on the right-hand one the runs name.
  const crop = cropFor(1920, 1080, 9 / 16);
  const flagged: FacesClip = { ...newer, shots: newer.shots.map((shot) => ({ ...shot, show: undefined })) };
  assert.deepEqual(cropMoves(flagged, crop, 30, 8), cropMoves(old, crop, 30, 8));
  const [held, shown] = [cropMoves(old, crop, 30, 8).at(-1)!.at, cropMoves(newer, crop, 30, 8).at(-1)!.at];
  assert.ok(held <= 200 && 420 <= held + crop.w, `without runs the crop at ${held} holds the left face`);
  assert.ok(shown <= 1400 && 1610 <= shown + crop.w, `with them the crop at ${shown} holds the right one`);
  // A faces.json whose runs or flags are not what a reader expects is refused by name, not tripped over inside reframe.
  const broken = (clip: object, why: RegExp) => {
    writeFileSync(path, JSON.stringify(clip));
    assert.throws(() => readFaces(path), why);
  };
  const [one] = newer.shots;
  broken({ ...newer, shots: [{ ...one, show: {} }] }, /is not a faces\.json the faces command wrote \(a shot whose runs of whom to show are not each a start, an end and tracks\)/);
  broken({ ...newer, shots: [{ ...one, show: [{ start: 0, end: 4 }] }] }, /runs of whom to show are not each a start, an end and tracks/);
  broken({ ...newer, shots: [{ ...one, show: [{ start: 0, end: 4, tracks: ['a'] }] }] }, /runs of whom to show/);
  broken({ ...newer, shots: [{ ...one, show: [{ end: 4, tracks: [0] }] }] }, /runs of whom to show are not each a start, an end and tracks/);
  broken({ ...newer, shots: [{ ...one, show: [{ start: 0, tracks: [0] }] }] }, /runs of whom to show are not each a start, an end and tracks/);
  // Runs out of order or overlapping, which a speakers file is refused for too, would give reframe a part that ends before it starts.
  const disordered = /a shot whose runs of whom to show end before they start, or start before the one ahead ends/;
  broken({ ...newer, shots: [{ ...one, show: [{ start: 2, end: 4, tracks: [0] }, { start: 0, end: 2, tracks: [0] }] }] }, disordered);
  broken({ ...newer, shots: [{ ...one, show: [{ start: 0, end: 3, tracks: [0] }, { start: 2, end: 4, tracks: [0] }] }] }, disordered);
  broken({ ...newer, shots: [{ ...one, show: [{ start: 3, end: 3, tracks: [0] }] }] }, disordered);
  // Runs that meet within the file's rounding are in order, as a speakers file's are: faces reads what it wrote.
  writeFileSync(path, JSON.stringify({ ...newer, shots: [{ ...one, show: [{ start: 0, end: 2, tracks: [0] }, { start: 1.9995, end: 4, tracks: [0] }] }] }));
  assert.equal(readFaces(path).shots[0].show?.length, 2);
  const half = (face: object) => ({ ...newer, shots: [{ ...one, samples: [{ sec: 0.5, faces: [{ x: 1, y: 1, w: 9, h: 9, ...face }] }] }] });
  broken(half({ track: 0 }), /a face with a track or a speaking flag but not both/);
  broken(half({ speaking: true }), /a face with a track or a speaking flag but not both/);
  broken(half({ track: 'a', speaking: true }), /a face with a track or a speaking flag but not both/);
  writeFileSync(path, JSON.stringify(newer));
  assert.deepEqual(readFaces(path), newer);

  // A cut of it: half speed from 3 to 7 s, laid from 10 s of the cut.
  const picture: CutPicture = { video: '/media/cut.mp4', width: 1920, height: 1080, fps: 30, frameRate: '30', durationSec: 18, fit: 'crop' };
  const range = (faces: FacesClip): RangeOnCut => ({ start: 3, end: 7, fps: 30, at: 10, stretch: 2, faces, shown: { width: 1920, height: 1080 } });
  const plain = facesOnCut([range(old)], picture)!;
  assert.ok(!JSON.stringify(plain).includes('track') && !JSON.stringify(plain).includes('show'), 'nothing is added to a cut of boxes without them');
  const carried = facesOnCut([range(newer)], picture)!;
  const bare = (clip: FacesClip) => clip.shots.map((s) => ({ ...s, show: undefined, samples: s.samples.map((x) => ({ ...x, faces: x.faces.map(({ x: fx, y, w, h, score }) => ({ x: fx, y, w, h, score })) })) }));
  assert.deepEqual(bare(carried), bare(plain), 'the same shots, samples and boxes');
  assert.deepEqual(carried.shots.map((s) => s.show), [
    [{ start: 10, end: 12, tracks: [0] }],
    // The second shot's runs, each for the part of it the range plays, on the cut's clock.
    [{ start: 12, end: 16, tracks: [1] }, { start: 16, end: 18, tracks: [1, 0] }],
  ]);
  assert.deepEqual(carried.shots[1].samples[0].faces.map((f) => [f.track, f.speaking]), [[0, false], [1, true]]);
});

// --- the hosted analysis ---------------------------------------------------------------------------------------

/** A fal that answers every route the analysis touches, counting the requests bought; `result` is what a finished request answers with. */
function fakeFal(speakers: string, result?: { status: number; body: unknown }): { http: Http; submits: number } {
  const reply = (status: number, body: unknown, bytes = new Uint8Array()) => ({
    status, json: async () => body, header: () => null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  const fal = { submits: 0 } as { http: Http; submits: number };
  fal.http = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'api.fal.ai' && u.pathname === '/v1/models/pricing') return reply(200, { prices: [] });
    if (u.host === 'api.fal.ai') return reply(403, { error: 'no' });
    if (u.host === 'rest.fal.ai') return reply(200, { upload_url: 'https://upload.example/clip?sig=1', file_url: 'https://cdn.example/clip.mp4' });
    if (u.host === 'upload.example') return reply(200, {});
    if (u.host === 'queue.fal.run' && init.method === 'POST') {
      fal.submits++;
      assert.deepEqual(JSON.parse(String(init.body)), { video_url: 'https://cdn.example/clip.mp4' });
      return reply(200, { request_id: 'req-1', status_url: 'https://queue.fal.run/acme/speakers/requests/req-1/status', response_url: 'https://queue.fal.run/acme/speakers/requests/req-1' });
    }
    if (u.host === 'queue.fal.run' && u.pathname.endsWith('/status')) return reply(200, { status: 'COMPLETED' });
    if (u.host === 'queue.fal.run') {
      return result ? reply(result.status, result.body)
        : reply(200, { speakers: { url: 'https://files.example/speakers.json', content_type: 'application/json', file_name: 'speakers.json' }, duration: 10.01 });
    }
    if (u.host === 'files.example') return reply(200, {}, new Uint8Array(readFileSync(speakers)));
    throw new Error(`the fake fal has no route for ${url}`);
  };
  return fal;
}

test('faces: the hosted analysis is named by the environment alone, a clip it would refuse is not sent, and a fal key comes before the environment\'s fal command', () => {
  assert.equal(analysisNamed({}), null);
  assert.equal(analysisNamed({ [ANALYSIS_ENV]: '  ' }), null);
  assert.equal(analysisNamed({ [ANALYSIS_ENV]: 'acme/speakers/v1' }), 'acme/speakers/v1');
  assert.throws(() => analysisNamed({ [ANALYSIS_ENV]: 'not a model' }), /OPEN_EDIT_SPEAKERS_ANALYSIS is "not a model", which is not a fal model id/);
  const fine = { sound: true, seconds: 600, bytes: 4e9 };
  assert.equal(whyNotSent(fine), null);
  assert.match(whyNotSent({ ...fine, sound: false }) ?? '', /the clip has no sound/);
  assert.match(whyNotSent({ ...fine, seconds: 632.3 }) ?? '', /the clip is 10\.5 minutes long, and the analysis takes at most 10/);
  assert.match(whyNotSent({ ...fine, bytes: 4.2e9 }) ?? '', /the clip is 4\.2 GB, and the analysis takes at most 4/);
  assert.deepEqual(sendable(FIXTURE), { sound: false, seconds: 10.01, bytes: readFileSync(FIXTURE).length });
  const own = () => ({ fal: '/bin/fal' });
  assert.deepEqual(falRoute({ FAL_KEY: 'k'.repeat(24) }, own), { how: 'key', key: 'k'.repeat(24) });
  assert.deepEqual(falRoute({}, own), { how: 'command', fal: '/bin/fal' });
  // With neither, why: a `fal` that timed out or could not be run is said, not passed over as absent.
  assert.deepEqual(falRoute({}, () => ({ why: 'the fal command at /bin/fal did not answer --help (spawnSync /bin/fal ETIMEDOUT)' })),
    { how: 'none', why: 'no fal key is readable here, and the fal command at /bin/fal did not answer --help (spawnSync /bin/fal ETIMEDOUT)' });
  // A key that is set and cannot be read is a setting to fix: it is the reason, and the command is not turned to in its place.
  const broken = falRoute({ OPEN_EDIT_FAL_KEY_FILE: join(FILES, 'no-such-key.md') }, own);
  assert.deepEqual([broken.how, 'unreadable' in broken && broken.unreadable], ['none', true]);
  assert.match((broken as { why: string }).why, /OPEN_EDIT_FAL_KEY_FILE points at .*no-such-key\.md, which does not exist/);
  assert.equal('unreadable' in falRoute({}, () => ({ why: 'x' })), false, 'no key at all is not an unreadable one');
  // A `fal` on PATH that cannot be run is named in the reason: it is not passed over as if there were none.
  // Windows finds no command in a file without an extension, so there is none to name there.
  if (process.platform !== 'win32') {
    const bin = join(FILES, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'fal'), '#!/no/such/interpreter\n', { mode: 0o755 });
    const unrunnable = falRoute({ PATH: bin });
    assert.equal(unrunnable.how, 'none');
    assert.match((unrunnable as { why: string }).why, /no fal key is readable here, and the fal command at .*bin[\\/]fal did not answer --help \(/);
  }
  assert.deepEqual(falRoute({ PATH: join(FILES, 'empty-bin') }), { how: 'none', why: 'no fal key is readable here, and the environment gives no fal command of its own' });
});

test('faces: on a fal key the analysis is bought once, its speakers file downloaded, and a refusal that comes with the result is the reason given', async () => {
  const root = join(FILES, 'keyed');
  const run = (dir: string, fal: { http: Http }) => runAnalysis('acme/speakers', FIXTURE, {
    runDir: join(root, 'runs', 'talking-head'), dir: join(root, dir), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: fal.http, sleep: async () => {},
  });
  const fal = fakeFal(fixtureFile());
  const got = await run('first', fal);
  assert.equal(got.requestId, 'req-1');
  assert.equal(readSpeakers(got.file).shots.length, 3);
  // The same clip again resumes the request it bought, as any fal run does.
  assert.equal((await run('again', fal)).requestId, 'req-1');
  assert.equal(fal.submits, 1);
  // A clip the analysis refuses is queued and reads as finished; the refusal is the result's status.
  const refusing = fakeFal(fixtureFile(), { status: 422, body: { detail: [{ loc: ['body', 'video_url'], msg: 'File has no audio stream.', type: 'value_error' }] } });
  await assert.rejects(runAnalysis('acme/other', FIXTURE, {
    runDir: join(root, 'runs', 'refused'), dir: join(root, 'refused'), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: refusing.http, sleep: async () => {},
  }), (e: Error) => e instanceof AnalysisFailed && /fal returned 422 for a completed job: .*File has no audio stream/.test(e.message));
  // A fal that cannot be reached at all is the analysis failing, not an error of faces' own.
  const down: Http = async () => { throw new Error('getaddrinfo ENOTFOUND api.fal.ai'); };
  await assert.rejects(runAnalysis('acme/down', FIXTURE, {
    runDir: join(root, 'runs', 'down'), dir: join(root, 'down'), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: down, sleep: async () => {},
  }), (e: Error) => e instanceof AnalysisFailed && /ENOTFOUND/.test(e.message));
  // So is the fal run itself throwing, wherever it throws from: here, the first line it prints.
  await assert.rejects(runAnalysis('acme/thrown', FIXTURE, {
    runDir: join(root, 'runs', 'thrown'), dir: join(root, 'thrown'), route: { how: 'key', key: 'k'.repeat(24) }, log: () => { throw new Error('the terminal is gone'); },
    http: fakeFal(fixtureFile()).http, sleep: async () => {},
  }), (e: Error) => e instanceof AnalysisFailed && /the terminal is gone/.test(e.message));
  // An answer larger than any speakers file is not downloaded: refused by its declared length, else read no further than the size taken.
  const sized = (over: object) => {
    const fal = fakeFal(fixtureFile());
    const http: Http = async (url, init) => (new URL(url).host === 'files.example' ? { ...(await fal.http(url, init)), ...over } : fal.http(url, init));
    return { http };
  };
  const tooLarge = (name: string, over: object) => assert.rejects(runAnalysis(`acme/${name}`, FIXTURE, {
    runDir: join(root, 'runs', name), dir: join(root, name), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: sized(over).http, sleep: async () => {},
  }), (e: Error) => e instanceof AnalysisFailed && /is over the 33554432 bytes taken for it, and is not downloaded/.test(e.message));
  let read = 0;
  await tooLarge('declared', { header: (name: string) => (name === 'content-length' ? String(SPEAKERS_BYTES + 1) : null), chunks: async function* () { read++; yield new Uint8Array(1); } });
  assert.equal(read, 0, 'a length declared past the size is refused unread');
  await tooLarge('long', { chunks: async function* () { for (let k = 0; k < 64; k++) { read++; yield new Uint8Array(1 << 20); } } });
  assert.equal(read, 33, 'read up to the size taken and a megabyte past it, and no further');
  await tooLarge('whole', { arrayBuffer: async () => new ArrayBuffer(SPEAKERS_BYTES + 1) });
  // An answer that names no JSON file is one too.
  const picture = fakeFal(fixtureFile(), { status: 200, body: { speakers: { url: 'https://files.example/speakers.png', content_type: 'image/png', file_name: 'speakers.png' } } });
  await assert.rejects(runAnalysis('acme/picture', FIXTURE, {
    runDir: join(root, 'runs', 'picture'), dir: join(root, 'picture'), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: picture.http, sleep: async () => {},
  }), (e: Error) => e instanceof AnalysisFailed && /its answer held no speakers file/.test(e.message));
});

test('faces: the environment\'s own fal command is run in a folder made for that run, its lines shown and its answer the plain files it left there', async () => {
  const dir = join(FILES, 'command');
  mkdirSync(dir);
  const calls: { args: string[]; timeoutMs: number; empty: boolean }[] = [];
  // A stand-in for the command: it leaves `files` in the folder it is given, prints `stderr`, and ends as `r` says.
  const answering = (r: Partial<Ran> & { stderr?: string[]; files?: (out: string) => void }): Runner => async (_, args, o) => {
    const out = args[args.indexOf('--out') + 1];
    calls.push({ args, timeoutMs: o.timeoutMs, empty: readdirSync(out).length === 0 });
    r.files?.(out);
    for (const line of r.stderr ?? []) o.onLine(line);
    return { status: 0, signal: null, timedOut: false, ...r };
  };
  const logged: string[] = [];
  const run = (runner: Runner) => runAnalysis('acme/speakers', '/clips/a.mp4', { runDir: dir, dir, route: { how: 'command', fal: '/bin/fal' }, log: (line) => logged.push(line), run: runner });
  const done = await run(answering({
    files: (out) => writeFileSync(join(out, 'acme-speakers-abcd1234-1.json'), '{}'),
    stderr: ['fal: uploaded /clips/a.mp4 (900 KB)', 'fal: queued acme/speakers as 019-req', '\u001b[2Jfal: COMPLETED\u0007', 'Authorization: Key abc123-secret', 'retrying with Bearer tok_456 now'],
  }));
  const [first] = calls;
  const folder = first.args[4];
  assert.deepEqual(done, { file: join(folder, 'acme-speakers-abcd1234-1.json'), requestId: '019-req' });
  assert.deepEqual(first.args.slice(0, 4), ['run', 'acme/speakers', '{"video_url":"/clips/a.mp4"}', '--out']);
  assert.ok(folder.startsWith(join(dir, 'run-')) && first.empty, `${folder} is a folder of this run's own, empty when the command starts`);
  assert.equal(first.timeoutMs, 40 * 60_000, 'waited for as long as a key\'s request is');
  // A run held for approval says so through these lines: shown as they come, with no control character and no credential.
  assert.deepEqual(logged, ['fal: uploaded /clips/a.mp4 (900 KB)', 'fal: queued acme/speakers as 019-req', '[2Jfal: COMPLETED', 'Authorization: Key «redacted»', 'retrying with Bearer «redacted» now']);
  assert.equal(shownLine('{"authorization": "Bearer abc.def", "x": 1}'), '{"authorization": "Bearer «redacted»", "x": 1}');
  assert.equal(shownLine(`fal: ${'x'.repeat(5000)}`).length, 400);

  const fails = async (runner: Runner, why: RegExp) => {
    await assert.rejects(run(runner), (e: Error) => e instanceof AnalysisFailed && why.test(e.message) && !/[\u0000-\u001f\u007f-\u009f]/.test(e.message));
    assert.ok(!existsSync(calls.at(-1)!.args[4]), 'nothing of a run that gave no answer is kept');
  };
  await fails(answering({ status: 3, stderr: ['fal: refused: this generation was not approved'] }), /the environment's fal command did not run it \(exit 3\): fal: refused: this generation was not approved/);
  await fails(answering({ status: 1, stderr: ['fal: queued acme/speakers as 019-req', 'fal: 422 from https://queue.fal.run/acme/speakers/requests/019-req', 'File has no audio stream.'] }),
    /\(exit 1\): .*fal: 422 from .* File has no audio stream\./);
  // Three hundred lines of progress and then the reason: the lines shown as they come stop at two hundred, and the reason is still the one given.
  logged.length = 0;
  await fails(answering({ status: 1, stderr: [...Array.from({ length: 300 }, (_, k) => `fal: IN_PROGRESS ${k}`), 'fal: 500 from the queue', 'out of capacity'] }),
    /\(exit 1\): fal: IN_PROGRESS 299 fal: 500 from the queue out of capacity$/);
  assert.deepEqual([logged.length, logged[199], logged[200]], [201, 'fal: IN_PROGRESS 199', 'more lines from the command are not shown as they come']);
  // Stopped for never answering: the request it queued is named, since it may still run and be billed, and the next run asks again.
  await fails(answering({ status: null, signal: 'SIGKILL', timedOut: true, stderr: ['fal: queued acme/speakers as 019-held', 'fal: IN_QUEUE'] }),
    /gave no answer in 40 minutes and was stopped; request 019-held may still run and be billed, and nothing of this run is kept, so the next run asks again: .*fal: IN_QUEUE$/);
  await fails(answering({ status: null, signal: 'SIGKILL', timedOut: true }), /was stopped; any request it queued may still run and be billed, and nothing of this run is kept, so the next run asks again$/);
  await fails(answering({ status: null, signal: null, error: new Error('spawn /bin/fal ENOENT') }), /did not run it \(spawn \/bin\/fal ENOENT\)/);

  // Its answer is what it left in the folder and nothing it printed: only a plain file, of a plain name, of a size a speakers file has.
  const outside = join(FILES, 'command-other');
  mkdirSync(outside);
  writeFileSync(join(outside, 'x.json'), '{}');
  await assert.rejects(run(answering({})), (e: Error) => e instanceof AnalysisFailed && e.message === 'the environment\'s fal command left no speakers file in the folder it was given');
  // A link, a folder, a pipe, a name that would redraw a terminal and a file no speakers file is as large as: none is opened or named.
  if (process.platform !== 'win32') {
    const odd = (out: string) => {
      symlinkSync(join(outside, 'x.json'), join(out, 'link.json'));
      mkdirSync(join(out, 'folder.json'));
      writeFileSync(join(out, 'a\u001b[2J.json'), '{}');
      writeFileSync(join(out, 'huge.json'), '');
      truncateSync(join(out, 'huge.json'), SPEAKERS_BYTES + 1);
      execFileSync('mkfifo', [join(out, 'pipe.json')]);
    };
    await assert.rejects(run(answering({ files: odd })), (e: Error) => e instanceof AnalysisFailed
      && e.message === 'the environment\'s fal command left no speakers file in the folder it was given (5 thing(s) there are not a plain file of at most 32 MB)');
    const beside = await run(answering({ files: (out) => { odd(out); writeFileSync(join(out, 'b-1.json'), '{}'); writeFileSync(join(out, 'b-1.mp4'), ''); } }));
    assert.equal(beside.file, join(calls.at(-1)!.args[4], 'b-1.json'));
  }
});

/** Whether a process is still there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Whether a process is gone, waited for as long as one just killed may take to go. */
async function gone(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 3000 && alive(pid); waited += 20) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}
/** Waits for `path` to hold a pid, for as long as a loaded machine may take to start a script. */
async function pidIn(path: string): Promise<number> {
  for (let waited = 0; waited < 15_000 && !(existsSync(path) && readFileSync(path, 'utf8').trim()); waited += 50) await new Promise((r) => setTimeout(r, 50));
  return Number(readFileSync(path, 'utf8'));
}

// The command is a shell script here, as the environments that give their own `fal` run Linux, and Windows has no process group to stop.
test('faces: the environment\'s command is run for real, answered when it exits, and stopped with all it started when it never answers or faces is stopped', { skip: process.platform === 'win32' }, async () => {
  const dir = join(FILES, 'runner');
  mkdirSync(dir);
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };
  const pidFile = (name: string) => join(dir, `${name}.pid`);
  const started: string[] = [];
  const stub = (name: string) => { started.push(pidFile(name)); return pidFile(name); };
  try {
    // It prints megabytes on a stdout nobody reads, leaves a child holding its stderr, and exits 0: answered then, not when the pipe closes.
    const fal = script('fal', `out="$5"\necho 'fal: queued acme/speakers as 019-live' >&2\nprintf 'fal: IN_' >&2\nsleep 30 &\necho $! > ${stub('lingering')}\n` +
      `head -c 3000000 /dev/zero\necho 'QUEUE' >&2\necho '{}' > "$out/a-1.json"\nexit 0`);
    const logged: string[] = [];
    const began = Date.now();
    const got = await runAnalysis('acme/speakers', '/clips/a.mp4', { runDir: dir, dir: join(dir, 'out'), route: { how: 'command', fal }, log: (line) => logged.push(line) });
    assert.ok(Date.now() - began < 10_000, `answered ${Date.now() - began} ms after a command that exited at once`);
    assert.deepEqual([got.requestId, logged], ['019-live', ['fal: queued acme/speakers as 019-live', 'fal: IN_QUEUE']]);
    assert.match(got.file, /out[\\/]run-[^\\/]+[\\/]a-1\.json$/);

    // Three commands that never answer, at once, each given a second and a half to start: a new script's first run can be slow.
    // A wrapper that ignores the signal, whose child ignores it too with its output closed.
    const held = script('held', `trap '' TERM\n(trap '' TERM; exec sleep 30 >/dev/null 2>&1) &\necho $! > ${stub('held-child')}\necho $$ > ${stub('held')}\necho 'fal: IN_QUEUE' >&2\nwait`);
    // A wrapper that ends at the first signal and leaves such a child.
    const quitter = script('quitter', `(trap '' TERM; exec sleep 30 >/dev/null 2>&1) &\necho $! > ${stub('quitter-child')}\nwait`);
    // A child that left the group and holds the pipe, which cannot be stopped from here.
    const escaped = script('escaped', `perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "30"' &\necho $! > ${stub('escaped-child')}\nsleep 30`);
    const said: string[] = [];
    const from = Date.now();
    const stopped = await Promise.all([held, quitter, escaped].map((cmd) => runCommand(cmd, [], { timeoutMs: 1500, graceMs: 200, onLine: (line) => { if (cmd === held) said.push(line); } })));
    assert.deepEqual([stopped.map((r) => r.timedOut), said], [[true, true, true], ['fal: IN_QUEUE']]);
    assert.ok(Date.now() - from < 9000, `answered ${Date.now() - from} ms after a limit of a second and a half and a fifth of a second's grace, one with a child still holding the pipe`);
    // Killed after the grace whatever ended at the first signal: nothing of the command's own group outlives the runner.
    for (const name of ['held', 'held-child', 'quitter-child']) assert.ok(await gone(await pidIn(pidFile(name))), `${name} outlived the runner that stopped it`);
    // And one that cannot be started at all is an error of its own, not a hang.
    assert.match(String((await runCommand(join(dir, 'no-such-command'), [], { timeoutMs: 300, onLine: () => {} })).error), /ENOENT/);

    // Stopping the process that runs it stops the command and what it started, though they sit in a group of their own.
    const waiting = script('waiting', `(trap '' TERM; exec sleep 30) &\necho $! > ${stub('waiting-child')}\necho $$ > ${stub('waiting')}\nwait`);
    const harness = join(dir, 'harness.mts');
    writeFileSync(harness, `import { runCommand } from ${JSON.stringify(fileURLToPath(new URL('../src/providers/fal-command.ts', import.meta.url)))};\n` +
      `await runCommand(${JSON.stringify(waiting)}, [], { timeoutMs: 60_000, graceMs: 200, onLine: () => {} });\n`);
    const runner = spawn(process.execPath, ['--import', 'tsx', harness], { stdio: 'ignore' });
    const ended = new Promise<NodeJS.Signals | null>((r) => runner.on('exit', (_, signal) => r(signal)));
    try {
      const child = await pidIn(pidFile('waiting-child'));
      const wrapper = await pidIn(pidFile('waiting'));
      runner.kill('SIGTERM');
      assert.equal(await ended, 'SIGTERM', 'the process ends as the signal would have ended it');
      assert.deepEqual([await gone(wrapper), await gone(child)], [true, true], 'the command or its child outlived the process that ran it');
    } finally {
      runner.kill('SIGKILL');
    }
  } finally {
    // Whatever an assertion above left running is not left behind.
    for (const path of started) {
      const pid = existsSync(path) ? Number(readFileSync(path, 'utf8')) : NaN;
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
});

/** The fixture with a tone, since the analysis takes no clip without sound, and a speakers file that is its own. */
function soundClip(root: string): { clip: string; made: string } {
  const clip = join(root, 'talking.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', clip]);
  const made = fixtureFile();
  writeFileSync(made, JSON.stringify({ ...JSON.parse(readFileSync(made, 'utf8')), duration: probeVideoSpan(clip).end }));
  return { clip, made };
}

const env = { [ANALYSIS_ENV]: 'acme/speakers' };
/** The speakers files kept in a faces folder. */
const keptIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => /^speakers-[0-9a-f]{16}\.json$/.test(name)).map((name) => join(dir, name)).sort() : []);
const keyed = (): FalRoute => ({ how: 'key', key: 'k'.repeat(24) });

test('faces: where the environment names an analysis it is run once, on this clip and this fal, said before it runs, and its file kept for the next run', async () => {
  const root = scratchDir('speakers-analysis');
  const { clip, made } = soundClip(root);
  const out = join(root, 'boxes');
  const calls: { model: string; video: string; runDir: string; dir: string; route: FalRoute; announced: boolean }[] = [];
  const lines: string[] = [];
  // The stand-in sees what was printed before it was called: the line that says a fal account is about to be charged.
  const analysis = async (model: string, video: string, o: { runDir: string; dir: string; route: FalRoute; log: (line: string) => void }) => {
    calls.push({ model, video, runDir: o.runDir, dir: o.dir, route: o.route, announced: lines.some((line) => /running the hosted analysis/.test(line)) });
    // What fal says on the charged path reaches the user through this.
    o.log('[fal] 1 job, bills your own fal account');
    o.log('\u001b[2J\u001b[31mfal: red\u0007');
    return { file: made, requestId: 'req-7' };
  };
  const first = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis }, lines);
  assert.equal(first.result, 0, first.out);
  assert.deepEqual(calls, [{ model: 'acme/speakers', video: clip, runDir: join(root, 'runs', 'talking'), dir: join(out, 'analysis'), route: keyed(), announced: true }]);
  assert.match(first.out, /faces: running the hosted analysis OPEN_EDIT_SPEAKERS_ANALYSIS names on talking\.mp4: one generation on the fal account of the fal key this run reads, never on a VEED workspace\. Its answer is waited for up to 40 minutes/);
  assert.match(first.out, /^faces: \[fal\] 1 job, bills your own fal account$/m, 'fal\'s own lines are printed');
  // Whatever a line quotes, no control character of it reaches the terminal.
  assert.match(first.out, /^faces:  \[2J \[31mfal: red $/m);
  assert.doesNotMatch(first.out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(first.out, /faces: the hosted analysis answered in \d+ s \(request req-7\); its speakers file is kept at .*boxes[\\/]speakers-[0-9a-f]{16}\.json/);
  assert.equal(readFaces(join(out, 'faces.json')).model, SPEAKERS_MODEL);
  // One file, named for the clip's bytes and the analysis, holding the answer whole.
  assert.deepEqual(keptIn(out).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(keptIn(out)[0], 'utf8')), JSON.parse(readFileSync(made, 'utf8')));

  const second = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(calls.length, 1, 'the kept file is read, and nothing is run again');
  assert.match(second.out, /the speakers file the hosted analysis made for this clip is kept at .*speakers-[0-9a-f]{16}\.json, so the analysis is not run again/);

  // Through the environment's command the line says so, and --json keeps stdout to the clip alone.
  const viaCommand = await runFaces(root, [clip, '--out', join(root, 'command'), '--json'], { env, route: (): FalRoute => ({ how: 'command', fal: '/bin/fal' }), analysis });
  assert.equal(JSON.parse(viaCommand.out).model, SPEAKERS_MODEL, 'stdout is the clip and nothing else');
  assert.match(viaCommand.err, /one generation through the fal command the environment gives in place of a key, which prices and approves it and bills as that environment arranges\. Its answer/);
  assert.match(viaCommand.err, /the hosted analysis answered in/);
  assert.match(viaCommand.err, /^faces: \[fal\] 1 job, bills your own fal account$/m, 'and under --json they go to stderr with the rest');
  assert.doesNotMatch(viaCommand.out, /\[fal\]/);
  assert.equal(calls.length, 2);
});

test('faces: a kept speakers file is one file named for the clip\'s bytes and the analysis, and one that no longer maps is run for again', async () => {
  const root = scratchDir('speakers-kept');
  const { clip, made } = soundClip(root);
  const out = join(root, 'boxes');
  let ran = 0;
  const analysis = async () => { ran++; return { file: made, requestId: `req-${ran}` }; };
  assert.equal((await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis })).result, 0);
  assert.equal(ran, 1);
  const [first] = keptIn(out);
  // Another analysis named: its answer is another file, and the first one's is not read as it.
  const newer = { [ANALYSIS_ENV]: 'acme/newer' };
  const other = await runFaces(root, [clip, '--out', out], { env: newer, route: keyed, analysis });
  assert.equal(other.result, 0, String(other.result));
  assert.doesNotMatch(other.out, /made for this clip is kept at|is not used|undefined/);
  assert.deepEqual([ran, keptIn(out).length], [2, 2]);
  const reused = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(reused.result, 0, String(reused.result));
  assert.match(reused.out, new RegExp(`is kept at ${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, so the analysis is not run again`));
  assert.equal(ran, 2);
  // The clip rendered again at the same path, size and length: its bytes changed, so the kept shots and boxes are another picture's.
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', clip]);
  const again = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(again.result, 0, String(again.result));
  assert.doesNotMatch(again.out, /made for this clip is kept at|is not used|undefined/);
  assert.deepEqual([ran, keptIn(out).length], [3, 3]);
  // A kept file that no longer maps says why, and is run for again; so is one damaged on disk, which is not a crash.
  const fourth = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(fourth.result, 0, String(fourth.result));
  const latest = fourth.out.match(/made for this clip is kept at (\S+\.json),/)![1];
  assert.ok(keptIn(out).includes(latest) && latest !== first);
  writeFileSync(latest, JSON.stringify({ ...JSON.parse(readFileSync(made, 'utf8')), version: 2 }));
  const unmapped = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(unmapped.result, 0, String(unmapped.result));
  assert.match(unmapped.out, /the speakers file kept at .*speakers-[0-9a-f]{16}\.json is not used \(.*is a speakers file of version 2, and faces reads version 1\), so the hosted analysis is run again/);
  assert.equal(ran, 4);
  assert.equal(JSON.parse(readFileSync(latest, 'utf8')).version, 1, 'replaced by the new answer');
  writeFileSync(latest, readFileSync(latest, 'utf8').slice(0, 300));
  const damaged = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(damaged.result, 0, damaged.out);
  assert.match(damaged.out, /is not used \(.*is not a speakers file faces can read \(not JSON\)\), so the hosted analysis is run again/);
  assert.equal(ran, 5);
  // One that is there and cannot be opened is said, with why, and run for again: it does not fail every run of the clip.
  rmSync(latest);
  mkdirSync(latest);
  const closed = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis });
  assert.equal(closed.result, 0, String(closed.result));
  assert.match(closed.out, /the speakers file kept at .*speakers-[0-9a-f]{16}\.json is not used \(.* cannot be read \(it is not a file\)\), so the hosted analysis is run again/);
  assert.match(closed.out, /the hosted analysis answered in \d+ s \(request req-6\); its speakers file could not be kept at .*speakers-[0-9a-f]{16}\.json \(.*\), so the next run asks again/);
  assert.equal(readFaces(join(out, 'faces.json')).model, SPEAKERS_MODEL, 'the answer is used all the same');
  assert.equal(ran, 6);
});

test('faces: an answer that does not map is not kept and the clip is left to MediaPipe; a failure that is not the file\'s is not called one', async () => {
  const root = scratchDir('speakers-unmapped');
  const { clip, made } = soundClip(root);
  const out = join(root, 'boxes');
  const wrong = written({ ...JSON.parse(readFileSync(made, 'utf8')), width: 1920, height: 1080 });
  let ran = 0;
  const r = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis: async () => { ran++; return { file: wrong }; } });
  assert.match(r.out, /the hosted analysis answered in \d+ s with a file that is not used \(.*is for a clip 1920x1080 and .* s long, not this one, 640x360 and .* s long\)\. So the shots and the faces are found here, with MediaPipe/);
  assert.doesNotMatch(r.out, /leave out --speakers/, 'nobody passed --speakers here');
  assert.match(String(r.result), /MediaPipe is not installed/);
  assert.deepEqual(keptIn(out), [], 'an answer that does not map is not kept, or every later run would find it and run again');
  // A truncated answer is the same: one line and MediaPipe, not a parse error after the request was bought.
  const cut = written({});
  writeFileSync(cut, readFileSync(made, 'utf8').slice(0, 300));
  const truncated = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis: async () => ({ file: cut }) });
  assert.match(truncated.out, /answered in \d+ s with a file that is not used \(.*is not a speakers file faces can read \(not JSON\)\)\. So the shots and the faces are found here, with MediaPipe/);
  assert.match(String(truncated.result), /MediaPipe is not installed/);
  // A file that vanished between the answer and the mapping is no refusal of the file: the error is its own.
  const gone = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis: async () => ({ file: join(root, 'gone.json') }) });
  assert.match(String(gone.result), /no speakers file at .*gone\.json/);
  assert.doesNotMatch(gone.out, /gave no speakers file|is not used/);
  // And an error of the stand-in's own, which is not the analysis failing, is not swallowed into a fallback.
  const bug = await runFaces(root, [clip, '--out', out], { env, route: keyed, analysis: async () => { throw new TypeError('not a failure of the analysis'); } });
  assert.equal(bug.result, 'not a failure of the analysis');
  assert.equal(ran, 1);
});

test('faces: --local, the local detection\'s own flags, --speakers, a clip the analysis does not take, no fal and a failure all leave the analysis alone or say why', async () => {
  const root = scratchDir('speakers-local');
  const { clip, made } = soundClip(root);
  let ran = 0;
  const analysis = async () => { ran++; return { file: made }; };
  const local = async (args: string[], deps: object, why: RegExp | null) => {
    const r = await runFaces(root, [clip, '--out', join(root, 'local'), ...args], deps);
    assert.match(String(r.result), /MediaPipe is not installed/, 'the clip is left to MediaPipe, which is not installed here');
    if (why) assert.match(r.out, why);
    else assert.doesNotMatch(r.out, /hosted analysis/);
  };
  await local(['--local'], { env, route: keyed, analysis }, null);
  await local(['--threshold', '5'], { env, route: keyed, analysis }, /--threshold asks for the cuts and the faces found here, so the hosted analysis OPEN_EDIT_SPEAKERS_ANALYSIS names is not run/);
  await local(['--confidence', '0.6'], { env, route: keyed, analysis }, /--confidence asks for the cuts and the faces found here/);
  await local([], { env, route: (): FalRoute => ({ how: 'none', why: 'no fal key is readable here, and the environment gives no fal command of its own' }), analysis },
    /is not run: no fal key is readable here, and the environment gives no fal command of its own\. So the shots and the faces are found here, with MediaPipe/);
  await local([], { env, route: keyed, analysis: async () => { throw new AnalysisFailed('fal returned 422 for a completed job: {"detail":"File has no audio stream."}'); } },
    /the hosted analysis gave no speakers file for this clip after \d+ s \(fal returned 422 for a completed job: .*\)\. So the shots and the faces are found here, with MediaPipe/);
  const silent = await runFaces(root, [FIXTURE, '--out', join(root, 'silent')], { env, route: keyed, analysis });
  assert.match(silent.out, /is not run: the clip has no sound, and the analysis tells who is speaking by it\. So the shots and the faces are found here, with MediaPipe/);
  // With the variable unset nothing is said and nothing is run.
  await local([], { env: {}, route: keyed, analysis }, null);
  assert.equal(ran, 0);
  // A speakers file passed by hand is mapped as it is, and the analysis is not run for it.
  const named = await runFaces(root, [clip, '--out', join(root, 'named'), '--speakers', made], { env, route: keyed, analysis });
  assert.equal(named.result, 0, named.out);
  assert.doesNotMatch(named.out, /hosted analysis/);
  assert.equal(ran, 0);
  // An answer larger than any speakers file is one line too, and the clip is left to MediaPipe.
  const huge = written({});
  truncateSync(huge, SPEAKERS_BYTES + 1);
  const answered = await runFaces(root, [clip, '--out', join(root, 'large')], { env, route: keyed, analysis: async () => ({ file: huge }) });
  assert.match(answered.out, /answered in \d+ s with a file that is not used \(.*is 32\.0 MB, and faces reads a speakers file of at most 32 MB\)\. So the shots and the faces are found here, with MediaPipe/);
});
