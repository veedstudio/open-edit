// Tests the whisper command's guard: the same transcript.json the other providers protect, and the
// one flag that replaces it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
