// Tests src/commands/words.ts: a transcript in any format read as timed lines, on real files.
//   Run:  node --import tsx --test cli/tests/words.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { words } from '../src/commands/words.ts';
import { captureConsole, scratchDir } from './helpers/synth.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));
const printed = (argv: string[]) => {
  const { result, out } = captureConsole(() => words(argv));
  assert.equal(result, 0);
  return out.trimEnd().split('\n');
};
const texts = (lines: string[]) => lines.slice(1).map((l) => l.slice(19));

await test('a fal answer is printed a word a line with its times, under one line naming what was read', () => {
  const path = fixture('fal-whisper-words.fal-result.json');
  const lines = printed([path]);
  assert.equal(lines[0], `${path}: fal-ai/whisper's response, word chunks, mapped in memory; 13 words in 2 cues, 0.03s to 3.99s`);
  assert.equal(lines[1], '    0.03     0.11  If');
  assert.equal(lines.at(-1), '    3.51     3.99  is...');
  assert.equal(lines.length, 14);
});

await test('--from and --to keep the lines that overlap that stretch, and --cues prints a cue a line', () => {
  const path = fixture('fal-whisper-words.json');
  assert.deepEqual(texts(printed([path, '--from', '2.5', '--to', '4'])), ['I', 'sure', "didn't.", "That's"]);
  assert.deepEqual(texts(printed([path, '--from', '2.5', '--to', '4', '--cues'])), ["I sure didn't.", "That's why I tell my friends about Evergreen"]);
  assert.throws(() => words([path, '--from', '4', '--to', '2']), /--to wants seconds after --from/);
});

await test('a voice\'s character timestamps read as its words, without the directions given to the voice', () => {
  const lines = printed([fixture('voice-character-timestamps.json'), '--cues']);
  assert.match(lines[0], /: a voice's character timestamps, mapped in memory; 14 words in 3 cues, 0\.14s to 5\.60s$/);
  assert.deepEqual(texts(lines), ['If the air vanished for ten seconds, the', "first thing you'd notice is...", 'nothing.']);
});

await test('a transcript.json is printed as written, and its first line says that is what it is', () => {
  const path = join(scratchDir('words'), 'transcript.json');
  writeFileSync(path, JSON.stringify({ text: 'hi there', chunks: [{ text: 'hi there', timestamp: [1, 2], words: [{ text: 'hi', timestamp: [1, 1.4] }, { text: 'there', timestamp: [1.5, 2] }] }] }));
  assert.deepEqual(printed([path]), [`${path}: transcript.json; 2 words in 1 cue, 1.00s to 2.00s`, '    1.00     1.40  hi', '    1.50     2.00  there']);
});
