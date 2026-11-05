// Tests the whisper command's guard: the same transcript.json the other providers protect, and the
// one flag that replaces it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { whisper } from '../src/commands/whisper.ts';
import { captureConsoleAsync, withRoot } from './helpers/synth.ts';

const whisperJson = (word: string) => JSON.stringify({
  segments: [{ start: 0, end: 1, text: word, words: [{ word, start: 0, end: 1 }] }],
});

const captured = async (fn: () => Promise<number>) => {
  const { result, out } = await captureConsoleAsync(fn);
  return { code: result, out };
};

await test('an existing transcript is left alone and the json is reported as NOT applied; --force replaces it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-whisper-'));
  await withRoot(root, async () => {
    await writeFile(join(root, 'clip.mp4'), '');
    await mkdir(join(root, 'runs'), { recursive: true });
    const first = join(root, 'first.json');
    const second = join(root, 'second.json');
    await writeFile(first, whisperJson('first'));
    await writeFile(second, whisperJson('second'));
    const transcript = join(root, 'runs', 'clip', 'transcript.json');
    const text = async () => (JSON.parse(await readFile(transcript, 'utf8')) as { text: string }).text;

    assert.equal((await captured(() => whisper([first, join(root, 'clip.mp4')]))).code, 0);
    assert.equal(await text(), 'first');

    const kept = await captured(() => whisper([second, join(root, 'clip.mp4')]));
    assert.equal(kept.code, 0);
    assert.match(kept.out, /already exists .*the supplied json was NOT applied; --force replaces the file/);
    assert.equal(await text(), 'first');

    assert.equal((await captured(() => whisper([second, join(root, 'clip.mp4'), '--force']))).code, 0);
    assert.equal(await text(), 'second');
  });
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));

await test('a fal model\'s answer becomes transcript.json as openedit fal run kept it, and the line names what it read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-whisper-fal-'));
  await withRoot(root, async () => {
    const cases = [
      ['speech.mp3', 'fal-whisper-words.fal-result.json', /read as fal-ai\/whisper's response, word chunks; 2 chunks, 13 words/, 13],
      ['voice.mp3', 'voice-character-timestamps.json', /read as a voice's character timestamps; 3 chunks, 14 words/, 14],
    ] as const;
    for (const [media, json, line, words] of cases) {
      await writeFile(join(root, media), '');
      const { code, out } = await captured(() => whisper([fixture(json), join(root, media)]));
      assert.equal(code, 0);
      assert.match(out, line);
      const written = JSON.parse(await readFile(join(root, 'runs', media.replace('.mp3', ''), 'transcript.json'), 'utf8')) as {
        chunks: { words: { text: string; timestamp: [number, number] }[] }[];
      };
      assert.equal(written.chunks.flatMap((c) => c.words).length, words);
    }
  });
});
