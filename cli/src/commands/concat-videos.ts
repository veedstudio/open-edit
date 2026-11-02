// Joins several clips into one, end to end.
//
//   openedit concat-videos <out.mp4> <in1.mp4> <in2.mp4> [...]
//   openedit concat-videos --canvas 1080x1920 --fit letterbox <out.mp4> <in...>
//
// Clips that disagree in size or shape (a portrait and a landscape Fabric presenter) are re-encoded onto one
// canvas, the largest as shown unless --canvas names it, since ffmpeg's concat demuxer refuses them outright.
// A clip of another shape is cut to the canvas's with reframe's own code (--fit crop) or padded whole (--fit letterbox).
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FFMPEG, FFPROBE } from '../config.ts';
import { converted, describeHdr, hdrKind, toSdr } from '../hdr.ts';
import { colourTagsOf, probeSquareSize, type ColourReport, type ColourTags } from '../probe.ts';
import { resolveVideoArg } from '../resolve-video.ts';
import { asShown } from '../shown.ts';
import { decideColour } from './apply-edl.ts';
import { cropFor, describeShape, parseFit, planShape, shapeChain, type Fit } from './reframe.ts';

const run = promisify(execFile);

export interface Size {
  width: number;
  height: number;
}

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

// Per-input audio facts the concat needs: whether the clip HAS an audio track, and how long it runs so a
// silent stand-in can be cut to match when it does not.
export interface AudioTrack {
  hasAudio: boolean;
  duration: number;
}

export interface InputMeta extends AudioTrack {
  /** As shown: upright, in square pixels. */
  size: Size;
  /** The pixel aspect it is stored in, 1 for square pixels. */
  sar: number;
  colour: ColourReport;
}

/**
 * One chain per input: its SDR conversion (`sdr[i]`), its cut to the canvas's shape (`shapes[i]`), then the fit,
 * where crop covers and letterbox pads what even pixels leave. `tags` labels every clip alike before the join,
 * which concat would otherwise take from the first clip and newer libavfilter would convert between.
 */
export function filterGraph(canvas: Size, fit: Fit, audio: AudioTrack[], sdr: (string | null)[] = [], tags?: ColourTags,
  shapes: string[][] = []): string {
  const { width: W, height: H } = canvas;
  // Without force_original_aspect_ratio ffmpeg stretches and every face goes oval.
  const fitTo = fit === 'crop'
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const parts: string[] = [];
  audio.forEach((track, i) => {
    const label = tags ? `,setparams=color_primaries=${tags.primaries}:color_trc=${tags.transfer}:colorspace=${tags.space}` : '';
    parts.push(`[${i}:v]${[sdr[i], ...(shapes[i] ?? []), fitTo].filter(Boolean).join(',')},setsar=1,fps=30${label}[v${i}]`);
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

export function ffmpegArgs(inputs: string[], out: string, canvas: Size, fit: Fit, audio: AudioTrack[], sdr: (string | null)[] = [], tags?: ColourTags,
  shapes: string[][] = []): string[] {
  return [
    '-loglevel', 'error', '-y',
    ...inputs.flatMap((i) => ['-i', i]),
    '-filter_complex', filterGraph(canvas, fit, audio, sdr, tags, shapes),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    out,
  ];
}

// One probe for everything the encode path needs: the shown size, whether an audio track is present, and the
// container duration (used only to size synthesised silence for an audio-less clip).
export async function probeInput(file: string): Promise<InputMeta> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type:format=duration',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration)) throw new Error(`could not read the duration of ${file}`);
  const { width, height, sar } = probeSquareSize(file);
  return {
    size: { width, height },
    sar,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    duration,
    colour: colourTagsOf(file),
  };
}

export interface ConcatOptions {
  canvas?: Size;
  fit?: Fit;
}

export async function concatVideos(inputs: string[], out: string, opts: ConcatOptions = {}): Promise<Size> {
  if (inputs.length < 2) throw new Error('concat needs at least two clips; one clip is already the answer');
  const missing = inputs.filter((i) => !existsSync(i));
  if (missing.length > 0) throw new Error(`clip not found:\n  ${missing.join('\n  ')}`);
  // Absolute, since ffmpeg runs where the crops' moves are written.
  const paths = inputs.map(resolveVideoArg);
  // Every input is probed now — the audio plan (present vs silent, and each clip's length) is needed even
  // when --canvas pins the size, so there is nothing to skip.
  const metas = await Promise.all(paths.map(probeInput));
  const target = opts.canvas ?? largestByArea(metas.map((m) => m.size));
  const fit = opts.fit ?? 'crop';
  // Planned before anything is encoded, so stale face boxes are refused up front.
  const plans = fit === 'crop' ? paths.map((p, i) => planShape(p, aspectOf(target), { label: inputs[i], ways: ', or join with --fit letterbox' })) : null;
  const sdr = metas.map((m, i) => (hdrKind(m.colour) ? toSdr(m.colour, inputs[i]) : null));
  // A converted clip is BT.709, so the others must be too, as apply-edl decides it: a clip of another colour
  // would otherwise be labelled with whichever clip came first.
  const tags = sdr.some(Boolean) ? decideColour(inputs.map((id, i) => ({ id, colour: converted(metas[i].colour) }))).tags : undefined;
  const work = mkdtempSync(join(tmpdir(), 'open-edit-concat-'));
  try {
    const shapes = metas.map((m, i) => {
      const plan = plans?.[i];
      if (!plan) return asShown({ ...m.size, sar: m.sar });
      const { filters, script } = shapeChain(plan, `c${i}`);
      if (script) writeFileSync(join(work, script.file), script.text);
      return filters;
    });
    await run(FFMPEG, ffmpegArgs(paths, resolve(out), target, fit, metas, sdr, tags, shapes), { cwd: work });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  metas.forEach((m, i) => {
    if (sdr[i]) console.log(`[concat] ${describeHdr(inputs[i], m.colour)}`);
    const plan = plans?.[i];
    if (plan && plan.how !== 'already') console.log(`[concat] ${describeShape(inputs[i], plan, `the canvas's shape (${target.width}x${target.height})`)}`);
    else if (!plan && cropFor(m.size.width, m.size.height, aspectOf(target)).travel > 0) {
      console.log(`[concat] ${inputs[i]} (${m.size.width}x${m.size.height}) is letterboxed onto the ${target.width}x${target.height} canvas`);
    }
  });
  return target;
}

export const usage = {
  summary: 'Re-encode clips that disagree onto one canvas at 30 fps',
  positionals: '<out.mp4> <in1.mp4> <in2.mp4> [...]',
  flags: {
    canvas: { type: 'string', value: 'WxH', help: 'Target canvas (default: the largest clip by area as shown, the first on a tie)' },
    fit: {
      type: 'string', value: 'crop|letterbox',
      help: 'How a clip of another shape meets the canvas: crop (default) cuts it as reframe does, around its faces when faces has run on it, else from the middle; letterbox pads it',
    },
  },
  notes: [
    'Sizes are as shown: a rotated phone clip is upright and anamorphic footage square-pixelled. A line names',
    'each clip cut to the canvas\'s shape and whether it followed the faces or cut from the middle. An HDR (PQ/HLG)',
    'clip is converted to SDR BT.709, and a line says so.',
  ].join('\n'),
} satisfies Usage;

export async function concatVideosCommand(argv: string[]): Promise<number> {
  // Strict, with the clip paths as positionals: a mistyped --canvas or --fit must not silently fall
  // through and be treated as one of the files to join.
  const { values, positionals } = parseUsage('concat-videos', usage, argv);
  const canvas = values.canvas === undefined ? undefined : parseCanvas(values.canvas);
  const fit = parseFit(values.fit);
  const [out, ...inputs] = positionals;
  if (!out || inputs.length < 2) {
    console.error(usageLine('concat-videos', usage));
    return 1;
  }
  const used = await concatVideos(inputs, out, { canvas, fit });
  console.log(`[concat] ${inputs.length} clips → ${out} at ${used.width}x${used.height} (--fit ${fit})`);
  return 0;
}
