// Joins several clips into one, end to end.
//
//   node --import tsx pipeline/scripts/concat-videos.ts <out.mp4> <in1.mp4> <in2.mp4> [...]
//   node --import tsx pipeline/scripts/concat-videos.ts --canvas 1080x1920 --fit crop <out.mp4> <in...>
//   node --import tsx pipeline/scripts/concat-videos.ts --fit open <in1.mp4> <in2.mp4> [...]
//
// Generated clips do NOT share a canvas: a Fabric still decides its own aspect, so a portrait presenter
// and a landscape one produce different dimensions. ffmpeg's concat demuxer refuses that outright, and
// the stream-copy path people reach for first fails with a size-mismatch that reads like a codec problem.
// So this re-encodes every input onto one canvas, and a clip whose aspect differs from that canvas has to
// lose something: --fit letterbox (the default) pads it and keeps the whole frame behind black bars;
// --fit crop fills the canvas and cuts the overflow; --fit open decides nothing in code and instead
// reports which clips differ, so the agent can reframe each shot itself. Re-encoding is the price of
// accepting mixed inputs at all.
//
// The canvas defaults to the LARGEST input by area, so the sharpest clip keeps its resolution and the
// others are upscaled to meet it rather than everything collapsing to the smallest.
import { parseFlags } from '../../veed/args.ts';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { FFMPEG, FFPROBE } from '../../config.ts';

const run = promisify(execFile);

export interface Size {
  width: number;
  height: number;
}

// letterbox pads a mismatched clip (keeps all framing); crop fills the canvas (cuts the overflow); open
// runs no encode and reports the mismatches for the agent to reframe by hand.
export type FitMode = 'letterbox' | 'crop' | 'open';

// Only these two reach the encoder — open never does, so the filter graph does not model it.
type EncodeFit = 'letterbox' | 'crop';

// Two aspects count as the same shape when they are within this FRACTION of each other — relative, so
// the threshold means the same thing in portrait and landscape. Even-dimension rounding moves a ratio by
// well under this, while a visibly different frame exceeds it.
const ASPECT_TOLERANCE = 0.01;

export function aspectOf(size: Size): number {
  return size.width / size.height;
}

// Even dimensions: yuv420p chroma is subsampled 2x, and an odd width or height makes the encoder fail
// with a message that says nothing about the real cause.
export function evenSize(size: Size): Size {
  return { width: Math.max(2, size.width - (size.width % 2)), height: Math.max(2, size.height - (size.height % 2)) };
}

export function largestByArea(sizes: Size[]): Size {
  if (sizes.length === 0) throw new Error('no inputs to size a canvas from');
  return evenSize(sizes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)));
}

export function parseCanvas(text: string): Size {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!m) throw new Error(`--canvas expects WIDTHxHEIGHT, got "${text}"`);
  return evenSize({ width: Number(m[1]), height: Number(m[2]) });
}

export function parseFit(text: string | undefined): FitMode {
  if (text === undefined) return 'letterbox';
  if (text === 'letterbox' || text === 'crop' || text === 'open') return text;
  throw new Error(`--fit expects letterbox, crop or open, got "${text}"`);
}

export interface AspectReport {
  size: Size;
  matchesCanvas: boolean;
}

// Which clips differ in shape from the canvas — the ones a fit strategy actually acts on. A clip that
// already matches gets the same result from crop or letterbox, so only these are worth reporting.
export function aspectReport(sizes: Size[], canvas: Size): AspectReport[] {
  const target = aspectOf(canvas);
  return sizes.map((size) => ({
    size,
    matchesCanvas: Math.abs(aspectOf(size) - target) <= target * ASPECT_TOLERANCE,
  }));
}

// One filter chain per input: fit or fill the canvas, force a common timebase and pixel aspect. setsar
// stops a clip with a non-square pixel aspect from concatenating at the wrong shape; a clip that already
// matches the canvas is unaffected by either shape (nothing to pad or crop).
// Per-input audio facts the concat needs: whether the clip HAS an audio track, and how long it runs so a
// silent stand-in can be cut to match when it does not.
export interface AudioTrack {
  hasAudio: boolean;
  duration: number;
}

export interface InputMeta extends AudioTrack {
  size: Size;
}

export function filterGraph(canvas: Size, fit: EncodeFit, audio: AudioTrack[]): string {
  const { width: W, height: H } = canvas;
  // crop scales to COVER then cuts; letterbox scales to FIT then pads. Without force_original_aspect_ratio
  // ffmpeg stretches and every face goes oval.
  const shape = fit === 'crop'
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const parts: string[] = [];
  audio.forEach((track, i) => {
    parts.push(`[${i}:v]${shape},setsar=1,fps=30[v${i}]`);
    // A clip with no audio track cannot be mapped as [i:a]; ffmpeg aborts the whole concat with an opaque
    // "Stream specifier :a matches no streams". Synthesise silence of the clip's own length instead, so
    // concat's a=1 always has a stream and a silent motion-graphics shot joins like any other.
    parts.push(track.hasAudio
      ? `[${i}:a]aresample=48000,asetpts=N/SR/TB[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${track.duration},asetpts=N/SR/TB[a${i}]`);
  });
  const count = audio.length;
  const streams = Array.from({ length: count }, (_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${streams}concat=n=${count}:v=1:a=1[v][a]`);
  return parts.join(';');
}

export function ffmpegArgs(inputs: string[], out: string, canvas: Size, fit: EncodeFit, audio: AudioTrack[]): string[] {
  return [
    '-loglevel', 'error', '-y',
    ...inputs.flatMap((i) => ['-i', i]),
    '-filter_complex', filterGraph(canvas, fit, audio),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    out,
  ];
}

export async function probeSize(file: string): Promise<Size> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file,
  ]);
  const [width, height] = stdout.trim().split('x').map(Number);
  if (!width || !height) throw new Error(`could not read the dimensions of ${file}`);
  return { width, height };
}

// One probe for everything the encode path needs: video size, whether an audio track is present, and the
// container duration (used only to size synthesised silence for an audio-less clip).
export async function probeInput(file: string): Promise<InputMeta> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height:format=duration',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video?.width || !video?.height) throw new Error(`could not read the dimensions of ${file}`);
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration)) throw new Error(`could not read the duration of ${file}`);
  return {
    size: { width: video.width, height: video.height },
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    duration,
  };
}

export interface ConcatOptions {
  canvas?: Size;
  fit?: EncodeFit;
}

// Shared by the encode and report paths so the "clip not found" message lives in exactly one place.
function assertClipsExist(inputs: string[]): void {
  const missing = inputs.filter((i) => !existsSync(i));
  if (missing.length > 0) throw new Error(`clip not found:\n  ${missing.join('\n  ')}`);
}

export async function concatVideos(inputs: string[], out: string, opts: ConcatOptions = {}): Promise<Size> {
  if (inputs.length < 2) throw new Error('concat needs at least two clips; one clip is already the answer');
  assertClipsExist(inputs);
  // Every input is probed now — the audio plan (present vs silent, and each clip's length) is needed even
  // when --canvas pins the size, so there is nothing to skip.
  const metas = await Promise.all(inputs.map(probeInput));
  const target = opts.canvas ?? largestByArea(metas.map((m) => m.size));
  await run(FFMPEG, ffmpegArgs(inputs, out, target, opts.fit ?? 'letterbox', metas));
  return target;
}

// The report path, a sibling to concatVideos that encodes nothing: probe, choose the canvas, and say which
// clips differ in shape — the --fit open answer, exported so it is testable without a subprocess.
export async function reportAspects(inputs: string[], canvas?: Size): Promise<{ canvas: Size; report: AspectReport[] }> {
  assertClipsExist(inputs);
  const sizes = await Promise.all(inputs.map(probeSize));
  const target = canvas ?? largestByArea(sizes);
  return { canvas: target, report: aspectReport(sizes, target) };
}

// Prints the --fit open report: the chosen canvas, then each clip's shape against it. The report is in
// input order, so the clip path is taken by position.
function printAspectReport(inputs: string[], canvas: Size, report: AspectReport[]): void {
  console.log(`[concat] canvas ${canvas.width}x${canvas.height} (aspect ${aspectOf(canvas).toFixed(3)})`);
  report.forEach((r, i) => {
    const tag = r.matchesCanvas ? 'matches ' : 'MISMATCH';
    console.log(`  ${tag}  ${r.size.width}x${r.size.height} (${aspectOf(r.size).toFixed(3)})  ${inputs[i]}`);
  });
  const off = report.filter((r) => !r.matchesCanvas).length;
  console.log(
    off === 0
      ? '[concat] every clip already matches the canvas — --fit letterbox or crop will both join cleanly.'
      : `[concat] ${off}/${report.length} clips differ from the canvas aspect — reframe them per shot, ` +
        'or fall back to --fit crop (fills, cuts overflow) or --fit letterbox (pads, keeps all framing).',
  );
}

async function main(): Promise<void> {
  // Strict, with the clip paths as positionals: a mistyped --canvas or --fit must not silently fall
  // through and be treated as one of the files to join.
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { canvas: { type: 'string' }, fit: { type: 'string' } },
    allowPositionals: true,
  });
  const canvas = values.canvas === undefined ? undefined : parseCanvas(values.canvas);
  const fit = parseFit(values.fit);

  if (fit === 'open') {
    // open reports on the inputs and writes nothing, so every positional is a clip — there is no out path.
    const clips = positionals;
    if (clips.length < 2) {
      console.error('usage: node --import tsx pipeline/scripts/concat-videos.ts --fit open <in1.mp4> <in2.mp4> [...]');
      process.exit(1);
    }
    const { canvas: target, report } = await reportAspects(clips, canvas);
    printAspectReport(clips, target, report);
    return;
  }

  const [out, ...inputs] = positionals;
  if (!out || inputs.length < 2) {
    console.error(
      'usage: node --import tsx pipeline/scripts/concat-videos.ts [--canvas WxH] [--fit letterbox|crop] <out.mp4> <in1.mp4> <in2.mp4> [...]',
    );
    process.exit(1);
  }
  const used = await concatVideos(inputs, out, { canvas, fit });
  console.log(`[concat] ${inputs.length} clips → ${out} at ${used.width}x${used.height} (--fit ${fit})`);
}

if (process.argv[1]?.endsWith('concat-videos.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
