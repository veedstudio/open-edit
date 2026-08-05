// Transcription providers, and the one flow they all end in.
//
//   resolve video -> derive key -> extract 16k mono WAV -> provider(audio) -> WhisperJson
//     -> mapWhisperTranscript -> validate -> runs/<key>/transcript.json
//
// VEED (veed/go.ts) writes that file itself and is not reimplemented here. WhisperX is a command
// template, run locally and free. A "custom" provider is deliberately not code: the agent obtains a
// Whisper-family JSON however the user's service works and feeds it to prep/whisper.ts, so no
// credential ever passes through OpenEdit.
//
//   node --import tsx prep/transcribe.ts <video.mp4> [...] [--model small.en|medium|...] [--language en]
//
// Device and compute are fixed to cpu/int8: the platform is Apple Silicon only, where CTranslate2 has
// no GPU path.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { FFMPEG, FFPROBE, REPO_ROOT, WHISPERX_BIN, WHISPERX_MODEL } from '../config.ts';
import { resolveVideoArg } from '../pipeline/scripts/resolve-video.ts';
import { mapWhisperTranscript, type Transcript, type WhisperJson } from './whisper-mapper.ts';

export const PREFS_PATH = join(REPO_ROOT, '.open-edit-prefs.json');
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

/** 16 kHz mono WAV: what every Whisper implementation wants, cut with the repo's own ffmpeg. */
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
    '--device', 'cpu',
    '--compute_type', 'int8',
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
      `${WHISPERX_BIN} is not available. Install it with pipeline/scripts/install-whisperx.sh ` +
      '(or choose VEED transcription instead).',
    );
  }
  const missing = ['--model', '--device', '--compute_type', '--output_format', '--output_dir']
    .filter((flag) => !out.includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `this build of ${WHISPERX_BIN} does not accept ${missing.join(', ')} — its CLI has changed. ` +
      'Reinstall with pipeline/scripts/install-whisperx.sh, or use VEED transcription.',
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

export function runKeyOf(video: string): string {
  return basename(video, extname(video)).replace(/\s+/g, '_');
}

export async function transcribeLocally(
  videoArg: string,
  opts: { model?: string; language?: string; run?: Run } = {},
): Promise<{ path: string; interpolated: number; reordered: number; words: number }> {
  const run = opts.run ?? realRun;
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  await assertHasAudio(video, run);

  const key = runKeyOf(video);
  const outDir = join(REPO_ROOT, 'runs', key);
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'open-edit-asr-'));

  try {
    const audio = await extractAudio(video, work, run);
    const model = opts.model ?? await recordedModel();
    const raw = await runWhisperx(audio, work, { ...opts, model, run });
    const { transcript, interpolated, reordered } = mapWhisperTranscript(raw);
    validateTranscript(transcript);

    const path = join(outDir, 'transcript.json');
    await writeFile(path, JSON.stringify(transcript, null, 2));
    const words = transcript.chunks.reduce((n, c) => n + c.words.length, 0);
    return { path, interpolated, reordered, words };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export const USAGE = 'usage: node --import tsx prep/transcribe.ts <video.mp4> [...] [--model <id>] [--language <code>]\n'
  + `   or: node --import tsx prep/transcribe.ts --record <${PROVIDERS.join('|')}> [--model <id>]`;

export interface Args {
  /** In the order given, like prep/prep.ts. Empty only when recording a choice. */
  videos: string[];
  model?: string;
  language?: string;
  /** Write the provider choice and exit — the "record the choice" step of the flow. */
  record?: Provider;
}

// Both `--flag value` and `--flag=value`. An unknown flag is an ERROR: a misspelled --language would
// otherwise leave English-only weights on non-English audio, transcribing it as confident nonsense.
export function parseArgs(argv: string[]): Args {
  const known = ['--model', '--language', '--record'];
  const videos: string[] = [];
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      videos.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (!known.includes(flag)) throw new Error(`unknown flag ${flag}\n${USAGE}`);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined || value === '') throw new Error(`${flag} needs a value\n${USAGE}`);
    out[flag.slice(2)] = value;
  }
  if (out.record !== undefined && !(PROVIDERS as readonly string[]).includes(out.record)) {
    throw new Error(`unknown provider "${out.record}" — expected one of ${PROVIDERS.join(', ')}\n${USAGE}`);
  }
  // Recording a choice is not a transcription run, so it needs no video.
  if (out.record === undefined && videos.length === 0) throw new Error(`no video given\n${USAGE}`);
  return {
    videos,
    ...(out.record === undefined ? {} : { record: out.record as Provider }),
    ...(out.model === undefined ? {} : { model: out.model }),
    ...(out.language === undefined ? {} : { language: out.language }),
  };
}

async function main(): Promise<void> {
  const { videos, model, language, record } = parseArgs(process.argv.slice(2));

  if (record) {
    await writePrefs({ provider: record, ...(model === undefined ? {} : { model }) });
    console.log(`[transcribe] recorded provider=${record}${model ? ` model=${model}` : ''} -> ${PREFS_PATH}`);
    return;
  }

  // Sequential, and a failure stops the batch: the videos share one provider, so a missing binary or
  // an exhausted account fails all of them, and the transcripts already written stay valid.
  for (const video of videos) {
    const { path, interpolated, reordered, words } = await transcribeLocally(video, { model, language });
    console.log(`[transcribe] whisperx: ${words} words -> ${path}`);
    const key = runKeyOf(video);
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
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
