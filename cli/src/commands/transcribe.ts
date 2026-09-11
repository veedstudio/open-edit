// Transcription providers, and the one flow they all end in: runs/<key>/transcript.json.
//
// WHISPERX (the default): resolve video -> derive key -> extract 16k mono WAV -> whisperx(audio)
//   -> WhisperJson -> mapWhisperTranscript -> validate. Local and free.
// VEED (--provider veed): upload to VEED's edge, transcribe hosted, map the caption items — spends
//   the logged-in user's VEED transcription credits, billed to ONE workspace (--workspace names it).
// A "custom" provider is deliberately not code: the agent obtains a Whisper-family JSON however the
// user's service works and feeds it to the whisper command, so no credential ever passes through
// Open Edit.
//
//   openedit transcribe <video.mp4> [...] [--model small.en|medium|...] [--language en] [--force]
//   openedit transcribe --provider veed <video.mp4> [...] [--workspace <id>] [--force]
//
// WhisperX device and compute default to cpu/int8, which runs everywhere (CTranslate2 has no GPU path
// on Apple Silicon); a CUDA-capable box overrides via OPEN_EDIT_WHISPERX_DEVICE / OPEN_EDIT_WHISPERX_COMPUTE.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { FFMPEG, FFPROBE, WHISPERX_BIN, WHISPERX_COMPUTE, WHISPERX_DEVICE, WHISPERX_MODEL, prefsPath, runsDir } from '../config.ts';
// runKeyOf is re-exported rather than redefined, so importers of this module keep working while
// there stays exactly one copy of the rule in this package.
import { resolveVideoArg, runKeyOf } from '../resolve-video.ts';
export { runKeyOf };
import { mapWhisperTranscript, type Transcript, type WhisperJson } from '../prep/whisper-mapper.ts';
import { cachedNote, cachedTranscriptPath, collidingRunKey, transcriptPathFor, wordCount } from '../prep/transcript-cache.ts';
import { readJsonFile } from '../json-file.ts';
import { parseFlags } from '../args.ts';
import type { VeedHttp } from '../veed/api.ts';
import { refreshingHttp } from '../veed/http.ts';
import { transcribeWithVeed } from '../veed/orchestrate.ts';
import { NO_LOGIN_HELP, resolveVeedToken } from '../veed/resolve-token.ts';

export const PREFS_PATH = prefsPath();
export const PROVIDERS = ['veed', 'whisperx', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

// small.en has no multilingual weights; anything but English must fall back to `small`.
const ENGLISH_ONLY = /\.en$/;

export interface Prefs {
  provider: Provider;
  model?: string;
}

// stdout and stderr stay SEPARATE: a probe's answer must never be read out of its error output.
export type Run = (
  cmd: string,
  args: string[],
  opts?: { inherit?: boolean },
) => Promise<{ code: number; out: string; err: string }>;

export const realRun: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => resolve({ code: 127, out, err: `${err}${(e as Error).message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });

// A missing, unreadable, or invalid file is a COLD START, never a crash: the caller then asks the
// user which provider to use. The reason is returned so it can be said out loud rather than guessed at.
export async function readPrefs(path = PREFS_PATH): Promise<{ prefs?: Prefs; reason?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { reason: 'no provider recorded yet' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: `${path} is not valid JSON` };
  }
  const t = (parsed as { transcription?: { provider?: unknown; model?: unknown } })?.transcription;
  const provider = t?.provider;
  if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
    return { reason: `${path} records no usable provider (expected one of ${PROVIDERS.join(', ')})` };
  }
  const model = typeof t?.model === 'string' && t.model.trim() !== '' ? t.model : undefined;
  return { prefs: { provider: provider as Provider, model } };
}

export async function writePrefs(prefs: Prefs, path = PREFS_PATH): Promise<void> {
  await writeFile(path, `${JSON.stringify({ transcription: prefs }, null, 2)}\n`);
}

/** The recorded quality tier, so a chosen `medium` is honoured without repeating --model every run. */
export async function recordedModel(path = PREFS_PATH): Promise<string | undefined> {
  return (await readPrefs(path)).prefs?.model;
}

// Garbage that happens to map without throwing still must not reach the pipeline.
export function validateTranscript(t: Transcript): void {
  if (t.chunks.length === 0) throw new Error('transcript has no chunks');
  let previousStart = -Infinity;
  for (const [i, c] of t.chunks.entries()) {
    for (const [from, to] of [c.timestamp, ...c.words.map((w) => w.timestamp)]) {
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`chunk ${i} has a non-finite timestamp`);
      if (from < 0 || to < 0) throw new Error(`chunk ${i} has a negative timestamp`);
      if (to < from) throw new Error(`chunk ${i} ends before it starts`);
    }
    // A word whose midpoint escapes its chunk makes synth-word-timings discard every real time for
    // that beat and even-split it instead — a silent timing regression, so it is an error here.
    for (const w of c.words) {
      const mid = (w.timestamp[0] + w.timestamp[1]) / 2;
      if (mid < c.timestamp[0] || mid > c.timestamp[1]) {
        throw new Error(`chunk ${i}: word "${w.text}" falls outside its chunk window — its timings would be discarded`);
      }
    }
    if (c.timestamp[0] < previousStart) throw new Error(`chunk ${i} starts before chunk ${i - 1} — chunks must be in order`);
    previousStart = c.timestamp[0];
  }
}

export async function assertHasAudio(video: string, run: Run = realRun): Promise<void> {
  const { code, out, err } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', video,
  ]);
  // A probe that failed says nothing about the audio, so it must not be read as "there is some".
  if (code !== 0) {
    throw new Error(`ffprobe could not inspect ${video} (exit ${code})\n${err.trim() || out.trim()}`);
  }
  if (out.trim() === '') throw new Error(`${video} has no audio track — there is nothing to transcribe`);
}

/** 16 kHz mono WAV: what every Whisper implementation wants. */
export async function extractAudio(video: string, dir: string, run: Run = realRun): Promise<string> {
  const wav = join(dir, 'audio.wav');
  const { code, out, err } = await run(FFMPEG, [
    '-nostdin', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
  ]);
  // ffmpeg reports on stderr; quoting stdout here would print nothing useful.
  if (code !== 0 || !existsSync(wav)) {
    throw new Error(`ffmpeg could not extract audio from ${video}\n${err.trim() || out.trim()}`);
  }
  return wav;
}

export function whisperxModel(model: string | undefined, language: string | undefined): string {
  const chosen = model ?? WHISPERX_MODEL;
  if (language && !/^en/i.test(language) && ENGLISH_ONLY.test(chosen)) {
    return chosen.replace(ENGLISH_ONLY, '');
  }
  return chosen;
}

export function whisperxArgs(audio: string, outDir: string, model: string, language?: string): string[] {
  return [
    audio,
    '--model', model,
    '--device', WHISPERX_DEVICE,
    '--compute_type', WHISPERX_COMPUTE,
    '--output_format', 'json',
    '--output_dir', outDir,
    ...(language ? ['--language', language] : []),
  ];
}

/** The flags we are about to pass must exist in this build's --help. Guards CLI drift. */
export async function assertWhisperxUsable(run: Run = realRun): Promise<void> {
  const help = await run(WHISPERX_BIN, ['--help']);
  const { code } = help;
  const out = `${help.out}${help.err}`; // some CLIs print usage on stderr
  if (code !== 0) {
    throw new Error(
      `${WHISPERX_BIN} is not available. Install it with npx @veedstudio/openedit-cli install-whisperx ` +
      '(or choose VEED transcription instead).',
    );
  }
  const missing = ['--model', '--device', '--compute_type', '--output_format', '--output_dir']
    .filter((flag) => !out.includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `this build of ${WHISPERX_BIN} does not accept ${missing.join(', ')} — its CLI has changed. ` +
      'Reinstall with npx @veedstudio/openedit-cli install-whisperx, or use VEED transcription.',
    );
  }
}

export async function runWhisperx(
  audio: string,
  outDir: string,
  opts: { model?: string; language?: string; run?: Run } = {},
): Promise<WhisperJson> {
  const run = opts.run ?? realRun;
  await assertWhisperxUsable(run);
  const model = whisperxModel(opts.model, opts.language);
  const { code, out, err } = await run(WHISPERX_BIN, whisperxArgs(audio, outDir, model, opts.language), { inherit: true });
  if (code !== 0) throw new Error(`whisperx failed (exit ${code})\n${err.trim() || out.trim()}`);
  const produced = join(outDir, `${basename(audio, extname(audio))}.json`);
  if (!existsSync(produced)) throw new Error(`whisperx exited 0 but wrote no JSON at ${produced}`);
  return JSON.parse(await readFile(produced, 'utf8')) as WhisperJson;
}

/**
 * A cached transcript reports no `interpolated`/`reordered` counts, because nobody measured them on
 * this run — they were reported when the file was written. Returning zeros for them would silently
 * stop the missing-timing warning from ever firing again once caching became the common path, so the
 * union makes the caller decide rather than read two numbers that are placeholders.
 */
export type LocalTranscript =
  | { cached: true; path: string; words: number }
  | { cached: false; path: string; words: number; interpolated: number; reordered: number };

export async function transcribeLocally(
  videoArg: string,
  opts: { model?: string; language?: string; run?: Run; force?: boolean } = {},
): Promise<LocalTranscript> {
  const run = opts.run ?? realRun;
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  await assertHasAudio(video, run);

  const key = runKeyOf(video);
  const outDir = join(runsDir(), key);
  await mkdir(outDir, { recursive: true });

  // Free to re-run, so this is not about money: a transcript on disk may have been RETIMED onto an
  // edited timeline, and a fresh alignment of the source silently restores the drift the retime removed.
  const existing = opts.force ? null : cachedTranscriptPath(video);
  if (existing) {
    return { cached: true, path: existing, words: wordCount(readJsonFile(existing) as Transcript) };
  }

  const work = await mkdtemp(join(tmpdir(), 'open-edit-asr-'));

  try {
    const audio = await extractAudio(video, work, run);
    const model = opts.model ?? await recordedModel();
    const raw = await runWhisperx(audio, work, { ...opts, model, run });
    const { transcript, interpolated, reordered } = mapWhisperTranscript(raw);
    validateTranscript(transcript);

    const path = join(outDir, 'transcript.json');
    await writeFile(path, JSON.stringify(transcript, null, 2));
    return { cached: false, path, words: wordCount(transcript), interpolated, reordered };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export const USAGE = 'usage: openedit transcribe <video.mp4> [...] [--model <id>] [--language <code>] [--force]\n'
  + '   or: openedit transcribe --provider veed <video.mp4> [...] [--workspace <id>] [--force]\n'
  + `   or: openedit transcribe --record <${PROVIDERS.join('|')}> [--model <id>]`;

export interface Args {
  /** In the order given, like the prep command. Empty only when recording a choice. */
  videos: string[];
  /** Which transcription runs. Defaults to whisperx — the local, free provider. */
  provider: 'veed' | 'whisperx';
  model?: string;
  language?: string;
  /** VEED only: the workspace whose transcription credits are billed. */
  workspace?: string;
  /** Write the provider choice and exit — the "record the choice" step of the flow. */
  record?: Provider;
  /** Transcribe a video that already has a transcript; the hosted provider re-bills for it. */
  force?: boolean;
}

// Both `--flag value` and `--flag=value`, via the shared strict parser — one flag grammar for every
// command, so a misspelled --language is refused the same way here as everywhere else (leaving
// English-only weights on non-English audio would transcribe it as confident nonsense).
export function parseArgs(argv: string[]): Args {
  const { values, positionals } = parseFlags({
    args: argv,
    options: {
      model: { type: 'string' },
      language: { type: 'string' },
      record: { type: 'string' },
      provider: { type: 'string' },
      workspace: { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  // parseFlags accepts `--model=` as an empty string; an empty value is a mistake, not a selection, so
  // refuse it up front rather than letting '' flow into tier/language/provider selection as a silent blank.
  for (const flag of ['model', 'language', 'record', 'provider', 'workspace'] as const) {
    if (values[flag] === '') throw new Error(`--${flag} needs a value\n${USAGE}`);
  }
  const record = values.record;
  if (record !== undefined && !(PROVIDERS as readonly string[]).includes(record)) {
    throw new Error(`unknown provider "${record}" — expected one of ${PROVIDERS.join(', ')}\n${USAGE}`);
  }
  const provider = values.provider ?? 'whisperx';
  if (provider !== 'veed' && provider !== 'whisperx') {
    // `custom` is a recorded CHOICE, not something this command can run: the user's own service
    // produces the JSON and the whisper command maps it.
    throw new Error(`--provider takes veed or whisperx (the custom provider runs via the whisper command)\n${USAGE}`);
  }
  // Flags that belong to the other provider are refused rather than ignored: a silently dropped
  // --model would transcribe with a tier nobody chose.
  if (provider === 'veed' && (values.model !== undefined || values.language !== undefined) && record === undefined) {
    throw new Error(`--model/--language are WhisperX flags; the veed provider takes neither\n${USAGE}`);
  }
  if (provider !== 'veed' && values.workspace !== undefined) {
    throw new Error(`--workspace applies only with --provider veed\n${USAGE}`);
  }
  // Recording a choice is not a transcription run, so it needs no video.
  if (record === undefined && positionals.length === 0) throw new Error(`no video given\n${USAGE}`);
  return {
    videos: positionals,
    provider,
    ...(record === undefined ? {} : { record: record as Provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.language === undefined ? {} : { language: values.language }),
    ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
    ...(values.force ? { force: true } : {}),
  };
}

async function readVideoBytes(videoPath: string): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  // Buffer IS a Uint8Array; no copy.
  const bytes = await readFile(videoPath);
  const ext = (extname(videoPath).slice(1) || 'mp4').toLowerCase();
  const mimeType = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  return { bytes, mimeType, extension: ext };
}

// A VeedHttp that re-resolves the token per REQUEST. A batch can outlive a single access token, so closing
// over one (realHttp) would 401 on a later video after earlier ones already spent credits; resolving per
// request refreshes mid-run instead.
export function connectRefreshing(resolve: () => Promise<string | null> = resolveVeedToken): VeedHttp {
  return refreshingHttp(async () => {
    const token = await resolve();
    if (!token) throw new Error('VEED login expired mid-run — re-run: npx @veedstudio/openedit-cli login');
    return token;
  });
}

/** The two calls a hosted batch makes that a test replaces: the token lookup, and one video's transcription. */
export interface VeedBatchDeps {
  resolveToken: () => Promise<string | null>;
  transcribeOne: (video: string, log: (line: string) => void) => Promise<Transcript>;
}

function liveVeedDeps(workspaceId: string | undefined): VeedBatchDeps {
  let http: VeedHttp | undefined;
  return {
    resolveToken: resolveVeedToken,
    transcribeOne: (video, log) => {
      http ??= connectRefreshing();
      return transcribeWithVeed({ http, readVideoBytes, log }, { videoPath: video, workspaceId });
    },
  };
}

/** Each video is an independent upload-and-poll that mostly waits on the service; four bounds a laptop's upload bandwidth. */
export const VEED_BATCH_CONCURRENCY = 4;

/** Run `work` over `items` with at most `concurrency` in flight; results in completion order. */
export async function runBatch<T, R>(items: T[], work: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        results.push(await work(next));
      }
    }),
  );
  return results;
}

export interface VeedBatchOptions {
  /** The workspace whose transcription credits are billed; unused when `deps` replaces the live call. */
  workspaceId?: string;
  /** Transcribe videos that already have a transcript; each one is billed again. */
  force?: boolean;
  deps?: VeedBatchDeps;
}

export async function transcribeVeed(videoArgs: string[], options: VeedBatchOptions = {}): Promise<number> {
  const force = options.force === true;
  const deps = options.deps ?? liveVeedDeps(options.workspaceId);
  const token = await deps.resolveToken();
  if (!token) {
    console.error(NO_LOGIN_HELP);
    console.error('\nthen re-run:  npx @veedstudio/openedit-cli transcribe --provider veed <video.mp4> [...]');
    return 1;
  }
  // Resolve and check every path before uploading any of them: a typo in the last argument should not
  // be discovered after the earlier videos have already spent transcription credits.
  const videos = videoArgs.map(resolveVideoArg);
  const missing = videos.filter((v) => !existsSync(v));
  if (missing.length > 0) {
    console.error(missing.map((v) => `video not found: ${v}`).join('\n'));
    return 1;
  }

  // Each video's own lines are buffered and flushed together: interleaved progress from four uploads
  // reads as one garbled stream and makes a failure impossible to attribute.
  const one = async (video: string): Promise<{ video: string; ok: boolean }> => {
    const lines: string[] = [`[veed-transcribe] ${video}`];
    try {
      const out = transcriptPathFor(video);
      await mkdir(dirname(out), { recursive: true });

      // The immutable output of an immutable input, and this one is BILLED: without the guard a re-run
      // over an already-transcribed directory pays for every file again.
      const existing = force ? null : cachedTranscriptPath(video);
      if (existing) {
        lines.push(`  cached: ${cachedNote(existing)}`);
        return { video, ok: true };
      }

      const transcript = await deps.transcribeOne(video, (m) => lines.push(`  ${m}`));
      await writeFile(out, JSON.stringify(transcript, null, 2));
      lines.push(`wrote ${out} (${transcript.chunks.length} beats)`);
      return { video, ok: true };
    } catch (error) {
      // String(error), not error.message: a thrown non-Error has no message.
      lines.push(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      return { video, ok: false };
    } finally {
      console.log(lines.join('\n'));
    }
  };

  const results = await runBatch(videos, one, VEED_BATCH_CONCURRENCY);

  // One failure must not hide behind four successes, and the transcripts that DID land stay on disk —
  // re-running the command skips them, so a retry costs only what failed.
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`transcribe: ${failed.length} of ${videos.length} failed: ${failed.map((f) => f.video).join(', ')}`);
    return 1;
  }
  return 0;
}

export async function transcribe(argv: string[]): Promise<number> {
  const { videos, provider, model, language, workspace, record, force } = parseArgs(argv);

  if (record) {
    await writePrefs({ provider: record, ...(model === undefined ? {} : { model }) });
    console.log(`[transcribe] recorded provider=${record}${model ? ` model=${model}` : ''} -> ${PREFS_PATH}`);
    return 0;
  }

  // Both batches write runs/<key>/transcript.json, so both can collide; the hosted one only fails more
  // expensively.
  const collision = collidingRunKey(videos);
  if (collision) {
    console.error(
      `these videos share the run key "${collision.key}", so they would share one transcript:\n  ${collision.videos.join('\n  ')}\n` +
        'Rename one, or transcribe them in separate runs.',
    );
    return 2;
  }

  if (provider === 'veed') return transcribeVeed(videos, { workspaceId: workspace, force });

  // Sequential, and a failure stops the batch: the videos share one local install, so a missing binary
  // fails all of them, and the transcripts already written stay valid.
  for (const video of videos) {
    const result = await transcribeLocally(video, { model, language, force });
    const { path, words } = result;
    const key = runKeyOf(video);
    // The transcribing line's format is pinned: SKILL.md's warning triage tells agents to look for it
    // verbatim. A cached run says so on its own line rather than reshaping the one that is quoted.
    if (result.cached) {
      console.log(`[transcribe] cached: ${cachedNote(path)}`);
      continue;
    }
    console.log(`[transcribe] whisperx: ${words} words -> ${path}`);
    const { interpolated, reordered } = result;
    if (interpolated > 0) {
      console.warn(
        `[transcribe] ${key}: WARNING ${interpolated} of ${words} word(s) arrived without usable timings; their ` +
        'windows were interpolated from neighbours. The text is complete, those reveals are approximate.',
      );
    }
    if (reordered > 0) {
      console.warn(
        `[transcribe] ${key}: WARNING ${reordered} word(s) had times running backwards and were reordered so ` +
        'the caption text matches the reveal order.',
      );
    }
  }
  return 0;
}
