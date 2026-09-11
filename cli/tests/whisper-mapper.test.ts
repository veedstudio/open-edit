// Tests for the Whisper -> editor transcript mapper. Pure logic, no deps; run with:
//   pnpm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { synthWordTimings } from '../src/prep/synth-word-timings.ts';
import { groupWordsIntoChunks, mapWhisperTranscript } from '../src/prep/whisper-mapper.ts';

await test('maps the Python Whisper shape (mlx-whisper, openai-whisper) one segment to one chunk', () => {
  const { transcript: out } = mapWhisperTranscript({
    text: ' hello world',
    segments: [
      {
        start: 0.5,
        end: 2,
        text: ' hello world',
        words: [
          { word: ' hello', start: 0.5, end: 1.2 },
          { word: ' world', start: 1.2, end: 2 },
        ],
      },
    ],
  });
  assert.deepEqual(out, {
    text: 'hello world',
    chunks: [
      {
        text: 'hello world',
        timestamp: [0.5, 2],
        words: [
          { text: 'hello', timestamp: [0.5, 1.2] },
          { text: 'world', timestamp: [1.2, 2] },
        ],
      },
    ],
  });
});

await test('accepts whisper-timestamped, which names the word key "text"', () => {
  const { transcript: out } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1, words: [{ text: 'So', start: 0, end: 0.4 }, { text: 'I', start: 0.4, end: 1 }] }],
  });
  assert.deepEqual(out.chunks[0].words, [
    { text: 'So', timestamp: [0, 0.4] },
    { text: 'I', timestamp: [0.4, 1] },
  ]);
});

await test('keeps the segment window even when word times sit inside it', () => {
  const { transcript: out } = mapWhisperTranscript({
    segments: [{ start: 0.1, end: 3, words: [{ word: 'one', start: 0.5, end: 0.9 }] }],
  });
  assert.deepEqual(out.chunks[0].timestamp, [0.1, 3]);
});

// WhisperX leaves any word its alignment dictionary cannot match untimed. Dropping such a word would
// delete it from the caption text, which is worse than an approximate window.
await test('interpolates an untimed word instead of dropping it, and counts it', () => {
  const { transcript: out, interpolated } = mapWhisperTranscript({
    segments: [
      {
        start: 0,
        end: 3,
        words: [
          { word: 'timed', start: 0, end: 1 },
          { word: 'unalignable' },
          { word: 'also', start: 2, end: 3 },
          { word: '   ', start: 2.5, end: 2.6 },
        ],
      },
    ],
  });
  assert.equal(interpolated, 1);
  assert.deepEqual(out.chunks[0].words.map((w) => w.text), ['timed', 'unalignable', 'also']);
  assert.deepEqual(out.chunks[0].words[1].timestamp, [1, 2]); // borrows the gap between its neighbours
  assert.equal(out.chunks[0].text, 'timed unalignable also');
});

await test('untimed runs at the edges borrow the segment window', () => {
  const { transcript: out, interpolated } = mapWhisperTranscript({
    segments: [
      { start: 0, end: 4, words: [{ word: 'lead' }, { word: 'anchor', start: 2, end: 3 }, { word: 'tail' }] },
    ],
  });
  assert.equal(interpolated, 2);
  assert.deepEqual(out.chunks[0].words[0].timestamp, [0, 2]);
  assert.deepEqual(out.chunks[0].words[2].timestamp, [3, 4]);
});

await test('a wholly untimed segment is spread across its own window, still counted', () => {
  const { transcript: out, interpolated } = mapWhisperTranscript({
    segments: [
      { start: 0, end: 2, words: [{ word: 'a' }, { word: 'b' }] },
      { start: 2, end: 3, words: [{ word: 'c', start: 2, end: 3 }] },
    ],
  });
  assert.equal(interpolated, 2);
  assert.deepEqual(out.chunks[0].words.map((w) => w.timestamp), [[0, 1], [1, 2]]);
});

await test('reports zero interpolation when every word is timed', () => {
  const { interpolated } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1, words: [{ word: 'all', start: 0, end: 0.5 }, { word: 'timed', start: 0.5, end: 1 }] }],
  });
  assert.equal(interpolated, 0);
});

// WhisperX ships a top-level word_segments array alongside segments[].words; only the latter is read.
await test('ignores WhisperX word_segments and reads segments[].words carrying a score', () => {
  const { transcript: out } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1, words: [{ word: 'hi', start: 0, end: 1 }] }],
    ...{ word_segments: [{ word: 'ignored', start: 9, end: 9 }] },
  });
  assert.deepEqual(out.chunks, [{ text: 'hi', timestamp: [0, 1], words: [{ text: 'hi', timestamp: [0, 1] }] }]);
});

await test('assigns the OpenAI API flat word list into its wordless segments by midpoint', () => {
  const { transcript: out } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    words: [
      { word: 'a', start: 0.1, end: 0.4 },
      { word: 'b', start: 0.5, end: 0.9 },
      { word: 'c', start: 1.1, end: 1.4 },
    ],
  });
  assert.equal(out.chunks.length, 2);
  assert.deepEqual(out.chunks[0].text, 'a b');
  assert.deepEqual(out.chunks[1].text, 'c');
  assert.deepEqual(out.chunks[1].timestamp, [1, 2]);
});

await test('converts whisper.cpp millisecond offsets to seconds', () => {
  const { transcript: out } = mapWhisperTranscript({
    transcription: [
      { text: ' Hello', offsets: { from: 0, to: 500 } },
      { text: ' there.', offsets: { from: 500, to: 1250 } },
    ],
  });
  assert.deepEqual(out.chunks[0].words, [
    { text: 'Hello', timestamp: [0, 0.5] },
    { text: 'there.', timestamp: [0.5, 1.25] },
  ]);
});

await test('groups an unsegmented word list on sentence-ending punctuation', () => {
  const chunks = groupWordsIntoChunks([
    { text: 'One', timestamp: [0, 0.2] },
    { text: 'two.', timestamp: [0.2, 0.4] },
    { text: 'Three', timestamp: [0.45, 0.6] },
  ]);
  assert.deepEqual(chunks.map((c) => c.text), ['One two.', 'Three']);
});

await test('groups on a pause and caps cue length', () => {
  const pause = groupWordsIntoChunks([
    { text: 'before', timestamp: [0, 0.2] },
    { text: 'after', timestamp: [1.5, 1.8] },
  ]);
  assert.deepEqual(pause.map((c) => c.text), ['before', 'after']);

  const words = Array.from({ length: 5 }, (_, i) => ({
    text: `w${i}`,
    timestamp: [i * 0.1, i * 0.1 + 0.05] as [number, number],
  }));
  assert.deepEqual(groupWordsIntoChunks(words, { maxWords: 2 }).map((c) => c.text), ['w0 w1', 'w2 w3', 'w4']);
});

await test('chunk timestamps span the grouped words', () => {
  const [chunk] = groupWordsIntoChunks([
    { text: 'a', timestamp: [0.25, 0.5] },
    { text: 'b', timestamp: [0.5, 0.8] },
  ]);
  assert.deepEqual(chunk.timestamp, [0.25, 0.8]);
});

// A segment-only transcript cannot be rescued: with no timed word anywhere there is nothing to
// interpolate from, and prep would even-split every cue.
await test('throws, naming the fix, when the transcript has no per-word timings at all', () => {
  assert.throws(
    () => mapWhisperTranscript({ text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] }),
    /no per-word timings found.*WhisperX.*-ml 1/s,
  );
  assert.throws(() => mapWhisperTranscript({}), /no per-word timings found/);
});

// ── regressions from the high-effort review ────────────────────────────────
// Every case below is a path that silently deleted spoken words or degraded timing while reporting
// success. The inputs are the reviewers' own reproductions.

const wordsOf = (t: { chunks: { words: { text: string }[] }[] }): string[] =>
  t.chunks.flatMap((c) => c.words.map((w) => w.text));

await test('keeps flat words that fall past the last segment, and counts them', () => {
  const { transcript, interpolated } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    words: [
      { word: 'a', start: 0.1, end: 0.4 },
      { word: 'b', start: 1.1, end: 1.4 },
      { word: 'goodbye', start: 1.9, end: 2.3 },
    ],
  });
  assert.deepEqual(wordsOf(transcript), ['a', 'b', 'goodbye']);
  assert.equal(interpolated, 0); // it had real times; it was only unassignable
  assert.ok(transcript.text.endsWith('goodbye'));
});

await test('a wholly untimed segment interpolates from its NEIGHBOURS when it has no window', () => {
  const { transcript, interpolated } = mapWhisperTranscript({
    segments: [
      { start: 0, end: 1, words: [{ word: 'hello', start: 0, end: 1 }] },
      { text: 'lost words here', words: [{ word: 'lost' }, { word: 'words' }, { word: 'here' }] },
      { start: 2, end: 3, words: [{ word: 'bye', start: 2, end: 3 }] },
    ],
  });
  assert.deepEqual(wordsOf(transcript), ['hello', 'lost', 'words', 'here', 'bye']);
  assert.equal(interpolated, 3);
  // borrowed the gap between the surrounding anchors
  const lost = transcript.chunks.flatMap((c) => c.words).find((w) => w.text === 'lost');
  assert.ok((lost as { timestamp: [number, number] }).timestamp[0] >= 1);
});

await test('a segment with no end does not swallow the segments after it', () => {
  const { transcript } = mapWhisperTranscript({
    segments: [{ start: 0, end: 2 }, { start: 2 }, { start: 4, end: 6 }],
    words: [
      { word: 'a', start: 0.1, end: 0.2 },
      { word: 'b', start: 2.1, end: 2.2 },
      { word: 'c', start: 4.1, end: 4.2 },
    ],
  });
  assert.equal(transcript.chunks.length, 3);
  assert.deepEqual(transcript.chunks.map((c) => c.text), ['a', 'b', 'c']);
});

// synth-word-timings discards a beat's real times when a word's midpoint sits outside the chunk
// window, so the window has to cover its own words.
await test('a chunk window widens to cover a word the provider aligned past the segment end', () => {
  const { transcript } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1.5, words: [{ word: 'hey', start: 0.05, end: 0.6 }, { word: 'there', start: 1.4, end: 2 }] }],
  });
  const [chunk] = transcript.chunks;
  assert.deepEqual(chunk.timestamp, [0, 2]);
  for (const w of chunk.words) {
    const mid = (w.timestamp[0] + w.timestamp[1]) / 2;
    assert.ok(mid >= chunk.timestamp[0] && mid <= chunk.timestamp[1], `${w.text} outside its chunk`);
  }
});

// whisper.cpp without -ml 1 emits segment-granularity entries; treating one as a single "word" let a
// segment-only transcript pass the per-word-times gate and then even-split downstream.
await test('a multi-word whisper.cpp entry is tokenised and counted as inferred', () => {
  const { transcript, interpolated } = mapWhisperTranscript({
    transcription: [{ text: ' Hello there my friend.', offsets: { from: 0, to: 2000 } }],
  });
  assert.deepEqual(wordsOf(transcript), ['Hello', 'there', 'my', 'friend.']);
  assert.equal(interpolated, 4);
  const [first] = transcript.chunks[0].words;
  assert.equal(first.timestamp[0], 0);
  assert.ok(first.timestamp[1] < 2);
});

await test('the flat-word path reports its interpolated count', () => {
  const { transcript, interpolated } = mapWhisperTranscript({
    words: [{ word: 'one', start: 0, end: 0.5 }, { word: 'mystery' }, { word: 'three', start: 1.5, end: 2 }],
  });
  assert.deepEqual(wordsOf(transcript), ['one', 'mystery', 'three']);
  assert.equal(interpolated, 1);
});

await test('a whisper.cpp entry with text but no offsets is interpolated, not dropped', () => {
  const { transcript, interpolated } = mapWhisperTranscript({
    transcription: [
      { text: ' Hello', offsets: { from: 0, to: 500 } },
      { text: ' lost' },
      { text: ' world.', offsets: { from: 900, to: 1400 } },
    ],
  });
  assert.deepEqual(wordsOf(transcript), ['Hello', 'lost', 'world.']);
  assert.equal(interpolated, 1);
});

// veed/transcript-mapper.ts sorts because provider order is not guaranteed; this mapper did not.
await test('out-of-order segments are sorted instead of aborting validation downstream', () => {
  const { transcript } = mapWhisperTranscript({
    segments: [
      { start: 4, end: 5, words: [{ word: 'later', start: 4, end: 5 }] },
      { start: 0, end: 1, words: [{ word: 'earlier', start: 0, end: 1 }] },
    ],
  });
  assert.deepEqual(transcript.chunks.map((c) => c.text), ['earlier', 'later']);
  assert.equal(transcript.text, 'earlier later');
});

await test('words whose starts run backwards are reordered so text and reveals agree', () => {
  const { transcript, reordered } = mapWhisperTranscript({
    segments: [{ start: 0, end: 5, words: [{ word: 'one', start: 3, end: 4 }, { word: 'two', start: 1, end: 2 }] }],
  });
  const [chunk] = transcript.chunks;
  assert.deepEqual(chunk.words.map((w) => w.text), ['two', 'one']);
  assert.equal(chunk.text, 'two one'); // text is rebuilt from the same order the reveals follow
  assert.equal(reordered, 1);
});

// Integration: this defect is INVISIBLE at the mapper boundary — the transcript looks fine and
// validateTranscript passes, but synth-word-timings' completeness guard then throws away every real
// time for the beat and even-splits it, while prep still logs "real per-word times".
await test('a word aligned past its segment keeps real delays through synth-word-timings', () => {
  const { transcript } = mapWhisperTranscript({
    segments: [{ start: 0, end: 1.5, words: [{ word: 'hey', start: 0.05, end: 0.6 }, { word: 'there', start: 1.4, end: 2 }] }],
  });
  const wordChunks = transcript.chunks.flatMap((c) => c.words);
  const { beats } = synthWordTimings(transcript.chunks, wordChunks);
  assert.deepEqual(beats[0].words.map((w) => w.delayMs), [50, 1400]); // real times, not an even split

  // The pre-fix chunk window, kept as documentation of what this cost: the same words under the
  // provider's own [0,1.5] window lose every real delay to the completeness guard.
  const { beats: degraded } = synthWordTimings([{ text: 'hey there', timestamp: [0, 1.5] }], wordChunks);
  assert.deepEqual(degraded[0].words.map((w) => w.delayMs), [0, 750]);
});

// The invariant that makes the whole class impossible: nothing may be lost between input and output.
await test('no input word is ever lost, across every input family', () => {
  const cases: { name: string; input: Parameters<typeof mapWhisperTranscript>[0]; expect: number }[] = [
    { name: 'trailing unassignable word', expect: 3, input: {
      segments: [{ start: 0, end: 1 }], words: [{ word: 'a', start: 0.1, end: 0.2 }, { word: 'b', start: 2, end: 3 }, { word: 'c', start: 4, end: 5 }] } },
    { name: 'untimed segment without window', expect: 3, input: {
      segments: [{ start: 0, end: 1, words: [{ word: 'x', start: 0, end: 1 }] }, { words: [{ word: 'y' }, { word: 'z' }] }] } },
    { name: 'segment without end', expect: 2, input: {
      segments: [{ start: 0 }, { start: 1, end: 2 }], words: [{ word: 'p', start: 0.1, end: 0.2 }, { word: 'q', start: 1.1, end: 1.2 }] } },
    { name: 'cpp entry missing offsets', expect: 2, input: {
      transcription: [{ text: 'kept', offsets: { from: 0, to: 100 } }, { text: 'untimed' }] } },
    { name: 'word with only a start', expect: 2, input: {
      segments: [{ start: 0, end: 2, words: [{ word: 'half', start: 0.5 }, { word: 'whole', start: 1, end: 2 }] }] } },
    { name: 'scrambled order', expect: 2, input: {
      segments: [{ start: 0, end: 5, words: [{ word: 'b', start: 3, end: 4 }, { word: 'a', start: 1, end: 2 }] }] } },
  ];
  for (const c of cases) {
    const { transcript } = mapWhisperTranscript(c.input);
    assert.equal(wordsOf(transcript).length, c.expect, `${c.name}: expected ${c.expect} words`);
  }
});

await test('a chunk window reaches an interior word that ends AFTER the last word (ASR overlap)', () => {
  // Overlaps are normal in ASR: an interior word can start after the first yet end after the last. Bounding
  // the window by the last-by-start word's end leaves that word's midpoint outside it, and synth-word-timings
  // then discards the whole beat. The window must cover every word's end, not just the final one's.
  const { transcript } = mapWhisperTranscript({
    segments: [{
      start: 0, end: 2, // the segment's own end is EARLIER than the overlapping word's end, as ASR emits
      words: [
        { word: 'a', start: 0, end: 1 },
        { word: 'b', start: 0.5, end: 5 }, // interior, ends long after 'c' by start-order
        { word: 'c', start: 1.5, end: 2 },
      ],
    }],
  });
  const chunk = transcript.chunks[0];
  const latestEnd = Math.max(...chunk.words.map((w) => w.timestamp[1]));
  assert.ok(chunk.timestamp[1] >= latestEnd, `window end ${chunk.timestamp[1]} must reach the latest word end ${latestEnd}`);
  for (const w of chunk.words) {
    const mid = (w.timestamp[0] + w.timestamp[1]) / 2;
    assert.ok(mid >= chunk.timestamp[0] && mid <= chunk.timestamp[1], `"${w.text}" midpoint ${mid} sits inside the window`);
  }
});

await test('a single very long cue is windowed without overflowing the argument limit', () => {
  // chunkOf takes the min-start/max-end across EVERY word of a segment. Spreading a segment of hundreds of
  // thousands of words into Math.min/Math.max blows the call stack; reduce computes the same bound safely.
  const N = 200_000; // above the ~125k spread threshold, so the old Math.min(...spread) form threw here
  const words = Array.from({ length: N }, (_, i) => ({ word: 'x', start: i, end: i + 1 }));
  const { transcript } = mapWhisperTranscript({ segments: [{ start: 0, end: N, words }] });
  assert.equal(transcript.chunks.length, 1, 'the whole segment is one cue');
  assert.deepEqual(transcript.chunks[0].timestamp, [0, N], 'bounded by the min start and max end across all words');
});

