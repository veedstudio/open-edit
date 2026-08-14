// The "custom provider" entrypoint: converts a Whisper-family JSON that something else produced into
// runs/<key>/transcript.json, the same artefact veed/go.ts writes. This is the seam a user's own
// service or MCP plugs into — no transcription is run here, and no credential is handled here.
// For the built-in local provider use prep/transcribe.ts, which drives WhisperX itself.
//
//   node --import tsx prep/whisper.ts <whisper.json> <media> [<whisper.json> <media> ...]
//
// `<media>` is a video OR an audio file. Nothing here probes it — it names the run and has to
// exist — so a film's GENERATED narration reaches `transcript.json` the same way a source clip's
// speech does, which is the only route a run with no footage yet has to per-word times.
//
// Producing the input, word timings included (they are required):
//   whisperx     video.mp4 --output_format json --output_dir .        # emits word times by default
//   openai-whisper / mlx-whisper   --word_timestamps True --output_format json --output_dir .
//   whisper.cpp  main -m models/ggml-base.en.bin -f audio.wav -oj -ml 1
//   OpenAI API   response_format=verbose_json, timestamp_granularities=["word"]
//
// The key is derived from the video filename exactly as veed/go.ts and prep/prep.ts derive it, so
// prep picks the transcript up with no further arguments.
import { parseFlags } from '../veed/args.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { resolveVideoArg, runKeyOf } from '../pipeline/scripts/resolve-video.ts';
import { validateTranscript } from './transcribe.ts';
import { mapWhisperTranscript, type WhisperJson } from './whisper-mapper.ts';

const USAGE = 'usage: node --import tsx prep/whisper.ts <whisper.json> <media> [<whisper.json> <media> ...]  (media = a video or an audio file)';

async function mapOne(jsonArg: string, videoArg: string): Promise<void> {
  if (!existsSync(jsonArg)) {
    console.error(`transcription json not found: ${jsonArg}`);
    process.exit(1);
  }
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) {
    console.error(`video not found: ${video}`);
    process.exit(1);
  }

  const raw = JSON.parse(await readFile(jsonArg, 'utf8')) as WhisperJson;
  const { transcript, interpolated, reordered } = mapWhisperTranscript(raw);
  validateTranscript(transcript);

  const key = runKeyOf(video);
  const outDir = join(REPO_ROOT, 'runs', key);
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, 'transcript.json');
  await writeFile(out, JSON.stringify(transcript, null, 2));

  const words = transcript.chunks.reduce((n, c) => n + c.words.length, 0);
  console.log(`[whisper-transcribe] ${key}: ${transcript.chunks.length} chunks, ${words} words -> ${out}`);
  if (interpolated > 0) {
    console.warn(
      `[whisper-transcribe] ${key}: WARNING ${interpolated} of ${words} word(s) arrived without usable timings; ` +
      'their windows were interpolated from neighbours. The text is complete, those reveals are approximate.',
    );
  }
  if (reordered > 0) {
    console.warn(
      `[whisper-transcribe] ${key}: WARNING ${reordered} word(s) had times running backwards and were reordered ` +
      'so the caption text matches the reveal order.',
    );
  }
}

async function run(): Promise<void> {
  // Pairs of paths, no flags. Strict, so a stray flag is named instead of being counted as one half of a
  // pair and silently mapping a transcript onto the wrong video.
  const { positionals: args } = parseFlags({
    args: process.argv.slice(2),
    options: {},
    allowPositionals: true,
  });
  // Each video carries its own transcription, so the arguments are pairs; an odd count means one is
  // missing, and guessing which would map a transcript onto the wrong video.
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error(args.length === 0
      ? USAGE
      : `every video needs its own json — got ${args.length} argument(s), which do not pair up\n${USAGE}`);
    process.exit(1);
  }
  for (let i = 0; i < args.length; i += 2) await mapOne(args[i], args[i + 1]);
}

run().catch((e) => { console.error((e as Error).message); process.exit(1); });
