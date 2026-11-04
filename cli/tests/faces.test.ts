// The faces command and faces.js. The arithmetic, the layout and the command's whole ffmpeg side run
// everywhere, with a stand-in detector; MediaPipe itself runs on the talking-head fixture when it is
// installed (`openedit install-mediapipe`), and is skipped otherwise unless OPENEDIT_REQUIRE_MEDIAPIPE is
// set. The page tests need the renderer's Chrome, and fail rather than skip under OPENEDIT_REQUIRE_BROWSER.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atPts, findFaces, otherClipAt, parseShowinfo, shotOf, toDisplay } from '../src/commands/faces.ts';
import { fetchModel, installArgs, PINNED, platformProblem, pythonProblem, stepFailure, verifyModel, type Machine } from '../src/commands/install-mediapipe.ts';
import { FFMPEG } from '../src/config.ts';
import { missingDetector, runDetector, type Spawn } from '../src/faces/mediapipe.ts';
import { facesApi, facesScript, type FacesClip, type Rect } from '../src/faces/page-script.ts';
import { CHROME_FLAGS, chromePlatform, installedChrome } from '../src/render/browser.ts';
import { startPageServer } from '../src/render/server.ts';
import { stubDetector } from './helpers/face-stub.ts';
import { scratchDir } from './helpers/synth.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/talking-head.mp4', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const OPTIONS = { every: 1, threshold: 10, confidence: 0.5, margin: 0.25 };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** One face per still at the same box (still pixels). */
const oneFace = () => stubDetector(() => [[10, 20, 30, 40]]);

/** A clip with the given faces, one sample per second of each shot. */
function clipOf(shots: { start: number; end: number; faces: Rect[] }[], over: Partial<FacesClip> = {}): FacesClip {
  return {
    video: '/media/clip.mp4', name: 'clip.mp4', width: 640, height: 360, fps: 30, frameRate: '30', durationSec: shots.at(-1)!.end,
    model: 'blaze_face_full_range', every: 1, threshold: 10, confidence: 0.5, textMargin: 0, ...over,
    shots: shots.map((s) => ({
      start: s.start, end: s.end,
      samples: Array.from({ length: Math.max(1, Math.round(s.end - s.start)) }, (_, i) => ({ sec: s.start + i + 0.5, faces: s.faces })),
    })),
  };
}

/** The fixture with every fourth frame dropped and the rest kept at their times: 22.5 fps on a 29.97 fps tag. */
function variableRate(dir: string): string {
  const out = join(dir, 'vfr.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', FIXTURE, '-vf', 'select=lt(mod(n\\,4)\\,3)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

test('faces: each frame is read by its pts in its time base, the cuts and the samples apart', () => {
  const log = '[showinfo@cuts @ 0x1] config in time_base: 1/30000, frame_rate: 30000/1001\n' +
    '[showinfo@grid @ 0x2] config in time_base: 1/30000, frame_rate: 30000/1001\n' +
    '[showinfo@grid @ 0x2] n:   0 pts:  15015 pts_time:0.5005  duration:   1001\n' +
    '[scdet @ 0x3] lavfi.scd.score: 32.031, lavfi.scd.time: 1.034367\n' +
    '[showinfo@cuts @ 0x1] n:   0 pts:  31031 pts_time:1.034367 duration:   1001\n' +
    '[showinfo@grid @ 0x2] n:   1 pts:  45045 pts_time:1.5015  duration:   1001\n';
  assert.deepEqual(parseShowinfo(log, 'grid'), { num: 1, den: 30000, pts: [15015, 45045] });
  assert.deepEqual(parseShowinfo(log, 'cuts'), { num: 1, den: 30000, pts: [31031] });
  assert.throws(() => parseShowinfo(log, 'mid'), /no time base for showinfo@mid/);
  // A cut's own frame is in the new shot however its time prints: the pts are compared, not seconds.
  assert.deepEqual([15015, 31030, 31031, 45045].map((p) => shotOf([31031], p)), [0, 0, 1, 1]);
  assert.equal(atPts(null), 'isnan(prev_pts)');
  assert.equal(atPts(31031), 'gte(pts,31031)*(isnan(prev_pts)+lt(prev_pts,31031))');
});

test('faces: detections are scaled to display pixels and clamped to the frame', () => {
  assert.deepEqual(toDisplay([[300, 10, 40, 40, 0.9], [-5, -5, 20, 20, 0.6]], 3, 3, 1000, 1000), [
    { x: 900, y: 30, w: 100, h: 120, score: 0.9 },
    { x: 0, y: 0, w: 45, h: 45, score: 0.6 },
  ]);
});

/** Every shot has at least `least` samples, each inside it. */
function assertSampled(clip: FacesClip, least: number): void {
  for (const shot of clip.shots) {
    assert.ok(shot.samples.length >= least, `${shot.start}-${shot.end} s has ${shot.samples.length} sample(s)`);
    for (const x of shot.samples) assert.ok(x.sec >= shot.start && x.sec < shot.end, `${x.sec} s lies outside ${shot.start}-${shot.end} s`);
  }
}

/** For each grid point, the sample taken there: the first frame at or past it, at most `slack` seconds later. */
function assertGrid(clip: FacesClip, points: number[], slack: number): void {
  const secs = clip.shots.flatMap((shot) => shot.samples.map((x) => x.sec));
  for (const g of points) assert.ok(secs.some((t) => t >= g && t < g + slack), `no sample just after the grid point ${g} s`);
}

test('faces: the fixture is sampled on the grid, at least four times a shot, and the boxes scaled to the clip\'s size', () => {
  const dir = scratchDir('faces-stub-run');
  // Twice the fixture's size: the stills stay 640 wide, so every box must come back doubled.
  const big = join(dir, 'big.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', FIXTURE, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', big]);
  const clip = findFaces(big, OPTIONS, oneFace());
  assert.deepEqual([clip.width, clip.height, clip.textMargin], [1280, 720, 0.25]);
  assert.deepEqual(clip.shots.map((s) => s.start), [0, 2.469133, 8.174833]);
  assertSampled(clip, 4);
  assertGrid(clip, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5], 0.034);
  assert.deepEqual(json(clip.shots[1].samples[0].faces), [{ x: 20, y: 40, w: 60, h: 80, score: 0.9 }]);
});
test('faces: a variable frame rate is sampled by time, so every shot gets its own frames', () => {
  const clip = findFaces(variableRate(scratchDir('faces-vfr')), OPTIONS, oneFace());
  assert.deepEqual(clip.shots.map((s) => s.start), [0, 2.469133, 8.174833]);
  assertSampled(clip, 4);
  // Each grid sample is the first frame at or past its point; with a frame in four missing, at most two frame
  // times (67 ms) later. Counting frames instead would put them 25% late, and the last shot would get none.
  assertGrid(clip, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5], 0.07);
});
test('faces: a shot the grid samples less than four times gets more, spread across it', () => {
  const clip = findFaces(FIXTURE, { ...OPTIONS, every: 4 }, oneFace());
  // Grid points at 2, 6 and 10 s: one or none in each shot, so each gets its first frame and one in each quarter.
  assertSampled(clip, 4);
  assertGrid(clip, [2, 6], 0.034);
  assert.equal(clip.shots[2].samples[0].sec, 8.174833, 'the last shot, which no grid point reaches, starts with its own first frame');
});
test('faces.js: the boxes on screen are the samples in the span and the nearest on each side, padded, per shot', () => {
  const api = facesApi(clipOf([
    { start: 0, end: 4, faces: [{ x: 100, y: 50, w: 100, h: 100 }] },
    { start: 4, end: 6, faces: [{ x: 400, y: 40, w: 80, h: 80 }, { x: 100, y: 60, w: 80, h: 80 }] },
  ], { textMargin: 0.25 }));
  assert.deepEqual(json(api.boxes(1)), [{ x: 75, y: 25, w: 150, h: 150 }]);
  assert.deepEqual(json(api.boxes(4)), [{ x: 380, y: 20, w: 120, h: 120 }, { x: 80, y: 40, w: 120, h: 120 }], 'the instant a shot starts is that shot');
  assert.equal(api.boxes(3, 5).length, 3, 'a span over a cut sees both shots, two people as two boxes');
  assert.equal(api.boxes(0, 4).length, 1, 'a span ending as the next shot starts does not see it');
  assert.deepEqual(json(api.boxes(9)), []);
});

test('faces.js: a face that moves within a shot is one box over the samples either side of the span', () => {
  const clip = clipOf([{ start: 0, end: 3, faces: [] }]);
  clip.shots[0].samples = [0, 100, 200].map((x, i) => ({ sec: i + 0.5, faces: [{ x, y: 50, w: 120, h: 100 }] }));
  // No sample falls inside 1-1.2 s: the ones at 0.5 s and 1.5 s bracket it, and the one at 2.5 s is not on screen.
  assert.deepEqual(json(facesApi(clip).boxes(1, 1.2)), [{ x: 0, y: 50, w: 220, h: 100 }]);
});

test('faces.js: text already clear stays; text on a face moves the least distance; no room is reported', () => {
  const { clear } = facesApi();
  const frame = { x: 0, y: 0, w: 640, h: 360 };
  const face = { x: 220, y: 40, w: 200, h: 200 };
  assert.deepEqual(json(clear({ x: 20, y: 280, w: 600, h: 60 }, [face], frame)), { x: 20, y: 280, clear: true, moved: false });
  // Overlapping the chin by 20 px: the nearest clear place is just below it.
  assert.deepEqual(json(clear({ x: 20, y: 220, w: 600, h: 60 }, [face], frame)), { x: 20, y: 241, clear: true, moved: true });
  // A narrow label on the face's left edge steps left rather than down past the whole face.
  assert.deepEqual(json(clear({ x: 190, y: 100, w: 60, h: 30 }, [face], frame)), { x: 159, y: 100, clear: true, moved: true });
  assert.deepEqual(json(clear({ x: 0, y: 0, w: 640, h: 300 }, [face], frame)), { x: 0, y: 0, clear: false, moved: false });
});

test('faces.js: from any starting place, a placed caption overlaps no face and stays in the frame', () => {
  const { clear } = facesApi();
  const frame = { x: 0, y: 0, w: 640, h: 360 };
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let placedCount = 0;
  for (let round = 0; round < 300; round++) {
    const faces = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ x: rand() * 560, y: rand() * 200, w: 40 + rand() * 120, h: 40 + rand() * 120 }));
    const rect = { x: rand() * 200, y: rand() * 300, w: 200 + rand() * 300, h: 30 + rand() * 50 };
    const res = clear(rect, faces, frame);
    if (!res.clear) continue;
    placedCount++;
    const placed = { x: res.x, y: res.y, w: rect.w, h: rect.h };
    assert.ok(placed.x >= 0 && placed.y >= 0 && placed.x + placed.w <= 640 + 1e-6 && placed.y + placed.h <= 360 + 1e-6, `round ${round} left the frame`);
    for (const f of faces) assert.ok(!overlaps(placed, f), `round ${round}: ${JSON.stringify(placed)} overlaps ${JSON.stringify(f)}`);
  }
  assert.ok(placedCount > 250, `only ${placedCount} of 300 rounds had room`);
});

test('faces.js: clips are keyed by path; a name shared by two is refused, and so is one never loaded', () => {
  const a = clipOf([{ start: 0, end: 2, faces: [] }]);
  const b = clipOf([{ start: 0, end: 2, faces: [{ x: 1, y: 1, w: 9, h: 9 }] }], { video: '/other/clip.mp4' });
  const c = clipOf([{ start: 0, end: 2, faces: [{ x: 1, y: 1, w: 9, h: 9 }] }], { video: '/media/b.mp4', name: 'b.mp4' });
  const api = facesApi(a, b, c);
  assert.equal(Object.keys(api.clips).length, 3, 'two files named clip.mp4 do not overwrite each other');
  assert.throws(() => api.boxes(1), /face data for several clips is loaded; name one with \{clip\}/);
  assert.throws(() => api.boxes(1, 1, 'clip.mp4'), /2 clips are named "clip\.mp4"; name one by its path/);
  assert.equal(api.boxes(1, 1, '/other/clip.mp4').length, 1);
  assert.equal(api.boxes(1, 1, 'b.mp4').length, 1);
  assert.throws(() => api.boxes(1, 1, 'c.mp4'), /no face data for "c\.mp4"/);
});

test('faces: the detector\'s lines are read; a failure shows the end of its log, a kill its signal', () => {
  const out = '{"ready_ms": 412.5}\n{"file": "c0000000.png", "ms": 4.1, "width": 640, "height": 360, "faces": [[1, 2, 3, 4, 0.9]]}\n';
  const reply = (r: object) => (() => ({ status: 0, signal: null, stdout: '', stderr: '', ...r })) as unknown as Spawn;
  assert.deepEqual(runDetector({ folder: '/x', confidence: 0.5, python: 'py', model: 'm' }, reply({ stdout: out, stderr: 'W0000 noise' })), {
    readyMs: 412.5,
    images: [{ file: 'c0000000.png', ms: 4.1, width: 640, height: 360, faces: [[1, 2, 3, 4, 0.9]] }],
  });
  assert.throws(() => runDetector({ confidence: 0.5, python: 'py', model: 'm' }, reply({ status: 1, stderr: 'noise\nModuleNotFoundError: No module named cv2' })),
    /exit 1\)\nnoise\nModuleNotFoundError: No module named cv2/);
  assert.throws(() => runDetector({ confidence: 0.5, python: 'py', model: 'm' }, reply({ status: null, signal: 'SIGKILL' })), /killed by SIGKILL/);
  assert.throws(() => runDetector({ confidence: 0.5, python: 'py', model: 'm' }, reply({ stdout: '{"ready_ms": 1}\n{truncated\n' })), /a line that is not JSON: \{truncated/);
});

test('install-mediapipe: a model download that is not the pinned file is refused, and leaves no file behind', async () => {
  assert.match(verifyModel(Buffer.from('not a model')) ?? '', /does not match its pinned checksum/);
  const dest = join(scratchDir('model'), 'blaze_face_full_range.tflite');
  const tampered = (async () => new Response('not a model')) as unknown as typeof fetch;
  await assert.rejects(fetchModel(tampered, dest), /does not match its pinned checksum/);
  assert.deepEqual([existsSync(dest), existsSync(`${dest}.part`)], [false, false]);
});

test('faces: with no MediaPipe installed the command names the installer', () => {
  const none = join(scratchDir('faces-none'), 'python');
  assert.throws(() => findFaces(FIXTURE, OPTIONS, { python: none }), /MediaPipe is not installed.*install-mediapipe/s);
});

test('faces: another clip\'s faces.json in a folder named with --out is not overwritten', () => {
  const dir = scratchDir('faces-clash');
  writeFileSync(join(dir, 'faces.json'), JSON.stringify(clipOf([{ start: 0, end: 1, faces: [] }], { video: '/a/clip.mp4' })));
  assert.match(otherClipAt(join(dir, 'faces.json'), '/b/clip.mp4') ?? '', /holds the faces of \/a\/clip\.mp4, another clip: pass another --out <dir>, or leave --out out/);
  assert.equal(otherClipAt(join(dir, 'faces.json'), '/a/clip.mp4'), null);
  assert.equal(otherClipAt(join(dir, 'none.json'), '/a/clip.mp4'), null);
});

test('faces: a container whose clock starts late is sampled on the same timeline throughout', () => {
  // MPEG-TS from 1.5 s into the fixture, with its clock starting at 2.9 s: the shots change at 0.968 and 6.673 s.
  const ts = join(scratchDir('faces-ts'), 'late.ts');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', FIXTURE, '-ss', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '1.5', '-f', 'mpegts', ts]);
  const clip = findFaces(ts, { ...OPTIONS, every: 4 }, oneFace());
  assert.deepEqual(clip.shots.map((s) => s.start), [0, 0.967633, 6.673333]);
  // On the clip's own clock: the 4 s grid's 2 and 6 s, and every shot sampled inside itself.
  assertSampled(clip, 4);
  assertGrid(clip, [2, 6], 0.034);
});
/** Generated pictures one after another at 29.97 fps: each lavfi source for so many frames. */
function sequence(dir: string, name: string, parts: [string, number][]): string {
  const out = join(dir, name);
  const inputs = parts.flatMap(([source]) => ['-f', 'lavfi', '-i', `${source}${source.includes('=') ? ':' : '='}s=640x360:r=30000/1001`]);
  const trims = parts.map(([, frames], i) => `[${i}:v]trim=end_frame=${frames},setpts=PTS-STARTPTS[p${i}]`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex',
    `${trims.join(';')};${parts.map((_, i) => `[p${i}]`).join('')}concat=n=${parts.length}:v=1:a=0`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

test('faces: a shot one frame long is sampled on that frame, in the middle of a clip or at its end', () => {
  const dir = scratchDir('faces-flash');
  const stub = oneFace();
  // One grey frame between black and colour bars: shots start at frames 31 and 32, whose times print rounded.
  const mid = findFaces(sequence(dir, 'mid.mp4', [['color=c=black', 31], ['color=c=gray', 1], ['testsrc', 60]]), OPTIONS, stub);
  const frame = (n: number) => (n * 1001) / 30000;
  assert.equal(mid.shots[1].samples.length, 1);
  assert.ok(mid.shots[0].samples.length >= 4 && mid.shots[2].samples.length >= 4);
  assert.ok(Math.abs(mid.shots[1].start - frame(31)) < 1e-4 && Math.abs(mid.shots[2].start - frame(32)) < 1e-4, JSON.stringify(mid.shots.map((s) => s.start)));
  assert.equal(mid.shots[1].samples[0].sec, mid.shots[1].start, 'the one-frame shot is sampled on its own frame');
  // A last shot of one frame: black after 121 frames of bars.
  const last = findFaces(sequence(dir, 'last.mp4', [['testsrc', 121], ['color=c=black', 1]]), OPTIONS, stub);
  assert.ok(last.shots[0].samples.length >= 4);
  assert.equal(last.shots[1].samples.length, 1);
  assert.ok(Math.abs(last.shots[1].start - frame(121)) < 1e-4, String(last.shots[1].start));
  assert.equal(last.shots[1].samples[0].sec, last.shots[1].start);
});

test('faces: a video that starts after its sound is measured on its own frames, to its last, and its first frame covers the wait', () => {
  // The fixture's picture a second after an 11 s tone: its frames run from 1 to 11.01 s.
  const late = join(scratchDir('faces-late'), 'late.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-itsoffset', '1', '-i', FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=11',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', late]);
  const clip = findFaces(late, OPTIONS, oneFace());
  assert.equal(clip.durationSec, 11.01);
  // A player shows the first frame until the picture starts, so the first shot runs from 0.
  assert.deepEqual(clip.shots.map((s) => [s.start, s.end]), [[0, 3.469133], [3.469133, 9.174833], [9.174833, 11.01]]);
  assertSampled(clip, 4);
  assert.ok(clip.shots[0].samples[0].sec >= 1, 'sampled from the first frame');
  assert.ok(clip.shots[2].samples.at(-1)!.sec > 10.5, 'the last second is sampled too');
  const api = facesApi(clip);
  for (const [from, to] of [[0, undefined], [0.5, undefined], [0, 0.9], [0.99, undefined]] as [number, number | undefined][]) {
    assert.equal(api.boxes(from, to).length, 1, `boxes(${from}, ${to}) sees the face the first frame shows`);
  }
});

test('faces: a shot with no readable frame stops the command rather than passing for a shot without faces', () => {
  const stub = oneFace();
  // The second decode, which samples the shots the grid missed, comes back with no frames.
  const spawn = ((cmd: string, args: string[], opts: object) => (args.some((a) => a.includes('showinfo@more'))
    ? { status: 0, signal: null, stdout: '', stderr: '[showinfo@more @ 0x1] config in time_base: 1/30000, frame_rate: 30000/1001\n' }
    : stub.spawn(cmd, args, opts as never))) as unknown as Spawn;
  assert.throws(() => findFaces(FIXTURE, { ...OPTIONS, every: 4 }, { ...stub, spawn }), /no frame could be read from 8\.175-10\.010 s of .*talking-head\.mp4, so the faces there are unknown/);
});

test('faces: an ffmpeg that is missing, killed or too talkative is named, never an empty reason', () => {
  const stub = oneFace();
  const failing = (r: object) => ((cmd: string, args: string[], opts: object) => (cmd === FFMPEG ? { status: null, signal: null, stdout: '', stderr: '', ...r } : stub.spawn(cmd, args, opts as never))) as unknown as Spawn;
  const enoent = Object.assign(new Error('spawnSync ffmpeg ENOENT'), { code: 'ENOENT' });
  assert.throws(() => findFaces(FIXTURE, OPTIONS, { ...stub, spawn: failing({ error: enoent }) }), /ffmpeg could not read .* \(.*ffmpeg(\.exe)? was not found\)/);
  assert.throws(() => findFaces(FIXTURE, OPTIONS, { ...stub, spawn: failing({ signal: 'SIGKILL' }) }), /\(killed by SIGKILL\)/);
  const enobufs = Object.assign(new Error('spawnSync ffmpeg ENOBUFS'), { code: 'ENOBUFS' });
  assert.throws(() => findFaces(FIXTURE, OPTIONS, { ...stub, spawn: failing({ error: enobufs }) }), /\(its log outgrew the buffer\)/);
});

test('faces: --threshold says what it accepts in the words it checks', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'faces', FIXTURE, '--threshold', '0'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--threshold wants a score above 0 and at most 100/);
});

test('install-mediapipe: the pinned set is installed whole, on a Python it builds for, and a failure says why', () => {
  const args = installArgs(PINNED[0].split('==')[1]);
  assert.equal(args[0], '--no-deps', 'the set is exact, so nothing resolves around it');
  assert.equal(args.length, 20, 'MediaPipe and the 18 packages it runs on');
  assert.ok(args.includes('opencv-python-headless==5.0.0.93') && args.includes('cffi==2.1.1') && args.includes('contourpy==1.4.0'));
  assert.deepEqual(installArgs('1.0.0'), ['mediapipe==1.0.0']);
  assert.equal(pythonProblem('3.12'), null);
  assert.equal(pythonProblem('3.15'), null, 'every pinned package publishes a build for 3.15');
  assert.match(pythonProblem('3.10') ?? '', /Python 3\.10 is older than the 3\.12 the pinned packages of MediaPipe 1\.1\.1 need/);
  const machine = (m: Partial<Machine>): Machine => ({ platform: 'linux', arch: 'x64', rosetta: false, windowsArm: false, uv: true, ...m });
  assert.match(platformProblem(machine({ platform: 'darwin' })) ?? '', /^MediaPipe 1\.1\.1 has no Intel Mac build, so it cannot be installed on this machine$/);
  assert.match(platformProblem(machine({ platform: 'darwin', rosetta: true })) ?? '', /under Rosetta.*run the CLI with an arm64 Node/);
  assert.equal(platformProblem(machine({ platform: 'darwin', arch: 'arm64' })), null);
  assert.equal(platformProblem(machine({})), null);
  assert.match(platformProblem(machine({ platform: 'win32', arch: 'arm64', windowsArm: true })) ?? '', /no Windows on ARM build.*OPEN_EDIT_MEDIAPIPE_PYTHON=cpython-3\.12-windows-x86_64-none/);
  assert.equal(platformProblem(machine({ platform: 'win32', arch: 'arm64', windowsArm: true, python: 'cpython-3.12-windows-x86_64-none' })), null);
  // Without uv the variable is never read and pip would try to build OpenCV from source: install uv first.
  assert.match(platformProblem(machine({ platform: 'win32', arch: 'arm64', windowsArm: true, uv: false, python: 'cpython-3.12-windows-x86_64-none' })) ?? '',
    /no Windows on ARM build.*install uv, set OPEN_EDIT_MEDIAPIPE_PYTHON=cpython-3\.12-windows-x86_64-none, then install-mediapipe again$/);
  const enoent = Object.assign(new Error('spawnSync uv ENOENT'), { code: 'ENOENT' });
  assert.equal(stepFailure('uv venv', { error: enoent, status: null }), 'uv venv failed (the program was not found)');
  assert.equal(stepFailure('pip install', { signal: 'SIGTERM', status: null }), 'pip install failed (killed by SIGTERM); its own output is above');
  assert.equal(stepFailure('pip install', { status: 1 }), 'pip install failed (exit 1); its own output is above');
});

const noDetector = missingDetector();
// (The install check, a model load and one detection on a blank image, runs below where MediaPipe is installed.)
// Set where MediaPipe was installed on purpose, so losing that install fails the suite instead of skipping it.
if (noDetector && process.env.OPENEDIT_REQUIRE_MEDIAPIPE) throw new Error(`${noDetector}, and OPENEDIT_REQUIRE_MEDIAPIPE is set`);
const detect = noDetector ? `${noDetector} (openedit install-mediapipe)` : false;

// The fixture's README holds the hand-annotated nose points and where the shots change.
const INTERVIEWEE = { x: 412, y: 115 };
const HOST = { x: 215, y: 118 };

function assertSpeakers(clip: FacesClip): void {
  assert.deepEqual(clip.shots.map((s) => s.start), [0, 2.469133, 8.174833]);
  const nose = [INTERVIEWEE, HOST, INTERVIEWEE];
  clip.shots.forEach((shot, i) => {
    assert.ok(shot.samples.length >= 2, `shot ${i} has ${shot.samples.length} sample(s)`);
    for (const s of shot.samples) {
      assert.equal(s.faces.length, 1, `shot ${i} at ${s.sec}s: ${s.faces.length} faces`);
      const [f] = s.faces;
      const p = nose[i];
      assert.ok(f.x < p.x && p.x < f.x + f.w && f.y < p.y && p.y < f.y + f.h, `shot ${i} at ${s.sec}s: ${JSON.stringify(f)} misses the nose at ${p.x},${p.y}`);
    }
  });
}

test('install-mediapipe: the install check loads the model and runs one detection', { skip: detect }, () => {
  const run = runDetector({ confidence: 0.5 });
  assert.ok(run.readyMs > 0);
  assert.deepEqual(run.images, []);
});

test('faces: on the talking-head fixture, every shot and every sampled frame finds its one speaker', { skip: detect }, () => {
  const clip = findFaces(FIXTURE, OPTIONS);
  assert.deepEqual([clip.width, clip.height, clip.frameRate], [640, 360, '30000/1001']);
  assertSpeakers(clip);
});

test('faces: re-timed to a variable frame rate, the fixture still finds each speaker in their own shot', { skip: detect }, () => {
  assertSpeakers(findFaces(variableRate(scratchDir('faces-vfr-real')), OPTIONS));
});

test('faces: a caption laid out against the fixture\'s boxes never overlaps a face', { skip: detect }, () => {
  const clip = findFaces(FIXTURE, OPTIONS);
  const api = facesApi(clip);
  const frame = { x: 0, y: 0, w: clip.width, h: clip.height };
  const raw = (from: number, to: number) => clip.shots.filter((s) => s.start < to && s.end > from).flatMap((s) => s.samples.flatMap((x) => x.faces));
  // Two-line captions a page sets centred, starting from the top, over the faces, the middle and the bottom.
  let moved = 0;
  for (const [from, to] of [[0, 2], [1.5, 3.5], [3, 6], [6, 8.1], [7.5, 9], [8.5, 10]]) {
    for (const y of [10, 60, 110, 150, 280]) {
      const rect = { x: 64, y, w: 512, h: 64 };
      const res = api.clear(rect, api.boxes(from, to), frame);
      assert.ok(res.clear, `no room for a caption from ${from} to ${to}s`);
      if (res.moved) moved++;
      const placed = { ...rect, x: res.x, y: res.y };
      for (const f of [...api.boxes(from, to), ...raw(from, to)]) {
        assert.ok(!overlaps(placed, f), `caption ${from}-${to}s from y ${y} at ${JSON.stringify(placed)} overlaps ${JSON.stringify(f)}`);
      }
    }
  }
  assert.ok(moved >= 12, `only ${moved} of 30 captions had to move: the fixture should put most starting places on a face`);
});

const platform = chromePlatform();
const noChrome = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (noChrome && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${noChrome}, and OPENEDIT_REQUIRE_BROWSER is set`);

type Seen = { res?: { x: number; y: number; clear: boolean; moved: boolean }; rect?: Rect; error?: string };

test('faces.js: in Chrome, place() maps the boxes onto the drawn picture and moves the element clear of them', { skip: noChrome ?? false }, async () => {
  const dir = scratchDir('faces-page');
  // One face at the picture's centre, 160x90 on a 640x360 clip.
  const clip = clipOf([{ start: 0, end: 4, faces: [{ x: 240, y: 135, w: 160, h: 90 }] }], { video: join(dir, 'clip.mp4') });
  const face = { x: 240, y: 135, w: 160, h: 90 };
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  // A second clip, with its face in the top-left corner, for the pages that load two.
  writeFileSync(join(dir, 'faces-b.js'), facesScript(clipOf([{ start: 0, end: 4, faces: [{ x: 0, y: 0, w: 50, h: 50 }] }], { video: join(dir, 'b.mp4'), name: 'b.mp4' })));
  const page = (name: string, stage: string, body: string, style = '', scripts = '<script src="faces.js"></script>') => {
    writeFileSync(join(dir, name), `<!doctype html><html><head><style>html,body{margin:0}
#stage{position:relative;overflow:hidden;${stage}}.cap{position:absolute;width:200px;height:40px}${style}</style>
${scripts}</head><body><div id="stage">${body}</div></body></html>`);
    return name;
  };
  const { chromium } = await import('playwright-core');
  const server = await startPageServer({ roots: [dir] });
  const browser = await chromium.launch({ executablePath: installedChrome(platform!), args: CHROME_FLAGS });
  try {
    const p = await browser.newPage();
    const warnings: string[] = [];
    p.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    const call = (video: string | null) => `openeditFaces.place(el, 0, 2, ${video ? `{ video: document.getElementById('${video}') }` : '{}'})`;
    const place = async (file: string, video: string | null, before = '') => {
      await p.goto(server.urlFor(join(dir, file)));
      return await p.evaluate(`(() => {
        const el = document.getElementById('c');
        ${before}
        try {
          const res = ${call(video)};
          const r = el.getBoundingClientRect();
          return { res, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
        } catch (e) { return { error: e.message }; }
      })()`) as Seen;
    };
    const twice = async (file: string, video: string | null) => {
      const first = await place(file, video);
      assert.equal(first.error, undefined, `${file}: ${first.error}`);
      const again = await p.evaluate(`(() => { const el = document.getElementById('c'); ${call(video)}; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`) as Rect;
      assert.deepEqual(again, first.rect, `${file}: placing again from the moved position gives the same answer`);
      assert.deepEqual([first.res!.x, first.res!.y], [first.rect!.x, first.rect!.y], `${file}: the result is where the element ended`);
      return first;
    };

    // contain, pinned to the top: scale 400/640, the picture 400x225 at the top of the 400x500 box, so the
    // face is drawn at 150,134.375 100x56.25. The caption starts at 105,100 (its own 5px translate kept); up
    // by 7.6 px is nearer than down past the face, and either side would leave the stage.
    const contain = await twice(page('contain.html', 'width:400px;height:600px', '<img id="v" src="clip.mp4"><div class="cap" id="c"></div>',
      'img{position:absolute;left:0;top:50px;width:400px;height:500px;object-fit:contain;object-position:50% 0%}.cap{left:100px;top:100px;translate:5px 0}'), 'v');
    const drawnFace = { x: 150, y: 50 + 135 * 0.625, w: 100, h: 56.25 };
    assert.deepEqual(contain.res, { x: 105, y: drawnFace.y - 40 - 1, clear: true, moved: true });
    assert.ok(!overlaps(contain.rect!, drawnFace));

    // No video: the footage fills the 640x360 stage, so the face is where faces.json says.
    const fill = await twice(page('fill.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>', '.cap{left:220px;top:150px}'), null);
    assert.deepEqual(fill.rect, { x: 220, y: 94, w: 200, h: 40 }, 'up past the face top at 135, the nearer side');

    // cover, by keyword: a 360x360 box shows the picture 640x360 at full size with its left edge at 0, so the
    // face is drawn at 240,135 and runs off the box's right side.
    const cover = await twice(page('cover.html', 'width:360px;height:360px', '<img id="v" src="clip.mp4"><div class="cap" id="c"></div>',
      'img{position:absolute;inset:0;width:360px;height:360px;object-fit:cover;object-position:left center}.cap{left:100px;top:200px;height:40px}'), 'v');
    assert.deepEqual(cover.rect, { x: 100, y: 226, w: 200, h: 40 }, 'down past the face bottom at 225');

    // An offset from an edge computes to calc(): right 20px, bottom 10px puts the contained picture at -20,165,
    // so the face is drawn at 130,249.375 100x56.25.
    const calc = await twice(page('calc.html', 'width:400px;height:400px', '<img id="v" src="clip.mp4"><div class="cap" id="c"></div>',
      'img{position:absolute;inset:0;width:400px;height:400px;object-fit:contain;object-position:right 20px bottom 10px}.cap{left:100px;top:260px}'), 'v');
    assert.equal(calc.res?.clear, true);
    assert.ok(!overlaps(calc.rect!, { x: 130, y: 249.375, w: 100, h: 56.25 }), `${JSON.stringify(calc.rect)} overlaps the face drawn at 130,249`);
    assert.notDeepEqual(calc.rect, { x: 100, y: 260, w: 200, h: 40 }, 'the caption started on the face, so it had to move');

    // Inside ancestors scaled by 2 and by 0.5 whose own boxes are empty (every child absolute), the move is
    // measured and corrected: the caption ends exactly where the nearest clear place is.
    for (const [k, left, top, w, h, endY] of [[2, 110, 75, 100, 20, 94], [0.5, 440, 300, 100, 20, 124]]) {
      const scaled = await twice(page(`scaled-${k}.html`, 'width:640px;height:360px',
        `<div style="position:absolute;transform:scale(${k});transform-origin:0 0"><div class="cap" id="c" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px"></div></div>`), null);
      assert.equal(scaled.res?.clear, true, `scale(${k})`);
      assert.equal(scaled.rect!.y, endY, `scale(${k}): the caption ends just above the face`);
      assert.ok(!overlaps(scaled.rect!, face));
    }

    // A rotated ancestor turns the move: whatever happens, the result says what was measured.
    const turned = await place(page('rotated.html', 'width:640px;height:360px',
      '<div style="position:absolute;left:320px;top:180px;transform:rotate(90deg)"><div class="cap" id="c" style="left:-100px;top:-20px"></div></div>'), null);
    const truly = !overlaps(turned.rect!, face) && turned.rect!.x >= 0 && turned.rect!.y >= 0 && turned.rect!.x + turned.rect!.w <= 640 && turned.rect!.y + turned.rect!.h <= 360;
    assert.equal(turned.res?.clear, truly, `rotated: reports clear ${turned.res?.clear} for ${JSON.stringify(turned.rect)}`);

    // A caption centred by a percentage translate and clear of the face keeps that translate, untouched.
    const centred = await twice(page('centred.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>',
      '.cap{left:50%;top:260px;width:300px;translate:-50% 0}'), null);
    assert.deepEqual([centred.rect!.x, centred.res!.moved, centred.res!.clear], [170, false, true]);
    // The same caption over the face moves up from where its percentage put it, and when the page changes its
    // translate between calls, the next call starts from the new one.
    const lifted = await twice(page('lifted.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>',
      '.cap{left:50%;top:150px;width:300px;translate:calc(-50% + 10px) 0}.cap.down{translate:calc(-50% + 10px) 100px}'), null);
    assert.deepEqual([lifted.rect!.x, lifted.rect!.y], [180, 94]);
    const moved = await p.evaluate(`(() => { const el = document.getElementById('c'); el.classList.add('down'); const res = ${call(null)}; const r = el.getBoundingClientRect(); return { res, x: r.left, y: r.top }; })()`) as { res: { moved: boolean }; x: number; y: number };
    assert.deepEqual([moved.x, moved.y, moved.res.moved], [180, 250, false], 'pushed below the face by the page, it is clear where it is');

    // A translate the page writes inline between calls, frame by frame, is the page's own and is kept.
    const inline = await twice(page('inline.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>', '.cap{left:220px;top:250px}'), null);
    assert.deepEqual([inline.rect!.y, inline.res!.moved], [250, false]);
    const lifted2 = await p.evaluate(`(() => { const el = document.getElementById('c'); const out = [];
      for (const y of [30, 60]) { el.style.translate = '0px ' + y + 'px'; const res = ${call(null)}; out.push([el.getBoundingClientRect().top, res.moved]); }
      return out; })()`) as [number, boolean][];
    assert.deepEqual(lifted2, [[280, false], [310, false]], 'the page moves it down, clear of the face, and place() leaves it there');

    // An animation owns the translate: place() cannot move it, says so, and does not claim to have moved it.
    warnings.length = 0;
    const owned = await place(page('owned.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>',
      '.cap{left:220px;top:150px;animation:hold 10s linear infinite}@keyframes hold{from{translate:0 0}to{translate:0 0}}'), null);
    assert.deepEqual([owned.res!.moved, owned.res!.clear], [false, false]);
    assert.match(warnings.join('\n'), /its translate is set by an animation or an !important rule/);

    // An entrance that owns the translate while place() runs at its start: the page's own inline translate is
    // put back, so when the entrance ends the caption sits where the page put it, not thrown off by the move.
    const entrance = await place(page('entrance.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>',
      '.cap{left:220px;top:300px;animation:drop 1s linear paused}@keyframes drop{from{translate:0 -180px}to{translate:0 0}}'), null);
    assert.deepEqual([entrance.rect!.y, entrance.res!.moved], [120, false], 'on the face at the entrance\'s start, and not moved');
    const ended = await p.evaluate(`(() => { const el = document.getElementById('c'); document.getAnimations().forEach((a) => { a.currentTime = 1000; });
      return { inline: el.style.translate, top: el.getBoundingClientRect().top }; })()`);
    assert.deepEqual(ended, { inline: '', top: 300 });

    // A move under a quarter pixel that does not take is not reported as a translate owned elsewhere.
    warnings.length = 0;
    const hair = await place(page('hair.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>', '.cap{left:-0.1px;top:300px}'), null);
    assert.equal(hair.res!.clear, true);
    assert.deepEqual(warnings, []);

    // The page writes a new translate after place() has moved the element: the next call starts from it.
    const rewritten = await twice(page('rewritten.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>', '.cap{left:220px;top:150px}'), null);
    assert.deepEqual([rewritten.rect!.y, rewritten.res!.moved], [94, true], 'up past the face, the nearer side from 150');
    const after = await p.evaluate(`(() => { const el = document.getElementById('c'); const out = [];
      for (const y of [120, 30]) { el.style.translate = '0px ' + y + 'px'; const res = ${call(null)}; out.push([el.getBoundingClientRect().top, res.moved]); }
      return out; })()`) as [number, boolean][];
    assert.deepEqual(after, [[270, false], [226, true]], 'clear at 270 it stays; from 180 the nearer side is down, not up as from 150');

    // No room: the caption stays where the page put it, and the warning says so.
    warnings.length = 0;
    const full = await place(page('full.html', 'width:640px;height:360px', '<div class="cap" id="c"></div>', '.cap{left:0;top:0;width:640px;height:300px}'), null);
    assert.deepEqual(full.res, { x: 0, y: 0, clear: false, moved: false });
    assert.deepEqual(full.rect, { x: 0, y: 0, w: 640, h: 300 });
    assert.match(warnings.join('\n'), /no place inside the stage keeps this element off every face and graphic from 0 to 2 s of the clip, so it stays where the page put it/);

    // Inside a [data-safe] container the caption keeps inside it: up past the face, the nearer side, would leave the
    // container, so it goes down. The zone a safe-zone stylesheet marks on the stage with its insets bounds it the same.
    const safe = await twice(page('safe.html', 'width:640px;height:360px',
      '<div data-safe style="position:absolute;left:100px;top:120px;width:440px;height:240px"><div class="cap" id="c" style="left:120px;top:30px"></div></div>'), null);
    assert.deepEqual([safe.rect!.x, safe.rect!.y, safe.res!.clear], [220, 226, true]);
    const zoned = await twice(page('zoned.html', 'width:640px;height:360px;--safe-top:120px;--safe-right:100px;--safe-bottom:0px;--safe-left:100px',
      '<div class="cap" id="c" style="left:220px;top:150px"></div>'), null);
    assert.deepEqual([zoned.rect!.x, zoned.rect!.y, zoned.res!.clear], [220, 226, true]);
    warnings.length = 0;
    await place(page('tight.html', 'width:640px;height:360px',
      '<div data-safe style="position:absolute;left:200px;top:100px;width:250px;height:150px"><div class="cap" id="c" style="left:20px;top:40px"></div></div>'), null);
    assert.match(warnings.join('\n'), /no place inside its \[data-safe\] container keeps this element off every face/);

    // Two clips loaded, and the video stood down the way a --footage render does it, after load: the clip it
    // showed is remembered.
    const stood = await place(page('stood.html', 'width:640px;height:360px', '<video id="v" src="clip.mp4"></video><div class="cap" id="c"></div>',
      'video{position:absolute;inset:0;width:640px;height:360px}.cap{left:220px;top:150px}', '<script src="faces.js"></script><script src="faces-b.js"></script>'), 'v',
      `const v = document.getElementById('v'); v.removeAttribute('src'); v.load();`);
    assert.equal(stood.error, undefined, stood.error);
    assert.deepEqual(stood.rect, { x: 220, y: 94, w: 200, h: 40 });

    // Refusals: a video with no face data, and a stage the footage cannot fill at its own shape.
    assert.match((await place(page('other.html', 'width:640px;height:360px', '<img id="v" src="another.mp4"><div class="cap" id="c"></div>'), 'v')).error ?? '', /no face data for .*another\.mp4/);
    assert.match((await place(page('square.html', 'width:400px;height:400px', '<div class="cap" id="c"></div>'), null)).error ?? '', /does not fill it at its own shape: pass the element it is drawn in as \{video\}/);
    assert.match((await place(page('percent.html', 'width:640px;height:360px', '<img id="v" src="50%.mp4"><div class="cap" id="c"></div>'), 'v')).error ?? '', /no face data for .*50%\.mp4/);
  } finally {
    await browser.close();
    await server.close();
  }
});
