// Tests src/probe.ts against clips ffmpeg synthesises: the rotation branch cannot be asserted on a
// string, and every command that reads a file's shape trusts this one reading of it.
//   Run:  node --import tsx tests/probe.test.ts
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { audioDurationOf, colourTagsOf, hasAudioStream, probeDisplaySize, probeFps } from '../src/probe.ts';
import { SINE, TESTSRC, rotatedCopy, scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('probe');
const plain = synthClip(dir, 'plain.mp4', { video: TESTSRC, audio: SINE, seconds: 2 });
const silent = synthClip(dir, 'silent.mp4', { video: TESTSRC, seconds: 1 });

await test('a plain clip reports its stored dimensions', () => {
  assert.deepEqual(probeDisplaySize(plain), { width: 320, height: 240 });
});

await test('a quarter-turn rotation tag swaps the dimensions, a half turn does not', () => {
  assert.deepEqual(probeDisplaySize(rotatedCopy(plain, join(dir, 'rot90.mp4'), 90)), { width: 240, height: 320 });
  assert.deepEqual(probeDisplaySize(rotatedCopy(plain, join(dir, 'rot270.mp4'), 270)), { width: 240, height: 320 });
  assert.deepEqual(probeDisplaySize(rotatedCopy(plain, join(dir, 'rot180.mp4'), 180)), { width: 320, height: 240 });
});

await test('the nominal frame rate is read as a number', () => {
  assert.equal(probeFps(plain), 25);
});

await test('audio presence and length come from the audio stream, not the container', () => {
  assert.equal(hasAudioStream(plain), true);
  assert.equal(hasAudioStream(silent), false);
  assert.ok(Math.abs(audioDurationOf(plain) - 2) < 0.1, `audio should be about 2s, got ${audioDurationOf(plain)}`);
  assert.throws(() => audioDurationOf(silent), /has no audio stream/);
});

await test('a file ffprobe cannot read is refused by name', () => {
  assert.throws(() => probeDisplaySize(join(dir, 'missing.mp4')), /could not read the dimensions/);
  assert.throws(() => colourTagsOf(join(dir, 'missing.mp4')), /could not read the colour tags/);
});
