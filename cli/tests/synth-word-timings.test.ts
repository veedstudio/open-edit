import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evenSplitDelays, synthWordTimings, type TimedChunk } from '../src/prep/synth-word-timings.ts';

test('evenSplitDelays: 700ms window / 3 words → even back-to-back slots, in-window + monotonic', () => {
  const d = evenSplitDelays(0, 0.7, ['A', 'B', 'C']);
  assert.deepEqual(d.map((x) => x.delayMs), [0, 233, 467]); // slot = 700/3 ≈ 233.33
  assert.deepEqual(d.map((x) => x.w), ['A', 'B', 'C']);
  for (let i = 1; i < d.length; i++) assert.ok(d[i].delayMs >= d[i - 1].delayMs, 'monotonic');
  assert.ok(d.at(-1)!.delayMs < 700, 'last word lands before the window closes');
});

test('evenSplitDelays: cue start offset is absolute-ms', () => {
  const d = evenSplitDelays(1.2, 1.9, ['X', 'Y']); // start 1200ms, window 700ms, slot 350
  assert.deepEqual(d.map((x) => x.delayMs), [1200, 1550]);
});

test('synthWordTimings: no word chunks → even-split fallback per beat; cueDelayMs = round(start*1000)', () => {
  const segs: TimedChunk[] = [{ timestamp: [0, 0.7], text: 'A B C' }, { timestamp: [1.0, 2.0], text: 'D E' }];
  const wt = synthWordTimings(segs, null);
  assert.equal(wt.beats.length, 2);
  assert.equal(wt.beats[0].cueDelayMs, 0);
  assert.equal(wt.beats[0].cueDurMs, 700);
  assert.deepEqual(wt.beats[0].words.map((w) => w.delayMs), [0, 233, 467]);
  assert.equal(wt.beats[1].cueDelayMs, 1000);
  assert.deepEqual(wt.beats[1].words.map((w) => w.delayMs), [1000, 1500]);
});

test('synthWordTimings: real word chunks mapped to their beat, clamped in-window + monotonic', () => {
  const segs: TimedChunk[] = [{ timestamp: [0, 2], text: 'a b' }, { timestamp: [2, 4], text: 'c d' }];
  const words: TimedChunk[] = [
    { timestamp: [0.1, 0.3], text: 'a' }, { timestamp: [0.5, 0.7], text: 'b' },
    { timestamp: [2.4, 2.6], text: 'c' }, { timestamp: [3.1, 3.4], text: 'd' },
  ];
  const wt = synthWordTimings(segs, words);
  assert.deepEqual(wt.beats[0].words.map((w) => w.delayMs), [100, 500]);
  assert.deepEqual(wt.beats[1].words.map((w) => w.delayMs), [2400, 3100]);
  for (const b of wt.beats) {
    const end = b.cueDelayMs + b.cueDurMs;
    for (const w of b.words) assert.ok(w.delayMs >= b.cueDelayMs && w.delayMs <= end, 'in-window');
  }
});

test('synthWordTimings: a word whose midpoint falls in an inter-segment gap → completeness guard even-splits the beat', () => {
  const segments = [
    { timestamp: [0, 2] as [number, number], text: 'hello world' },
    { timestamp: [2.1, 4] as [number, number], text: 'again' },
  ];
  // 'world' spans [1.9, 2.2] → midpoint 2.05 lands in the gap between segments — matched to NO beat
  const words = [
    { timestamp: [0.1, 0.5] as [number, number], text: 'hello' },
    { timestamp: [1.9, 2.2] as [number, number], text: 'world' },
    { timestamp: [2.2, 2.6] as [number, number], text: 'again' },
  ];
  const wt = synthWordTimings(segments, words);
  assert.equal(wt.beats[0].words.length, 2, 'beat 1 keeps BOTH transcript words (fallback, not a partial real list)');
  assert.deepEqual(wt.beats[0].words.map((w) => w.w), ['hello', 'world']);
  assert.equal(wt.beats[1].words.length, 1);
});

test('synthWordTimings: a chunk with no usable timestamp throws a descriptive error', () => {
  assert.throws(
    () => synthWordTimings([{ timestamp: null, text: 'x' } as never]),
    /chunk 1 has no usable timestamp/,
  );
});
