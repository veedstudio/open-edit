import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  DEFAULT_MIN_SHOT_SEC, DEFAULT_THRESHOLD, parseFrames, pickCuts, pictureShareOf, shotList, shots, shotsFrom, withShotSize, withSpeech,
  type FrameScore, type ShotList, type ShotListFile,
} from '../src/commands/shots.ts';
import { findFaces } from '../src/commands/faces.ts';
import { extractFrames, seekFor } from '../src/commands/frames.ts';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { facesPathFor } from '../src/faces/folder.ts';
import type { FacesClip, Sample } from '../src/faces/page-script.ts';
import { CLOSE_UP_MIN, MEDIUM_MIN, shotSizeOf } from '../src/faces/shot-size.ts';
import { probeDisplaySize, videoDurationOf } from '../src/probe.ts';
import {
  labelBand, MAX_SHEETS, SHEET_PATCHES, SHEET_SIDE, writeStoryboard, type Storyboard, type StoryboardResult, type StoryboardTile,
} from '../src/storyboard.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import { stubDetector, type StubBox } from './helpers/face-stub.ts';
import { hdrClip } from './helpers/hdr.ts';
import {
  captureConsoleAsync, countFrames, meanAbsDiff, rawFrame, rotatedCopy, scratchDir, SINE, synthClip, TESTSRC, withRoot,
} from './helpers/synth.ts';

const FPS = 25;
// Six sources that look nothing alike, cut together at these frames. Two of them move inside the shot
// (testsrc2 scrolls, mandelbrot zooms) and cellauto changes wholesale on its second frame, which is the
// flicker the shortest-shot floor exists for.
const SEGMENTS = [
  { source: 'testsrc2', frames: 40 },
  { source: 'smptebars', frames: 30 },
  { source: 'mandelbrot', frames: 50 },
  { source: 'color=c=0x2050a0', frames: 25 },
  { source: 'rgbtestsrc', frames: 20 },
  { source: 'cellauto=seed=1:rule=110', frames: 35 },
];
const CUT_FRAMES = SEGMENTS.slice(0, -1).reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + s.frames], []);
const TOTAL_FRAMES = SEGMENTS.reduce((n, s) => n + s.frames, 0);

const ffmpeg = (args: string[]) => execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', ...args]);
const lavfi = (source: string, size = '320x180', rate = FPS) => {
  const [kind] = source.split('=');
  const own = source.slice(kind.length + 1);
  return ['-f', 'lavfi', '-i', `${kind}=s=${size}:r=${rate}${own ? `:${own}` : ''}`];
};
const trimmed = (i: number, frames: number) => `[${i}:v]trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${i}]`;

/** The fixture reference: the segments above, hard-cut, with a tone under them so it has an audio track. */
function reference(dir: string): string {
  const path = join(dir, 'reference.mp4');
  const graph = `${SEGMENTS.map((s, i) => trimmed(i, s.frames)).join(';')};` +
    `${SEGMENTS.map((_, i) => `[v${i}]`).join('')}concat=n=${SEGMENTS.length}:v=1:a=0[v]`;
  ffmpeg([...SEGMENTS.flatMap((s) => lavfi(s.source)), '-f', 'lavfi', '-i', SINE, '-filter_complex', graph,
    '-map', '[v]', '-map', `${SEGMENTS.length}:a`, '-t', String(TOTAL_FRAMES / FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  return path;
}

const dir = scratchDir('shots');
const fixture = reference(dir);
const options: { threshold: number; minShotSec: number; faces?: string } = { threshold: DEFAULT_THRESHOLD, minShotSec: DEFAULT_MIN_SHOT_SEC };
const listIn = (root: string, video = fixture, o = options): Promise<ShotList> => withRoot(join(dir, root), () => shotList(video, o));
/** Where faces writes `video`'s boxes in the workspace `root`. */
const facesAt = (root: string, video = fixture): Promise<string> => withRoot(join(dir, root), () => facesPathFor(video));
/** Writes `body` where faces writes `video`'s boxes in the workspace `root`, and returns that path. */
const writeFaces = async (root: string, video: string, body: string): Promise<string> => {
  const path = await facesAt(root, video);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const transcriptAt = (root: string, t: Transcript, key = 'reference') => {
  mkdirSync(join(dir, root, 'runs', key), { recursive: true });
  writeFileSync(join(dir, root, 'runs', key, 'transcript.json'), JSON.stringify(t));
  return join(dir, root, 'runs', key, 'transcript.json');
};
/** One chunk per argument, each a list of [word, start, end]. */
const transcript = (...chunks: [string, number, number][][]): Transcript => ({
  text: chunks.flat().map(([t]) => t).join(' '),
  chunks: chunks.map((w) => ({
    text: w.map(([t]) => t).join(' '),
    timestamp: [w[0][1], w.at(-1)![2]],
    words: w.map(([text, a, b]) => ({ text, timestamp: [a, b] })),
  })),
});
const json = async (root: string, argv: string[], video = fixture, draw?: typeof writeStoryboard): Promise<ShotListFile> => {
  const { result, out } = await withRoot(join(dir, root), () => captureConsoleAsync(() => shots([video, '--json', ...argv], draw)));
  assert.equal(result, 0);
  return JSON.parse(out) as ShotListFile;
};
const printed = async (root: string, argv: string[]): Promise<string> => {
  const { result, out } = await withRoot(join(dir, root), () => captureConsoleAsync(() => shots(argv)));
  assert.equal(result, 0);
  return out;
};
const written = (board: StoryboardResult): Storyboard => {
  if ('why' in board) assert.fail(`no storyboard: ${board.why}`);
  return board;
};
/** A picture as rgb24 rows, read back from the file ffmpeg wrote. */
const rgbOf = (file: string) => ({
  ...probeDisplaySize(file),
  pixels: execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 }),
});
/** The `w`x`h` box at `x`,`y` of an rgb24 picture `width` wide. */
const crop = (rgb: { width: number; pixels: Buffer }, x: number, y: number, w: number, h: number): Buffer =>
  Buffer.concat(Array.from({ length: h }, (_, row) => rgb.pixels.subarray(((y + row) * rgb.width + x) * 3, ((y + row) * rgb.width + x + w) * 3)));
/** Where a tile's label band starts on its sheet, from the sizes the storyboard records. */
const tileAt = (board: Storyboard, t: StoryboardTile) => ({
  x: (t.col - 1) * (board.tile.width + board.tile.padding),
  y: (t.row - 1) * (board.tile.label + board.tile.height + board.tile.padding),
});
/** Pixels whose lit or dark state differs between two label bands: the band read off a sheet, and one drawn. */
const labelMisses = (band: Buffer, drawn: Buffer): number => {
  let misses = 0;
  for (let i = 0; i < drawn.length; i += 3) if ((band[i] + band[i + 1] + band[i + 2] > 384) !== (drawn[i] === 255)) misses++;
  return misses;
};
/** The time of the picture `frames --frame` shows at `frame`, on the file's own clock. */
const shownAt = (video: string, frame: number, fps: number): number => Number(spawnSync(FFMPEG, ['-v', 'info', '-ss',
  String(seekFor(frame, fps)), '-i', video, '-copyts', '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' })
  .stderr.match(/pts_time:([\d.]+)/)?.[1]);

test('shots: the fixture reference gives its six shots, each cut on its own frame', async () => {
  const list = await listIn('empty');
  assert.equal(list.shots.length, SEGMENTS.length);
  assert.deepEqual(list.shots.map((s) => s.startFrame), [0, ...CUT_FRAMES]);
  list.shots.forEach((s, i) => {
    const truth = i === 0 ? 0 : CUT_FRAMES[i - 1] / FPS;
    assert.ok(Math.abs(s.start - truth) < 0.5 / FPS, `shot ${s.shot} starts at ${s.start}s, the cut is at ${truth}s`);
    assert.equal(s.end, i + 1 < list.shots.length ? list.shots[i + 1].start : list.durationSec);
  });
  assert.equal(list.frameRate, String(FPS));
});

test('shots: a jump cut (one take with a second removed) is a cut at the default, and not at 0.2', async () => {
  const jump = join(dir, 'jump.mp4');
  ffmpeg([...lavfi('mandelbrot'), '-filter_complex',
    '[0:v]split[a][b];[a]trim=end_frame=40,setpts=PTS-STARTPTS[x];[b]trim=start_frame=65:end_frame=105,setpts=PTS-STARTPTS[y];' +
    '[x][y]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', jump]);
  assert.deepEqual((await listIn('jump', jump)).shots.map((s) => s.startFrame), [0, 40]);
  assert.deepEqual((await listIn('jump', jump, { ...options, threshold: 0.2 })).shots.map((s) => s.startFrame), [0]);
});

test('shots: a fade through black splits two shots at its middle black frame; black cut in and out keeps its cuts', async () => {
  // testsrc2 fading out over its last half second, 0.24 s of black, smptebars fading in: black runs from
  // frame 63 to 70, so the darkest point is frame 67.
  const dip = join(dir, 'dip.mp4');
  ffmpeg([...lavfi('testsrc2'), ...lavfi('color=c=black'), ...lavfi('smptebars'), '-filter_complex',
    `[0:v]trim=end_frame=63,setpts=PTS-STARTPTS,fade=t=out:st=2.02:d=0.5,format=yuv420p,setsar=1[v0];${trimmed(1, 6)};` +
    '[2:v]trim=end_frame=63,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.5,format=yuv420p,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', dip]);
  const faded = await listIn('dip', dip);
  assert.deepEqual(faded.shots.map((s) => [s.startFrame, s.transition, s.cutScore]), [[0, null, null], [67, 'dip to black', null]]);
  // Cut to a second of black and cut out again: a shot of its own.
  const slate = join(dir, 'slate.mp4');
  ffmpeg([...lavfi('testsrc2'), ...lavfi('color=c=black'), ...lavfi('smptebars'), '-filter_complex',
    `${trimmed(0, 50)};${trimmed(1, 25)};${trimmed(2, 50)};[v0][v1][v2]concat=n=3:v=1:a=0[v]`, '-map', '[v]', '-c:v', 'libx264', slate]);
  const cut = await listIn('slate', slate);
  assert.deepEqual(cut.shots.map((s) => [s.startFrame, s.transition]), [[0, null], [50, 'cut'], [75, 'cut']]);
});

test('shots: without the shortest-shot floor, the flicker at the start of a shot splits it', async () => {
  const list = await listIn('empty', fixture, { ...options, minShotSec: 0 });
  assert.ok(list.shots.length > SEGMENTS.length, `${list.shots.length} shots with no floor`);
  for (const cut of CUT_FRAMES) assert.ok(list.shots.some((s) => s.startFrame === cut), `cut at frame ${cut} kept`);
});

test('shots: --json prints the list it writes, every field filled', async () => {
  const list = await json('json', []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'json', 'runs', 'reference', 'shots.json'), 'utf8')), list);
  assert.deepEqual(Object.keys(list).sort(),
    ['durationSec', 'fps', 'frameRate', 'height', 'minShotSec', 'pictureHeight', 'shots', 'sources', 'storyboard', 'threshold', 'video', 'width']);
  assert.equal(list.durationSec, Number(videoDurationOf(fixture).toFixed(3)));
  assert.deepEqual([list.width, list.height, list.threshold, list.minShotSec], [320, 180, DEFAULT_THRESHOLD, 0.333]);
  assert.deepEqual([list.shots[0].transition, list.shots[0].cutScore], [null, null]);
  for (const s of list.shots.slice(1)) {
    assert.equal(s.transition, 'cut');
    assert.ok(s.cutScore! >= DEFAULT_THRESHOLD, `shot ${s.shot} opened at ${s.cutScore}`);
  }
});

test('shots: the storyboard shows each shot\'s first, middle and last frame, or its middle under a second, labelled, in shot order', async () => {
  const list = await json('storyboard', []);
  const board = written(list.storyboard);
  // The six shots last 1.6, 1.2, 2.0, 1.0, 0.8 and 1.4 s; each runs to the frame before the next one's first, and
  // the last to the last frame the encode kept, its middle the frame on screen halfway through it.
  const last = countFrames(fixture) - 1;
  const picked: [number, number[]][] = [[1, [0, 20, 39]], [2, [40, 55, 69]], [3, [70, 95, 119]], [4, [120, 132, 144]], [5, [155]],
    [6, [165, 182, last]]];
  assert.deepEqual(board.tiles.map((t) => [t.shot, t.at, t.frame]), picked.flatMap(([shot, frames]) =>
    frames.length === 1 ? [[shot, 'middle', frames[0]]] : frames.map((f, i) => [shot, ['start', 'middle', 'end'][i], f])));
  for (const t of board.tiles) {
    assert.equal(t.sec, Number((t.frame / FPS).toFixed(3)));
    assert.equal(t.label, `#${t.shot} ${t.sec.toFixed(3)}s`);
    assert.equal(t.sheet, board.sheets[0]);
  }
  // The fixture is 320x180, and a tile is never larger than its source.
  assert.deepEqual(board.tile, { width: 320, height: 180, label: 22, padding: 4 });
  assert.equal(board.note, null);
  assert.equal(board.sheets.length, 1);
  assert.match(board.sheets[0], /storyboard-[0-9a-z]+-1\.jpg$/);
  assert.equal(dirname(board.sheets[0]), join(dir, 'storyboard', 'runs', 'reference'));
  // Row-major in shot order, a shot's frames side by side.
  const order = board.tiles.map((t) => t.row * 1000 + t.col);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  board.tiles.forEach((t, i) => {
    const prev = board.tiles[i - 1];
    if (prev?.shot === t.shot) assert.deepEqual([t.row, t.col], [prev.row, prev.col + 1], `shot ${t.shot}`);
  });

  const sheet = rgbOf(board.sheets[0]);
  const { width, height, label, padding } = board.tile;
  const cols = Math.max(...board.tiles.map((t) => t.col));
  const rows = Math.max(...board.tiles.map((t) => t.row));
  assert.deepEqual([sheet.width, sheet.height], [cols * width + (cols - 1) * padding, rows * (label + height) + (rows - 1) * padding]);
  const sources = new Map(board.tiles.map((t) => [t.frame, rawFrame(fixture, t.frame, `scale=${width}:${height}`, 'rgb24')]));
  for (const t of board.tiles) {
    const { x, y } = tileAt(board, t);
    // The picture under the label is this tile's frame, closer to it than to any other frame on the sheet.
    const picture = crop(sheet, x, y + label, width, height);
    const own = meanAbsDiff(picture, sources.get(t.frame)!);
    assert.ok(own < 6, `${t.label}: ${own.toFixed(1)} levels from frame ${t.frame}`);
    for (const [frame, other] of sources) {
      assert.ok(own <= meanAbsDiff(picture, other) + 0.5, `${t.label} looks more like frame ${frame} than frame ${t.frame}`);
    }
    // The label above it reads as its own text, and not as any other tile's.
    const band = crop(sheet, x, y, width, label);
    const misses = labelMisses(band, labelBand(t.label, width, 2));
    assert.ok(misses < 10, `${t.label}: ${misses} pixels differ`);
    for (const o of board.tiles) if (o !== t) assert.ok(labelMisses(band, labelBand(o.label, width, 2)) > misses, `${t.label} reads as ${o.label}`);
  }
  // Run again, the command prints its own sheets, which shots.json now names. The first run's stay a while,
  // since a run beside it may have printed them; a later run removes them once they are old.
  const out = await printed('storyboard', [fixture]);
  const again = written((JSON.parse(readFileSync(join(dir, 'storyboard', 'runs', 'reference', 'shots.json'), 'utf8')) as ShotListFile).storyboard);
  assert.ok(out.split('\n').includes(`    ${again.sheets[0]}  shots 1-6`), out);
  assert.match(out, /storyboard: a few frames of every shot, .* they show framing and on-screen text at those frames:/);
  assert.notEqual(again.sheets[0], board.sheets[0]);
  assert.deepEqual([existsSync(again.sheets[0]), existsSync(board.sheets[0])], [true, true]);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(board.sheets[0], old, old);
  await printed('storyboard', [fixture]);
  assert.equal(existsSync(board.sheets[0]), false);
});

test('shots: a reference too long for three frames a shot shows every shot\'s middle frame, on at most four sheets', async () => {
  // Thirty one-second shots: the hue and the brightness step every second, so every second is a cut.
  const long = join(dir, 'long.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=5:d=30', '-vf', "hue=H=floor(t)*2.4:b='mod(floor(t)*3.7,8)-4',format=yuv420p",
    '-c:v', 'libx264', long]);
  const list = await json('long', [], long);
  assert.equal(list.shots.length, 30);
  const board = written(list.storyboard);
  assert.equal(board.note, 'every shot shows its middle frame alone, since three frames a shot would need 5 sheets, more than 4');
  assert.deepEqual([board.tile.width, board.tile.height], [480, 270]);
  assert.deepEqual(board.tiles.map((t) => [t.shot, t.at]), list.shots.map((s) => [s.shot, 'middle']));
  assert.ok(board.sheets.length > 1 && board.sheets.length <= MAX_SHEETS, `${board.sheets.length} sheets`);
  for (const path of board.sheets) {
    const { width, height } = probeDisplaySize(path);
    assert.ok(width <= SHEET_SIDE && height <= SHEET_SIDE && Math.ceil(width / 28) * Math.ceil(height / 28) <= SHEET_PATCHES, `${path}: ${width}x${height}`);
    assert.ok(board.tiles.some((t) => t.sheet === path), `${path} holds no tile`);
  }
  // A shorter list of the same video names only its own sheet, and says each shot shows its middle.
  const out = await printed('long', [long]);
  assert.match(out, /storyboard: a few frames of every shot, labelled #<shot> <seconds> in shot order \(the middle of each\), on 2 sheet/);
  assert.match(out, /storyboard note: every shot shows its middle frame alone, since three frames a shot would need 5 sheets/);
  const one = written((await json('long', ['--threshold', '1'], long)).storyboard);
  assert.equal(one.sheets.length, 1);
  assert.ok(existsSync(one.sheets[0]));
  assert.deepEqual(written((JSON.parse(readFileSync(join(dir, 'long', 'runs', 'long', 'shots.json'), 'utf8')) as ShotListFile).storyboard).sheets, one.sheets);
});

test('shots: every storyboard tile is a frame of its own shot, however the frames fall on the grid', async () => {
  // One second at 30 fps, then 10 fps: the second shot's last frame is at 1.9 s, two grid frames before the cut.
  const vfr = join(dir, 'vfr-tiles.mp4');
  const parts = [{ source: 'testsrc2', rate: 30, frames: 30 }, { source: 'smptebars', rate: 10, frames: 10 }, { source: 'mandelbrot', rate: 10, frames: 10 }];
  ffmpeg([...parts.flatMap((p) => lavfi(p.source, '320x180', p.rate)),
    '-filter_complex', `${parts.map((p, i) => trimmed(i, p.frames)).join(';')};[v0][v1][v2]concat=n=3:v=1:a=0[v]`,
    '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', vfr]);
  // 30 fps with every frame after the first half a frame late: the second shot opens at 119/60 s, which ffmpeg
  // prints as 1.983333, a hair before the half-way point the seek of frame 60 lands on.
  const half = join(dir, 'half-frame.mp4');
  ffmpeg([...lavfi('smptebars', '320x180', 30), ...lavfi('mandelbrot', '320x180', 30), '-filter_complex',
    `${trimmed(0, 59)};${trimmed(1, 60)};[v0][v1]concat=n=2:v=1:a=0,settb=1/60,setpts='if(eq(N,0),0,PTS+1)'[v]`,
    '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', half]);
  for (const video of [vfr, half]) {
    const list = await json('tiles', [], video);
    const board = written(list.storyboard);
    for (const t of board.tiles) {
      const s = list.shots[t.shot - 1];
      const at = shownAt(video, t.frame, list.fps);
      assert.ok(Math.abs(at - t.sec) < 1e-3 && at >= s.start - 1e-3 && at < s.end - 1e-3,
        `${video}: ${t.label} (${t.at}, frame ${t.frame}) shows ${at}s; shot ${t.shot} runs ${s.start}-${s.end}s`);
    }
    // The list's own first frames are the ones frames --frame shows, too.
    for (const s of list.shots) assert.ok(Math.abs(shownAt(video, s.startFrame, list.fps) - s.start) < 1e-3, `${video}: shot ${s.shot}`);
  }
});

test('shots: a storyboard that cannot be made leaves the list written, and says why', async () => {
  const failing = async () => {
    throw Object.assign(new Error('Command failed: ffmpeg ...'), { stderr: 'first line\nffmpeg could not open the file\n' });
  };
  const list = await json('failing', [], fixture, failing);
  assert.deepEqual(list.storyboard, { sheets: [], why: 'it could not be made: ffmpeg could not open the file' });
  const onDisk = JSON.parse(readFileSync(join(dir, 'failing', 'runs', 'reference', 'shots.json'), 'utf8')) as ShotListFile;
  assert.deepEqual([onDisk.shots.length, onDisk.storyboard], [SEGMENTS.length, list.storyboard]);
  const { result, out } = await withRoot(join(dir, 'failing'), () => captureConsoleAsync(() => shots([fixture], failing)));
  assert.equal(result, 0);
  assert.match(out, /^ {2}storyboard: none: it could not be made: ffmpeg could not open the file$/m);
  // Nothing of the failed runs is left beside the list.
  assert.deepEqual(readdirSync(join(dir, 'failing', 'runs', 'reference')), ['shots.json']);
});

test('shots: a picture in a non-square or rotated frame is tiled in the shape it is shown in', async () => {
  // 160x180 stored, each pixel twice as wide as tall: shown 320x180. And 320x180 turned a quarter: shown 180x320.
  const anamorphic = synthClip(dir, 'anamorphic.mp4', { video: 'testsrc2=size=160x180:rate=25', seconds: 1, vf: 'setsar=2' });
  const turned = rotatedCopy(synthClip(dir, 'flat.mp4', { video: 'testsrc2=size=320x180:rate=25', seconds: 1 }), join(dir, 'turned.mp4'), 90);
  for (const [video, shown] of [[anamorphic, [320, 180]], [turned, [180, 320]]] as const) {
    const board = written((await json('shapes', [], video)).storyboard);
    assert.deepEqual([board.tile.width, board.tile.height], shown, video);
    const sheet = rgbOf(board.sheets[0]);
    for (const t of board.tiles) {
      const { x, y } = tileAt(board, t);
      const picture = crop(sheet, x, y + board.tile.label, board.tile.width, board.tile.height);
      const own = meanAbsDiff(picture, rawFrame(video, t.frame, `scale=${shown[0]}:${shown[1]}`, 'rgb24'));
      assert.ok(own < 8, `${video} ${t.label}: ${own.toFixed(1)} levels from its frame in its shown shape`);
    }
  }
});

test('shots: an HDR reference is tiled as frames shows it, converted to SDR', async () => {
  const pq = hdrClip(dir, 'pq-tiles.mp4', { transfer: 'smpte2084', video: 'testsrc2=size=960x540:rate=25', audio: null, pixFmt: 'yuv420p10le' });
  const list = await json('hdr', [], pq);
  const board = written(list.storyboard);
  const { width, height, label } = board.tile;
  assert.deepEqual([width, height], [480, 270]);
  const sheet = rgbOf(board.sheets[0]);
  const plan = extractFrames(pq, { frame: board.tiles.map((t) => String(t.frame)), out: join(dir, 'hdr-frames'), width });
  for (const t of board.tiles) {
    const { x, y } = tileAt(board, t);
    const shown = execFileSync(FFMPEG, ['-v', 'error', '-i', plan.stills.find((s) => s.frame === t.frame)!.path, '-vf', `scale=${width}:${height},format=rgb24`,
      '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    const own = meanAbsDiff(crop(sheet, x, y + label, width, height), shown);
    assert.ok(own < 6, `${t.label}: ${own.toFixed(1)} levels from frames --frame ${t.frame}`);
  }
});

test('shots: a % in the video\'s name is part of the run\'s folder, not a frame-number pattern', async () => {
  const percent = join(dir, 'clip%03d.mp4');
  synthClip(dir, 'clip%03d.mp4', { video: TESTSRC, seconds: 2 });
  const board = written((await json('percent', [], percent)).storyboard);
  assert.equal(dirname(board.sheets[0]), join(dir, 'percent', 'runs', 'clip%03d'));
  assert.ok(existsSync(board.sheets[0]));
  assert.equal(existsSync(join(dir, 'percent', 'runs', 'clip001')), false);
});

test('shots: --threshold and --min-shot reach the list and are recorded in it', async () => {
  const noFloor = await json('flags', ['--min-shot', '0']);
  assert.equal(noFloor.minShotSec, 0);
  assert.ok(noFloor.shots.length > SEGMENTS.length);
  const strict = await json('flags', ['--threshold', '0.9']);
  assert.equal(strict.threshold, 0.9);
  assert.ok(strict.shots.length < SEGMENTS.length && strict.shots.length >= 1);
  await assert.rejects(shots([fixture, '--threshold', '0']), /--threshold wants/);
  await assert.rejects(shots([fixture, '--threshold', '2']), /--threshold wants/);
  await assert.rejects(shots([fixture, '--min-shot=-1']), /--min-shot wants/);
});

test('shots: the command prints one row per shot, and refuses anything but one existing video', async () => {
  const out = await printed('cli', [fixture]);
  assert.match(out, new RegExp(`shots: ${SEGMENTS.length} shot\\(s\\)`));
  assert.match(out, /^\s+5\s+5\.800s\s+0\.800s\s+f000145\s+cut$/m);
  assert.ok(existsSync(join(dir, 'cli', 'runs', 'reference', 'shots.json')));
  assert.equal((await captureConsoleAsync(() => shots([]))).result, 2);
  assert.equal((await captureConsoleAsync(() => shots([fixture, fixture]))).result, 2);
  await assert.rejects(shots([join(dir, 'nothing-here.mp4')]), /video not found/);
});

test('shots: speech comes from the transcript on disk, word by word into the shot its midpoint falls in', async () => {
  // Cuts at 1.6 and 4.8 s. "and" straddles the first with its midpoint before it, "two" with its midpoint
  // after; the second chunk's words land by their own times.
  const path = transcriptAt('with-transcript', transcript(
    [['One', 0.2, 0.5], ['and', 1.4, 1.7], ['two', 1.7, 1.9], ['three.', 3.0, 3.4]],
    [['Four', 3.5, 3.8], ['five', 5.0, 5.2]],
  ));
  const list = await listIn('with-transcript');
  assert.deepEqual(list.sources.speech, { path });
  assert.deepEqual(list.shots.map((s) => s.speech), ['One and', 'two', 'three. Four', 'five', null, null]);
});

test('shots: speech comes from a speech-to-text JSON left as the transcript too, mapped in memory', async () => {
  const path = join(dir, 'mapped-transcript', 'runs', 'reference', 'transcript.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(new URL('./fixtures/transcripts/typed-words.json', import.meta.url)));
  const list = await listIn('mapped-transcript');
  assert.deepEqual(list.sources.speech, { path, mappedFrom: 'a timed word list' });
  assert.equal(list.shots.flatMap((s) => s.speech ?? []).join(' '), 'Give your family peace of mind, not a bill. Check your rate in two minutes.');
});

test('shots: with no transcript the list says why speech is missing, and never transcribes', async () => {
  const list = await listIn('no-transcript');
  const speech = list.sources.speech as { path: null; why: string };
  assert.equal(speech.path, null);
  assert.match(speech.why, /no transcript at .*transcript\.json.*transcribe/);
  assert.ok(list.shots.every((s) => s.speech === null));
  assert.equal(existsSync(join(dir, 'no-transcript', 'runs', 'reference', 'transcript.json')), false);
});

test('shots: a transcript that runs past the end of the video is another video\'s, and is not used', async () => {
  transcriptAt('foreign', transcript(Array.from({ length: 60 }, (_, i): [string, number, number] => [`w${i}`, i, i + 0.5])));
  const list = await listIn('foreign');
  const speech = list.sources.speech as { path: null; why: string };
  assert.equal(speech.path, null);
  assert.match(speech.why, /words until 59\.500s, but this video ends at 8\.000s, so it belongs to another video/);
  assert.ok(list.shots.every((s) => s.speech === null));
});

test('shots: a recording whose header holds no lengths (as a browser writes one) still takes its transcript', async () => {
  const live = join(dir, 'live.webm');
  ffmpeg([...lavfi('testsrc2', '320x180', 30), '-f', 'lavfi', '-i', SINE, '-filter_complex',
    '[0:v]trim=end_frame=60,setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]atrim=end=2[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libopus', '-live', '1', live]);
  const path = transcriptAt('live', transcript([['Hello', 0.2, 0.6], ['there.', 0.7, 1.1]]), 'live');
  const list = await listIn('live', live);
  assert.deepEqual(list.sources.speech, { path });
  assert.deepEqual(list.shots.map((s) => s.speech), ['Hello there.']);
  assert.ok(Math.abs(list.durationSec - 2) < 0.01, `ends at ${list.durationSec}s`);
  // Its storyboard needs no length either: the frames come from the decode.
  const board = written((await json('live', [], live)).storyboard);
  assert.deepEqual(board.tiles.map((t) => t.at), ['start', 'middle', 'end']);
  assert.ok(existsSync(board.sheets[0]));
});

test('shots: a video with no audio track has no speech to list', async () => {
  const silent = synthClip(dir, 'silent.mp4', { video: TESTSRC, seconds: 2 });
  const list = await listIn('silent-root', silent);
  assert.deepEqual(list.sources.speech, { path: null, why: 'the video has no audio track' });
  assert.equal(list.shots.length, 1);
});

test('shots: a file with no picture is refused', async () => {
  const tone = synthClip(dir, 'tone.m4a', { audio: SINE, seconds: 1 });
  await assert.rejects(listIn('tone', tone), /no video stream/);
});

test('shots: a file cut short is refused rather than listed to the length its header claims', async () => {
  const whole = join(dir, 'whole.mp4');
  // faststart puts the index first, so the cut copy still opens and declares all twelve seconds.
  ffmpeg([...lavfi('testsrc2'), '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', whole]);
  const cut = join(dir, 'cut.mp4');
  writeFileSync(cut, readFileSync(whole).subarray(0, Math.floor(statSync(whole).size * 0.45)));
  await assert.rejects(listIn('cut', cut), /declares 12\.000s of picture, but frames decode only until .*cut short/);
});

test('shots: a file that declares a little more picture than it decodes ends its storyboard at the last frame it has', async () => {
  // Every frame a keyframe, the index first: dropping the file's last packets leaves a file that still declares
  // them. Two frames short is within the three frames of slack the list allows; how many packets that takes
  // depends on whether this ffmpeg's encode shows its last frame.
  const whole = join(dir, 'whole-intra.mp4');
  ffmpeg([...lavfi('testsrc2'), ...lavfi('smptebars'), '-filter_complex', `${trimmed(0, 50)};${trimmed(1, 52)};[v0][v1]concat=n=2:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-g', '1', '-movflags', '+faststart', whole]);
  const sizes = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', whole],
    { encoding: 'utf8' }).trim().split('\n').map(Number);
  const declared = Math.round(videoDurationOf(whole) * FPS);
  const short = join(dir, 'short-intra.mp4');
  for (let drop = 1; drop <= 4; drop++) {
    writeFileSync(short, readFileSync(whole).subarray(0, statSync(whole).size - sizes.slice(-drop).reduce((a, b) => a + b, 0)));
    if (countFrames(short) <= declared - 2) break;
  }
  const decoded = countFrames(short);
  assert.equal(decoded, declared - 2, 'the fixture decodes two frames fewer than it declares');
  const list = await json('short', [], short);
  assert.equal(Math.round(list.durationSec * FPS), declared);
  assert.equal(written(list.storyboard).tiles.at(-1)!.frame, decoded - 1);
});

test('shots: on a variable-rate video the first frame of a shot is the one frames --frame shows', async () => {
  // One second at 30 fps, then two seconds at 10 fps: ffmpeg's own count reaches the cut at 2 s in 40
  // frames, the 30 fps grid that frames works on in 60.
  const vfr = join(dir, 'vfr.mp4');
  const parts = [{ source: 'testsrc2', rate: 30, frames: 30 }, { source: 'smptebars', rate: 10, frames: 10 }, { source: 'mandelbrot', rate: 10, frames: 10 }];
  ffmpeg([...parts.flatMap((p) => lavfi(p.source, '320x180', p.rate)),
    '-filter_complex', `${parts.map((p, i) => trimmed(i, p.frames)).join(';')};[v0][v1][v2]concat=n=3:v=1:a=0[v]`,
    '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', vfr]);
  const list = await listIn('vfr', vfr);
  assert.equal(list.fps, 30);
  assert.deepEqual(list.shots.map((s) => [s.start, s.startFrame]), [[0, 0], [1, 30], [2, 60]]);
  for (const s of list.shots) {
    const shown: string = spawnSync(FFMPEG, ['-v', 'info', '-ss', String(seekFor(s.startFrame, list.fps)), '-i', vfr, '-copyts',
      '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    assert.equal(Number(shown.match(/pts_time:([\d.]+)/)?.[1]), s.start, `frame ${s.startFrame} is the shot's first picture`);
  }
});

test('shots: off the frame grid, the first frame of a shot is still the one frames --frame shows', async () => {
  // A cut at frame 31 of 30 fps: Matroska's millisecond clock stamps it 1.033 s, and an .mp4 cut 6 ms early
  // stamps it 1.027 s. Both are frame 31 to frames, which seeks half a frame early.
  const graph = `${trimmed(0, 31)};${trimmed(1, 30)};[v0][v1]concat=n=2:v=1:a=0`;
  const mkv = join(dir, 'offgrid.mkv');
  ffmpeg([...lavfi('testsrc2', '320x180', 30), ...lavfi('smptebars', '320x180', 30), '-filter_complex', `${graph}[v]`,
    '-map', '[v]', '-c:v', 'libx264', mkv]);
  const early = join(dir, 'early.mp4');
  ffmpeg([...lavfi('testsrc2', '320x180', 30), ...lavfi('smptebars', '320x180', 30), '-filter_complex',
    `${graph},setpts='PTS-gte(N,31)*0.006/TB'[v]`, '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', early]);
  for (const video of [mkv, early]) {
    const list = await listIn('offgrid', video);
    assert.deepEqual(list.shots.map((s) => s.startFrame), [0, 31], video);
    const cut = list.shots[1];
    const shown: string = spawnSync(FFMPEG, ['-v', 'info', '-ss', String(seekFor(cut.startFrame, list.fps)), '-i', video, '-copyts',
      '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const at = Number(shown.match(/pts_time:([\d.]+)/)?.[1]);
    assert.ok(Math.abs(at - cut.start) < 1e-3, `${video}: frame 31 shows ${at}s, the cut is at ${cut.start}s`);
  }
});

test('shots: a .webm whose audio outlasts its picture is listed, not refused as cut short', async () => {
  // Matroska keeps no length per stream, so the container's, which counts the audio, cannot hold the picture.
  const webm = join(dir, 'long-audio.webm');
  ffmpeg([...lavfi('testsrc2', '320x180', 30), '-f', 'lavfi', '-i', SINE, '-filter_complex',
    '[0:v]trim=end_frame=90,setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]atrim=end=3.25[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libopus', webm]);
  const list = await listIn('webm', webm);
  assert.equal(list.shots.length, 1);
  assert.ok(Math.abs(list.durationSec - 3) < 0.01, `ends at ${list.durationSec}s`);
});

test('shots: a picture that starts after its audio is listed on the file\'s clock to its own end', async () => {
  // The picture starts a second in and runs three: testsrc2 for two, then smptebars, cut at 3 s on the clock.
  // -fps_mode vfr keeps that first second empty, which ffmpeg 6.1 otherwise fills with copies of the first frame.
  const late = join(dir, 'late.mp4');
  ffmpeg([...lavfi('testsrc2'), ...lavfi('smptebars'), '-f', 'lavfi', '-i', SINE,
    '-filter_complex', `${trimmed(0, 50)};${trimmed(1, 25)};[v0][v1]concat=n=2:v=1:a=0,setpts=PTS+1/TB[v]`,
    '-map', '[v]', '-map', '2:a', '-t', '4', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', late]);
  const list = await listIn('late', late);
  assert.deepEqual(list.shots.map((s) => [s.start, s.startFrame]), [[1, 25], [3, 75]]);
  assert.ok(list.durationSec > 3.9, `ends at ${list.durationSec}s`);
  assert.equal(list.shots.at(-1)!.end, list.durationSec);
  // The storyboard reaches the second shot, on the clock past the three seconds the picture lasts.
  const board = written((await json('late', [], late)).storyboard);
  assert.deepEqual([...new Set(board.tiles.map((t) => t.shot))], [1, 2]);
  assert.deepEqual(board.tiles.slice(0, 3).map((t) => t.frame), [25, 50, 74]);
  assert.ok(board.tiles.at(-1)!.frame > 75, `last tile at frame ${board.tiles.at(-1)!.frame}`);
});

test('shots: ffmpeg metadata lines parse into scores, closed black runs and the rows the picture fills', () => {
  const frame = (n: number, sec: number, ...keys: string[]) => [`frame:${n}    pts:${n}    pts_time:${sec}`, ...keys];
  const text = [
    ...frame(0, 0, 'lavfi.cropdetect.y1=60', 'lavfi.cropdetect.y2=119', 'lavfi.scene_score=0.000000'),
    ...frame(1, 0.5, 'lavfi.black_start=0.5', 'lavfi.scene_score=0.553000'),
    ...frame(2, 1, 'lavfi.black_end=1', 'lavfi.scene_score=0.010000'),
    ...frame(3, 1.5, 'lavfi.black_start=1.5', 'lavfi.cropdetect.y1=40', 'lavfi.cropdetect.y2=139', 'lavfi.scene_score=0.400000'),
    '',
  ].join('\n');
  // The run opened at 1.5 s never closes: it runs into the end of the picture. The crop box only grows, so the
  // last frame's is the whole clip's.
  assert.deepEqual(parseFrames(text), {
    scores: [{ sec: 0, score: 0 }, { sec: 0.5, score: 0.553 }, { sec: 1, score: 0.01 }, { sec: 1.5, score: 0.4 }],
    blacks: [{ start: 0.5, end: 1 }],
    picture: { top: 40, bottom: 139 },
  });
  // Black throughout leaves the box inside out, and no rows are read as the picture.
  assert.equal(parseFrames(frame(0, 0, 'lavfi.cropdetect.y1=179', 'lavfi.cropdetect.y2=0', 'lavfi.scene_score=0').join('\n')).picture, null);
});

test('shots: a cut needs the threshold and room from the first frame, the end and every stronger cut', () => {
  const at = (frame: number, score: number): FrameScore => ({ sec: frame / 10, score });
  const cuts = (scores: FrameScore[], minShotSec: number) =>
    pickCuts(scores, [], { threshold: 0.2, minShotSec, startSec: 0, endSec: 6, fps: 10 }).map((c) => Math.round(c.sec * 10));
  // Frame 0 opens the first shot already; 2 is 0.2 s in; 22 is 0.2 s after 20; 58 leaves 0.2 s; 10 is under.
  assert.deepEqual(cuts([at(0, 1), at(2, 0.9), at(10, 0.19), at(20, 0.5), at(22, 0.4), at(40, 0.2), at(58, 0.9)], 0.5), [20, 40]);
  // Exactly the floor apart is far enough, float rounding included.
  assert.deepEqual(cuts([at(20, 0.4), at(24, 0.4)], 0.4), [20, 24]);
  // Spacing counts from the cuts kept, not from every candidate.
  assert.deepEqual(cuts([20, 23, 26, 29].map((f) => at(f, 0.5)), 0.5), [20, 26]);
  // A weak flash just before a strong cut does not take its place.
  assert.deepEqual(cuts([at(49, 0.3), at(51, 0.9)], DEFAULT_MIN_SHOT_SEC), [51]);
  // Ranked before the start and the end are cleared, so a strong cut too near the start still beats the weaker
  // one beside it, as it would mid-video.
  assert.deepEqual(cuts([at(6, 0.9), at(14, 0.4)], 1), []);
  assert.deepEqual(cuts([at(26, 0.9), at(34, 0.4)], 1), [26]);
});

test('shots: a fade through black opens a shot at its middle black frame; a cut at its edge stands instead', () => {
  // Frames every 0.1 s for 6 s, quiet but for the spikes named.
  const film = (spikes: Record<number, number>): FrameScore[] =>
    Array.from({ length: 60 }, (_, f) => ({ sec: f / 10, score: spikes[f] ?? 0.01 }));
  const cuts = (scores: FrameScore[], blacks: { start: number; end: number }[]) =>
    pickCuts(scores, blacks, { threshold: 0.2, minShotSec: 0.3, startSec: 0, endSec: 6, fps: 10 })
      .map((c) => [Math.round(c.sec * 10), c.transition]);
  // Faded out and in: black from 2.0 to 2.6 s, frames 20-25, so the middle is frame 23.
  assert.deepEqual(cuts(film({}), [{ start: 2, end: 2.6 }]), [[23, 'dip to black']]);
  // Faded into, cut out of (or a fade in short enough to spike): the cut is the split, and it is still a dip.
  assert.deepEqual(cuts(film({ 26: 0.8 }), [{ start: 2, end: 2.6 }]), [[26, 'dip to black']]);
  // Cut into and out of: a black shot of its own, opened and closed by its cuts.
  assert.deepEqual(cuts(film({ 20: 0.8, 26: 0.8 }), [{ start: 2, end: 2.6 }]), [[20, 'cut'], [26, 'cut']]);
  // Black from the first frame is the first shot fading in, not a dip between two.
  assert.deepEqual(cuts(film({}), [{ start: 0, end: 0.5 }]), []);
});

test('shots: shots run from cut to cut, numbered on the frames grid', () => {
  const list = shotsFrom([{ sec: 2, score: 0.5, transition: 'cut' }, { sec: 4, score: null, transition: 'dip to black' }],
    { startSec: 0, endSec: 6, fps: 25 });
  assert.deepEqual(list.map((s) => [s.start, s.end, s.duration, s.startFrame, s.transition, s.cutScore]), [
    [0, 2, 2, 0, null, null], [2, 4, 2, 50, 'cut', 0.5], [4, 6, 2, 100, 'dip to black', null],
  ]);
});

test('shots: a shot nothing is said in has null speech, and punctuation closes up on its word', () => {
  const plain = shotsFrom([{ sec: 2, score: 0.5, transition: 'cut' }], { startSec: 0, endSec: 4, fps: 25 });
  const said = withSpeech(plain, transcript([['Hello', 0.1, 0.4], [',', 0.4, 0.45], ['you', 0.5, 0.7]]));
  assert.deepEqual(said.map((s) => s.speech), ['Hello, you', null]);
});

// Four shots of two seconds on a 320x180 frame. The stand-in detector puts one face in every still of a shot,
// by the still's place on faces' sampling grid: 80 px tall (0.444 of the frame), 36 (0.2), 18 (0.1), then none.
const FACE_EVERY = 0.25;
const FACE_OPTIONS = { every: FACE_EVERY, threshold: 10, confidence: 0.5, margin: 0.25 };
const FACED = [
  { source: 'testsrc2', face: 80 },
  { source: 'smptebars', face: 36 },
  { source: 'mandelbrot', face: 18 },
  { source: 'color=c=0x2050a0', face: 0 },
];
const sizedVideo = join(dir, 'sized.mp4');

/** The four shots above, hard-cut, with the faces the stand-in finds in them written where faces writes them. */
async function sizedReference(root: string): Promise<string> {
  if (!existsSync(sizedVideo)) {
    ffmpeg([...FACED.flatMap((s) => lavfi(s.source)), '-filter_complex',
      `${FACED.map((_, i) => trimmed(i, 2 * FPS)).join(';')};${FACED.map((_, i) => `[v${i}]`).join('')}concat=n=${FACED.length}:v=1:a=0[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sizedVideo]);
  }
  // Grid still n is the first frame at or past (n + 0.5) * FACE_EVERY seconds; no shot is short enough to get more.
  const stub = stubDetector((file): StubBox[] => {
    if (!file.startsWith('c')) throw new Error(`${file} is not a grid still, so the stand-in cannot place it`);
    const h = FACED[Math.floor(((Number(file.slice(1, -4)) + 0.5) * FACE_EVERY) / 2)].face;
    return h ? [[100, 20, h, h]] : [];
  });
  return writeFaces(root, sizedVideo, JSON.stringify(findFaces(sizedVideo, FACE_OPTIONS, stub)));
}

test('shots: each shot\'s size comes from the face boxes faces wrote: close-up, medium, wide and no face', async () => {
  const path = await sizedReference('sized');
  const list = await listIn('sized', sizedVideo);
  assert.deepEqual(list.sources.shotSize, { path });
  assert.equal(list.pictureHeight, list.height);
  assert.deepEqual(list.shots.map((s) => [s.startFrame, s.shotSize, s.faceShare]),
    [[0, 'close-up', 0.444], [50, 'medium', 0.2], [100, 'wide', 0.1], [150, 'no face', null]]);
  const out = await printed('sized', [sizedVideo]);
  assert.match(out, /^\s+1\s+0\.000s\s+2\.000s\s+f000000\s+start\s+close-up 0\.444$/m);
  assert.match(out, /^\s+3\s+4\.000s\s+2\.000s\s+f000100\s+cut\s+wide 0\.100$/m);
  // The last shot's length is left out: ffmpeg builds disagree on how long the encoded clip's last frame lasts.
  assert.match(out, /^\s+4\s+6\.000s\s+[\d.]+s\s+f000150\s+cut\s+no face$/m);
  assert.match(out, new RegExp(`shot size: .*faces\\.json \\(the largest face's height over the picture's: close-up from ${CLOSE_UP_MIN}, ` +
    `medium from ${MEDIUM_MIN}, wide below\\)\\. .*in profile now and then a size off.*check those shots on the storyboard`));
});

test('shots: a 16:9 close-up letterboxed into 9:16 is measured against its picture, not the bars', async () => {
  const boxed = join(dir, 'letterboxed.mp4');
  ffmpeg([...lavfi('testsrc2'), '-t', '2', '-vf', 'scale=180:102,pad=180:320:0:109:black,setsar=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', boxed]);
  // A face 45 px tall: 0.44 of the 102-row picture, 0.14 of the 320-row frame.
  await writeFaces('letterboxed', boxed, JSON.stringify(findFaces(boxed, FACE_OPTIONS, stubDetector(() => [[60, 130, 45, 45]]))));
  const list = await listIn('letterboxed', boxed);
  assert.ok(list.pictureHeight >= 100 && list.pictureHeight <= 104, `picture ${list.pictureHeight} rows`);
  assert.deepEqual(list.shots.map((s) => s.shotSize), ['close-up']);
  assert.ok(Math.abs(list.shots[0].faceShare! - 45 / list.pictureHeight) < 0.002, `share ${list.shots[0].faceShare}`);
  assert.match(await printed('letterboxed', [boxed]), new RegExp(`the picture ${list.pictureHeight} of 320 rows between black bars`));
});

test('shots: a dark backdrop above a face, or a dark body below it, is not taken for a letterbox', async () => {
  // A bright head on rows 38-87 of a black 320x180 frame, over a body down to the bottom edge: mid grey, then near
  // black. Read as bars, the first lost its top 38 rows and the second everything but the head.
  for (const [name, body] of [['dark', '0x404040'], ['darker', '0x101010']]) {
    const video = join(dir, `${name}.mp4`);
    ffmpeg([...lavfi('color=c=black'), '-t', '2', '-vf',
      `drawbox=x=135:y=38:w=50:h=50:color=0xB0B0B0:t=fill,drawbox=x=110:y=88:w=100:h=92:color=${body}:t=fill`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    await writeFaces(name, video, JSON.stringify(findFaces(video, FACE_OPTIONS, stubDetector(() => [[140, 44, 36, 36]]))));
    const list = await listIn(name, video);
    assert.equal(list.pictureHeight, 180, name);
    assert.deepEqual(list.shots.map((s) => [s.shotSize, s.faceShare]), [['medium', 0.2]], name);
  }
});

test('shots: black rows are bars only when there are some both above and below the picture, and they match', () => {
  // 456 rows: a 16:9 picture centred in 9:16 leaves about 155 above and below.
  assert.equal(pictureShareOf({ top: 155, bottom: 300 }, 456), 146 / 456);
  assert.equal(pictureShareOf({ top: 153, bottom: 299 }, 456), 147 / 456);
  for (const picture of [null, { top: 0, bottom: 455 }, { top: 30, bottom: 455 }, { top: 0, bottom: 300 }, { top: 30, bottom: 69 }, { top: 155, bottom: 456 }]) {
    assert.equal(pictureShareOf(picture, 456), 1, JSON.stringify(picture));
  }
});

test('shots: with no faces.json the list says to run faces or name the boxes, never finds faces itself, and lists the rest', async () => {
  const list = await listIn('no-faces');
  const source = list.sources.shotSize as { path: null; why: string };
  assert.equal(source.path, null);
  assert.match(source.why, /no face boxes at .*faces\.json\. Run npx @veedstudio\/openedit-cli faces .*reference\.mp4.*, then run shots again, or name boxes kept elsewhere with --faces <faces\.json>$/);
  assert.ok(list.shots.every((s) => s.shotSize === null && s.faceShare === null));
  assert.equal(list.shots.length, SEGMENTS.length);
  assert.equal(existsSync(await facesAt('no-faces')), false);
  assert.match(await printed('no-faces', [fixture]), /shot size: none listed: no face boxes at .*faces\.json\. Run .* faces /);
});

test('shots: --faces names the boxes to read, and refuses a file that is not there, a directory, or another clip\'s boxes', async () => {
  const path = await sizedReference('named-faces-from');
  const list = await listIn('named-faces', sizedVideo, { ...options, faces: path });
  assert.deepEqual(list.sources.shotSize, { path });
  assert.equal(list.shots[0].shotSize, 'close-up');
  await assert.rejects(listIn('named-faces', sizedVideo, { ...options, faces: join(dir, 'nowhere', 'faces.json') }),
    /no face boxes at .*nowhere.*faces\.json: run npx @veedstudio\/openedit-cli faces .* --out <dir> first, or leave out --faces/);
  await assert.rejects(listIn('named-faces', sizedVideo, { ...options, faces: join(dir, 'named-faces-from', 'runs', 'sized') }),
    /--faces names the directory .*sized: name the file in it, as --faces .*faces\.json/);
  // Named on purpose, so a mismatch stops the command rather than emptying the column.
  await assert.rejects(listIn('named-faces', fixture, { ...options, faces: path }),
    /holds the faces of .*sized\.mp4 .*not of .*reference\.mp4.*: name the faces\.json faces wrote for .*reference\.mp4.*, or leave out --faces$/);
  const torn = join(dir, 'named-faces', 'torn.json');
  mkdirSync(join(dir, 'named-faces'), { recursive: true });
  writeFileSync(torn, '{"video": "/a/clip.mp4", "shots": [');
  await assert.rejects(listIn('named-faces', fixture, { ...options, faces: torn }), /torn\.json: Unexpected end of JSON input: name the faces\.json/);
});

test('shots: --faces on the command line reads the boxes it names, a relative path from the working directory', async () => {
  // Kept under another root, so only the flag finds them.
  const path = await sizedReference('named-faces-cli-from');
  const list = await json('named-faces-cli', ['--faces', relative(process.cwd(), path)], sizedVideo);
  assert.deepEqual(list.sources.shotSize, { path });
  assert.equal(list.shots[0].shotSize, 'close-up');
});

test('shots: boxes found on this video before it changed are named as stale, with the command that finds them again', async () => {
  await writeFaces('stale-faces', fixture, JSON.stringify({
    video: fixture, width: 320, height: 180, durationSec: 99, shots: [{ start: 0, end: 99, samples: [{ sec: 1, faces: [] }] }],
  }));
  const list = await listIn('stale-faces');
  const source = list.sources.shotSize as { path: null; why: string };
  assert.equal(source.path, null);
  assert.match(source.why, /the video has changed since\. Run npx @veedstudio\/openedit-cli faces .*reference\.mp4.* again, then run shots again$/);
  assert.doesNotMatch(source.why, /--out/);
  assert.ok(list.shots.every((s) => s.shotSize === null));
});

test('shots: another clip\'s boxes where faces writes this clip\'s are refused with the way round it; the same file by another path is not', async () => {
  const path = await sizedReference('foreign-faces');
  await writeFaces('foreign-faces', fixture, readFileSync(path, 'utf8'));
  const list = await listIn('foreign-faces');
  const source = list.sources.shotSize as { path: null; why: string };
  assert.equal(source.path, null);
  // faces refuses to write over another clip's boxes at the default place, so the way round is --out, then --faces.
  assert.match(source.why, /holds the faces of .*sized\.mp4 .*not of .*reference\.mp4.*\. Run npx @veedstudio\/openedit-cli faces .*reference\.mp4.* --out <dir>, then npx @veedstudio\/openedit-cli shots .*reference\.mp4.* --faces <dir>\/faces\.json$/);
  assert.ok(list.shots.every((s) => s.shotSize === null));
  if (process.platform === 'win32') return; // a symbolic link needs privileges there
  mkdirSync(join(dir, 'link'), { recursive: true });
  const link = join(dir, 'link', 'sized.mp4');
  if (!existsSync(link)) symlinkSync(sizedVideo, link);
  const linked = await listIn('foreign-faces', link, { ...options, faces: path });
  assert.deepEqual(linked.sources.shotSize, { path });
});

test('shots: boxes an older faces wrote to runs/<key>/faces.json are read for their own clip, and passed over for another', async () => {
  const boxes = readFileSync(await sizedReference('shared-faces-from'));
  const shared = (key: string) => {
    mkdirSync(join(dir, 'shared-faces', 'runs', key), { recursive: true });
    writeFileSync(join(dir, 'shared-faces', 'runs', key, 'faces.json'), boxes);
    return join(dir, 'shared-faces', 'runs', key, 'faces.json');
  };
  const own = shared('sized');
  const list = await listIn('shared-faces', sizedVideo);
  assert.deepEqual(list.sources.shotSize, { path: own });
  assert.equal(list.shots[0].shotSize, 'close-up');
  shared('reference');
  const other = (await listIn('shared-faces')).sources.shotSize as { path: null; why: string };
  assert.equal(other.path, null);
  assert.ok(other.why.startsWith(`no face boxes at ${await facesAt('shared-faces')}. Run `), other.why);
});

test('shots: a faces.json that cannot be read says so, naming the file, and the rest is listed', async () => {
  const clip = '"video": "/a/clip.mp4", "width": 320, "height": 180, "durationSec": 8';
  for (const [body, problem] of [
    ['{"video": "/a/clip.mp4", "shots": [', /Unexpected end of JSON input/],
    ['{}', /is not a faces\.json the faces command wrote \(no video path\)/],
    [`{${clip}, "shots": [{"samples": []}]}`, /\(a shot without its start or end\)/],
    [`{${clip}, "shots": [{"start": 0, "end": 8, "samples": [{"sec": 1}]}]}`, /\(a sample without its time or face boxes\)/],
  ] as const) {
    await writeFaces('bad-faces', fixture, body);
    const list = await listIn('bad-faces');
    const source = list.sources.shotSize as { path: null; why: string };
    assert.equal(source.path, null);
    assert.match(source.why, new RegExp(`faces\\.json.*${problem.source}.*\\. Run npx @veedstudio/openedit-cli faces .* again, then run shots again$`));
    assert.equal(list.shots.length, SEGMENTS.length);
  }
});

test('shots: a shot no sample of faces.json falls in is listed as not sampled', async () => {
  const path = await sizedReference('unsampled');
  const clip = JSON.parse(readFileSync(path, 'utf8')) as FacesClip;
  for (const shot of clip.shots) shot.samples = shot.samples.filter((x) => x.sec < 2 || x.sec >= 4);
  writeFileSync(path, JSON.stringify(clip));
  const list = await listIn('unsampled', sizedVideo);
  assert.deepEqual(list.shots.map((s) => s.shotSize), ['close-up', null, 'wide', 'no face']);
  assert.match(await printed('unsampled', [sizedVideo]), /^\s+2\s+2\.000s\s+2\.000s\s+f000050\s+cut\s+not sampled$/m);
});

const sample = (sec: number, ...heights: number[]): Sample => ({ sec, faces: heights.map((h) => ({ x: 0, y: 0, w: h, h })) });
const sizeAt = (share: number) => shotSizeOf([sample(0, share * 1000)], 1000)!.shotSize;

test('shots: a shot\'s size is the median of each sample\'s largest face against the picture', () => {
  // The largest face in each sample counts; one sample far off does not move the median (the mean would be 0.239).
  assert.deepEqual(shotSizeOf([sample(0, 30, 90), sample(1, 92), sample(2, 10), sample(3, 95)], 300), { shotSize: 'close-up', faceShare: 0.303 });
  assert.deepEqual([CLOSE_UP_MIN, CLOSE_UP_MIN - 0.001, MEDIUM_MIN, MEDIUM_MIN - 0.001].map(sizeAt), ['close-up', 'medium', 'medium', 'wide']);
  assert.equal(shotSizeOf([], 1000), null);
});

test('shots: the thresholds sit in the gaps between the sizes of real shots labelled by eye', () => {
  // Of 89 shots labelled by eye, the medium with the largest face read 0.232 and the close-up with the smallest 0.249;
  // the wide with the largest face 0.153 and the medium with the smallest 0.177.
  assert.deepEqual([0.232, 0.249, 0.153, 0.177].map(sizeAt), ['medium', 'close-up', 'wide', 'medium']);
});

test('shots: a face in fewer than half a shot\'s samples is no face; in half or more, it sizes the shot', () => {
  assert.deepEqual(shotSizeOf([sample(0, 300), sample(1), sample(2)], 1000), { shotSize: 'no face', faceShare: null });
  // The samples with no face are left out of the median rather than counted as nothing.
  assert.deepEqual(shotSizeOf([sample(0, 100), sample(1)], 1000), { shotSize: 'wide', faceShare: 0.1 });
});

test('shots: a sample goes to the shot its frame is in, whatever shot faces put it in', () => {
  const plain = shotsFrom([{ sec: 2, score: 0.5, transition: 'cut' }], { startSec: 0, endSec: 4, fps: 25 });
  // faces saw no cut here. The sample on the cut's own frame (2 s, frame 50) is the second shot's: counted in the
  // first, it would pull that shot from 0.30 to 0.20, a medium.
  const clip = { height: 100, shots: [{ start: 0, end: 4, samples: [sample(0.5, 30), sample(2, 10), sample(3, 10)] }] } as FacesClip;
  assert.deepEqual(withShotSize(plain, clip, 25).map((s) => [s.shotSize, s.faceShare]), [['close-up', 0.3], ['wide', 0.1]]);
  // The frame before the cut is the first shot's, and the cut's own frame alone sizes the second.
  const edge = { height: 100, shots: [{ start: 0, end: 4, samples: [sample(1.96, 30), sample(2, 10)] }] } as FacesClip;
  assert.deepEqual(withShotSize(plain, edge, 25).map((s) => s.shotSize), ['close-up', 'wide']);
  // A shot no sample falls in has no size to give, and a picture half the frame's height doubles every share.
  const sparse = { height: 100, shots: [{ start: 0, end: 4, samples: [sample(3, 10)] }] } as FacesClip;
  assert.deepEqual(withShotSize(plain, sparse, 25).map((s) => s.shotSize), [null, 'wide']);
  assert.deepEqual(withShotSize(plain, sparse, 25, 0.5).map((s) => s.faceShare), [null, 0.2]);
});
