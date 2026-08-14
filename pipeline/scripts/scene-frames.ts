// Frames for a clip that has no beats.
//
// `extract-beat-frames.ts` samples one still per transcript chunk, which is the right unit for a
// captioned run and no unit at all for the others: a 3-second UGC clip with no dialogue, a card with
// no audio track, a piece of stock footage. All 52 agent briefs of the launch session handled that by
// writing the footage into the brief in prose — "her head sits roughly y430-900; the ceiling band
// y0-420 is empty; the doorway is centre-right" — retyped per agent, per round, and never checkable.
//
// This samples on TIME instead, and emits the plan alongside the stills so a vision pass writes facts
// against sample indices rather than against beats that do not exist.
//
//   scene-frames.ts <video.mp4> <outDir> [--count 8]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { FFMPEG, FFPROBE } from '../../config.ts';

export interface Sample { i: number; sec: number; frame: number; path: string }
export interface ScenePlan {
  video: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  /** Half-canvas, like the beat frames — a vision pass doubles every pixel it reads off one. */
  frameWidth: number;
  frameHeight: number;
  samples: Sample[];
}

function probe(video: string): { durationSec: number; fps: number; width: number; height: number } {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration',
    '-of', 'json', video,
  ], { encoding: 'utf8' });
  const j = JSON.parse(out) as {
    streams: { width: number; height: number; r_frame_rate: string; duration?: string }[];
    format: { duration: string };
  };
  const s = j.streams[0];
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  // The CONTAINER's duration follows its longest stream. A file whose audio outlasts its picture — an
  // ordinary thing — then puts most samples past the last frame, where ffmpeg writes nothing and exits
  // 0. Sample against the picture, and fall back to the container only when the stream does not say.
  const streamSec = Number(s.duration);
  const formatSec = Number(j.format.duration);
  const durationSec = Number.isFinite(streamSec) && streamSec > 0 ? Math.min(streamSec, formatSec || streamSec) : formatSec;
  return { durationSec, fps: d ? n / d : n, width: s.width, height: s.height };
}

/**
 * Samples spread across the clip, avoiding both ends.
 *
 * The first and last frames of a clip are the least representative moments it has — a fade, a slate, a
 * hand still leaving the frame — so the samples sit inside a margin rather than at 0 and `duration`.
 */
export function planFor(video: string, outDir: string, count = 8): ScenePlan {
  const { durationSec, fps, width, height } = probe(video);
  const margin = Math.min(0.25, durationSec / (count + 2));
  const span = Math.max(0, durationSec - margin * 2);
  const samples: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const sec = count === 1 ? durationSec / 2 : margin + (span * i) / (count - 1);
    samples.push({ i: i + 1, sec: Number(sec.toFixed(3)), frame: Math.round(sec * fps), path: join(outDir, `scene-${i + 1}.png`) });
  }
  return { video, durationSec, fps, width, height, frameWidth: Math.round(width / 2), frameHeight: Math.round(height / 2), samples };
}

export function extractSceneFrames(video: string, outDir: string, count = 8): ScenePlan {
  const plan = planFor(video, outDir, count);
  mkdirSync(outDir, { recursive: true });
  const missing: string[] = [];
  for (const s of plan.samples) {
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(s.sec), '-i', video, '-frames:v', '1',
      '-vf', `scale=${plan.frameWidth}:${plan.frameHeight}`, s.path,
    ]);
    // A seek past the end of the VIDEO stream writes nothing and exits 0. `format.duration` follows
    // the longest stream, so an ordinary file whose audio outlasts its picture silently produced a
    // plan of eight stills with five of them absent — and a vision pass reads that as an empty frame.
    if (!existsSync(s.path) || statSync(s.path).size === 0) missing.push(`${s.path} (${s.sec}s)`);
  }
  if (missing.length) {
    throw new Error(
      `ffmpeg wrote no frame for ${missing.length} of ${plan.samples.length} samples — the seek is past ` +
      `the end of the video stream, which happens when the audio runs longer than the picture:\n  ${missing.join('\n  ')}`,
    );
  }
  writeFileSync(join(outDir, 'scene-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { count: { type: 'string' } },
    allowPositionals: true,
  });
  const [video, outDir] = positionals;
  if (!video || !outDir) { console.error('usage: scene-frames.ts <video.mp4> <outDir> [--count 8]'); process.exit(2); }
  const count = Number(values.count ?? 8);
  if (!Number.isInteger(count) || count < 1) {
    console.error(`--count must be a positive integer, got "${values.count}"`);
    process.exit(2);
  }
  const plan = extractSceneFrames(video, outDir, count);
  console.log(`scene-frames: ${plan.samples.length} stills at ${plan.frameWidth}x${plan.frameHeight} → ${outDir}`);
  console.log(`  sampled at ${plan.samples.map((s) => `${s.sec}s`).join(', ')}`);
  console.log(`  plan: ${join(outDir, 'scene-plan.json')}`);
}
