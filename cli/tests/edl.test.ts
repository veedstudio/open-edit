// Tests src/edl.ts: the shape check both cut tools share, and the frame-grid snapping.
//   Run:  node --import tsx tests/edl.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { framesOf, parseEdl, playedLength, snapRanges, snapToFrames } from '../src/edl.ts';

const good = { sources: { a: 'a.mp4' }, ranges: [{ source: 'a', start: 1.6, end: 7.05, note: 'take two' }] };

await test('a well-formed EDL passes through with its optional fields', () => {
  assert.deepEqual(parseEdl(good, 'edl.json'), good);
  assert.deepEqual(parseEdl({ ...good, transcripts: { a: 't.json' } }, 'edl.json').transcripts, { a: 't.json' });
});

await test('numbers written as strings are refused, not coerced by whichever tool reads them first', () => {
  // "7.05" + 0.04 is the string "7.050.04" in one tool and a working number in the other.
  const edl = { sources: { a: 'a.mp4' }, ranges: [{ source: 'a', start: '1.6', end: '7.05' }] };
  assert.throws(() => parseEdl(edl, 'edl.json'), /edl\.json: range 0 "start" must be a number of seconds — got the string "1\.6"/);
});

await test('every structural mistake is named with the file', () => {
  assert.throws(() => parseEdl([], 'x.json'), /x\.json: an EDL is a JSON object/);
  assert.throws(() => parseEdl({ ranges: [] }, 'x.json'), /"sources" must map each id to a video path — got absent/);
  assert.throws(() => parseEdl({ sources: { a: 1 }, ranges: [] }, 'x.json'), /"sources" must map/);
  assert.throws(() => parseEdl({ sources: { a: '' }, ranges: [] }, 'x.json'), /"sources" must map/);
  assert.throws(() => parseEdl({ sources: {}, ranges: {} }, 'x.json'), /"ranges" must be an array/);
  assert.throws(() => parseEdl({ sources: {}, transcripts: 'no', ranges: [] }, 'x.json'), /"transcripts" must map/);
  assert.throws(() => parseEdl({ sources: { a: 'a.mp4' }, ranges: [{ source: 'zz', start: 0, end: 1 }] }, 'x.json'), /range 0 names a source the "sources" map has no entry for/);
  assert.throws(() => parseEdl({ sources: { a: 'a.mp4' }, ranges: [{ source: 'a', start: 0, end: 1, note: 3 }] }, 'x.json'), /"note" must be text/);
  assert.throws(() => parseEdl({ sources: { a: 'a.mp4' }, ranges: [] }, 'x.json'), /no ranges/);
  assert.throws(() => parseEdl({ sources: { a: 'a.mp4' }, ranges: [{ source: 'a', start: -1, end: 1 }] }, 'x.json'), /before the file begins/);
  assert.throws(() => parseEdl({ sources: { a: 'a.mp4' }, ranges: [{ source: 'a', start: 2, end: 1 }] }, 'x.json'), /range 0 of "a" ends at 1, which is not after its start 2/);
});

await test('snapping moves both edges UP to the next frame instant and keeps a grid value where it is', () => {
  assert.deepEqual(snapToFrames({ source: 'a', start: 0.013, end: 0.9 }, 25), { source: 'a', start: 0.04, end: 0.92, fps: 25 });
  assert.deepEqual(snapToFrames({ source: 'a', start: 1, end: 2 }, 25), { source: 'a', start: 1, end: 2, fps: 25 });
  // 1.0s is NOT on the 29.97 grid: frame 30 sits at 1.001s.
  const ntsc = snapToFrames({ source: 'a', start: 1, end: 2 }, 30000 / 1001);
  assert.ok(Math.abs(ntsc.start - 30 * 1001 / 30000) < 1e-9);
  assert.ok(Math.abs(ntsc.end - 60 * 1001 / 30000) < 1e-9);
});

await test('a range from a source at another rate starts on its own grid and lasts whole frames of the cut', () => {
  const at = snapToFrames({ source: 'h', start: 0.013, end: 0.9 }, 30, 0, { cutFps: 25 });
  assert.ok(Math.abs(at.start - 1 / 30) < 1e-9);
  // 0.8667s from there is 21.67 frames at 25 fps, rounded up to 22.
  assert.ok(Math.abs(at.end - (1 / 30 + 22 / 25)) < 1e-9);
  assert.equal(at.cutFps, 25);
  assert.equal(framesOf(at).kept, 22);
  assert.equal(playedLength({ ...at, speed: 2 }), 11 / 25);
  // At the cut's own rate nothing is added.
  assert.deepEqual(snapToFrames({ source: 'a', start: 1, end: 2 }, 25, 0, { cutFps: 25 }), { source: 'a', start: 1, end: 2, fps: 25 });
  // The cut's rate is the first range's source's.
  const [first, second] = snapRanges([{ source: 'a', start: 0, end: 1 }, { source: 'h', start: 0, end: 1 }], new Map([['a', 24], ['h', 30]]));
  assert.equal(first.cutFps, undefined);
  assert.equal(second.cutFps, 24);
});

await test('an out-point up to two frames past the picture\'s end ends on its last frame, and one further is left to refuse', () => {
  // 289 frames at 24 fps, with a container that says 12.051s because its sound runs on.
  const end = 289 / 24;
  assert.equal(snapToFrames({ source: 'c', start: 1, end: 12.051 }, 24, 0, { end }).end, end);
  assert.equal(snapToFrames({ source: 'c', start: 1, end: end + 2 / 24 }, 24, 0, { end }).end, end);
  assert.ok(snapToFrames({ source: 'c', start: 1, end: 12.2 }, 24, 0, { end }).end > end);
  // Converted, it ends on the last whole frame of the cut the picture still holds: 7.5667s from 1.4667 holds 181 at 24 fps.
  const hill = snapToFrames({ source: 'h', start: 1.45, end: 9.05 }, 30, 0, { cutFps: 24, end: 271 / 30 });
  assert.ok(Math.abs(hill.end - (44 / 30 + 181 / 24)) < 1e-9 && hill.end <= 271 / 30);
  assert.equal(snapRanges([{ source: 'c', start: 11, end: 12.06 }], new Map([['c', 24]]), new Map([['c', end]]))[0].end, end);
});

await test('a range shorter than one frame is refused rather than snapped to nothing', () => {
  assert.throws(() => snapToFrames({ source: 'a', start: 1.001, end: 1.011 }, 25, 3), /range 3 of "a" .*shorter than one frame at 25 fps/);
});
