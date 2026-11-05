// Tests src/render/picture-notes.ts, what a video render says about the picture it made, on clips ffmpeg synthesises:
// a picture that freezes partway, an opening on black, and a patch that looks only near what it re-rendered.
//   Run:  node --import tsx --test cli/tests/picture-notes.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pictureDurationOf } from '../src/probe.ts';
import { pictureNotes } from '../src/render/picture-notes.ts';
import type { TextRecord, TextSample } from '../src/render/text-record.ts';
import { changesIn } from '../src/verify/dead-air.ts';
import { scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('picture-notes');
const MOVING = 'testsrc2=size=320x240:rate=30';

/** A 320x240 record at 30 fps, read every third frame, showing `text` from `from` on. */
function recordOf(seconds: number, text = '', from = 0): TextRecord {
  const frames = Math.round(seconds * 30);
  const samples: TextSample[] = [];
  for (let frame = 0; frame < frames; frame += 3) {
    const shown = text && frame / 30 >= from - 1e-9;
    samples.push({
      frame, time: frame / 30, texts: shown ? [{
        text, box: [20, 20, 280, 40], fontSize: 32, color: [255, 255, 255, 1], opacity: 1, selector: '#card',
      }] : [],
    });
  }
  return { version: 1, page: 'index.html', width: 320, height: 240, fps: '30', frames, transparent: false, framesPerSample: 3, samples };
}

// Moving for 2 s, then the last frame held for 4: frozen from 2 s to the end.
const frozenTail = synthClip(dir, 'frozen-tail.mp4', { video: MOVING, seconds: 6, vf: 'trim=0:2,tpad=stop_mode=clone:stop_duration=4' });
const duration = pictureDurationOf(frozenTail);

await test('a still held past what its words allow is one short line, and words on it let it hold longer', async () => {
  assert.deepEqual(await pictureNotes(frozenTail, { duration, record: recordOf(6), range: null }), [
    'frozen 2.0-6.0 s (4.0 s, over the 3.0 s a still with no page text allows)',
  ]);
  // Six words may hold 4.2 s, so the same 4 s passes.
  assert.deepEqual(await pictureNotes(frozenTail, { duration, record: recordOf(6, 'See you at the grand opening', 1.5), range: null }), []);
  assert.deepEqual(await pictureNotes(frozenTail, { duration, record: null, range: null }), [
    'frozen 2.0-6.0 s (4.0 s, over the 3.0 s a still allows)',
  ]);
});

await test('a first frame of flat black is named with how long it lasts, since platforms show it as the cover', async () => {
  const video = synthClip(dir, 'black-open.mp4', { video: MOVING, seconds: 4, vf: "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,1)'" });
  assert.deepEqual(await pictureNotes(video, { duration: pictureDurationOf(video), record: recordOf(4), range: null }), [
    'frame 0 is blank, flat black until 1.00 s; platforms show it as the cover',
  ]);
});

await test('a patch looks only at stills overlapping the stretch it re-rendered, and at the first frame only when that stretch starts it', async () => {
  const record = recordOf(6);
  assert.deepEqual(await pictureNotes(frozenTail, { duration, record, range: { start: 0, end: 1 } }), []);
  assert.deepEqual(await pictureNotes(frozenTail, { duration, record, range: { start: 4, end: 5 } }), [
    'frozen 2.0-6.0 s (4.0 s, over the 3.0 s a still with no page text allows)',
  ]);
});

await test('a still the patch\'s scan cuts at its edge is measured whole, from where it starts', async () => {
  const video = synthClip(dir, 'long-hold.mp4', { video: MOVING, seconds: 16, vf: 'trim=0:2,tpad=stop_mode=clone:stop_duration=14' });
  const notes = await pictureNotes(video, { duration: pictureDurationOf(video), record: recordOf(16), range: { start: 14, end: 15 } });
  // Its scan from 8.5 s finds it already holding; the encoder's keyframe inside it nudges the held frame, which stays frozen.
  assert.deepEqual(notes, ['frozen 2.0-16.0 s (14.0 s, over the 3.0 s a still with no page text allows)']);
});

await test('a scan of a stretch reads the same changes as the whole scan does there, at the same times', async () => {
  const whole = await changesIn(frozenTail);
  const part = await changesIn(frozenTail, { start: 1, end: 3 });
  const there = whole.filter((c) => c.sec > 1 + 1e-6 && c.sec < 3 - 1e-6);
  assert.equal(part.length, there.length);
  part.forEach((c, i) => {
    assert.ok(Math.abs(c.sec - there[i].sec) < 1e-6, `change ${i} at ${c.sec}s, expected ${there[i].sec}s`);
    assert.ok(Math.abs(c.mean - there[i].mean) < 0.05, `change at ${c.sec}s: mean ${c.mean}, expected ${there[i].mean}`);
  });
});
