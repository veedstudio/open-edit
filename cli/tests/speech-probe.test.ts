// Tests src/commands/speech-probe.ts. The envelope, the percentile and the gap search are pure, so
// they are asserted against synthesised PCM rather than against a recording — a test that needs a
// street to reproduce a floor is a test nobody re-runs.
//   Run:  node --import tsx tests/speech-probe.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, envelopeOf, MIN_DYNAMIC_RANGE_DB, percentile, speechProbe } from '../src/commands/speech-probe.ts';
import { SINE, TESTSRC, captureConsole, scratchDir, synthClip } from './helpers/synth.ts';

/** dBFS -> the constant 16-bit amplitude that measures as that level. */
const amplitudeFor = (db: number) => Math.round(32768 * 10 ** (db / 20));

/** PCM whose level follows `plan`, one entry per window of `windowSamples`. */
const pcmFrom = (plan: number[], windowSamples: number): Int16Array => {
  const out = new Int16Array(plan.length * windowSamples);
  plan.forEach((db, w) => {
    const amp = amplitudeFor(db);
    for (let i = 0; i < windowSamples; i++) out[w * windowSamples + i] = i % 2 === 0 ? amp : -amp;
  });
  return out;
};

await test('the envelope reports each window in dBFS', () => {
  const env = envelopeOf(pcmFrom([-6, -20, -40], 160), 160);
  assert.equal(env.length, 3);
  env.forEach((db, i) => assert.ok(Math.abs(db - [-6, -20, -40][i]) < 0.1, `window ${i} was ${db}`));
});

await test('a trailing partial window is not measured as a quiet one', () => {
  // 2.5 windows of signal must produce 2 readings, not 3 with the last one wrong.
  const pcm = new Int16Array(400).fill(amplitudeFor(-6));
  assert.equal(envelopeOf(pcm, 160).length, 2);
});

await test('digital silence reads as the floor sentinel rather than -Infinity', () => {
  assert.deepEqual(envelopeOf(new Int16Array(320), 160), [-100, -100]);
});

await test('percentile picks from the sorted values and clamps at both ends', () => {
  const values = [-10, -50, -30, -20, -40];
  assert.equal(percentile(values, 0), -50);
  assert.equal(percentile(values, 1), -10);
  assert.equal(percentile(values, 0.5), -30);
});

await test('an empty envelope does not throw', () => {
  assert.equal(percentile([], 0.1), -100);
  const result = analyse([], 10, 250, 0);
  assert.equal(result.onset, null);
  assert.equal(result.decay, null);
  assert.deepEqual(result.gaps, []);
});

await test('onset and decay bracket the speech, and gaps are reported in source seconds', () => {
  // 500ms of floor, 300ms of speech, 400ms of floor, at 10ms per window.
  const plan = [...Array(50).fill(-50), ...Array(30).fill(-15), ...Array(40).fill(-50)];
  const result = analyse(plan, 10, 250, 0);
  assert.ok(Math.abs(result.onset! - 0.5) < 1e-9, `onset ${result.onset}`);
  assert.ok(Math.abs(result.decay! - 0.8) < 1e-9, `decay ${result.decay}`);
  assert.equal(result.gaps.length, 2);
  assert.ok(Math.abs(result.gaps[0].duration - 0.5) < 1e-9);
  assert.ok(Math.abs(result.gaps[1].duration - 0.4) < 1e-9);
});

await test('a range offset is carried into every reported time, so the numbers address the source', () => {
  const plan = [...Array(50).fill(-50), ...Array(30).fill(-15)];
  const result = analyse(plan, 10, 250, 12.5);
  assert.ok(Math.abs(result.onset! - 13.0) < 1e-9, `onset ${result.onset}`);
  assert.ok(Math.abs(result.gaps[0].start - 12.5) < 1e-9);
});

await test('a gap shorter than the minimum is not offered as a cut point', () => {
  // 100ms of quiet inside continuous speech: real, and far too short to cut in.
  const plan = [...Array(30).fill(-15), ...Array(10).fill(-50), ...Array(30).fill(-15)];
  assert.deepEqual(analyse(plan, 10, 250, 0).gaps, []);
  assert.equal(analyse(plan, 10, 80, 0).gaps.length, 1);
});

await test('the threshold follows the MEASURED floor, so the same numbers work on a street and in a booth', () => {
  const quiet = [...Array(50).fill(-60), ...Array(30).fill(-15)];
  const street = [...Array(50).fill(-37), ...Array(30).fill(-15)];
  const q = analyse(quiet, 10, 250, 0);
  const s = analyse(street, 10, 250, 0);
  assert.ok(q.threshold < s.threshold, 'a quieter floor must lower the threshold with it');
  // Both find the same speech, which a fixed threshold could not do.
  assert.ok(Math.abs(q.onset! - 0.5) < 1e-9);
  assert.ok(Math.abs(s.onset! - 0.5) < 1e-9);
});

await test('a clip that is speech end to end offers no cut point rather than inventing one', () => {
  const result = analyse(Array(80).fill(-15), 10, 250, 0);
  assert.deepEqual(result.gaps, []);
  assert.ok(Math.abs(result.onset! - 0) < 1e-9);
});

await test('a constant level is NOT reported as unbroken speech', () => {
  // peak === floor makes the threshold equal the floor, so every window counts as speech and the gap
  // search finds nothing. Printed as "no gaps", that tells the agent not to cut anywhere on a clip
  // with no voice in it at all.
  for (const level of [-100, -45, -12]) {
    const result = analyse(Array(200).fill(level), 10, 250, 0);
    assert.equal(result.speechFound, false, `${level} dBFS flat must not read as speech`);
    assert.equal(result.onset, null);
    assert.deepEqual(result.gaps, []);
  }
});

await test('an envelope that measured nothing reports no speech rather than no gaps', () => {
  const result = analyse([], 10, 250, 0);
  assert.equal(result.speechFound, false);
});

await test('a real signal just over the dynamic-range floor is still analysed', () => {
  const plan = [...Array(50).fill(-50), ...Array(30).fill(-50 + MIN_DYNAMIC_RANGE_DB + 1)];
  const result = analyse(plan, 10, 250, 0);
  assert.equal(result.speechFound, true);
  assert.ok(result.onset !== null);
});

await test('a gap is reported only when it is AT LEAST --gap long — 240ms does not satisfy 250', () => {
  // 30ms windows: 8 quiet ones are 240ms, 9 are 270ms. Rounding 250/30 down to 8 reported the first.
  const speech = Array(20).fill(-10);
  const short = analyse([...speech, ...Array(8).fill(-60), ...speech], 30, 250, 0);
  const long = analyse([...speech, ...Array(9).fill(-60), ...speech], 30, 250, 0);
  assert.equal(short.gaps.length, 0, 'a 240ms gap must not pass as 250');
  assert.equal(long.gaps.length, 1);
  assert.ok(long.gaps[0].duration >= 0.25);
});

// --- the command ---------------------------------------------------------------

const dir = scratchDir('probe-cmd');
const clip = synthClip(dir, 'tone.mp4', { video: TESTSRC, audio: SINE, seconds: 1 });

await test('the flags are refused by name, with their unit', () => {
  assert.throws(() => speechProbe([clip, '--range', '4:2']), /--range end 2 must be after start 4/);
  assert.throws(() => speechProbe([clip, '--range', 'abc']), /--range wants seconds as start:end/);
  assert.throws(() => speechProbe([clip, '--gap', 'abc']), /--gap wants milliseconds, e\.g\. --gap 250/);
  assert.throws(() => speechProbe([clip, '--window=']), /--window wants milliseconds/);
});

await test('a range past the end of the file says NO AUDIO MEASURED rather than reporting a clean gap', () => {
  const { out } = captureConsole(() => speechProbe([clip, '--range', '3:5']));
  assert.match(out, /NO AUDIO MEASURED/);
});

await test('--json omits the envelope and states how many windows it measured', () => {
  const { out } = captureConsole(() => speechProbe([clip, '--json']));
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.equal('envelope' in parsed, false);
  assert.equal(parsed.measuredWindows, 100, 'one second of 10ms windows');
  assert.equal(parsed.windowMs, 10);
});
