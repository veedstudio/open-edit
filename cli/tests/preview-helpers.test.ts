import { test } from 'node:test';
import assert from 'node:assert/strict';
// Plain-JS browser module, imported directly — tsx handles .mjs fine.
import { chunkIndexAtTime, cueBlockGeometry, fitWidth, focalFraction, nextCueTime, prevCueTime, rearmDecoder, refocusScrollDelta } from '../src/preview/page/helpers.mjs';

const chunks = [
  { text: 'a', timestamp: [0.5, 1.2], words: [] },
  { text: 'b', timestamp: [1.4, 2.6], words: [] },
  { text: 'c', timestamp: [3.0, 4.0], words: [] },
];

test('time inside a window finds that chunk', () => {
  assert.equal(chunkIndexAtTime(chunks, 0.6), 0);
  assert.equal(chunkIndexAtTime(chunks, 1.4), 1);
  assert.equal(chunkIndexAtTime(chunks, 3.999), 2);
});

test('gap between chunks binds to the previous line', () => {
  assert.equal(chunkIndexAtTime(chunks, 1.3), 0);
  assert.equal(chunkIndexAtTime(chunks, 2.8), 1);
});

test('before the first chunk is -1, past the end is the last line', () => {
  assert.equal(chunkIndexAtTime(chunks, 0.1), -1);
  assert.equal(chunkIndexAtTime(chunks, 99), 2);
});

test('empty chunk list is -1', () => {
  assert.equal(chunkIndexAtTime([], 1), -1);
});

test('cue block geometry maps time windows to track percentages', () => {
  assert.deepEqual(cueBlockGeometry({ text: 'x', timestamp: [1.5, 4.5], words: [] }, 15), { leftPct: 10, widthPct: 20 });
  assert.deepEqual(cueBlockGeometry({ text: 'x', timestamp: [0, 15], words: [] }, 15), { leftPct: 0, widthPct: 100 });
});

test('cue block geometry clamps windows that overrun the duration', () => {
  const g = cueBlockGeometry({ text: 'x', timestamp: [12, 20], words: [] }, 15)!;
  assert.equal(g.leftPct, 80);
  assert.equal(g.widthPct, 20); // clipped at the track end
});

test('cue block geometry with no duration renders nothing', () => {
  assert.equal(cueBlockGeometry({ text: 'x', timestamp: [1, 2], words: [] }, 0), null);
  assert.equal(cueBlockGeometry({ text: 'x', timestamp: [1, 2], words: [] }, undefined), null);
});

test('next cue jumps to the first line starting after now', () => {
  assert.equal(nextCueTime(chunks, 0), 0.5);
  assert.equal(nextCueTime(chunks, 0.6), 1.4);
  assert.equal(nextCueTime(chunks, 3.0), null); // inside the last cue: nowhere to go
  assert.equal(nextCueTime([], 1), null);
});

test('prev cue restarts the current line, or steps back when near its start', () => {
  assert.equal(prevCueTime(chunks, 2.6), 1.4);  // deep into cue 2: restart it
  assert.equal(prevCueTime(chunks, 1.6), 0.5);  // just after cue 2 started: go to cue 1
  assert.equal(prevCueTime(chunks, 0.2), 0);    // before the first cue: go to zero
  assert.equal(prevCueTime([], 5), 0);
});

// ---- canvas zoom ----
test('fit is the contained width, and at 100% never upscales past the source', () => {
  assert.equal(fitWidth(1000, 800, 1920, 1080), 1000);                // stage is the narrow edge
  assert.equal(fitWidth(2000, 500, 1920, 1080), 500 * (1920 / 1080)); // stage is the short edge
  assert.equal(fitWidth(1000, 800, 480, 270), 480);                   // small source stays native
});

test('fit is degenerate-safe', () => {
  assert.equal(fitWidth(0, 800, 1920, 1080), 0);
  assert.equal(fitWidth(1000, 800, 0, 0), 0);
});

// The 50%→200% jump that used to land in the far corner: at 50% the canvas is narrower than the
// stage and sits at x=300 by auto margins, so its centre is NOT the scroll origin. Reading the
// focal point off the canvas and putting it back is what keeps it centred.
test('zoom keeps the focal point under the stage centre across a resize', () => {
  const centre = 500;
  const frac = focalFraction(centre, 300, 400);            // 50%: 400 wide, auto-centred at x=300
  assert.equal(refocusScrollDelta(centre, 0, 1600, frac), 300); // 200%: 1600 wide from the origin
  assert.equal(refocusScrollDelta(centre, 300, 400, frac), 0);  // unchanged canvas: no nudge
});

test('a canvas with no width yet cannot divide by zero', () => {
  assert.equal(focalFraction(500, 0, 0), 0.5);
});

test('rearms the media decoder only for Safari and preserves the paused position', () => {
  const listeners = new Map();
  const video = {
    currentTime: 12,
    duration: 20,
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback); },
    load() { listeners.get('loadedmetadata')(); },
  };
  assert.equal(rearmDecoder(video as unknown as HTMLVideoElement, 'Mozilla/5.0 Safari/605.1.15'), true);
  assert.equal(video.currentTime, 12);

  const chromium = { ...video, load() { throw new Error('must not reload Chromium'); } };
  assert.equal(rearmDecoder(chromium as unknown as HTMLVideoElement, 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36'), false);
});
