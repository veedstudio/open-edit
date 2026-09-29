// Tests for the transcription flow: provider argv, the validation gates, and preference handling.
// The spawn is injected, so nothing here launches whisperx or ffmpeg.
// (The skill's warning-triage coupling test stays in the Open Edit repository, beside TRANSCRIPTION.md.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync as existsNow, writeFileSync as writeNow } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertHasAudio,
  assertWhisperxUsable,
  parseArgs,
  runBatch,
  transcribeLocally,
  transcribeVeed,
  readPrefs,
  recordedModel,
  resolveProvider,
  runKeyOf,
  validateTranscript,
  whisperxArgs,
  whisperxModel,
  writePrefs,
  type PrefsFailure,
  type Run,
  uploadProxy,
  PROXY_OVER_BYTES,
} from '../src/commands/transcribe.ts';
import { collidingRunKey } from '../src/transcript/transcript-cache.ts';
import { REQUESTED } from '../src/veed/orchestrate.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
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
  assert.deepEqual(parseArgs(['clip.mp4', '--model', 'medium']), { videos: ['clip.mp4'], model: 'medium' });
  assert.deepEqual(parseArgs(['clip.mp4', '--model=medium']), { videos: ['clip.mp4'], model: 'medium' });
  assert.deepEqual(parseArgs(['--language=de', 'clip.mp4']), { videos: ['clip.mp4'], language: 'de' });
  assert.deepEqual(
    parseArgs(['--model', 'medium', '--language', 'de', 'clip.mp4']),
    { videos: ['clip.mp4'], model: 'medium', language: 'de' },
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

// A batch is one command, not one per file.
test('several videos in one call, in the order given, with the flags shared', () => {
  assert.deepEqual(parseArgs(['a.mp4', 'b.mp4', 'c.mp4']), { videos: ['a.mp4', 'b.mp4', 'c.mp4'] });
  assert.deepEqual(
    parseArgs(['a.mp4', '--model', 'medium', 'b.mp4', '--language=de']),
    { videos: ['a.mp4', 'b.mp4'], model: 'medium', language: 'de' },
  );
  // the same file twice is the caller's business, not something to silently collapse
  assert.deepEqual(parseArgs(['a.mp4', 'a.mp4']), { videos: ['a.mp4', 'a.mp4'] });
});

// The recorded choice is a step in the documented flow, so writing it has to be one command rather
// than the agent hand-authoring JSON.
test('--record writes the provider choice and needs no video', () => {
  assert.deepEqual(
    parseArgs(['--record', 'whisperx', '--model', 'medium']),
    { videos: [], record: 'whisperx', model: 'medium' },
  );
  assert.deepEqual(parseArgs(['--record=veed']), { videos: [], record: 'veed' });
  assert.deepEqual(parseArgs(['--record', 'custom']), { videos: [], record: 'custom' });

  assert.throws(() => parseArgs(['--record', 'deepgram']), /unknown provider "deepgram".*veed, whisperx, custom/s);
  // Nothing records a workspace, so accepting one here would drop it without a word.
  for (const argv of [['--record', 'veed', '--workspace', 'ws1'], ['--record', 'veed', '--provider', 'veed', '--workspace', 'ws1']]) {
    assert.throws(() => parseArgs(argv), /--workspace is chosen per spend and never recorded; pass it on the transcribe run/);
  }
  assert.throws(() => parseArgs(['--record']), /--record <value>' argument missing/);
  // a transcription run still requires the video
  assert.throws(() => parseArgs([]), /no video/);
  assert.deepEqual(parseArgs(['clip.mp4']), { videos: ['clip.mp4'] });
});

// validateTranscript is the belt for the chunk-window defect: a cue timed from a chunk that does not
// contain its words starts after, or ends before, its own speech.
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

// Only a missing file, or one that records no provider, is a choice never made. Anything else may hide a
// choice the user already made, so it is told apart rather than read as a cold start.
test('each unusable preference file names why, and only an absent choice reads as absent', async () => {
  const dir = await tempDir();
  const read = async (path: string, body?: unknown) => {
    if (body !== undefined) await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body));
    const recorded = await readPrefs(path);
    assert.equal(recorded.prefs, undefined);
    const { state, reason } = recorded as PrefsFailure;
    return `${state}: ${reason}`;
  };

  assert.match(await read(join(dir, 'nope.json')), /^absent: .*nope\.json does not exist$/);
  assert.match(await read(join(dir, 'empty.json'), { transcription: {} }), /^absent: .*records no provider$/);
  assert.match(await read(join(dir, 'bare.json'), {}), /^absent: .*records no provider$/);

  assert.match(await read(dir), /^unreadable: .*could not be read \(EISDIR\)$/);

  assert.match(await read(join(dir, 'corrupt.json'), '{ not json'), /^damaged: .*is not valid JSON$/);
  assert.match(
    await read(join(dir, 'unknown.json'), { transcription: { provider: 'deepgram' } }),
    /^damaged: .*records the provider "deepgram", not one of veed, whisperx, custom$/,
  );
  assert.match(await read(join(dir, 'shape.json'), ['veed']), /^damaged: .*is not a \{ "transcription"/);
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

// --- which provider runs ----------------------------------------------------------
// The skill runs a bare `transcribe <video>`, so the bare form must run the user's recorded choice and
// never make one for them.

const PREFS = '/ws/.open-edit-prefs.json';

test('with no --provider the recorded provider runs, and the run says so', () => {
  const veed = resolveProvider({}, { prefs: { provider: 'veed' } }, PREFS);
  assert.equal(veed.provider, 'veed');
  assert.equal(veed.note, `[transcribe] veed, the provider recorded in ${PREFS}`);

  const wx = resolveProvider({}, { prefs: { provider: 'whisperx', model: 'medium' } }, PREFS);
  assert.deepEqual(wx, { provider: 'whisperx', model: 'medium', note: `[transcribe] whisperx (medium), the provider recorded in ${PREFS}` });
  assert.equal(resolveProvider({ model: 'small.en' }, { prefs: { provider: 'whisperx', model: 'medium' } }, PREFS).model, 'small.en', '--model overrides the recorded tier');
  assert.equal(resolveProvider({ workspace: 'ws1' }, { prefs: { provider: 'veed' } }, PREFS).provider, 'veed', 'a recorded veed takes --workspace');
});

test('--provider overrides the recorded one; a named whisperx keeps the recorded tier', () => {
  assert.deepEqual(resolveProvider({ provider: 'veed' }, { prefs: { provider: 'whisperx', model: 'medium' } }, PREFS), { provider: 'veed' });
  assert.deepEqual(resolveProvider({ provider: 'whisperx' }, { prefs: { provider: 'whisperx', model: 'medium' } }, PREFS), { provider: 'whisperx', model: 'medium' });
  assert.deepEqual(resolveProvider({ provider: 'whisperx' }, { prefs: { provider: 'veed' } }, PREFS), { provider: 'whisperx', model: undefined });
});

// There is no default provider: a transcript from one the user never chose is cached and outlives the
// mistake, so a bare run with no choice recorded stops and says why.
test('with no choice recorded a bare run refuses, naming the reason and the ways forward', () => {
  for (const reason of [`${PREFS} does not exist`, `${PREFS} records no provider`]) {
    assert.throws(() => resolveProvider({}, { state: 'absent', reason }, PREFS), (error: Error) => {
      assert.ok(error.message.startsWith(`no transcription provider is recorded: ${reason}.`), error.message);
      assert.match(error.message, /There is no default, the user chooses: ask them \(the open-edit skill's TRANSCRIPTION\.md/);
      assert.match(error.message, /transcribe --record <veed\|whisperx\|custom>.*--provider veed\|whisperx.*whisper <json> <media>/s);
      return true;
    });
  }
  assert.throws(() => resolveProvider({ workspace: 'ws1' }, { state: 'absent', reason: `${PREFS} does not exist` }, PREFS), /no transcription provider is recorded/);
  // Naming the provider IS the user's choice for this run, so it still runs with nothing recorded.
  assert.deepEqual(resolveProvider({ provider: 'whisperx' }, { state: 'absent', reason: `${PREFS} does not exist` }, PREFS), { provider: 'whisperx', model: undefined });
  assert.deepEqual(resolveProvider({ provider: 'veed' }, { state: 'damaged', reason: `${PREFS} is not valid JSON` }, PREFS), { provider: 'veed' });
});

// A choice may sit behind an unreadable or damaged file, so neither sends the agent back to the question
// the user already answered; each names the file and what to fix.
test('an unreadable or damaged prefs file is refused as such, never as nothing recorded', () => {
  const refusal = (recorded: PrefsFailure): string => {
    try {
      resolveProvider({}, recorded, PREFS);
    } catch (error) {
      return (error as Error).message;
    }
    assert.fail('a bare run with no usable prefs did not refuse');
  };
  // The agent cannot see the recorded provider through an unreadable file, so --provider is only ever the user's
  // answer, never a pick of its own.
  const unreadable = refusal({ state: 'unreadable', reason: `${PREFS} could not be read (EACCES)` });
  assert.ok(unreadable.startsWith(`${PREFS} could not be read (EACCES), so the choice recorded there cannot be read.`), unreadable);
  assert.match(unreadable, /Either fix what is at that path \(its permissions, or a directory standing in its place\), or ask the user to name their provider again and pass it for this run with --provider veed\|whisperx\. Never pick one for them\./);
  assert.doesNotMatch(unreadable, /Do not ask the user again/);

  const damaged = refusal({ state: 'damaged', reason: `${PREFS} is not valid JSON` });
  assert.ok(damaged.startsWith(`${PREFS} is not valid JSON, so`), damaged);
  assert.match(damaged, /Do not ask the user again: read the file for the provider it names and record that one with npx @veedstudio\/openedit-cli transcribe --record <veed\|whisperx\|custom>/);
  // --record rewrites the file whole, so a re-record without --model loses the WhisperX tier the user chose.
  assert.match(damaged, /--record <veed\|whisperx\|custom> --model <tier>, keeping the tier it names; drop --model only if it names none/);

  for (const message of [unreadable, damaged]) {
    assert.doesNotMatch(message, /no transcription provider is recorded|ask them/);
    assert.match(message, /--provider veed\|whisperx/);
  }
});

test('a recorded custom provider is refused with the command that maps it, never run as WhisperX', () => {
  assert.throws(
    () => resolveProvider({}, { prefs: { provider: 'custom' } }, PREFS),
    /recorded in \/ws\/\.open-edit-prefs\.json is custom.*whisper <json> <media>/s,
  );
  assert.equal(resolveProvider({ provider: 'whisperx' }, { prefs: { provider: 'custom' } }, PREFS).provider, 'whisperx');
});

test('the recorded provider refuses the other provider\'s flags, as --provider does', () => {
  assert.throws(() => resolveProvider({ model: 'medium' }, { prefs: { provider: 'veed' } }, PREFS), /WhisperX flags; the recorded provider is veed/);
  assert.throws(() => resolveProvider({ language: 'de' }, { prefs: { provider: 'veed' } }, PREFS), /WhisperX flags/);
  assert.throws(() => resolveProvider({ workspace: 'ws1' }, { prefs: { provider: 'whisperx' } }, PREFS), /--workspace applies only/);
});

// Through the real entry point, so the prefs file is actually read from the workspace root. A missing
// video stops each run before ffmpeg, whisperx or the network is reached.
test('the command reads the recorded provider from the workspace it runs in', async () => {
  const { execFile } = await import('node:child_process');
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const root = await tempDir();
  const run = () => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, 'transcribe', join(root, 'absent.mp4')],
      { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: root } },
      (error, out, err) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err }));
  });
  const prefs = join(root, '.open-edit-prefs.json');

  // The refusal comes before the video is even looked at, so nothing is written under runs/.
  const cold = await run();
  assert.equal(cold.code, 1);
  assert.match(cold.err, /no transcription provider is recorded: .*\.open-edit-prefs\.json does not exist/);
  assert.doesNotMatch(cold.err, /video not found/);
  assert.doesNotMatch(cold.out, /whisperx/);
  assert.equal(existsSync(join(root, 'runs')), false);

  await mkdir(prefs);
  assert.match((await run()).err, /\.open-edit-prefs\.json could not be read \(EISDIR\), so the choice recorded there cannot be read\. .*Never pick one for them/);
  await rm(prefs, { recursive: true });
  await writeFile(prefs, '{ not json');
  assert.match((await run()).err, /\.open-edit-prefs\.json is not valid JSON, so .*Do not ask the user again/);
  await writeFile(prefs, JSON.stringify({ transcription: { provider: 'VEED' } }));
  assert.match((await run()).err, /records the provider "VEED", not one of veed, whisperx, custom, so /);

  await writePrefs({ provider: 'whisperx', model: 'medium' }, prefs);
  const recorded = await run();
  assert.ok(recorded.out.includes(`whisperx (medium), the provider recorded in ${prefs}`), recorded.out);

  await writePrefs({ provider: 'custom' }, prefs);
  const custom = await run();
  assert.equal(custom.code, 1);
  assert.match(custom.err, /is custom, which this command does not run/);
  assert.doesNotMatch(custom.out, /whisperx/);
});

// The skill's TRANSCRIPTION.md triage tells agents to look for this exact success line; its side
// of the pin lives in the Open Edit repository (tests/skill-transcribe-triage.test.ts). Change the
// format and this fails, instead of the guidance quietly becoming wrong.
test('the success and cached lines SKILL.md quotes are still emitted', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/commands/transcribe.ts', import.meta.url), 'utf8');
  assert.match(source, /console\.log\(`\[transcribe\] whisperx: \$\{words\} words -> \$\{path\}`\)/);
  assert.match(source, /console\.log\(`\[transcribe\] cached: \$\{cachedNote\(path\)\}`\)/);
  const cache = await readFile(new URL('../src/transcript/transcript-cache.ts', import.meta.url), 'utf8');
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

