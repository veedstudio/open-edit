// Tests src/edl.ts: the shape check both cut tools share, and the frame-grid snapping.
//   Run:  node --import tsx tests/edl.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEdl, snapToFrames } from '../src/edl.ts';

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

await test('a range shorter than one frame is refused rather than snapped to nothing', () => {
  assert.throws(() => snapToFrames({ source: 'a', start: 1.001, end: 1.011 }, 25, 3), /range 3 of "a" .*shorter than one frame at 25 fps/);
});
