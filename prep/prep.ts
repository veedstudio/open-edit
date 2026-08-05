// Prep for one or more source videos. Probes the source to fix the canvas (aspect → W/H/fps), writes
// runs/<key>/meta.json (the single source of canvas/duration/paths every downstream step reads),
// synthesizes runs/<key>/word-timings.json from the VEED transcript's real per-word times, and
// extracts one base frame per beat. The VEED transcript (veed/go.ts) must already exist — frames are
// cut at each beat's mid time from it.
//
// Paths come from ../config.ts.
// Run:  node --import tsx prep/prep.ts <video.mp4> [<video2.mp4> ...]
//   (any path works — absolute or relative to your CWD; outputs land in <repo>/runs/<key>/)
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { FFPROBE, REPO_ROOT } from '../config.ts';
import { extractBeatFrames } from '../pipeline/scripts/extract-beat-frames.ts';
import { resolveVideoArg } from '../pipeline/scripts/resolve-video.ts';
import { synthWordTimings, type TimedChunk } from '../pipeline/scripts/synth-word-timings.ts';

function keyOf(file: string): string {
  return basename(file, extname(file)).replace(/\s+/g, '_');
}

interface Canvas { aspect: '9:16' | '16:9'; width: number; height: number; fps: number }

// r_frame_rate is the nominal rate (avg_frame_rate drifts on trimmed/VFR files); avg is the fallback.
function probeFps(src: string): number {
  const lines = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'default=nw=1', src]).toString().trim().split('\n');
  const rate = (key: string): number => {
    const [n, d] = (lines.find((l) => l.startsWith(`${key}=`))?.split('=')[1] ?? '').split('/').map(Number);
    return d ? n / d : n;
  };
  const fps = [rate('r_frame_rate'), rate('avg_frame_rate')].find((r) => Number.isFinite(r) && r > 0);
  if (!fps) throw new Error(`ffprobe: bad frame rate for ${src}`);
  return Math.round(fps * 1000) / 1000;
}

function probeCanvas(src: string): { canvas: Canvas; durationSec: number } {
  const dims = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', src]).toString().trim();
  const [rawW, rawH] = dims.split('x').map(Number);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH)) throw new Error(`ffprobe: bad dims "${dims}" for ${src}`);
  // Phone footage is often stored landscape with a rotation side-data tag; ±90/270 => display dims are swapped.
  const rot = Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=rotation', '-of', 'default=nw=1:nk=1', src]).toString().trim().split('\n')[0]);
  const swap = Number.isFinite(rot) && Math.abs(rot) % 180 === 90;
  const w = swap ? rawH : rawW;
  const h = swap ? rawW : rawH;
  const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]).toString().trim());
  if (!Number.isFinite(dur)) throw new Error(`ffprobe: bad duration for ${src}`);
  const canvas: Canvas = { aspect: h >= w ? '9:16' : '16:9', width: w, height: h, fps: probeFps(src) };
  return { canvas, durationSec: dur };
}

async function prep(file: string): Promise<void> {
  const key = keyOf(file);
  const src = resolveVideoArg(file); // same rule as veed/go.ts — the two must never disagree about the source file
  const dir = join(REPO_ROOT, 'runs', key);
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

  // veed/go.ts owns transcript.json (real per-word timings); frames are cut at each beat's mid time.
  await access(meta.transcriptPath).catch(() => { throw new Error(`no ${meta.transcriptPath} — run veed/go.ts first`); });
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

async function run(): Promise<void> {
  const videos = process.argv.slice(2);
  if (videos.length === 0) throw new Error('usage: node --import tsx prep/prep.ts <video.mp4> [...]');
  for (const file of videos) await prep(file);
  console.log('PREP DONE');
}
run().catch((e) => { console.error(e); process.exit(1); });
