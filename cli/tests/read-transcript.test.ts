// Tests src/transcript/read-transcript.ts on real speech-to-text files, one per format: what every command
// that reads a transcript is given, and the words and times it gets back from each.
//   Run:  node --import tsx --test cli/tests/read-transcript.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mappedNote, readTranscriptFile, readTranscriptJson } from '../src/transcript/read-transcript.ts';
import type { Transcript, TranscriptWord } from '../src/transcript/transcript-types.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));
const wordsOf = (t: Transcript): TranscriptWord[] => t.chunks.flatMap((c) => c.words);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const CASES: { file: string; format: RegExp; words: number; first: [string, number, number]; last: [string, number, number]; interpolated?: number }[] = [
  { file: 'whisper-segments.json', format: /^Whisper segments with word times$/, words: 16, first: ['Also,', 0.451, 0.752], last: ['again.', 7.819, 7.979] },
  { file: 'fal-whisper-words.json', format: /^word chunks$/, words: 48, first: ['Nobody', 0.03, 0.29], last: ['minutes.', 16.29, 16.83] },
  { file: 'fal-whisper-words.fal-result.json', format: /^fal-ai\/whisper's response, word chunks$/, words: 13, first: ['If', 0.03, 0.11], last: ['is...', 3.51, 3.99] },
  { file: 'typed-words.json', format: /^a timed word list$/, words: 15, first: ['Give', 0.46, 0.6], last: ['minutes.', 4.88, 5.24] },
  { file: 'forced-alignment.json', format: /^a timed word list$/, words: 44, first: ['Nobody', 0.3, 0.72], last: ['minutes.', 16.5, 16.84] },
  { file: 'voice-character-timestamps.json', format: /^a voice's character timestamps$/, words: 14, first: ['If', 0.137, 0.16], last: ['nothing.', 4.800000000000001, 5.6000000000000005] },
];

await test('every speech-to-text format in the fixtures is read from its real file, every word with its own times', () => {
  for (const c of CASES) {
    const read = readTranscriptFile(fixture(c.file));
    const words = wordsOf(read.transcript);
    assert.match(read.format, c.format, c.file);
    assert.equal(read.mapped, true, c.file);
    assert.equal(words.length, c.words, `${c.file}: ${words.map((w) => w.text).join(' ')}`);
    assert.equal(read.interpolated, 0, c.file);
    for (const [word, [text, from, to]] of [[words[0], c.first], [words.at(-1)!, c.last]] as const) {
      assert.equal(word.text, text, c.file);
      assert.ok(near(word.timestamp[0], from) && near(word.timestamp[1], to), `${c.file}: "${text}" at ${word.timestamp}`);
    }
    // Spacing entries, and the bracketed directions a voice is given, are not words anyone says.
    assert.ok(words.every((w) => w.text.trim() !== '' && !/[[\]]/.test(w.text)), c.file);
  }
});

await test('segment chunks without word times keep every word, each spread over its segment and counted', () => {
  const read = readTranscriptFile(fixture('fal-whisper-segments.fal-result.json'));
  const words = wordsOf(read.transcript);
  assert.equal(words.length, 13);
  assert.equal(read.interpolated, 13);
  assert.match(read.format, /segment chunks without word times \(chunk_level "word" times each word\)/);
  assert.ok(near(words[0].timestamp[0], 0.03096875) && near(words.at(-1)!.timestamp[1], 4.350968750000001));
  assert.match(mappedNote('s.json', read)!, /^s\.json: read as .*, mapped in memory \(13 words, 13 of them without times of their own, so interpolated\)$/);
});

await test('a voice\'s word split across two blocks of characters is one word', () => {
  // The real file splits "nothing." as "nothing" and "." across its last two blocks.
  const raw = JSON.parse(readFileSync(fixture('voice-character-timestamps.json'), 'utf8')) as { timestamps: { characters: string[] }[] };
  assert.equal(raw.timestamps.at(-1)!.characters.join(''), '.');
  assert.equal(wordsOf(readTranscriptFile(fixture('voice-character-timestamps.json')).transcript).at(-1)!.text, 'nothing.');
});

await test('an audio event in a typed word list is not taken for a word', () => {
  const raw = JSON.parse(readFileSync(fixture('typed-words.json'), 'utf8')) as { words: object[] };
  raw.words.splice(1, 0, { text: '(laughs)', start: 0.6, end: 0.66, type: 'audio_event', speaker_id: null });
  const words = wordsOf(readTranscriptJson(raw, 'with-event.json').transcript);
  assert.equal(words.length, 15);
  assert.ok(!words.some((w) => w.text === '(laughs)'));
});

await test('a transcript.json is returned exactly as written, with no line about it', () => {
  const written: Transcript = {
    text: 'b a',
    chunks: [{ text: 'b a', timestamp: [0, 2], words: [{ text: 'b', timestamp: [1, 2] }, { text: 'a', timestamp: [0, 1] }] }],
  };
  const read = readTranscriptJson(written, 'transcript.json');
  assert.deepEqual(read.transcript, written);
  assert.equal(read.format, 'transcript.json');
  assert.equal(mappedNote('transcript.json', read), undefined);
});

await test('a file in no format read here is refused by name, with what is read', () => {
  for (const raw of [{ text: 'hello' }, null, { chunks: 'no' }, { chunks: [null] }]) {
    assert.throws(() => readTranscriptJson(raw, 'odd.json'), /^Error: odd\.json is not a transcript: expected a transcript\.json .*timestamps\[\]\.characters\)$/);
  }
  // A format that is read, but carries no word times at all, says how to get them.
  assert.throws(() => readTranscriptJson({ segments: [{ start: 0, end: 1, text: 'hi' }] }, 'untimed.json'), /^Error: untimed\.json: no per-word timings found/);
});
