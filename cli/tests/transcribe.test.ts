// Tests for the transcription flow: provider argv, the validation gates, and preference handling.
// The spawn is injected, so nothing here launches whisperx or ffmpeg.
// (The skill's warning-triage coupling test stays in the Open Edit repository, beside TRANSCRIPTION.md.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync as existsNow, writeFileSync as writeNow } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHasAudio,
  assertWhisperxUsable,
  parseArgs,
  runBatch,
  transcribeLocally,
  transcribeVeed,
  readPrefs,
  recordedModel,
  runKeyOf,
  validateTranscript,
  whisperxArgs,
  whisperxModel,
  writePrefs,
  type Run,
  uploadProxy,
  PROXY_OVER_BYTES,
} from '../src/commands/transcribe.ts';
import { collidingRunKey } from '../src/prep/transcript-cache.ts';
import { REQUESTED } from '../src/veed/orchestrate.ts';
import type { Transcript } from '../src/prep/transcript-types.ts';
import { existsSync } from 'node:fs';
import { captureConsoleAsync, withRoot } from './helpers/synth.ts';

const HELP = '--model --device --compute_type --output_format --output_dir --language --diarize';

/** A Run that records every invocation and replies from a scripted queue. */
function fakeRun(replies: { code?: number; out?: string; err?: string }[] = []): Run & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    const next = replies.shift() ?? { code: 0, out: '' };
    return { code: next.code ?? 0, out: next.out ?? '', err: next.err ?? '' };
  }) as Run & { calls: [string, string[]][] };
  run.calls = calls;
  return run;
}

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'open-edit-test-'));

test('whisperx argv defaults to cpu/int8 and json output', () => {
  const args = whisperxArgs('/tmp/a/audio.wav', '/tmp/a', 'small.en');
  assert.deepEqual(args, [
    '/tmp/a/audio.wav',
    '--model', 'small.en',
    '--device', 'cpu',
    '--compute_type', 'int8',
    '--output_format', 'json',
    '--output_dir', '/tmp/a',
  ]);
  assert.ok(whisperxArgs('/a.wav', '/o', 'medium', 'de').includes('--language'));
});

// The device/compute knobs are read at config import, so the override is proven in a subprocess.
test('OPEN_EDIT_WHISPERX_DEVICE/COMPUTE override the cpu/int8 defaults', () => {
  const probe = spawnSync(process.execPath, [
    '--import', 'tsx', '-e',
    "import('./src/config.ts').then(c => console.log(`${c.WHISPERX_DEVICE} ${c.WHISPERX_COMPUTE}`))",
  ], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, OPEN_EDIT_WHISPERX_DEVICE: 'cuda', OPEN_EDIT_WHISPERX_COMPUTE: 'float16' },
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), 'cuda float16');
});

test('the medium tier is passed through untouched', () => {
  assert.equal(whisperxModel('medium', undefined), 'medium');
  assert.equal(whisperxModel('medium', 'de'), 'medium');
});

// small.en has no multilingual weights: transcribing German with it produces confident nonsense.
test('an English-only model drops .en for a non-English language', () => {
  assert.equal(whisperxModel('small.en', 'de'), 'small');
  assert.equal(whisperxModel('small.en', 'en'), 'small.en');
  assert.equal(whisperxModel('small.en', undefined), 'small.en');
});

test('a missing whisperx names the installer rather than failing obscurely', async () => {
  await assert.rejects(
    () => assertWhisperxUsable(fakeRun([{ code: 127, out: 'command not found' }])),
    /install-whisperx/,
  );
});

// The output flags are inherited from openai-whisper and undocumented in WhisperX's own README, so a
// build that lacks them must be caught before we spawn it, not after.
test('a whisperx whose CLI lacks our flags is refused, naming them', async () => {
  await assert.rejects(
    () => assertWhisperxUsable(fakeRun([{ code: 0, out: '--model --device' }])),
    /does not accept --compute_type, --output_format, --output_dir/,
  );
  await assertWhisperxUsable(fakeRun([{ code: 0, out: HELP }]));
});

test('a clip with no audio track is rejected before anything is spawned', async () => {
  await assert.rejects(() => assertHasAudio('/tmp/silent.mp4', fakeRun([{ out: '\n' }])), /no audio track/);
  await assertHasAudio('/tmp/fine.mp4', fakeRun([{ out: '0\n' }]));
});

// A failing probe says nothing about the audio, so it must not read as "has audio" — which is what
// folding stderr into the tested string, or ignoring the exit code, would produce.
test('a failing ffprobe is reported as a failure, not as "has audio"', async () => {
  await assert.rejects(
    () => assertHasAudio('/tmp/clip.mp4', fakeRun([{ code: 127, err: 'ffprobe: command not found' }])),
    /ffprobe/,
  );
  // ...and its diagnostic is passed on rather than swallowed
  await assert.rejects(
    () => assertHasAudio('/tmp/broken.mp4', fakeRun([{ code: 1, err: 'moov atom not found' }])),
    /moov atom not found/,
  );
  // stderr chatter on a healthy probe must not be mistaken for a stream listing
  await assert.rejects(
    () => assertHasAudio('/tmp/silent.mp4', fakeRun([{ code: 0, out: '', err: 'deprecated pixel format' }])),
    /no audio track/,
  );
});

test('the argv parser accepts both flag forms and refuses what it does not know', () => {
  // A transcript is a BILLED artifact, so re-buying one has to be asked for by name rather than being
  // what a re-run does by default.
  assert.deepEqual(
    parseArgs(['--provider', 'veed', 'clip.mp4', '--force']),
    { provider: 'veed', videos: ['clip.mp4'], force: true },
  );
  assert.deepEqual(
    parseArgs(['--provider', 'veed', 'clip.mp4']),
    { provider: 'veed', videos: ['clip.mp4'] },
    'without --force the flag is absent, not false — the caller decides the default',
  );
  assert.deepEqual(parseArgs(['clip.mp4', '--model', 'medium']), { provider: 'whisperx', videos: ['clip.mp4'], model: 'medium' });
  assert.deepEqual(parseArgs(['clip.mp4', '--model=medium']), { provider: 'whisperx', videos: ['clip.mp4'], model: 'medium' });
  assert.deepEqual(parseArgs(['--language=de', 'clip.mp4']), { provider: 'whisperx', videos: ['clip.mp4'], language: 'de' });
  assert.deepEqual(
    parseArgs(['--model', 'medium', '--language', 'de', 'clip.mp4']),
    { provider: 'whisperx', videos: ['clip.mp4'], model: 'medium', language: 'de' },
  );

  // An unknown flag stops the run: a misspelled --language would leave English-only weights on
  // non-English audio, which transcribes as confident nonsense. The messages are the SHARED parser's, so
  // a revert to a hand-rolled reader (which said "unknown flag"/"needs a value") turns these red.
  assert.throws(() => parseArgs(['clip.mp4', '--lang', 'de']), /Unknown option '--lang'/);
  assert.throws(() => parseArgs(['clip.mp4', '--model']), /--model <value>' argument missing/);
  // an EMPTY value (`--model=`) is a mistake, not a selection: reject it up front rather than let a blank
  // tier/language/provider flow downstream. --record= must fail as "needs a value", before the provider check.
  assert.throws(() => parseArgs(['clip.mp4', '--model=']), /--model needs a value/);
  assert.throws(() => parseArgs(['clip.mp4', '--language=']), /--language needs a value/);
  assert.throws(() => parseArgs(['clip.mp4', '--record=']), /--record needs a value/);
  // a flag's value must never be mistaken for the video path
  assert.throws(() => parseArgs(['--model', 'medium']), /no video/);
  assert.throws(() => parseArgs([]), /no video/);
});

// The prep command takes `<video.mp4> [...]`, so the stage that feeds it must too, or a batch has to be
// transcribed one command at a time while prep handles the whole list.
test('several videos in one call, in the order given, with the flags shared', () => {
  assert.deepEqual(parseArgs(['a.mp4', 'b.mp4', 'c.mp4']), { provider: 'whisperx', videos: ['a.mp4', 'b.mp4', 'c.mp4'] });
  assert.deepEqual(
    parseArgs(['a.mp4', '--model', 'medium', 'b.mp4', '--language=de']),
    { provider: 'whisperx', videos: ['a.mp4', 'b.mp4'], model: 'medium', language: 'de' },
  );
  // the same file twice is the caller's business, not something to silently collapse
  assert.deepEqual(parseArgs(['a.mp4', 'a.mp4']), { provider: 'whisperx', videos: ['a.mp4', 'a.mp4'] });
});

// The recorded choice is a step in the documented flow, so writing it has to be one command rather
// than the agent hand-authoring JSON.
test('--record writes the provider choice and needs no video', () => {
  assert.deepEqual(
    parseArgs(['--record', 'whisperx', '--model', 'medium']),
    { provider: 'whisperx', videos: [], record: 'whisperx', model: 'medium' },
  );
  assert.deepEqual(parseArgs(['--record=veed']), { provider: 'whisperx', videos: [], record: 'veed' });
  assert.deepEqual(parseArgs(['--record', 'custom']), { provider: 'whisperx', videos: [], record: 'custom' });

  assert.throws(() => parseArgs(['--record', 'deepgram']), /unknown provider "deepgram".*veed, whisperx, custom/s);
  assert.throws(() => parseArgs(['--record']), /--record <value>' argument missing/);
  // a transcription run still requires the video
  assert.throws(() => parseArgs([]), /no video/);
  assert.deepEqual(parseArgs(['clip.mp4']), { provider: 'whisperx', videos: ['clip.mp4'] });
});

// validateTranscript is the belt for the chunk-window defect: a word outside its chunk makes
// synth-word-timings discard the whole beat's real times.
test('validation rejects a word that falls outside its chunk window', () => {
  assert.throws(() => validateTranscript({ text: 'hey there', chunks: [
    { text: 'hey there', timestamp: [0, 1.5], words: [
      { text: 'hey', timestamp: [0.05, 0.6] },
      { text: 'there', timestamp: [1.4, 2] },
    ] },
  ] }), /outside its chunk/);
});

test('ffprobe is asked only about audio streams', async () => {
  const run = fakeRun([{ out: '0' }]);
  await assertHasAudio('/tmp/clip.mp4', run);
  const [, args] = run.calls[0];
  assert.ok(args.includes('-select_streams') && args.includes('a'));
  assert.equal(args[args.length - 1], '/tmp/clip.mp4');
});

test('validation rejects transcripts that mapped but are unusable', () => {
  const ok = { text: 'a b', chunks: [
    { text: 'a', timestamp: [0, 1] as [number, number], words: [{ text: 'a', timestamp: [0, 1] as [number, number] }] },
    { text: 'b', timestamp: [1, 2] as [number, number], words: [{ text: 'b', timestamp: [1, 2] as [number, number] }] },
  ] };
  validateTranscript(ok);

  assert.throws(() => validateTranscript({ text: '', chunks: [] }), /no chunks/);
  assert.throws(() => validateTranscript({ text: 'x', chunks: [
    { text: 'x', timestamp: [0, Number.NaN], words: [] },
  ] }), /non-finite/);
  assert.throws(() => validateTranscript({ text: 'x', chunks: [
    { text: 'x', timestamp: [-1, 1], words: [] },
  ] }), /negative/);
  assert.throws(() => validateTranscript({ text: 'x', chunks: [
    { text: 'x', timestamp: [2, 1], words: [] },
  ] }), /ends before it starts/);
  assert.throws(() => validateTranscript({ text: 'x y', chunks: [
    { text: 'x', timestamp: [5, 6], words: [] },
    { text: 'y', timestamp: [1, 2], words: [] },
  ] }), /must be in order/);
});

test('a word timestamp is validated too, not just the chunk window', () => {
  assert.throws(() => validateTranscript({ text: 'x', chunks: [
    { text: 'x', timestamp: [0, 1], words: [{ text: 'x', timestamp: [0, Number.POSITIVE_INFINITY] }] },
  ] }), /non-finite/);
});

test('the run key matches how every entry point derives it', () => {
  assert.equal(runKeyOf('/videos/My Clip.mp4'), 'My_Clip');
  assert.equal(runKeyOf('clip.final.mov'), 'clip.final');
});

test('preferences round-trip', async () => {
  const path = join(await tempDir(), 'prefs.json');
  await writePrefs({ provider: 'whisperx', model: 'medium' }, path);
  assert.deepEqual((await readPrefs(path)).prefs, { provider: 'whisperx', model: 'medium' });

  await writePrefs({ provider: 'veed' }, path);
  assert.deepEqual((await readPrefs(path)).prefs, { provider: 'veed', model: undefined });
});

// Anything unreadable is a COLD START with a stated reason, never a crash: the agent then asks.
test('absent, corrupt and invalid preference files all read as cold start', async () => {
  const dir = await tempDir();

  const absent = await readPrefs(join(dir, 'nope.json'));
  assert.equal(absent.prefs, undefined);
  assert.match(absent.reason as string, /no provider recorded/);

  const corrupt = join(dir, 'corrupt.json');
  await writeFile(corrupt, '{ not json');
  assert.match((await readPrefs(corrupt)).reason as string, /not valid JSON/);

  const unknown = join(dir, 'unknown.json');
  await writeFile(unknown, JSON.stringify({ transcription: { provider: 'deepgram' } }));
  assert.match((await readPrefs(unknown)).reason as string, /no usable provider.*veed, whisperx, custom/);

  const empty = join(dir, 'empty.json');
  await writeFile(empty, JSON.stringify({ transcription: {} }));
  assert.equal((await readPrefs(empty)).prefs, undefined);

  const wrongShape = join(dir, 'shape.json');
  await writeFile(wrongShape, JSON.stringify(['veed']));
  assert.match((await readPrefs(wrongShape)).reason as string, /no usable provider/);
});

// The recorded tier has to actually reach the runner, or choosing "medium" once means nothing.
test('the recorded tier is what runs when no --model is given', async () => {
  const path = join(await tempDir(), 'prefs.json');
  await writePrefs({ provider: 'whisperx', model: 'medium' }, path);
  assert.equal(await recordedModel(path), 'medium');

  await writePrefs({ provider: 'whisperx' }, path);
  assert.equal(await recordedModel(path), undefined);
  assert.equal(await recordedModel(join(await tempDir(), 'absent.json')), undefined);
});

// The skill's TRANSCRIPTION.md triage tells agents to look for this exact success line; its side
// of the pin lives in the Open Edit repository (tests/skill-transcribe-triage.test.ts). Change the
// format and this fails, instead of the guidance quietly becoming wrong.
test('the success and cached lines SKILL.md quotes are still emitted', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/commands/transcribe.ts', import.meta.url), 'utf8');
  assert.match(source, /console\.log\(`\[transcribe\] whisperx: \$\{words\} words -> \$\{path\}`\)/);
  assert.match(source, /console\.log\(`\[transcribe\] cached: \$\{cachedNote\(path\)\}`\)/);
  const cache = await readFile(new URL('../src/prep/transcript-cache.ts', import.meta.url), 'utf8');
  assert.match(cache, /already exists \(--force to transcribe it again\)/);
});

test('a blank model is treated as unset rather than passed to whisperx', async () => {
  const path = join(await tempDir(), 'blank.json');
  await writeFile(path, JSON.stringify({ transcription: { provider: 'whisperx', model: '   ' } }));
  assert.deepEqual((await readPrefs(path)).prefs, { provider: 'whisperx', model: undefined });
});

// --- the transcript cache -----------------------------------------------------
// A transcript is a BILLED artifact on the hosted path and a slow one locally, and BOTH paths guard it
// independently — pinning one does not protect the other. These pin the local one, which is the half a
// test can reach without a VEED harness.

const sample: Transcript = {
  text: 'one two', chunks: [{ text: 'one two', timestamp: [0, 1], words: [
    { text: 'one', timestamp: [0, 0.5] }, { text: 'two', timestamp: [0.5, 1] },
  ] }],
};

const seedTranscript = async (root: string, key: string) => {
  // The video has to exist: transcribeLocally checks the file before it checks the cache.
  await writeFile(join(root, `${key}.mp4`), '');
  await mkdir(join(root, 'runs', key), { recursive: true });
  await writeFile(join(root, 'runs', key, 'transcript.json'), JSON.stringify(sample));
};

test('a transcript already on disk is reused, and whisperx is never spawned', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await seedTranscript(root, 'clip');
    const run = fakeRun([{ out: '0\n' }]);   // assertHasAudio only
    const result = await transcribeLocally(join(root, 'clip.mp4'), { run });
    assert.equal(result.cached, true);
    assert.equal(result.words, 2, 'the word count comes from the file, not from a placeholder');
    assert.equal(run.calls.length, 1, 'nothing beyond the audio check may run for a cached transcript');
  });
});

test('a cached result carries NO interpolated/reordered counts — nobody measured them on this run', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await seedTranscript(root, 'clip');
    const result = await transcribeLocally(join(root, 'clip.mp4'), { run: fakeRun([{ out: '0\n' }]) });
    // Zeros here would have silently stopped the missing-timing warning from ever firing again, once
    // caching became the common path.
    assert.equal('interpolated' in result, false);
    assert.equal('reordered' in result, false);
  });
});

test('--force goes past the cache and runs the transcription', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await seedTranscript(root, 'clip');
    const run = fakeRun([{ out: '0\n' }, { out: '' }, { out: '' }]);
    // The fake never writes the audio ffmpeg would extract, so the run fails AFTER proving it went past
    // the cache: the cached path stops at the audio check, one call.
    await assert.rejects(() => transcribeLocally(join(root, 'clip.mp4'), { run, force: true }));
    assert.ok(run.calls.length >= 2, `expected the audio check and then ffmpeg to run, saw ${run.calls.length} call(s)`);
  });
});

test('a corrupt cached transcript names its file instead of failing on a bare parse error', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await seedTranscript(root, 'clip');
    await writeFile(join(root, 'runs', 'clip', 'transcript.json'), '{"text": "cut off');
    await assert.rejects(() => transcribeLocally(join(root, 'clip.mp4'), { run: fakeRun([{ out: '0\n' }]) }), /runs[\\/]clip[\\/]transcript\.json: /);
  });
});

test('two videos that would share a run key are refused before anything runs', () => {
  assert.deepEqual(collidingRunKey(['a/clip.mp4', 'b/clip.mp4']), { key: 'clip', videos: ['a/clip.mp4', 'b/clip.mp4'] });
  assert.equal(collidingRunKey(['a.mp4', 'b.mp4']), null);
});

// --- the hosted batch ------------------------------------------------------------
// Four at a time, every failure caught per video, and the batch finishes before it reports: pinned
// through the injected transcription, since the real one uploads and bills.

const captured = async (fn: () => Promise<number>) => {
  const { result, out, err } = await captureConsoleAsync(fn);
  return { code: result, out, err };
};

test('runBatch keeps at most `concurrency` in flight and returns every result', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await runBatch([1, 2, 3, 4, 5, 6], async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 2;
  }, 2);
  assert.deepEqual([...results].sort((a, b) => a - b), [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test('one failed video does not stop the others, is named, and fails the batch', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, `${name}.mp4`), '');
    const asked: string[] = [];
    const { code, out, err } = await captured(() => transcribeVeed([join(root, 'a.mp4'), join(root, 'b.mp4'), join(root, 'c.mp4')], { deps: {
      resolveToken: async () => 'token',
      transcribeOne: async (video) => {
        asked.push(video);
        if (video.endsWith('b.mp4')) throw new Error('quota exhausted');
        return sample;
      },
    } }));
    assert.equal(code, 1);
    assert.deepEqual(asked.map((v) => v.slice(-5)).sort(), ['a.mp4', 'b.mp4', 'c.mp4']);
    assert.equal(existsSync(join(root, 'runs', 'a', 'transcript.json')), true);
    assert.equal(existsSync(join(root, 'runs', 'c', 'transcript.json')), true);
    assert.equal(existsSync(join(root, 'runs', 'b', 'transcript.json')), false);
    assert.match(out, /FAILED: quota exhausted/);
    assert.match(err, /transcribe: 1 of 3 failed: .*b\.mp4/);
  });
});

test('a transcript already on disk is not bought again, and --force buys it', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await seedTranscript(root, 'a');
    let bought = 0;
    const deps = { resolveToken: async () => 'token', transcribeOne: async () => { bought += 1; return sample; } };
    const cached = await captured(() => transcribeVeed([join(root, 'a.mp4')], { deps }));
    assert.equal(cached.code, 0);
    assert.equal(bought, 0);
    assert.match(cached.out, /cached: .*already exists \(--force to transcribe it again\)/);
    const forced = await captured(() => transcribeVeed([join(root, 'a.mp4')], { force: true, deps }));
    assert.equal(forced.code, 0);
    assert.equal(bought, 1);
  });
});

test('no login means no upload: the batch stops before any video is touched', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await writeFile(join(root, 'a.mp4'), '');
    let bought = 0;
    const { code } = await captured(() => transcribeVeed([join(root, 'a.mp4')], { deps: {
      resolveToken: async () => null,
      transcribeOne: async () => { bought += 1; return sample; },
    } }));
    assert.equal(code, 1);
    assert.equal(bought, 0);
  });
});

test('a typo in the last path is found before the first upload spends anything', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await writeFile(join(root, 'a.mp4'), '');
    let bought = 0;
    const { code, err } = await captured(() => transcribeVeed([join(root, 'a.mp4'), join(root, 'nope.mp4')], { deps: {
      resolveToken: async () => 'token',
      transcribeOne: async () => { bought += 1; return sample; },
    } }));
    assert.equal(code, 1);
    assert.equal(bought, 0);
    assert.match(err, /video not found: .*nope\.mp4/);
  });
});

test('a failed fetch says "run it again" only while nothing can have been billed', async () => {
  const root = await tempDir();
  await withRoot(root, async () => {
    await writeFile(join(root, 'a.mp4'), '');
    const failing = (message: string) => captured(() => transcribeVeed([join(root, 'a.mp4')], { force: true, deps: {
      resolveToken: async () => 'token', transcribeOne: async () => { throw new Error(message); },
    } }));
    // a sandbox kills the very first request: nothing uploaded, nothing requested, nothing billed
    const early = await failing('fetch failed');
    assert.match(early.out, /nothing was billed/);
    assert.match(early.out, /OUTSIDE the sandbox/);
    // the same words once a job was requested may hide one that is running and charged
    const late = await failing(`${REQUESTED}fetch failed`);
    assert.match(late.out, /may be running and billed/);
    assert.doesNotMatch(late.out, /run it again OUTSIDE/);
    const other = await failing('quota exhausted');
    assert.doesNotMatch(other.out, /billed/);
  });
});

test('uploadProxy: a proxy that encodes is returned; one that fails says why and leaves no temp dir behind', () => {
  assert.equal(PROXY_OVER_BYTES, 25 * 1024 * 1024);
  let outPath = '';
  const ok = uploadProxy('/x/clip.mp4', ((_bin: string, args: string[]) => {
    outPath = args[args.length - 1]; writeNow(outPath, 'proxy');
    return { status: 0, stderr: '' };
  }) as unknown as typeof spawnSync);
  assert.equal(ok.path, outPath);
  assert.ok(existsNow(outPath));

  let failedOut = '';
  const bad = uploadProxy('/x/silent.mp4', ((_bin: string, args: string[]) => {
    failedOut = args[args.length - 1];
    return { status: 1, stderr: "Stream map '0:a:0' matches no streams.\n" };
  }) as unknown as typeof spawnSync);
  assert.equal(bad.path, null);
  assert.match((bad as { why: string }).why, /matches no streams/, 'a source with no audio track falls back to the original, and says so');
  assert.equal(existsNow(join(failedOut, '..')), false, 'the temp dir does not outlive a failed encode');
});

