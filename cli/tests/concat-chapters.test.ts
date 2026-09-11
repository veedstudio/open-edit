import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { concatList, shapeDiff, type StreamShape } from '../src/commands/concat-chapters.ts';

const shape = (over: Partial<StreamShape> = {}): StreamShape => ({
  codec: 'h264', width: 1920, height: 1080, fps: '30/1',
  audioCodec: 'aac', sampleRate: '48000', channels: 2, ...over,
});

test('concat: the list is in the order it was given, absolute, and quote-safe', () => {
  // Deriving the order from a directory listing would put act-10 before act-2, and a film whose
  // chapters play in the wrong order is not a failure any gate notices.
  const list = concatList(['/runs/f/chapters/act-1/out.mp4', '/runs/f/chapters/act-2/out.mp4']);
  assert.deepEqual(list.trim().split('\n'), [
    `file '${resolve('/runs/f/chapters/act-1/out.mp4')}'`,
    `file '${resolve('/runs/f/chapters/act-2/out.mp4')}'`,
  ]);

  assert.match(concatList(["/runs/hunter's cut/out.mp4"]), /hunter'\\''s cut/, 'a quote in a path is escaped, not fatal');
  assert.ok(concatList(['out.mp4']).includes(process.cwd()), 'relative paths are resolved, because the demuxer reads them from the list file');
  assert.throws(() => concatList([]), /no chapters/);
});

test('concat: a mismatched chapter is named before anything is copied', () => {
  // Copying streams needs them identical. A mismatch produces a file that plays for one chapter and
  // then glitches — the kind of defect nobody sees until the whole thing is watched.
  assert.deepEqual(shapeDiff(shape(), shape()), []);
  assert.deepEqual(shapeDiff(shape(), shape({ width: 1080, height: 1920 })), ['canvas 1920x1080 vs 1080x1920']);
  assert.deepEqual(shapeDiff(shape(), shape({ fps: '25/1' })), ['fps 30/1 vs 25/1']);
  assert.deepEqual(shapeDiff(shape(), shape({ audioCodec: '' })), ['audio codec aac vs none']);
  assert.deepEqual(shapeDiff(shape(), shape({ channels: 1 })), ['channels 2 vs 1']);

  const many = shapeDiff(shape(), shape({ codec: 'hevc', fps: '24/1', sampleRate: '44100' }));
  assert.equal(many.length, 3, 'every difference is reported, not just the first');
});
