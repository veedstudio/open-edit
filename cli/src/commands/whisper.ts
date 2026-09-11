// The "custom provider" entrypoint: converts a Whisper-family JSON that something else produced into
// runs/<key>/transcript.json, the same artefact the VEED provider writes. This is the seam a user's
// own service or MCP plugs into — no transcription is run here, and no credential is handled here.
// For the built-in local provider use the transcribe command, which drives WhisperX itself.
//
//   openedit whisper <whisper.json> <media> [<whisper.json> <media> ...] [--force]
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
// The key is derived from the video filename exactly as the transcribe and prep commands derive it,
// so prep picks the transcript up with no further arguments.
import { parseFlags } from '../args.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runsDir } from '../config.ts';
import { resolveVideoArg, runKeyOf } from '../resolve-video.ts';
import { validateTranscript } from './transcribe.ts';
import { mapWhisperTranscript, type WhisperJson } from '../prep/whisper-mapper.ts';
import { cachedNote, cachedTranscriptPath, wordCount } from '../prep/transcript-cache.ts';

const USAGE = 'usage: openedit whisper <whisper.json> <media> [<whisper.json> <media> ...] [--force]  (media = a video or an audio file)';

async function mapOne(jsonArg: string, videoArg: string, force = false): Promise<void> {
  if (!existsSync(jsonArg)) {
    throw new Error(`transcription json not found: ${jsonArg}`);
  }
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) {
    throw new Error(`video not found: ${video}`);
  }

  const raw = JSON.parse(await readFile(jsonArg, 'utf8')) as WhisperJson;
  const { transcript, interpolated, reordered } = mapWhisperTranscript(raw);
  validateTranscript(transcript);

  const key = runKeyOf(video);

  // This path writes the same file the other two providers guard, and a transcript on disk may have
  // been RETIMED onto an edited timeline. Overwriting it with a fresh mapping of the source restores
  // the drift the retime removed, and nothing downstream would report it.
  const existing = force ? null : cachedTranscriptPath(video);
  if (existing) {
    console.log(`[whisper-transcribe] ${key}: ${cachedNote(existing)} — the supplied json was NOT applied; --force replaces the file with it`);
    return;
  }

  const outDir = join(runsDir(), key);
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, 'transcript.json');
  await writeFile(out, JSON.stringify(transcript, null, 2));

  const words = wordCount(transcript);
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

export async function whisper(argv: string[]): Promise<number> {
  // Pairs of paths; --force is the only flag. Strict, so a stray flag is named instead of being counted
  // as one half of a pair and silently mapping a transcript onto the wrong video.
  const { values, positionals: args } = parseFlags({
    args: argv,
    options: { force: { type: 'boolean' } },
    allowPositionals: true,
  });
  // Each video carries its own transcription, so the arguments are pairs; an odd count means one is
  // missing, and guessing which would map a transcript onto the wrong video.
  if (args.length === 0 || args.length % 2 !== 0) {
    throw new Error(args.length === 0
      ? USAGE
      : `every video needs its own json — got ${args.length} argument(s), which do not pair up\n${USAGE}`);
  }
  for (let i = 0; i < args.length; i += 2) await mapOne(args[i], args[i + 1], values.force === true);
  return 0;
}
