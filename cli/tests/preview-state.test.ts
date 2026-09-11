import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunState, RunStateError } from '../src/preview/state.ts';

const CHUNK = {
  text: 'So I built',
  timestamp: [0.32, 1] as [number, number],
  words: [
    { text: 'So', timestamp: [0.32, 0.4] as [number, number] },
    { text: 'I', timestamp: [0.4, 0.52] as [number, number] },
    { text: 'built', timestamp: [0.52, 1] as [number, number] },
  ],
};

async function makeRun(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'preview-state-'));
}

async function writeTranscript(dir: string, chunks: unknown[] = [CHUNK]): Promise<void> {
  await writeFile(join(dir, 'transcript.json'), JSON.stringify({ text: 'So I built', chunks }));
}

async function writeMeta(dir: string): Promise<void> {
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    key: 'demo', file: 'demo.mp4', videoPath: '/tmp/demo.mp4',
    width: 736, height: 1312, fps: 25, durationSec: 8,
  }));
}

async function writeRender(dir: string): Promise<void> {
  await mkdir(join(dir, 'final'), { recursive: true });
  await writeFile(join(dir, 'final', 'out.mp4'), 'not-really-mp4');
}

async function writeWv(dir: string): Promise<void> {
  await mkdir(join(dir, 'final'), { recursive: true });
  await writeFile(join(dir, 'final', 'template.wv'), '<wv/>');
}

// Fixed mtimes, never "now": ordering is the whole point of these assertions and same-millisecond
// writes would make them coin flips.
const T = 1_780_000_000; // epoch seconds
async function setMtime(path: string, epochSec: number): Promise<void> {
  await utimes(path, epochSec, epochSec);
}

test('empty dir is waiting', async () => {
  const dir = await makeRun();
  const s = await readRunState(dir);
  assert.equal(s.stage, 'waiting');
  assert.equal(s.chunks, null);
  assert.equal(s.video, null);
});

test('transcript without meta is still waiting (go.ts runs before prep)', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  const s = await readRunState(dir);
  assert.equal(s.stage, 'waiting');
});

test('transcript + meta is cooking, with video meta and chunks exposed', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  const s = await readRunState(dir);
  assert.equal(s.stage, 'cooking');
  assert.equal(s.video?.width, 736);
  assert.equal(s.video?.videoPath, '/tmp/demo.mp4');
  assert.equal(s.chunks?.length, 1);
  assert.equal(s.chunks?.[0].text, 'So I built');
  assert.equal(s.styleRef, null);
});

test('style.json surfaces the chosen ref while cooking', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  await writeFile(join(dir, 'style.json'), JSON.stringify({ refId: 'hook-224-peak', refPath: 'refs/html/hook-224-peak', tags: [], hasRecipe: true, seed: 7 }));
  const s = await readRunState(dir);
  assert.equal(s.styleRef, 'hook-224-peak');
});

test('final/out.mp4 makes it rendered, and its mtime is what swaps the player over', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  await writeRender(dir);
  const s = await readRunState(dir);
  assert.equal(s.stage, 'rendered');
  assert.equal(typeof s.renderMtimeMs, 'number');
});

test('renderMtimeMs is null before the render exists', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  const s = await readRunState(dir);
  assert.equal(s.renderMtimeMs, null);
});

test('an empty chunk list is a valid cooking transcript (page derives no-speech from it)', async () => {
  const dir = await makeRun();
  await writeTranscript(dir, []);
  await writeMeta(dir);
  const s = await readRunState(dir);
  assert.equal(s.stage, 'cooking');
  assert.deepEqual(s.chunks, []);
});

test('a transcript with ANY invalid chunk reads as no-transcript (indices must never skew)', async () => {
  const dir = await makeRun();
  await writeTranscript(dir, [CHUNK, { text: 'broken', timestamp: 'corrupt' }, CHUNK]);
  await writeMeta(dir);
  const s = await readRunState(dir);
  assert.equal(s.chunks, null, 'partial validity must not produce a compacted list');
  assert.equal(s.stage, 'waiting');
});

// Stage used to latch on "out.mp4 exists", so a re-render still read "done · final video" while
// the new one was in flight (Owen, #proj-open-edit).
test('an edit landing after the render flips the strip back to pending', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  await writeRender(dir);
  await writeWv(dir);
  await setMtime(join(dir, 'final', 'out.mp4'), T);
  await setMtime(join(dir, 'final', 'template.wv'), T + 30); // edited after delivery
  const s = await readRunState(dir);
  assert.equal(s.stage, 'cooking');
});

test('a re-render keeps the delivered video on screen while it cooks', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  await writeRender(dir);
  await writeWv(dir);
  await setMtime(join(dir, 'final', 'out.mp4'), T);
  await setMtime(join(dir, 'final', 'template.wv'), T + 30);
  const s = await readRunState(dir);
  assert.equal(s.renderMtimeMs, T * 1000, 'the last good render is still the one to play');
  assert.equal(s.stageStartedAtMs, (T + 30) * 1000, 'elapsed counts from the edit, not from prep');
});

test('the wv that produced the current render leaves it rendered', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  await writeWv(dir);
  await writeRender(dir);
  await setMtime(join(dir, 'final', 'template.wv'), T);
  await setMtime(join(dir, 'final', 'out.mp4'), T + 30); // muxed after its source, as the pipeline leaves it
  assert.equal((await readRunState(dir)).stage, 'rendered');
  await setMtime(join(dir, 'final', 'out.mp4'), T); // same second: not stale, the mux was that fast
  assert.equal((await readRunState(dir)).stage, 'rendered');
});

// Every run sits here between DESIGN + RENDER and MUX AUDIO: the .wv document is written, the mux has
// not happened yet.
test('a wv with no render yet is simply still cooking', async () => {
  const dir = await makeRun();
  await writeTranscript(dir);
  await writeMeta(dir);
  await writeWv(dir);
  const s = await readRunState(dir);
  assert.equal(s.stage, 'cooking');
  assert.equal(s.renderMtimeMs, null);
});

test('malformed transcript json throws RunStateError', async () => {
  const dir = await makeRun();
  await writeFile(join(dir, 'transcript.json'), '{"text": "truncat');
  await writeMeta(dir);
  await assert.rejects(readRunState(dir), RunStateError);
});
