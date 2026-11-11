// Tests src/commands/apply-edl.ts. The graphs' shape is asserted on the filter strings; the arithmetic
// that matters — that the assembled picture and sound are the SAME length, and the right frames — is
// asserted on a real encode, because a model of the fades and the mix would pass whatever ffmpeg does.
//   Run:  node --import tsx tests/apply-edl.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdl, audioGraph, inputSeeks, levelGains, rangeGraph, removedOf, speechWindows } from '../src/commands/apply-edl.ts';
import { snapToFrames, type EdlRange, type SnappedRange } from '../src/edl.ts';
import { ASSUMED_COLOUR } from '../src/probe.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { CONVERTED, stampColour } from '../src/colour.ts';
import { FFMPEG } from '../src/config.ts';
import { SINE, TESTSRC, captureConsoleAsync, countFrames, probeStream, scratchDir, synthClip } from './helpers/synth.ts';

const canvas = { width: 1080, height: 1920 };
const grid = (ranges: EdlRange[], fps = 25): SnappedRange[] => ranges.map((r) => snapToFrames(r, fps));
/** The sound's graph for these ranges, every one heard. */
const graphOf = (ranges: EdlRange[], crossfade = 0.04) => {
  const snapped = grid(ranges);
  return { filter: audioGraph(snapped, inputSeeks(snapped), crossfade, snapped.map(() => true)) };
};
/** Each range's picture graph. */
const picturesOf = (ranges: EdlRange[]) => {
  const snapped = grid(ranges);
  const seeks = inputSeeks(snapped);
  return snapped.map((range, i) => rangeGraph(range, seeks[i], canvas, stampColour(CONVERTED, ASSUMED_COLOUR), '25/1'));
};

/** The atrim windows the graph asks for, in order. */
const atrims = (filter: string): { start: number; end: number }[] =>
  [...filter.matchAll(/atrim=start=([\d.]+):end=([\d.]+)/g)]
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));

await test('every range is its own input, seeked to the whole second at least one second before it', () => {
  const snapped = grid([{ source: '0', start: 0.5, end: 3 }, { source: '0', start: 5.2, end: 6 }, { source: '1', start: 12, end: 13 }]);
  assert.deepEqual(inputSeeks(snapped), [0, 4, 11]);
  const ranges = [{ source: '0', start: 0.5, end: 3 }, { source: '0', start: 5.2, end: 6 }];
  // Each picture is encoded from an input of its own; the sound's inputs follow the joined picture, input 0.
  for (const graph of picturesOf(ranges)) assert.match(graph, /^\[0:v\]trim=/);
  const { filter } = graphOf(ranges);
  assert.match(filter, /\[1:a\]atrim=/);
  assert.match(filter, /\[2:a\]atrim=/);
});

await test('trims are relative to the input\'s seek, and the video edges sit half a frame early', () => {
  const [picture] = picturesOf([{ source: '0', start: 5.2, end: 6 }]);
  // seeked to 4s: 5.2 -> 1.2, 6 -> 2; half a frame at 25fps is 0.02.
  assert.match(picture, /\]trim=start=1\.180000:end=1\.980000/);
  assert.deepEqual(atrims(graphOf([{ source: '0', start: 5.2, end: 6 }]).filter), [{ start: 1.2, end: 2 }]);
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
  const [picture] = picturesOf([{ source: '0', start: 0, end: 1 }]);
  assert.match(picture, /\]trim=start=0\.000000:end=0\.980000/);
});

await test('every clip is fitted to one canvas, cut to its shape first or padded when letterboxed, and stamped with the colour', () => {
  // The stamp joinColour gives a range: the label it ends on is the cut's colour, whatever that is.
  const colour = stampColour(CONVERTED, { primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc' });
  const snapped = grid([{ source: '0', start: 0, end: 1 }]);
  // A range of another shape arrives cut to the canvas's by reframe's filters, so covering it cuts only rounding.
  const shape = ['sendcmd=f=shape.cmd', 'crop@shape=w=606:h=1080:x=0:y=0'];
  const filter = rangeGraph(snapped[0], 0, canvas, colour, '25/1', { shape });
  assert.match(filter, /setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=5,sendcmd=f=shape\.cmd,crop@shape=w=606:h=1080:x=0:y=0,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,/);
  assert.doesNotMatch(filter, /,pad=\d/);
  const boxed = rangeGraph(snapped[0], 0, canvas, colour, '25/1', { fit: 'letterbox', grade: { tone: ['eq=contrast=0.8'], grain: ['noise=c0s=3:c0f=t'] } });
  // The bars are padded on after the grade and its grain, so they stay black.
  assert.match(boxed, /scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,eq=contrast=0\.8,fps=25\/1,noise=c0s=3:c0f=t,pad=1080:1920:/);
  // At its own speed too, a range is held to its rate's grid, so a frame its source skipped is filled.
  // On every range, so the ranges' streams carry the same tags into the join.
  assert.match(filter, /setsar=1,fps=25\/1,(?:colorspace=[^,]*,)?format=yuv420p,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv\[v\]$/);
  assert.match(boxed, /,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv\[v\]$/);
});

await test('the chains end on the labels the caller maps', () => {
  const ranges = [{ source: '0', start: 0, end: 2 }, { source: '1', start: 0, end: 2 }];
  for (const picture of picturesOf(ranges)) assert.ok(picture.endsWith('[v]'));
  assert.ok(graphOf(ranges).filter.endsWith('[aout]'));
});

await test('every segment is normalised to stereo 48k, so input order cannot decide the channel count', () => {
  const { filter } = graphOf([{ source: '0', start: 0, end: 2 }, { source: '1', start: 0, end: 2 }]);
  assert.equal([...filter.matchAll(/aformat=sample_rates=48000:channel_layouts=stereo/g)].length, 2);
});

await test('a source\'s gain levels its range before the stretch and the fades, and no gain adds no filter', () => {
  const snapped = grid([{ source: '0', start: 0, end: 2 }, { source: '1', start: 0, end: 2, speed: 2 }]);
  const filter = audioGraph(snapped, inputSeeks(snapped), 0.04, [true, true], [0, -5.5]);
  const [first, second] = filter.split(';');
  assert.doesNotMatch(first, /volume=/);
  assert.match(second, /channel_layouts=stereo,volume=-5\.50dB,atempo=/);
});

await test('speech is read on the words, in windows wholly inside the range, and levelled down to the quietest source', () => {
  // Windows end every 100 ms from the in-point and span 400 ms: the k-th is centred 0.1k - 0.1 s in.
  const momentary = Array.from({ length: 20 }, (_, k) => -20 - k);
  const windows = speechWindows({ start: 1, end: 3 }, momentary, [[0.5, 1.15], [1.25, 1.45], [2.45, 2.75], [9, 10]]);
  // Centred at 1.3 and 1.4 (k 4, 5) and 2.5 to 2.7 (k 16 to 18); the windows centred on the first word start before the range.
  assert.deepEqual(windows, [-24, -25, -36, -37, -38]);
  assert.deepEqual(speechWindows({ start: 1, end: 1.3 }, momentary, [[1, 1.3]]), []);
  const levels = levelGains(new Map([['loud', -14.9], ['quiet', -20.4], ['mid', -18]]));
  assert.equal(levels?.target, -20.4);
  assert.deepEqual([...levels!.gains].map(([id, db]) => [id, Number(db.toFixed(1))]), [['loud', -5.5], ['quiet', 0], ['mid', -2.4]]);
  assert.equal(levelGains(new Map([['only', -18]])), null);
});

await test('what was removed is each source\'s stretches no range keeps, overlapping and repeated ranges counted once', () => {
  const ranges = grid([{ source: 'a', start: 2, end: 3 }, { source: 'b', start: 0, end: 4 }, { source: 'a', start: 0.6, end: 2.4 }, { source: 'a', start: 1, end: 1.5 }]);
  const removed = removedOf(ranges, new Map([['a', 5], ['b', 4]]));
  assert.deepEqual([...removed.keys()], ['a', 'b']);
  assert.deepEqual(removed.get('a'), [{ start: 0, end: 0.6 }, { start: 3, end: 5 }]);
  assert.deepEqual(removed.get('b'), []);
});

// --- the command, against real clips -------------------------------------------

const dir = scratchDir('edl');
const clip = synthClip(dir, 'clip.mp4', { video: TESTSRC, audio: SINE, seconds: 3 });
const silent = synthClip(dir, 'silent.mp4', { video: TESTSRC, seconds: 1 });
const thirty = synthClip(dir, 'thirty.mp4', { video: 'testsrc=size=320x240:rate=30', audio: SINE, seconds: 1 });

let n = 0;
const run = async (edl: unknown, extra: string[] = []): Promise<{ out: string; log: string }> => {
  const path = join(dir, `edl-${n++}.json`);
  const out = join(dir, `out-${n}.mp4`);
  writeFileSync(path, JSON.stringify(edl));
  const { out: log } = await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out, ...extra]));
  return { out, log };
};

/** Mean level of the cut's sound between two instants, in dB; volumedetect reports -91 dB for digital silence. */
const levelOf = (file: string, from: number, to: number): number => {
  // volumedetect reports on stderr, which execFileSync only returns on a throw.
  const { stderr } = spawnSync(FFMPEG, [
    '-nostdin', '-hide_banner', '-i', file, '-vn', '-af', `atrim=${from}:${to},volumedetect`, '-f', 'null', '-',
  ], { encoding: 'utf8' });
  return Number(/mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr ?? '')?.[1].replace('-inf', '-Infinity'));
};

await test('three ranges cut off the frame grid, played out of order, assemble to picture and sound of the SAME length', async () => {
  // Each range is 0.887s asked for and 0.88s (22 frames at 25fps) once snapped; the raw figures would
  // have produced 66 frames of picture under 2.661s of sound, a drift of over a frame by the last join.
  const ranges = [[2.013, 2.9], [0.013, 0.9], [1.013, 1.9]].map(([start, end]) => ({ source: 'a', start, end }));
  const { out, log } = await run({ sources: { a: 'clip.mp4' }, ranges });
  assert.equal(countFrames(out), 66);
  const audio = Number(probeStream(out, 'a:0', 'duration').duration);
  const video = Number(probeStream(out, 'v:0', 'duration').duration);
  assert.ok(Math.abs(video - 2.64) < 0.005, `video ${video}s, expected 2.64`);
  assert.ok(Math.abs(audio - video) < 0.005, `audio ${audio}s vs video ${video}s`);
  assert.match(log, /2\.640s kept, 2 crossfaded join\(s\) of 40ms/);
  assert.match(log, /colour bt709\/bt709\/bt709 \(assumed/);
  // What was cut, on the snapped edges, in the source's own seconds and in source order.
  assert.match(log, /Removed from "a" \(clip\.mp4\): 0\.000-0\.040s \(0\.040s\), 0\.920-1\.040s \(0\.120s\), 1\.920-2\.040s \(0\.120s\), 2\.920-3\.000s \(0\.080s\); 0\.360s of its 3\.000s\./);
});

await test('a range may end past its audio, at its last frame or just past it, and the sound is padded to the picture', async () => {
  // A source whose sound stops 13ms before its picture, the way an AAC track ending on its own block
  // grid does. The last frame is kept and the sound padded to meet it.
  const tail = synthClip(dir, 'tail.mp4', { video: TESTSRC, audio: 'sine=frequency=440:sample_rate=48000:duration=2.987', seconds: 3 });
  assert.ok(Number(probeStream(tail, 'a:0', 'duration').duration) < 3, 'the fixture must end its audio before its picture');
  const { out } = await run({ sources: { t: 'tail.mp4' }, ranges: [{ source: 't', start: 1, end: 2.98 }] });
  assert.equal(countFrames(out), 50, 'frames 25..74: the last frame of the source is kept');
  const audio = Number(probeStream(out, 'a:0', 'duration').duration);
  assert.ok(Math.abs(audio - 2) < 0.005, `audio ${audio}s, expected 2.000 (padded)`);
  // Before another range too: its join fades over what sound is left.
  const joined = await run({ sources: { t: 'tail.mp4' }, ranges: [{ source: 't', start: 1, end: 2.98 }, { source: 't', start: 0, end: 1 }] });
  assert.equal(countFrames(joined.out), 75);
  assert.ok(Math.abs(Number(probeStream(joined.out, 'a:0', 'duration').duration) - 3) < 0.005);
  // An out-point within two frames past the picture's end is that end, the container's duration included.
  const past = await run({ sources: { t: 'tail.mp4' }, ranges: [{ source: 't', start: 1, end: 3.05 }] });
  assert.equal(countFrames(past.out), 50);
  assert.match(past.log, /Removed from "t" \(tail\.mp4\): 0\.000-1\.000s \(1\.000s\); 1\.000s of its 3\.000s\./);
  // Sound that ends well before the picture: the range plays silence where the recording has none.
  synthClip(dir, 'tail-far.mp4', { video: TESTSRC, audio: 'sine=frequency=440:sample_rate=48000:duration=2.9', seconds: 3 });
  const far = await run({ sources: { f: 'tail-far.mp4' }, ranges: [{ source: 'f', start: 1, end: 2.98 }] });
  assert.equal(countFrames(far.out), 50);
  assert.ok(levelOf(far.out, 1.93, 1.99) < -60, 'no sound past the recording\'s');
  assert.ok(levelOf(far.out, 1.2, 1.8) > -40, 'the recording\'s sound up to there');
});

await test('a range past the end of the PICTURE is refused: trim would just deliver fewer frames', async () => {
  const longAudio = synthClip(dir, 'long-audio.mp4', { video: 'testsrc=size=320x240:rate=25:duration=3', audio: SINE, seconds: 3.4 });
  assert.ok(Number(probeStream(longAudio, 'a:0', 'duration').duration) > 3.3, 'the fixture must have audio past its picture');
  await assert.rejects(run({ sources: { l: 'long-audio.mp4' }, ranges: [{ source: 'l', start: 0, end: 3.2 }, { source: 'l', start: 0, end: 1 }] }),
    /range 0 of "l" ends at 3\.200s but the source's picture is only 3\.000s long/);
});

await test('a range far past its picture is still refused, also on a source at another frame rate', async () => {
  await assert.rejects(run({ sources: { a: 'clip.mp4', t: 'thirty.mp4' }, ranges: [{ source: 'a', start: 0, end: 1 }, { source: 't', start: 0.5, end: 1.2 }] }),
    /range 1 of "t" ends at 1\.220s but the source's picture is only 1\.000s long/);
});

await test('a range no longer than the crossfade is refused by name', async () => {
  await assert.rejects(run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 0.03 }, { source: 'a', start: 0, end: 1 }] }),
    /no longer than the 40ms crossfade/);
});

await test('a source with no audio stream plays silent, its sound exactly as long as its picture', async () => {
  const { out, log } = await run({ sources: { s: 'silent.mp4', a: 'clip.mp4' }, ranges: [{ source: 's', start: 0, end: 1 }, { source: 'a', start: 0, end: 1 }] });
  assert.equal(countFrames(out), 50);
  assert.ok(Math.abs(Number(probeStream(out, 'a:0', 'duration').duration) - 2) < 0.005);
  assert.match(log, /source "s" has no sound: its ranges play silent/);
  assert.ok(levelOf(out, 0.1, 0.9) < -80, 'the silent source\'s range is silent');
  assert.ok(levelOf(out, 1.1, 1.9) > -40, 'the other range keeps its tone');
});

await test('each source\'s speech is levelled to the quietest source\'s, unless --keep-levels or it has no words there', async () => {
  // One tone 6 dB under the other, each spoken through by its transcript.
  synthClip(dir, 'loud.mp4', { video: TESTSRC, audio: SINE, seconds: 3 });
  synthClip(dir, 'quiet.mp4', { video: TESTSRC, audio: `${SINE},volume=-6dB`, seconds: 3 });
  const spoken = { text: 'a b', chunks: [{ text: 'a b', timestamp: [0.2, 2.8], words: [{ text: 'a', timestamp: [0.2, 1.4] }, { text: 'b', timestamp: [1.5, 2.8] }] }] };
  for (const name of ['loud', 'quiet']) writeFileSync(join(dir, `${name}.words.json`), JSON.stringify(spoken));
  const edl = {
    sources: { loud: 'loud.mp4', quiet: 'quiet.mp4' }, transcripts: { loud: 'loud.words.json', quiet: 'quiet.words.json' },
    ranges: [{ source: 'loud', start: 0, end: 2 }, { source: 'quiet', start: 0, end: 2 }],
  };
  // Away from the join, each range's own tone.
  const apart = (out: string) => levelOf(out, 0.3, 1.7) - levelOf(out, 2.3, 3.7);
  const levelled = await run(edl);
  assert.match(levelled.log, /Speech levelled to the quietest source's, -\d+\.\d LUFS: "loud" -[56]\.\d dB, "quiet" as recorded/);
  assert.ok(Math.abs(apart(levelled.out)) < 0.3, `levelled, the sources are ${apart(levelled.out)} dB apart`);
  const kept = await run(edl, ['--keep-levels']);
  assert.doesNotMatch(kept.log, /levelled/);
  assert.ok(Math.abs(apart(kept.out) - 6) < 0.3, `kept, the sources are ${apart(kept.out)} dB apart`);
  const unread = await run({ ...edl, transcripts: { loud: 'loud.words.json', quiet: 'none.json' } });
  assert.match(unread.log, /source "quiet" has no transcribed words where the cut plays its sound, so its level is as recorded/);
  assert.ok(Math.abs(apart(unread.out) - 6) < 0.3, `with one source measured, the sources are ${apart(unread.out)} dB apart`);
});

await test('a missing source file and an unknown source id are named', async () => {
  await assert.rejects(run({ sources: { a: 'nope.mp4' }, ranges: [{ source: 'a', start: 0, end: 1 }] }), /source "a" not found at/);
  await assert.rejects(run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'zz', start: 0, end: 1 }] }), /no entry for/);
});

await test('a crossfade of zero is refused, because ffmpeg reads acrossfade d=0 as UNSET', async () => {
  const one = { sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 2 }] };
  await assert.rejects(run(one, ['--crossfade', '0']), /at least 1 millisecond/);
  await assert.rejects(run(one, ['--crossfade', '0.5']), /at least 1 millisecond/);
  await assert.rejects(run(one, ['--crossfade', 'abc']), /at least 1 millisecond/);
  await assert.rejects(run(one, ['--crossfade=']), /at least 1 millisecond/);
});

await test('a crf outside the encoder\'s range is refused by name', async () => {
  const one = { sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 2 }] };
  await assert.rejects(run(one, ['--crf', '52']), /--crf wants 0-51/);
  // `--crf=-1`, not `--crf -1`: a bare -1 is parsed as a flag, which is the arg parser's business.
  await assert.rejects(run(one, ['--crf=-1']), /--crf wants 0-51/);
  await assert.rejects(run(one, ['--crf=']), /--crf wants 0-51/);
});

await test('an EDL with no ranges is refused before anything is decoded', async () => {
  await assert.rejects(run({ sources: {}, ranges: [] }), /no ranges/);
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

await test('the frames that come out are the frames the ranges named, seeks included', async () => {
  // A clip whose luma steps once a second: 16, then 128, then 235 to the end. Assembled as [2-3][0-1][1-2]
  // it must play bright, dark, mid — a dropped or misindexed -ss keeps every length and the log identical.
  // Four seconds long, so the first range's join has sound to borrow past its out-point.
  const stepped = synthClip(dir, 'stepped.mp4', {
    video: "nullsrc=size=320x240:rate=25,geq=lum='if(lt(T,1),16,if(lt(T,2),128,235))':cb=128:cr=128", audio: SINE, seconds: 4,
  });
  const { out } = await run({ sources: { s: 'stepped.mp4' }, ranges: [{ source: 's', start: 2, end: 3 }, { source: 's', start: 0, end: 1 }, { source: 's', start: 1, end: 2 }] });
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

await test('the join is a crossfade, not a gap and not a doubling', async () => {
  // Whole-second ranges of a 440Hz tone are phase-aligned at the join, so a correct fade keeps the
  // level flat across it: a gap reads tens of dB down, a missing fade about +6 dB up.
  const { out } = await run({ sources: { a: 'clip.mp4' }, ranges: [{ source: 'a', start: 0, end: 1 }, { source: 'a', start: 2, end: 3 }] });
  const body = levelOf(out, 0.2, 0.8);
  const join = levelOf(out, 0.98, 1.02);
  assert.ok(Number.isFinite(body) && Number.isFinite(join), `levels body=${body} join=${join}`);
  assert.ok(Math.abs(join - body) < 1, `the join sits at ${join} dB against a body of ${body} dB`);
});

await test('at 29.97 fps one whole second is 30 frames, and sound and picture still agree', async () => {
  const ntsc = synthClip(dir, 'ntsc.mp4', { video: 'testsrc=size=320x240:rate=30000/1001', audio: SINE, seconds: 3 });
  const { out } = await run({ sources: { n: 'ntsc.mp4' }, ranges: [{ source: 'n', start: 1, end: 2 }] });
  assert.equal(countFrames(out), 30);
  const audio = Number(probeStream(out, 'a:0', 'duration').duration);
  const video = Number(probeStream(out, 'v:0', 'duration').duration);
  assert.ok(Math.abs(audio - video) < 0.005, `audio ${audio}s vs video ${video}s`);
});

await test('a source at another frame rate is converted to the cut\'s, each of its ranges whole frames of the cut and on time', async () => {
  // 30 fps, dark until 0.5s and bright after: from 0.2s into a 25 fps cut, the step lands 0.3s into the range.
  synthClip(dir, 'step30.mp4', {
    video: "nullsrc=size=320x240:rate=30,geq=lum='if(lt(T,0.5),16,235)':cb=128:cr=128", audio: SINE, seconds: 1,
  });
  const { out, log } = await run({ sources: { a: 'clip.mp4', s: 'step30.mp4' }, ranges: [
    { source: 'a', start: 0, end: 1 }, { source: 's', start: 0.2, end: 0.8 }, { source: 's', start: 0.2, end: 0.8, speed: 2 },
  ] });
  // 25 + 15 + 8: 0.6s is 15 frames at 25 fps, and 7.5 played at double speed round to 8.
  assert.equal(countFrames(out), 48);
  assert.ok(Math.abs(Number(probeStream(out, 'a:0', 'duration').duration) - 48 / 25) < 0.005);
  assert.equal(probeStream(out, 'v:0', 'r_frame_rate').r_frame_rate, '25/1');
  assert.match(log, /source "s" runs at 30 fps: its ranges are converted to the cut's 25 fps\./);
  // Cut frame 25 + k shows the source at 0.2 + k/25 s, so the step falls between frames 32 and 33.
  assert.ok(lumaAt(out, 31) < 40, `frame 31 should be dark, luma ${lumaAt(out, 31)}`);
  assert.ok(lumaAt(out, 34) > 200, `frame 34 should be bright, luma ${lumaAt(out, 34)}`);
  // The other way round, the cut runs at the first range's source's 30 fps.
  const back = await run({ sources: { a: 'clip.mp4', s: 'step30.mp4' }, ranges: [{ source: 's', start: 0, end: 0.5 }, { source: 'a', start: 0, end: 1 }] });
  assert.equal(countFrames(back.out), 45);
  assert.match(back.log, /source "a" runs at 25 fps: its ranges are converted to the cut's 30 fps\./);
});
