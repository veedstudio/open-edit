// apply-edl in a workspace laid out as an agent lays one: sources under inputs/, the EDL in a run's folder naming
// them from where the agent stands, transcripts where the transcribe command writes them. Real encodes, because
// the paths must reach ffmpeg and the cut's transcript must land on the cut that was actually made.
//   Run:  node --import tsx tests/apply-edl-transcript.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { retimeTranscript } from '../src/commands/retime-transcript.ts';
import { SINE, TESTSRC, captureConsole, captureConsoleAsync, probeStream, scratchDir, synthClip, withRoot } from './helpers/synth.ts';

const root = scratchDir('edl-ws');
const elsewhere = scratchDir('edl-cwd');
// Paths go into a pattern as written: a Windows path's backslashes would otherwise read as escapes.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Back to the previous folder afterwards: Windows cannot remove a scratch folder that is still the working directory.
async function from<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const was = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(was);
  }
}
mkdirSync(join(root, 'inputs'), { recursive: true });
mkdirSync(join(root, 'runs', 'piece'), { recursive: true });
synthClip(join(root, 'inputs'), 'a.mp4', { video: TESTSRC, audio: SINE, seconds: 3 });
synthClip(join(root, 'inputs'), 'b.mp4', { video: TESTSRC, audio: SINE, seconds: 2 });

const word = (text: string, a: number, b: number) => ({ text, timestamp: [a, b] as [number, number] });
const transcriptOfA = {
  text: 'one two three four',
  chunks: [
    { text: 'one two', timestamp: [0.6, 1.4] as [number, number], words: [word('one', 0.6, 0.9), word('two', 1.0, 1.4)] },
    { text: 'three four', timestamp: [2.1, 2.8] as [number, number], words: [word('three', 2.1, 2.4), word('four', 2.5, 2.8)] },
  ],
};
const sourceTranscript = join(root, 'runs', 'a', 'transcript.json');
mkdirSync(join(root, 'runs', 'a'), { recursive: true });
writeFileSync(sourceTranscript, JSON.stringify(transcriptOfA));

let n = 0;
/** An EDL written in runs/piece/, cut from `cwd` with OPEN_EDIT_ROOT at `workspace`. */
async function cut(edl: object, o: { cwd?: string; workspace?: string; out?: string } = {}) {
  const path = join(root, 'runs', 'piece', `edl-${n++}.json`);
  writeFileSync(path, JSON.stringify(edl));
  const out = o.out ?? join(root, 'runs', 'piece', `cut${n}.mp4`);
  const was = process.cwd();
  process.chdir(o.cwd ?? root);
  try {
    const { out: log } = await withRoot(o.workspace ?? root, () => captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out])));
    return { out, log, edl: path };
  } finally {
    process.chdir(was);
  }
}

const A_RANGES = [{ source: 'a', start: 0.5, end: 1.5 }, { source: 'a', start: 2, end: 3 }];
// Named absolutely where the test is about the transcript rather than where the source was found.
const A = join(root, 'inputs', 'a.mp4');
const B = join(root, 'inputs', 'b.mp4');

await test('a source named from the working directory is read from there, and a line says so', async () => {
  const { out, log } = await cut({ sources: { a: 'inputs/a.mp4' }, ranges: A_RANGES }, { workspace: elsewhere });
  // The working directory as the process reports it, with its links resolved.
  assert.match(log, new RegExp(`source "a" \\(inputs/a\\.mp4\\) is not beside the EDL, so it was read from the working directory: ${escaped(join(realpathSync(root), 'inputs', 'a.mp4'))}`));
  assert.ok(Math.abs(Number(probeStream(out, 'v:0', 'duration').duration) - 2) < 0.01);
  // A file beside the EDL is the one read, whatever the working directory holds.
  mkdirSync(join(root, 'runs', 'piece', 'inputs'), { recursive: true });
  synthClip(join(root, 'runs', 'piece', 'inputs'), 'near.mp4', { video: TESTSRC, audio: SINE, seconds: 1.5 });
  synthClip(join(root, 'inputs'), 'near.mp4', { video: TESTSRC, audio: SINE, seconds: 3 });
  const beside = await cut({ sources: { a: 'inputs/near.mp4' }, ranges: [{ source: 'a', start: 0, end: 1.5 }] });
  assert.doesNotMatch(beside.log, /not beside the EDL/);
});

await test('a source found only under OPEN_EDIT_ROOT is read from there, and a missing one is named where it was looked for', async () => {
  const { log } = await cut({ sources: { a: 'inputs/a.mp4' }, ranges: A_RANGES }, { cwd: elsewhere });
  assert.match(log, /source "a" \(inputs\/a\.mp4\) is not beside the EDL, so it was read from \$OPEN_EDIT_ROOT/);
  await assert.rejects(cut({ sources: { a: 'inputs/none.mp4' }, ranges: A_RANGES }),
    new RegExp(`source "a" not found at ${escaped(join(root, 'runs', 'piece', 'inputs', 'none.mp4'))}, nor in the working directory or the workspace`));
});

await test('the cut\'s transcript is written where a transcription of the cut would land, as retime-transcript writes it', async () => {
  const { out, log, edl } = await cut({ sources: { a: A }, ranges: A_RANGES });
  const written = join(root, 'runs', `cut${n}`, 'transcript.json');
  assert.match(log, new RegExp(`the cut's transcript, its sources' words retimed onto it \\(4 words\\) -> ${escaped(written)}`));
  const retimed = join(elsewhere, 'retimed.json');
  await from(root, () => withRoot(root, () => captureConsole(() => retimeTranscript(['--edl', edl, '--out', retimed]))));
  assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), JSON.parse(readFileSync(retimed, 'utf8')));
  // On the cut's timeline: "three" was at 2.1 s of the source, 0.1 s into the second range, which starts at 1 s.
  const words = JSON.parse(readFileSync(written, 'utf8')).chunks.flatMap((c: { words: unknown[] }) => c.words);
  assert.deepEqual(words[2], word('three', 1.1, 1.4));
  assert.ok(existsSync(out));
});

await test('a heard source with no transcript adds no words and is named, while the others are still retimed', async () => {
  const { log } = await cut({ sources: { a: A, b: B }, ranges: [{ source: 'b', start: 0, end: 1 }, ...A_RANGES] });
  assert.match(log, /source "b" has no transcript at [^\n]*runs[\\/]b[\\/]transcript\.json, so its ranges add no words to the cut's/);
  const written = JSON.parse(readFileSync(join(root, 'runs', `cut${n}`, 'transcript.json'), 'utf8'));
  assert.equal(written.chunks.flatMap((c: { words: unknown[] }) => c.words).length, 4);
});

await test('a cut named like its own source does not overwrite that source\'s transcript', async () => {
  const before = readFileSync(sourceTranscript, 'utf8');
  mkdirSync(join(root, 'out'), { recursive: true });
  const { log } = await cut({ sources: { a: A }, ranges: A_RANGES }, { out: join(root, 'out', 'a.mp4') });
  assert.match(log, new RegExp(`no transcript of the cut was written: ${escaped(sourceTranscript)}, where it goes, is the transcript of source "a"`));
  assert.equal(readFileSync(sourceTranscript, 'utf8'), before);
});

await test('with no transcript of any source, the cut is still made and a line says none was written', async () => {
  const { out, log } = await cut({ sources: { b: B }, ranges: [{ source: 'b', start: 0, end: 1 }] });
  assert.match(log, /no transcript of the cut was written: its sources have none/);
  assert.ok(existsSync(out));
  assert.ok(!existsSync(join(root, 'runs', `cut${n}`, 'transcript.json')));
});

await test('retime-transcript reads a source and a transcript named from the working directory too', async () => {
  const edl = join(root, 'runs', 'piece', 'retime-edl.json');
  writeFileSync(edl, JSON.stringify({ sources: { a: 'inputs/a.mp4' }, transcripts: { a: 'runs/a/transcript.json' }, ranges: A_RANGES }));
  const { out } = await from(root, () => withRoot(elsewhere, () => captureConsole(() => retimeTranscript(['--edl', edl, '--out', join(elsewhere, 'r.json')]))));
  assert.match(out, /the transcript of "a" \(runs\/a\/transcript\.json\) is not beside the EDL, so it was read from the working directory/);
  assert.match(out, /retimed 4 words/);
});
