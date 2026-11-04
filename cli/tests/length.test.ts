// Tests src/verify/length.ts. The judgement reads only the probed length and the one asked for, so every
// case is a context written out; the review's own tests run it on a rendered clip.
//   Run:  node --import tsx --test cli/tests/length.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LengthInput } from '../src/verify/checks.ts';
import { measureLength, toleranceFor } from '../src/verify/length.ts';

// Asked with --length unless the case says where else.
const judge = (duration: number, asked: { seconds: number; from?: string } | { missing: string }) => {
  const askedLength: LengthInput = 'missing' in asked ? asked : { from: '--length', ...asked };
  return measureLength({ video: 'out.mp4', duration, transcript: { missing: 'none' }, askedLength, textRecord: { missing: 'none' }, brief: { missing: 'none' } });
};

await test('a render shorter than the length asked for is reported with both durations', () => {
  const report = judge(20.8, { seconds: 25 });
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, ['the video is 20.80s, 4.20s shorter than the 25.00s asked for (--length), more than the 1.25s allowed']);
  assert.deepEqual(report.skipped, []);
});

await test('a render longer than the length asked for is reported too', () => {
  const report = judge(31, { seconds: 25 });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /^the video is 31\.00s, 6\.00s longer than the 25\.00s asked for \(--length\)/);
});

await test('a render within the tolerance passes, and says how close it came', () => {
  const report = judge(24, { seconds: 25 });
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.lines, ['on length: 24.00s against the 25.00s asked for (--length), 1.00s off, within the 1.25s allowed']);
});

await test('the tolerance is a second on a short piece and 5% on a longer one, either way', () => {
  assert.equal(toleranceFor(10), 1);
  assert.equal(toleranceFor(20), 1);
  assert.ok(Math.abs(toleranceFor(60) - 3) < 1e-9);
  assert.equal(judge(9, { seconds: 10 }).verdict, 'pass');
  assert.equal(judge(11, { seconds: 10 }).verdict, 'pass');
  assert.equal(judge(8.9, { seconds: 10 }).verdict, 'found');
  assert.equal(judge(11.1, { seconds: 10 }).verdict, 'found');
  assert.equal(judge(57, { seconds: 60 }).verdict, 'pass');
  assert.equal(judge(63, { seconds: 60 }).verdict, 'pass');
  assert.equal(judge(56.9, { seconds: 60 }).verdict, 'found');
  assert.equal(judge(63.1, { seconds: 60 }).verdict, 'found');
});

await test('a miss at the allowance passes, though float subtraction puts it a hair over', () => {
  // 27.3 - 26 is 1.3000000000000007 and 5% of 26 is 1.3: the line would print "1.30s longer ... the 1.30s allowed".
  for (const [duration, asked] of [[27.3, 26], [24.7, 26], [23.1, 22]]) {
    assert.equal(judge(duration, { seconds: asked }).verdict, 'pass', `${duration} against ${asked}`);
  }
  assert.equal(judge(27.31, { seconds: 26 }).verdict, 'found');
});

await test('with no length asked for the check is skipped, with the reason, never a pass', () => {
  const report = judge(20.8, { missing: 'none given with --length' });
  assert.equal(report.verdict, 'skipped');
  assert.deepEqual(report.lines, []);
  assert.deepEqual(report.skipped, ['the length asked for: none given with --length']);
});
