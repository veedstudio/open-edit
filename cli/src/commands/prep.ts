// Prep for one or more source videos. Probes the source to fix the canvas (aspect → W/H/fps), writes
// runs/<key>/meta.json (the single source of canvas/duration/paths every downstream step reads),
// synthesizes runs/<key>/word-timings.json from the transcript's real per-word times, and
// extracts one base frame per beat. The transcript (any provider) must already exist — frames are
// cut at each beat's mid time from it.
//
//   openedit prep <video.mp4> [<video2.mp4> ...]
//   (any path works — absolute or relative to your CWD; outputs land in runs/<key>/ under the runtime root)
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FFPROBE, runsDir } from '../config.ts';
import { probeDisplaySize, probeFps } from '../probe.ts';
import { extractBeatFrames } from '../prep/extract-beat-frames.ts';
import { resolveVideoArg, runKeyOf } from '../resolve-video.ts';
import { synthWordTimings, type TimedChunk } from '../prep/synth-word-timings.ts';

interface Canvas { aspect: '9:16' | '16:9'; width: number; height: number; fps: number }

function probeCanvas(src: string): { canvas: Canvas; durationSec: number } {
  const { width: w, height: h } = probeDisplaySize(src);
  const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]).toString().trim());
  if (!Number.isFinite(dur)) throw new Error(`ffprobe: bad duration for ${src}`);
  const canvas: Canvas = { aspect: h >= w ? '9:16' : '16:9', width: w, height: h, fps: Math.round(probeFps(src) * 1000) / 1000 };
  return { canvas, durationSec: dur };
}

async function prepOne(file: string): Promise<void> {
  const key = runKeyOf(file);
  const src = resolveVideoArg(file); // same rule as the transcription commands — the two must never disagree about the source file
  const dir = join(runsDir(), key);
  await mkdir(dir, { recursive: true });
  const { canvas, durationSec } = probeCanvas(src);
  const framesDir = join(dir, 'frames');
  const meta = {
    key, file, videoPath: src,
    transcriptPath: join(dir, 'transcript.json'),
    wordTimingsPath: join(dir, 'word-timings.json'),
    framesDir,
    aspect: canvas.aspect, width: canvas.width, height: canvas.height, fps: canvas.fps,
    durationSec: Math.round(durationSec * 1000) / 1000,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[meta] ${key}: ${canvas.aspect} ${canvas.width}x${canvas.height}@${canvas.fps} dur=${meta.durationSec}s`);

  // The transcription step owns transcript.json (real per-word timings); frames are cut at each beat's mid time.
  await access(meta.transcriptPath).catch(() => { throw new Error(`no ${meta.transcriptPath} — run the transcription step first`); });
  await ensureWordTimings(dir, meta.transcriptPath, key);
  extractBeatFrames(src, meta.transcriptPath, framesDir, canvas.width, canvas.height);
  console.log(`[prep] ${key}: DONE`);
}

// Per-beat absolute-ms word reveal delays for the word-level caption animation. Transcripts carry REAL per-word
// times in words:[{text,timestamp}] (the same shape as a TimedChunk) — flatten those as the word-level
// source; even split only when a transcript has no word arrays at all. Every provider supplies real
// times, so an even split means the transcript itself is deficient.
async function ensureWordTimings(dir: string, transcriptPath: string, key: string): Promise<void> {
  const t = JSON.parse(await readFile(transcriptPath, 'utf8')) as { chunks?: (TimedChunk & { words?: TimedChunk[] })[] };
  const chunks = Array.isArray(t.chunks) ? t.chunks : [];
  const wordChunks = chunks.flatMap((c) => Array.isArray(c.words) ? c.words : []);
  const wt = synthWordTimings(chunks, wordChunks.length ? wordChunks : undefined);
  await writeFile(join(dir, 'word-timings.json'), JSON.stringify(wt, null, 2));
  if (wordChunks.length) {
    console.log(`[prep] ${key}: word-timings.json (real per-word times)`);
  } else {
    // An even split desynchronises the word reveals, so it must not read like a routine log line.
    console.warn(
      `[prep] ${key}: WARNING word-timings.json is an EVEN SPLIT — ${transcriptPath} carries no ` +
      'per-word times, so word reveals will drift out of sync with the audio.',
    );
  }
}

export const usage = {
  summary: 'Probe canvas, synthesize word timings, and cut base frames for source videos',
  positionals: '<video.mp4> [...]',
  flags: {},
} satisfies Usage;

export async function prep(argv: string[]): Promise<number> {
  // Every argument is a video; prep takes no flags at all. Said strictly, so a flag meant for some other
  // command is named here rather than resolved as a file path and reported as a missing video.
  const { positionals: videos } = parseUsage('prep', usage, argv);
  if (videos.length === 0) throw new Error(usageLine('prep', usage));
  for (const file of videos) await prepOne(file);
  console.log('PREP DONE');
  return 0;
}
