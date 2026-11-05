// Tests a range's speed, sound and grade in apply-edl, and the per-range cache, on real encodes: frame counts,
// which source frame each output frame shows, where a flash and a beep land, and pixel statistics.
//   Run:  node --import tsx --test cli/tests/apply-edl-speed-grade.test.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { FFMPEG } from '../src/config.ts';
import { parseEdl } from '../src/edl.ts';
import { captureConsoleAsync, countFrames, probeStream, scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('edl-speed');

// Flat frames whose brightness counts the frame: 16 + 8 * (n mod 25), so frame k of a second reads back as k.
const counted = synthClip(dir, 'counted.mp4', {
  video: "color=black:size=64x48:rate=25,geq=lum='16+8*mod(N,25)':cb=128:cr=128", audio: 'sine=frequency=440:sample_rate=48000', seconds: 4,
});
// Dark but for a white flash on frames 50 and 51 (2.00-2.08 s), with silence but for a 1 kHz beep at 2.00-2.04 s.
synthClip(dir, 'sync.mp4', {
  video: "color=black:size=64x48:rate=25,geq=lum='if(between(N,50,51),235,16)':cb=128:cr=128",
  audio: "aevalsrc='if(between(t,2,2.04),0.8*sin(2*PI*1000*t),0)':s=48000", seconds: 4,
});
synthClip(dir, 'bars.mp4', { video: 'testsrc=size=160x120:rate=25', audio: 'sine=frequency=440:sample_rate=48000', seconds: 2 });
synthClip(dir, 'grey.mp4', { video: 'color=gray:size=160x120:rate=25', audio: 'sine=frequency=440:sample_rate=48000', seconds: 2 });

let n = 0;
const run = async (edl: unknown, out = join(dir, `out-${n}.mp4`)): Promise<{ out: string; log: string }> => {
  const path = join(dir, `edl-${n++}.json`);
  writeFileSync(path, JSON.stringify(edl));
  const { out: log } = await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out]));
  return { out, log };
};

/** Each frame's planes as raw bytes at the clip's size: Y, then U, then V. */
function frames(file: string, width: number, height: number): Buffer[] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 28 });
  const size = (width * height * 3) / 2;
  return Array.from({ length: raw.length / size }, (_, i) => raw.subarray(i * size, (i + 1) * size));
}
const mean = (b: Uint8Array) => b.reduce((s, x) => s + x, 0) / b.length;
const lumas = (file: string) => frames(file, 64, 48).map((f) => mean(f.subarray(0, 64 * 48)));
/** Which frame of its second each output frame shows, read back from its brightness. */
const indices = (file: string) => lumas(file).map((y) => Math.round((y - 16) / 8));

/** The first instant the sound passes `threshold`, in seconds. */
function onset(file: string, threshold = 0.2): number {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const i = samples.findIndex((s) => Math.abs(s) > threshold);
  return i < 0 ? Infinity : i / 48000;
}

/** Mean level between two instants, in dB; digital silence reads as -Infinity or volumedetect's -91 floor. */
function level(file: string, from: number, to: number): number {
  const { stderr } = spawnSync(FFMPEG, ['-nostdin', '-hide_banner', '-i', file, '-vn', '-af', `atrim=${from}:${to},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (\S+) dB/.exec(stderr ?? '')?.[1];
  return m === '-inf' ? -Infinity : Number(m);
}

const length = (file: string, stream: 'v:0' | 'a:0') => Number(probeStream(file, stream, 'duration').duration);

await test('a range at half speed plays every frame twice, and at double speed every other frame, for exactly the frames it promises', async () => {
  const { out, log } = await run({
    sources: { c: 'counted.mp4' },
    ranges: [{ source: 'c', start: 1, end: 2, speed: 0.5 }, { source: 'c', start: 2, end: 3, speed: 2 }, { source: 'c', start: 3, end: 3.4 }],
  });
  // 25 frames at half speed are 50, 25 at double speed 13 (12.5 rounded), and 10 at their own speed.
  assert.equal(countFrames(out), 73);
  const shown = indices(out);
  assert.deepEqual(shown.slice(0, 50), Array.from({ length: 50 }, (_, j) => Math.floor(j / 2)));
  assert.deepEqual(shown.slice(50, 63), Array.from({ length: 13 }, (_, j) => Math.min(24, 2 * j)));
  assert.deepEqual(shown.slice(63), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // The sound is exactly as long as the picture, so nothing after a slowed range drifts.
  assert.ok(Math.abs(length(out, 'v:0') - 2.92) < 0.001, `picture ${length(out, 'v:0')}s`);
  assert.ok(Math.abs(length(out, 'a:0') - 2.92) < 0.005, `sound ${length(out, 'a:0')}s`);
  assert.match(log, /2\.400s kept, 2 crossfaded join\(s\) of 40ms/);
  assert.match(log, /At each range's speed the cut runs 2\.920s:/);
  assert.match(log, /range 0: "c" 1\.000-2\.000s at 0\.5x -> 0\.000-2\.000s of the cut, sound stretched/);
  assert.match(log, /range 1: "c" 2\.000-3\.000s at 2x -> 2\.000-2\.520s of the cut, sound stretched/);
  assert.match(log, /range 2: "c" 3\.000-3\.400s at 1x -> 2\.520-2\.920s of the cut, sound kept/);
});

await test('a stretched range keeps its sound on its picture: the beep lands on the flash at half and at double speed', async () => {
  for (const [speed, flash] of [[0.5, 1 + 2 * 1], [2, 1 + 1 / 2]] as const) {
    // A second at its own speed first, so the slowed range sits after a crossfaded join.
    const { out } = await run({ sources: { s: 'sync.mp4' }, ranges: [{ source: 's', start: 0, end: 1 }, { source: 's', start: 1, end: 3, speed }] });
    const bright = lumas(out).findIndex((y) => y > 128);
    assert.ok(Math.abs(bright / 25 - flash) <= 0.04 + 1e-9, `${speed}x: the flash shows at ${bright / 25}s, expected ${flash}s`);
    const beep = onset(out);
    assert.ok(Math.abs(beep - flash) < 0.04, `${speed}x: the beep starts at ${beep.toFixed(3)}s, the flash at ${flash}s`);
  }
});

await test('a range slower than half speed, or muted, plays silent for its whole length, and the printout says so', async () => {
  const { out, log } = await run({
    sources: { b: 'bars.mp4' },
    ranges: [{ source: 'b', start: 0, end: 0.4, speed: 0.4 }, { source: 'b', start: 0.4, end: 0.8 }, { source: 'b', start: 0.8, end: 1.2, mute: true }, { source: 'b', start: 1.2, end: 1.6 }],
  });
  // 10 frames at 0.4x are 25: one second of silence, then a tone, then 0.4 s muted, then a tone.
  assert.equal(countFrames(out), 25 + 10 + 10 + 10);
  assert.ok(level(out, 0.05, 0.95) < -80, `the slowed range reads ${level(out, 0.05, 0.95)} dB`);
  assert.ok(level(out, 1.05, 1.35) > -40, 'the range at its own speed keeps its tone');
  assert.ok(level(out, 1.45, 1.75) < -80, `the muted range reads ${level(out, 1.45, 1.75)} dB`);
  assert.ok(level(out, 1.85, 2.15) > -40);
  assert.ok(Math.abs(length(out, 'a:0') - 2.2) < 0.005);
  assert.match(log, /range 0: "b" 0\.000-0\.400s at 0\.4x -> 0\.000-1\.000s of the cut, silent/);
  assert.match(log, /range 2: "b" 0\.800-1\.200s at 1x -> 1\.400-1\.800s of the cut, silent/);
});

await test('interpolated slow motion draws new frames between the source\'s, where plain slow motion repeats them', async () => {
  const ranges = (interpolate: boolean) => [{ source: 'c', start: 0, end: 0.8, speed: 0.5, ...(interpolate ? { interpolate } : {}) }];
  const plain = (await run({ sources: { c: 'counted.mp4' }, ranges: ranges(false) })).out;
  const drawn = (await run({ sources: { c: 'counted.mp4' }, ranges: ranges(true) })).out;
  assert.equal(countFrames(plain), 40);
  assert.equal(countFrames(drawn), 40);
  const repeats = (ys: number[]) => ys.slice(1).filter((y, j) => Math.abs(y - ys[j]) < 0.5).length;
  const between = (ys: number[]) => ys.filter((y) => Math.abs((y - 16) / 8 - Math.round((y - 16) / 8)) > 0.25).length;
  // Plain: frames 0,0,1,1,... — every other frame repeats the one before, and none lies between two source frames.
  assert.ok(repeats(lumas(plain)) >= 19, `plain repeats ${repeats(lumas(plain))} frames`);
  assert.equal(between(lumas(plain)), 0);
  // Drawn: the frames between are blends, half-way in brightness.
  assert.ok(between(lumas(drawn)) >= 15, `only ${between(lumas(drawn))} drawn frames lie between two source frames`);
  assert.ok(repeats(lumas(drawn)) <= 3, `drawn repeats ${repeats(lumas(drawn))} frames`);
});

await test('each grade moves the picture the way it says, and a range\'s own grade overrides the cut\'s key by key', async () => {
  // A LUT that inverts every channel: 2x2x2 points, red fastest.
  const invert = ['LUT_3D_SIZE 2', ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)))].join('\n');
  writeFileSync(join(dir, 'invert.cube'), `${invert}\n`);
  const kinds = [{}, { exposure: 1 }, { contrast: 1.5 }, { saturation: 0 }, { temperature: 3000 }, { lut: 'invert.cube' }];
  const { out, log } = await run({ sources: { b: 'bars.mp4' }, ranges: kinds.map((grade) => ({ source: 'b', start: 0, end: 0.4, grade })) });
  const all = frames(out, 160, 120);
  // Frame 5 of each range, all the same moment of the source.
  const [plain, exposed, contrasted, grey, warm, inverted] = kinds.map((_, i) => all[i * 10 + 5]);
  const Y = (f: Buffer) => f.subarray(0, 160 * 120);
  const chroma = (f: Buffer) => f.subarray(160 * 120);
  const spread = (b: Uint8Array) => {
    const m = mean(b);
    return Math.sqrt(b.reduce((s, x) => s + (x - m) ** 2, 0) / b.length);
  };
  assert.ok(mean(Y(exposed)) > mean(Y(plain)) + 15, `exposure +1: ${mean(Y(exposed))} against ${mean(Y(plain))}`);
  assert.ok(spread(Y(contrasted)) > spread(Y(plain)) * 1.2, 'contrast 1.5 spreads the brightness');
  assert.ok(spread(chroma(grey)) < 2 && spread(chroma(plain)) > 20, `saturation 0 leaves no colour (${spread(chroma(grey))})`);
  const V = (f: Buffer) => mean(f.subarray(160 * 120 + 80 * 60));
  const U = (f: Buffer) => mean(f.subarray(160 * 120, 160 * 120 + 80 * 60));
  // Warmer is more red (V up) and less blue (U down).
  assert.ok(V(warm) - U(warm) > V(plain) - U(plain) + 10, `3000K: V-U ${V(warm) - U(warm)} against ${V(plain) - U(plain)}`);
  assert.ok(Math.abs(mean(Y(inverted)) - (16 + 235 - mean(Y(plain)))) < 8, `the inverting LUT: ${mean(Y(inverted))} against ${mean(Y(plain))}`);
  assert.match(log, /Graded exposure \+1: range\(s\) 1\./);
  assert.match(log, /Graded LUT invert\.cube: range\(s\) 5\./);

  const cut = await run({
    sources: { b: 'bars.mp4' }, grade: { saturation: 0 },
    ranges: [{ source: 'b', start: 0, end: 0.4 }, { source: 'b', start: 0, end: 0.4, grade: { saturation: null } }, { source: 'b', start: 0, end: 0.4, grade: { exposure: 1 } }],
  });
  const cutFrames = frames(cut.out, 160, 120);
  const [a, b, c] = [5, 15, 25].map((i) => cutFrames[i]);
  assert.ok(spread(chroma(a)) < 2, 'the cut\'s grade reaches a range with none of its own');
  assert.ok(spread(chroma(b)) > 20, 'null drops the cut\'s saturation for that range');
  assert.ok(spread(chroma(c)) < 2 && mean(Y(c)) > mean(Y(a)) + 15, 'a range\'s own key is added to the cut\'s');
});

await test('a letterboxed range is graded inside its picture: the bars stay black under a grade that lifts black', async () => {
  synthClip(dir, 'tall.mp4', { video: 'color=black:size=60x120:rate=25', audio: 'sine=frequency=440:sample_rate=48000', seconds: 1 });
  const path = join(dir, `edl-${n++}.json`);
  const out = join(dir, 'boxed.mp4');
  writeFileSync(path, JSON.stringify({ sources: { b: 'bars.mp4', t: 'tall.mp4' }, ranges: [
    { source: 'b', start: 0, end: 0.4 }, { source: 't', start: 0, end: 0.4, grade: { contrast: 0.5, grain: 10 } },
  ] }));
  await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out, '--fit', 'letterbox']));
  // The tall clip sits 60 wide in the middle of the 160x120 canvas; a column 20 in from the left is bar.
  const Y = frames(out, 160, 120)[15].subarray(0, 160 * 120);
  const column = (x: number) => Array.from({ length: 120 }, (_, y) => Y[y * 160 + x]);
  assert.ok(Math.max(...column(20)) <= 17, `the bar reads up to ${Math.max(...column(20))}`);
  assert.ok(mean(Uint8Array.from(column(80))) > 60, 'contrast 0.5 lifts the black picture inside the bars');
});

await test('grain gives a still picture a different texture on every frame, even where slow motion repeats a frame', async () => {
  const { out } = await run({ sources: { g: 'grey.mp4' }, ranges: [{ source: 'g', start: 0, end: 0.4 }, { source: 'g', start: 0, end: 0.4, speed: 0.5, grade: { grain: 20 } }] });
  const all = frames(out, 160, 120).map((f) => f.subarray(0, 160 * 120));
  const change = (a: Uint8Array, b: Uint8Array) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;
  assert.ok(change(all[3], all[4]) < 1, 'the plain grey range is still');
  // Frames 10 and 11 show the same source frame at half speed; their grain still differs.
  assert.ok(change(all[10], all[11]) > 3, `grain moved ${change(all[10], all[11])} levels between repeated frames`);
});

await test('a second run that changes one range encodes only that range, and the cache follows the source\'s content, not its path', async () => {
  const out = join(dir, 'cached.mp4');
  const cache = `${out}.ranges`;
  const edl = (speed: number, source = 'counted.mp4', exposure = 0.5) => ({
    sources: { c: source },
    ranges: [{ source: 'c', start: 0, end: 0.8 }, { source: 'c', start: 1, end: 1.8, speed }, { source: 'c', start: 2, end: 2.8, grade: { exposure } }],
  });
  // The range files alone: each keeps its picture's changes in a .changes.json beside it.
  const stamp = () => new Map(readdirSync(cache).filter((f) => f.endsWith('.mp4')).map((f) => [f, statSync(join(cache, f)).mtimeMs]));

  const first = await run(edl(1), out);
  assert.match(first.log, /3 range\(s\) encoded, 0 reused/);
  const before = stamp();
  assert.equal(before.size, 3);

  const second = await run(edl(0.5), out);
  assert.match(second.log, /1 range\(s\) encoded, 2 reused/);
  const after = stamp();
  assert.equal(after.size, 4, 'one new range beside the three kept');
  const untouched = [...before].filter(([f, t]) => after.get(f) === t).length;
  assert.equal(untouched, 3, 'no kept range was rewritten');
  assert.equal(countFrames(out), 20 + 40 + 20, 'the join holds the new range between the reused ones');
  assert.deepEqual(indices(out).slice(20, 24), [0, 0, 1, 1]);
  assert.match(second.log, /2\.400s kept/);
  assert.match(second.log, /At each range's speed the cut runs 3\.200s/);

  assert.match((await run(edl(0.5), out)).log, /0 range\(s\) encoded, 3 reused/);
  // A grade is part of what a range is made of.
  assert.match((await run(edl(0.5, 'counted.mp4', 1), out)).log, /1 range\(s\) encoded, 2 reused/);
  // The same bytes at another path are the same ranges.
  copyFileSync(counted, join(dir, 'counted-copy.mp4'));
  assert.match((await run(edl(0.5, 'counted-copy.mp4'), out)).log, /0 range\(s\) encoded, 3 reused/);
  // Other bytes at the same path are not: the copy is replaced by a clip that counts from 5.
  synthClip(dir, 'counted-copy.mp4', {
    video: "color=black:size=64x48:rate=25,geq=lum='16+8*mod(N+5,25)':cb=128:cr=128", audio: 'sine=frequency=440:sample_rate=48000', seconds: 4,
  });
  const replaced = await run(edl(0.5, 'counted-copy.mp4'), out);
  assert.match(replaced.log, /3 range\(s\) encoded, 0 reused/);
  assert.equal(readdirSync(cache).filter((f) => f.endsWith('.tmp')).length, 0, 'no attempt left a part-written file');
  assert.equal(indices(out)[0], 5);
});

await test('a speed, interpolation or grade the cut cannot honour is refused before anything is encoded, naming the range', () => {
  const edl = (range: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    () => parseEdl({ sources: { a: 'a.mp4' }, ranges: [{ source: 'a', start: 0, end: 1, ...range }], ...extra }, 'edl.json');
  assert.throws(edl({ speed: 0 }), /range 0 "speed" must be a number above 0/);
  assert.throws(edl({ speed: -1 }), /range 0 "speed" must be a number above 0/);
  assert.throws(edl({ speed: '0.5' }), /range 0 "speed" must be a number above 0/);
  assert.throws(edl({ interpolate: true }), /range 0 "interpolate" draws frames for slow motion, so it needs a "speed" below 1/);
  assert.throws(edl({ speed: 2, interpolate: true }), /needs a "speed" below 1/);
  assert.throws(edl({ mute: 'yes' }), /range 0 "mute" must be true or false/);
  assert.throws(edl({ grade: { brightness: 1 } }), /range 0 "grade": "brightness" is not a grade setting; the settings are exposure, contrast, saturation, temperature, grain, lut/);
  assert.throws(edl({ grade: { exposure: 4 } }), /"exposure" must be a number from -3 to 3/);
  assert.throws(edl({ grade: { saturation: 115 } }), /"saturation" must be a number from 0 to 3/);
  assert.throws(edl({ grade: { grain: 2.5 } }), /"grain" must be a whole number from 0 to 100/);
  assert.throws(edl({ grade: { lut: 'look.png' } }), /"lut" must be the path of a \.cube, \.3dl, \.dat, \.m3d, \.csp file/);
  assert.throws(edl({}, { grade: { contrast: null } }), /"grade": "contrast" is null; null only drops the cut's value in a range's own grade/);
  assert.doesNotThrow(edl({ speed: 0.25, interpolate: true, mute: true, grade: { exposure: null, lut: 'x.CUBE' } }, { grade: { exposure: 0.5 } }));
});

await test('a LUT that is not there is named before anything is encoded', async () => {
  await assert.rejects(run({ sources: { b: 'bars.mp4' }, ranges: [{ source: 'b', start: 0, end: 0.4, grade: { lut: 'missing.cube' } }] }),
    /LUT "missing\.cube" not found at .*missing\.cube/);
});
