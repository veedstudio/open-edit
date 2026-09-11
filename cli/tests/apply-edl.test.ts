// Tests src/commands/apply-edl.ts. The graph's shape is asserted on the filter string; the arithmetic
// that matters — that the assembled picture and sound are the SAME length, and the right frames — is
// asserted on a real encode, because a model of the fades and the mix would pass whatever ffmpeg does.
//   Run:  node --import tsx tests/apply-edl.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdl, buildGraph, inputSeeks } from '../src/commands/apply-edl.ts';
import { snapToFrames, type EdlRange, type SnappedRange } from '../src/edl.ts';
import { ASSUMED_COLOUR } from '../src/probe.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { FFMPEG } from '../src/config.ts';
import { SINE, TESTSRC, captureConsole, countFrames, probeStream, scratchDir, synthClip } from './helpers/synth.ts';

const canvas = { width: 1080, height: 1920 };
const grid = (ranges: EdlRange[], fps = 25): SnappedRange[] => ranges.map((r) => snapToFrames(r, fps));
const graphOf = (ranges: EdlRange[], crossfade = 0.04) => {
  const snapped = grid(ranges);
  return buildGraph(snapped, inputSeeks(snapped), canvas, ASSUMED_COLOUR, crossfade);
};

/** The atrim windows the graph asks for, in order. */
const atrims = (filter: string): { start: number; end: number }[] =>
  [...filter.matchAll(/atrim=start=([\d.]+):end=([\d.]+)/g)]
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));

await test('every range is its own input, seeked to the whole second at least one second before it', () => {
  const snapped = grid([{ source: '0', start: 0.5, end: 3 }, { source: '0', start: 5.2, end: 6 }, { source: '1', start: 12, end: 13 }]);
  assert.deepEqual(inputSeeks(snapped), [0, 4, 11]);
  const { filter } = graphOf([{ source: '0', start: 0.5, end: 3 }, { source: '0', start: 5.2, end: 6 }]);
  assert.match(filter, /\[0:v\]trim=/);
  assert.match(filter, /\[1:v\]trim=/);
  assert.match(filter, /\[1:a\]atrim=/);
});

await test('trims are relative to the input\'s seek, and the video edges sit half a frame early', () => {
  const { filter } = graphOf([{ source: '0', start: 5.2, end: 6 }]);
  // seeked to 4s: 5.2 -> 1.2, 6 -> 2; half a frame at 25fps is 0.02.
  assert.match(filter, /\]trim=start=1\.180000:end=1\.980000/);
  assert.deepEqual(atrims(filter), [{ start: 1.2, end: 2 }]);
});

await test('a single range needs no fades, no delay and no mix, only the pad to its own length', () => {
  const { filter } = graphOf([{ source: '0', start: 1, end: 3 }]);
  assert.deepEqual(atrims(filter), [{ start: 1, end: 3 }]);
  assert.doesNotMatch(filter, /afade|adelay|amix/);
  assert.match(filter, /apad=whole_len=96000/);
  assert.match(filter, /\[a0\]anull\[aout\]/);
});

await test('every segment but the last takes the crossfade as EXTRA audio, fades over it, and is delayed to its place', () => {
  const { filter } = graphOf([
    { source: '0', start: 1, end: 3 },
    { source: '1', start: 5, end: 6 },
    { source: '2', start: 0, end: 2 },
  ]);
  // inputs seeked to 0, 4, 0
  assert.deepEqual(atrims(filter), [{ start: 1, end: 3.04 }, { start: 1, end: 2.04 }, { start: 0, end: 2 }]);
  const chains = filter.split(';').filter((p) => p.includes('atrim'));
  assert.match(chains[0], /afade=t=out:st=2\.000000:d=0\.040000/);
  assert.doesNotMatch(chains[0], /afade=t=in|adelay/);
  assert.match(chains[1], /afade=t=in:st=0:d=0\.040000,afade=t=out:st=1\.000000:d=0\.040000,adelay=96000S:all=1/);
  assert.match(chains[2], /afade=t=in:st=0:d=0\.040000,apad=whole_len=96000,adelay=144000S:all=1/);
  assert.doesNotMatch(chains[2], /afade=t=out/);
  assert.match(filter, /\[a0\]\[a1\]\[a2\]amix=inputs=3:normalize=0:dropout_transition=0\[aout\]/);
});

await test('a range starting at zero does not ask ffmpeg for a negative trim start', () => {
  const { filter } = graphOf([{ source: '0', start: 0, end: 1 }]);
  assert.match(filter, /\]trim=start=0\.000000:end=0\.980000/);
});

await test('every clip is fitted to one canvas, padded rather than cropped, and stamped with the colour', () => {
  const colour = { primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc' };
  const snapped = grid([{ source: '0', start: 0, end: 1 }]);
  const { filter } = buildGraph(snapped, inputSeeks(snapped), canvas, colour, 0.04);
  assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=decrease/);
  assert.match(filter, /pad=1080:1920/);
  assert.match(filter, /setsar=1/);
  assert.match(filter, /setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc\[vout\]/);
});

await test('the chain ends on the labels the caller maps', () => {
  const { filter, videoLabel, audioLabel } = graphOf([{ source: '0', start: 0, end: 2 }, { source: '1', start: 0, end: 2 }]);
  assert.equal(videoLabel, '[vout]');
  assert.equal(audioLabel, '[aout]');
  assert.ok(filter.includes(videoLabel));
  assert.ok(filter.trimEnd().endsWith(audioLabel));
});

await test('every segment is normalised to stereo 48k, so input order cannot decide the channel count', () => {
  const { filter } = graphOf([{ source: '0', start: 0, end: 2 }, { source: '1', start: 0, end: 2 }]);
  assert.equal([...filter.matchAll(/aformat=sample_rates=48000:channel_layouts=stereo/g)].length, 2);
});

// --- the command, against real clips -------------------------------------------

const dir = scratchDir('edl');
const clip = synthClip(dir, 'clip.mp4', { video: TESTSRC, audio: SINE, seconds: 3 });
const silent = synthClip(dir, 'silent.mp4', { video: TESTSRC, seconds: 1 });
const thirty = synthClip(dir, 'thirty.mp4', { video: 'testsrc=size=320x240:rate=30', audio: SINE, seconds: 1 });

let n = 0;
const run = (edl: unknown, extra: string[] = []): { out: string; log: string } => {
  const path = join(dir, `edl-${n++}.json`);
  const out = join(dir, `out-${n}.mp4`);
  writeFileSync(path, JSON.stringify(edl));
  const { out: log } = captureConsole(() => applyEdl(['--edl', path, '--out', out, ...extra]));
  return { out, log };
};

await test('three ranges cut off the frame grid, played out of order, assemble to picture and sound of the SAME length', () => {
  // Each range is 0.887s asked for and 0.88s (22 frames at 25fps) once snapped; the raw figures would
  // have produced 66 frames of picture under 2.661s of sound, a drift of over a frame by the last join.
  const ranges = [[2.013, 2.9], [0.013, 0.9], [1.013, 1.9]].map(([start, end]) => ({ source: 'a', start, end }));
  const { out, log } = run({ sources: { a: 'clip.mp4' }, ranges });
  assert.equal(countFrames(out), 66);
  const audio = Number(probeStream(out, 'a:0', 'duration').duration);
  const video = Number(probeStream(out, 'v:0', 'duration').duration);
  assert.ok(Math.abs(video - 2.64) < 0.005, `video ${video}s, expected 2.64`);
  assert.ok(Math.abs(audio - video) < 0.005, `audio ${audio}s vs video ${video}s`);
  assert.match(log, /2\.640s kept, 2 crossfaded join\(s\) of 40ms/);
  assert.match(log, /colour bt709\/bt709\/bt709 \(assumed/);
});

await test('the LAST range may end a little past its audio, and the tail is padded to the picture', () => {
  // A source whose sound stops 13ms before its picture, the way an AAC track ending on its own block
  // grid does. The last frame is kept and the sound padded to meet it.
  const tail = synthClip(dir, 'tail.mp4', { video: TESTSRC, audio: 'sine=frequency=440:sample_rate=48000:duration=2.987', seconds: 3 });
  assert.ok(Number(probeStream(tail, 'a:0', 'duration').duration) < 3, 'the fixture must end its audio before its picture');
  const { out } = run({ sources: { t: 'tail.mp4' }, ranges: [{ source: 't', start: 1, end: 2.98 }] });
  assert.equal(countFrames(out), 50, 'frames 25..74: the last frame of the source is kept');
  const audio = Number(probeStream(out, 'a:0', 'duration').duration);
  assert.ok(Math.abs(audio - 2) < 0.005, `audio ${audio}s, expected 2.000 (padded)`);
  // A non-last range gets no such tolerance: its join genuinely needs the sound.
  assert.throws(() => run({ sources: { t: 'tail.mp4' }, ranges: [{ source: 't', start: 1, end: 2.98 }, { source: 't', start: 0, end: 1 }] }),
    /range 0 of "t" ends at 3\.000s and its join needs 40ms more audio/);
  // Past the picture it is the picture guard that refuses.
  assert.throws(() => run({ sources: { t: 'tail.mp4' }, ranges: [{ source: 't', start: 1, end: 3.05 }] }), /the source's picture is only 3\.000s/);
  // Sound that ends well before the picture is refused even at the end, naming the audio.
  const far = synthClip(dir, 'tail-far.mp4', { video: TESTSRC, audio: 'sine=frequency=440:sample_rate=48000:duration=2.9', seconds: 3 });
  void far;
  assert.throws(() => run({ sources: { f: 'tail-far.mp4' }, ranges: [{ source: 'f', start: 1, end: 2.98 }] }), /range 0 of "f" ends at 3\.000s but the source's audio is only 2\.9\d\ds long/);
});

await test('a range past the end of the PICTURE is refused: trim would just deliver fewer frames', () => {
  const longAudio = synthClip(dir, 'long-audio.mp4', { video: 'testsrc=size=320x240:rate=25:duration=3', audio: SINE, seconds: 3.4 });
  assert.ok(Number(probeStream(longAudio, 'a:0', 'duration').duration) > 3.3, 'the fixture must have audio past its picture');
  assert.throws(() => run({ sources: { l: 'long-audio.mp4' }, ranges: [{ source: 'l', start: 0, end: 3.2 }, { source: 'l', start: 0, end: 1 }] }),
    /range 0 of "l" ends at 3\.200s but the source's picture is only 3\.000s long/);
});

await test('a range whose join would run past the end of its audio is refused before encoding', () => {
  assert.throws(() => run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 2.99 }, { source: 'a', start: 0, end: 1 }] }),
    /range 0 of "a" ends at 3\.000s and its join needs 40ms more audio/);
});

await test('a range no longer than the crossfade is refused by name', () => {
  assert.throws(() => run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 0.03 }, { source: 'a', start: 0, end: 1 }] }),
    /no longer than the 40ms crossfade/);
});

await test('a source with no audio stream is refused, since every join borrows sound from beyond its out-point', () => {
  assert.throws(() => run({ sources: { s: 'silent.mp4' }, ranges: [{ source: 's', start: 0, end: 1 }] }), /source "s": .*has no audio stream/);
});

await test('sources at different frame rates are refused, since the output is encoded at one', () => {
  assert.throws(() => run({ sources: { a: 'clip.mp4', t: 'thirty.mp4' }, ranges: [{ source: 'a', start: 0, end: 1 }, { source: 't', start: 0, end: 0.5 }] }),
    /"a" runs at 25\/1 fps and "t" at 30\/1/);
});

await test('a missing source file and an unknown source id are named', () => {
  assert.throws(() => run({ sources: { a: 'nope.mp4' }, ranges: [{ source: 'a', start: 0, end: 1 }] }), /source "a" not found at/);
  assert.throws(() => run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'zz', start: 0, end: 1 }] }), /no entry for/);
});

await test('a crossfade of zero is refused, because ffmpeg reads acrossfade d=0 as UNSET', () => {
  const one = { sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 2 }] };
  assert.throws(() => run(one, ['--crossfade', '0']), /at least 1 millisecond/);
  assert.throws(() => run(one, ['--crossfade', '0.5']), /at least 1 millisecond/);
  assert.throws(() => run(one, ['--crossfade', 'abc']), /at least 1 millisecond/);
  assert.throws(() => run(one, ['--crossfade=']), /at least 1 millisecond/);
});

await test('a crf outside the encoder\'s range is refused by name', () => {
  const one = { sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 2 }] };
  assert.throws(() => run(one, ['--crf', '52']), /--crf wants 0-51/);
  // `--crf=-1`, not `--crf -1`: a bare -1 is parsed as a flag, which is the arg parser's business.
  assert.throws(() => run(one, ['--crf=-1']), /--crf wants 0-51/);
  assert.throws(() => run(one, ['--crf=']), /--crf wants 0-51/);
});

await test('an EDL with no ranges is refused before anything is decoded', () => {
  assert.throws(() => run({ sources: {}, ranges: [] }), /no ranges/);
});

// --- what the output CONTAINS, not just how long it is ---------------------------

/** Mean luma of one output frame: the frame itself as 8-bit gray on stdout, so no path enters a filter string. */
const lumaAt = (file: string, frameIndex: number): number => {
  const pixels = execFileSync(FFMPEG, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `select=eq(n\\,${frameIndex})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: 1 << 24 });
  assert.ok(pixels.length > 0, `no frame ${frameIndex} in ${file}`);
  let sum = 0;
  for (const p of pixels) sum += p;
  return sum / pixels.length;
};

await test('the frames that come out are the frames the ranges named, seeks included', () => {
  // A clip whose luma steps once a second: 16, then 128, then 235 to the end. Assembled as [2-3][0-1][1-2]
  // it must play bright, dark, mid — a dropped or misindexed -ss keeps every length and the log identical.
  // Four seconds long, so the first range's join has sound to borrow past its out-point.
  const stepped = synthClip(dir, 'stepped.mp4', {
    video: "nullsrc=size=320x240:rate=25,geq=lum='if(lt(T,1),16,if(lt(T,2),128,235))':cb=128:cr=128", audio: SINE, seconds: 4,
  });
  const { out } = run({ sources: { s: 'stepped.mp4' }, ranges: [{ source: 's', start: 2, end: 3 }, { source: 's', start: 0, end: 1 }, { source: 's', start: 1, end: 2 }] });
  assert.equal(countFrames(out), 75);
  // Read as 8-bit gray the levels are range-scaled (16 -> 0, 235 -> 255), so bands are asserted, not values.
  const bright = (frame: number) => assert.ok(lumaAt(out, frame) > 200, `frame ${frame} should be bright, luma ${lumaAt(out, frame)}`);
  const dark = (frame: number) => assert.ok(lumaAt(out, frame) < 40, `frame ${frame} should be dark, luma ${lumaAt(out, frame)}`);
  const mid = (frame: number) => {
    const l = lumaAt(out, frame);
    assert.ok(l > 100 && l < 160, `frame ${frame} should be mid-grey, luma ${l}`);
  };
  bright(5);
  bright(24);
  dark(30);
  mid(55);
});

await test('the join is a crossfade, not a gap and not a doubling', () => {
  // Whole-second ranges of a 440Hz tone are phase-aligned at the join, so a correct fade keeps the
  // level flat across it: a gap reads tens of dB down, a missing fade about +6 dB up.
  const { out } = run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 1 }, { source: 'a', start: 2, end: 3 }] });
  const level = (from: number, to: number): number => {
    // volumedetect reports on stderr, which execFileSync only returns on a throw.
    const { stderr } = spawnSync(FFMPEG, [
      '-nostdin', '-hide_banner', '-i', out, '-vn', '-af', `atrim=${from}:${to},volumedetect`, '-f', 'null', '-',
    ], { encoding: 'utf8' });
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr ?? '')?.[1]);
  };
  const body = level(0.2, 0.8);
  const join = level(0.98, 1.02);
  assert.ok(Number.isFinite(body) && Number.isFinite(join), `levels body=${body} join=${join}`);
  assert.ok(Math.abs(join - body) < 1, `the join sits at ${join} dB against a body of ${body} dB`);
});

await test('at 29.97 fps one whole second is 30 frames, and sound and picture still agree', () => {
  const ntsc = synthClip(dir, 'ntsc.mp4', { video: 'testsrc=size=320x240:rate=30000/1001', audio: SINE, seconds: 3 });
  const { out } = run({ sources: { n: 'ntsc.mp4' }, ranges: [{ source: 'n', start: 1, end: 2 }] });
  assert.equal(countFrames(out), 30);
  const audio = Number(probeStream(out, 'a:0', 'duration').duration);
  const video = Number(probeStream(out, 'v:0', 'duration').duration);
  assert.ok(Math.abs(audio - video) < 0.005, `audio ${audio}s vs video ${video}s`);
});
