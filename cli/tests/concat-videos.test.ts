// Tests commands/concat-videos.ts. The pure parts — canvas choice, filter graph, argv — are
// asserted directly; the join itself is exercised for real against two clips ffmpeg synthesises here,
// with DIFFERENT aspect ratios, because that is the case the obvious implementation gets wrong.
//   Run:  node --import tsx tests/concat-videos.test.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { concatVideos, ffmpegArgs, filterGraph, largestByArea } from '../src/commands/concat-videos.ts';
import { evenSize, parseCanvas } from '../src/size.ts';
import { parseFit } from '../src/commands/reframe.ts';
import { probeSquareSize } from '../src/probe.ts';
import { FLAT_RGB, captureConsole, captureConsoleAsync, flatClip, probeStream, scratchDir, shownRgb } from './helpers/synth.ts';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

// filterGraph/ffmpegArgs take a per-input audio plan; most tests just want "every clip has audio".
const withAudio = (n: number): { hasAudio: boolean; duration: number }[] =>
  Array.from({ length: n }, () => ({ hasAudio: true, duration: 1 }));

await test('the canvas is the largest input, so nothing is downscaled to meet the smallest', () => {
  assert.deepEqual(
    largestByArea([{ width: 480, height: 864 }, { width: 1280, height: 720 }, { width: 640, height: 360 }]),
    { width: 1280, height: 720 },
  );
});

await test('canvas dimensions are forced even, because yuv420p cannot encode odd ones', () => {
  assert.deepEqual(evenSize({ width: 1001, height: 547 }), { width: 1000, height: 546 });
  assert.deepEqual(largestByArea([{ width: 999, height: 999 }]), { width: 998, height: 998 });
  assert.deepEqual(parseCanvas('1081x1921'), { width: 1080, height: 1920 });
});

await test('a malformed --canvas is refused by name rather than silently ignored', () => {
  assert.throws(() => parseCanvas('1080'), /WIDTHxHEIGHT/);
  assert.throws(() => parseCanvas('wide'), /WIDTHxHEIGHT/);
});

await test('letterbox FITS and pads each clip, never crops or stretches', () => {
  const graph = filterGraph({ width: 1280, height: 720 }, 'letterbox', withAudio(2));
  // decrease = fit inside; without it ffmpeg stretches and every face goes oval.
  assert.match(graph, /force_original_aspect_ratio=decrease/);
  assert.match(graph, /pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2/);
  assert.ok(!graph.includes('crop'), 'letterbox keeps all the framing behind bars — it must not cut');
  // A non-square pixel aspect on one input would otherwise concatenate at the wrong shape.
  assert.match(graph, /setsar=1/);
  assert.match(graph, /concat=n=2:v=1:a=1/);
});

await test('crop FILLS the canvas and cuts the overflow, never pads', () => {
  const graph = filterGraph({ width: 1280, height: 720 }, 'crop', withAudio(2));
  // increase = cover the canvas, then crop the part that hangs over — the opposite trade to letterbox. A clip of
  // another shape reaches this already cut to the canvas's shape by reframe's filters, so only rounding is left.
  assert.match(graph, /force_original_aspect_ratio=increase/);
  assert.match(graph, /crop=1280:720/);
  assert.ok(!graph.includes('pad='), 'crop fills the frame — a black bar means it fitted instead');
  assert.match(graph, /setsar=1/);
  assert.match(graph, /concat=n=2:v=1:a=1/);
});

await test('a clip with no audio track gets synthesised silence, not a missing [i:a] map', () => {
  const graph = filterGraph({ width: 640, height: 360 }, 'letterbox',
    [{ hasAudio: true, duration: 1 }, { hasAudio: false, duration: 2.5 }]);
  assert.match(graph, /\[0:a\]aresample=48000/, 'the clip that has audio uses its own track');
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=duration=2\.5/, 'the silent clip is filled to its length');
  assert.ok(!graph.includes('[1:a]'), 'the audio-less clip must never be mapped as [1:a]');
  assert.match(graph, /concat=n=2:v=1:a=1/);
});

await test('--fit is validated by name, so a typo cannot be read as a mode', () => {
  assert.equal(parseFit(undefined), 'crop');
  assert.equal(parseFit('letterbox'), 'letterbox');
  assert.equal(parseFit('crop'), 'crop');
  assert.throws(() => parseFit('cropp'), /crop or letterbox/);
  assert.throws(() => parseFit('open'), /crop or letterbox/);
});

await test('the graph scales with the number of inputs', () => {
  assert.match(
    filterGraph({ width: 640, height: 360 }, 'letterbox', withAudio(3)),
    /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3/,
  );
});

await test('every input is passed as its own -i, in order', () => {
  const args = ffmpegArgs(['a.mp4', 'b.mp4'], 'out.mp4', { width: 640, height: 360 }, 'letterbox', withAudio(2));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '-i'), ['a.mp4', 'b.mp4']);
  assert.equal(args.at(-1), 'out.mp4');
  assert.ok(args.includes('yuv420p'));
});

await test('fewer than two clips is refused — one clip is already the answer', async () => {
  await assert.rejects(concatVideos(['only.mp4'], 'out.mp4'), /at least two clips/);
});

await test('a missing clip is named, rather than failing inside ffmpeg', async () => {
  await assert.rejects(concatVideos(['/nope/a.mp4', '/nope/b.mp4'], 'out.mp4'), /clip not found/);
});

// A clip of an exact size with a tone, synthesised so the tests need no fixtures and no network.
async function synthClip(file: string, size: string): Promise<void> {
  await run(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=1`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
}

// A video-only clip with NO audio track — a stand-in for a silent motion-graphics render.
async function synthSilentClip(file: string, size: string): Promise<void> {
  await run(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', file,
  ]);
}

async function joinedDuration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return Number(stdout.trim());
}

async function hasAudioStream(file: string): Promise<boolean> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
  ]);
  return stdout.trim().length > 0;
}

// The case the concat demuxer rejects outright, and the one Fabric produces whenever two stills have
// different shapes. Both code-based strategies must land the join at the exact canvas with both clips
// present — they differ only in what they do to the mismatched clip, which the filter-graph unit tests pin.
for (const fit of ['letterbox', 'crop'] as const) {
  await test(`two clips of DIFFERENT aspect ratios really do join with --fit ${fit}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concat-'));
    // A workspace of its own, so no face boxes from elsewhere are found for the landscape clip.
    const root = process.env.OPEN_EDIT_ROOT;
    process.env.OPEN_EDIT_ROOT = dir;
    try {
      const portrait = join(dir, 'portrait.mp4');
      const landscape = join(dir, 'landscape.mp4');
      const out = join(dir, 'joined.mp4');
      await Promise.all([synthClip(portrait, '480x864'), synthClip(landscape, '640x360')]);

      const canvas = await concatVideos([portrait, landscape], out, { fit });
      // 480x864 is the larger area, so it is the canvas; the landscape clip is padded or cropped into it.
      assert.deepEqual(canvas, { width: 480, height: 864 });
      const { width, height } = probeSquareSize(out);
      assert.deepEqual({ width, height }, { width: 480, height: 864 });
      // Both clips are present: ~2s, not ~1s. A concat that silently dropped one would still produce a file.
      assert.ok(await joinedDuration(out) > 1.6, `joined duration should be ~2s under --fit ${fit}`);
    } finally {
      if (root === undefined) delete process.env.OPEN_EDIT_ROOT; else process.env.OPEN_EDIT_ROOT = root;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

await test('a clip with NO audio track still joins — the concat synthesises silence for it', async () => {
  // Before the fix, filterGraph maps [1:a] for the silent clip and ffmpeg aborts the whole run with
  // "Stream specifier :a matches no streams". A motion-graphics shot is commonly silent, so it must
  // join like any other and the output must carry an audio track.
  const dir = await mkdtemp(join(tmpdir(), 'concat-'));
  try {
    const voiced = join(dir, 'voiced.mp4');
    const silent = join(dir, 'silent.mp4');
    const out = join(dir, 'joined.mp4');
    await Promise.all([synthClip(voiced, '640x360'), synthSilentClip(silent, '640x360')]);

    await concatVideos([voiced, silent], out);
    assert.ok(await joinedDuration(out) > 1.6, 'both clips present (~2s)');
    assert.equal(await hasAudioStream(out), true, 'the joined output carries an audio track');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a VP8 WebM joined first, which its decoder labels in part, comes out labelled whole and in each clip\'s colour, and apply-edl assembles the join', async () => {
  const dir = scratchDir('concat-colour');
  const out = join(dir, 'joined.mp4');
  await concatVideos([flatClip(dir, 'vp8'), flatClip(dir, 'untagged')], out, { fit: 'letterbox' });
  assert.deepEqual(probeStream(out, 'v:0', 'color_range,color_primaries,color_transfer,color_space'),
    { color_range: 'tv', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
  // 30 fps: frame 0 is the WebM's first, frame 45 the middle of the untagged clip.
  for (const frame of [0, 45]) {
    const shown = shownRgb(out, frame);
    assert.ok(shown.every((v, i) => Math.abs(v - FLAT_RGB[i]) < 4), `frame ${frame}: shown as ${shown.map((v) => v.toFixed(1))}, made as ${FLAT_RGB}`);
  }
  const edl = join(dir, 'edl.json');
  writeFileSync(edl, JSON.stringify({ sources: { a: out }, ranges: [{ source: 'a', start: 0, end: 1.5 }] }));
  const cut = join(dir, 'cut.mp4');
  const { result } = await captureConsoleAsync(() => applyEdl(['--edl', edl, '--out', cut]));
  assert.equal(result, 0);
  // The WebM's timestamps leave a slot of the join empty; the cut fills it, so it holds every frame of its 1.5 s.
  assert.equal(probeStream(cut, 'v:0', 'nb_frames').nb_frames, '45');
});

// Moved from the repository's cli-entry suite with the entry point itself: the argv seams
// stay strict through the CLI dispatch.
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function runCli(args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, 'concat-videos', ...args], { encoding: 'utf8' },
      (error, _out, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, err: stderr }));
  });
}

test('a stray flag is refused instead of being treated as a clip to join', async () => {
  const { code, err } = await runCli(['--canvas', '1080x1920', '--fast', 'o.mp4', 'a.mp4', 'b.mp4']);
  assert.equal(code, 1);
  assert.match(err, /Unknown option '--fast'/);
});

test('the real arguments still parse — a list of paths', async () => {
  const { code, err } = await runCli(['--canvas', '640x360', '/nope/o.mp4', '/nope/a.mp4', '/nope/b.mp4']);
  assert.equal(code, 1);
  assert.match(err, /clip not found/);
});

test('an unknown --fit mode is rejected by name, not silently', async () => {
  const { code, err } = await runCli(['--fit', 'cropp', 'o.mp4', 'a.mp4', 'b.mp4']);
  assert.equal(code, 1);
  assert.match(err, /--fit expects crop or letterbox, got "cropp"/);
});
