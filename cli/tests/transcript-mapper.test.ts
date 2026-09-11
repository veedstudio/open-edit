// Tests for the VEED -> editor transcript mapper. Pure logic, no deps; run with:
//   node --import tsx tests/transcript-mapper.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapVeedTranscript } from '../src/veed/transcript-mapper.ts';

await test('maps one caption item to one chunk with space-joined word text and the item timestamp', () => {
  const out = mapVeedTranscript({
    a: { from: 0.5, to: 2, words: [{ value: 'hello' }, { value: 'world' }] },
  });
  assert.deepEqual(out, {
    text: 'hello world',
    chunks: [
      {
        text: 'hello world',
        timestamp: [0.5, 2],
        // words with no from/to fall back to the item window
        words: [
          { text: 'hello', timestamp: [0.5, 2] },
          { text: 'world', timestamp: [0.5, 2] },
        ],
      },
    ],
  });
});

await test('preserves per-word from/to timings for word-level animation', () => {
  const out = mapVeedTranscript({
    a: {
      from: 0.32,
      to: 1,
      words: [
        { value: 'So', from: 0.32, to: 0.4 },
        { value: 'I', from: 0.4, to: 0.52 },
        { value: 'built', from: 0.52, to: 1 },
      ],
    },
  });
  assert.deepEqual(out.chunks[0].words, [
    { text: 'So', timestamp: [0.32, 0.4] },
    { text: 'I', timestamp: [0.4, 0.52] },
    { text: 'built', timestamp: [0.52, 1] },
  ]);
});

await test('orders chunks by start time even when the subtitles record keys are not chronological', () => {
  const out = mapVeedTranscript({
    second: { from: 5, to: 6, words: [{ value: 'late' }] },
    first: { from: 1, to: 2, words: [{ value: 'early' }] },
  });
  assert.deepEqual(
    out.chunks.map((c) => c.timestamp),
    [
      [1, 2],
      [5, 6],
    ],
  );
  assert.equal(out.text, 'early late');
});

await test('drops caption items whose text is empty so they do not become blank beats', () => {
  const out = mapVeedTranscript({
    a: { from: 0, to: 1, words: [{ value: 'real' }] },
    b: { from: 1, to: 2, words: [] },
    c: { from: 2, to: 3, words: [{ value: '  ' }] },
  });
  assert.deepEqual(
    out.chunks.map((c) => c.text),
    ['real'],
  );
  assert.equal(out.text, 'real');
});

await test('trims stray whitespace from word values in the stored chunk text', () => {
  const out = mapVeedTranscript({
    a: { from: 0, to: 1, words: [{ value: ' hi ' }, { value: 'there' }] },
  });
  assert.equal(out.chunks[0].text, 'hi there');
  assert.equal(out.text, 'hi there');
});

await test('throws a clear error when there are no usable caption items', () => {
  assert.throws(() => mapVeedTranscript({}), /no usable caption items/i);
});

