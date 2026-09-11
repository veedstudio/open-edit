// What ffprobe knows about a file, asked once here rather than re-typed by every command that needs it.
import { execFileSync } from 'node:child_process';
import { FFPROBE } from './config.ts';

export interface Display {
  width: number;
  height: number;
}

export interface ColourTags {
  readonly primaries: string;
  readonly transfer: string;
  readonly space: string;
}

export const ASSUMED_COLOUR: ColourTags = Object.freeze({ primaries: 'bt709', transfer: 'bt709', space: 'bt709' });

export interface ColourReport {
  /** What the output is stamped with. */
  tags: ColourTags;
  /** True when the source declared fewer than all three axes and `tags` is the bt709 assumption. */
  assumed: boolean;
  /** The axes the source did declare. */
  declared: Partial<ColourTags>;
}

function probeJson(video: string, args: string[], what: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = execFileSync(FFPROBE, ['-v', 'error', ...args, '-of', 'json', video], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`could not read the ${what} of ${video}`, { cause });
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`ffprobe returned unreadable ${what} for ${video}`, { cause });
  }
}

/** The first video stream's requested entries. */
function videoStream(video: string, entries: string, what: string): Record<string, unknown> {
  const streams = probeJson(video, ['-select_streams', 'v:0', '-show_entries', entries], what).streams as
    | Record<string, unknown>[]
    | undefined;
  const stream = streams?.[0];
  if (!stream) throw new Error(`no video stream in ${video}`);
  return stream;
}

/** Display dimensions: a quarter-turn rotation tag swaps them, because ffmpeg autorotates before filtering. */
export function probeDisplaySize(video: string): Display {
  const stream = videoStream(video, 'stream=width,height:stream_side_data=rotation', 'dimensions');
  let { width, height } = stream as { width: number; height: number };
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`ffprobe: bad dims "${width}x${height}" for ${video}`);
  const sideData = (stream.side_data_list ?? []) as { rotation?: number }[];
  const rotation = sideData.find((s) => s.rotation !== undefined)?.rotation;
  if (rotation !== undefined && Math.abs(Math.round(Number(rotation))) % 180 === 90) {
    [width, height] = [height, width];
  }
  return { width, height };
}

export interface FrameRate {
  /** The nominal rate: the grid frames are meant to sit on. */
  fps: number;
  /** ffprobe's own rational, e.g. `30000/1001`: what ffmpeg's -r takes without re-approximating a decimal. */
  rate: string;
  /** Frames actually present per second; below `fps` on a file whose camera skipped frames. Equals
   *  `fps` when ffprobe declares no average, so a missing figure never reads as a skipped frame. */
  averageFps: number;
}

/** Nominal frame rate; the average rate stands in only when no nominal one is declared. */
export function probeFrameRate(video: string): FrameRate {
  const stream = videoStream(video, 'stream=r_frame_rate,avg_frame_rate', 'frame rate');
  const parse = (value: unknown): { fps: number; rate: string } | null => {
    const rate = String(value ?? '');
    const [n, d] = rate.split('/').map(Number);
    const fps = d ? n / d : n;
    return Number.isFinite(fps) && fps > 0 ? { fps, rate } : null;
  };
  const nominal = parse(stream.r_frame_rate);
  const average = parse(stream.avg_frame_rate);
  const found = nominal ?? average;
  if (!found) throw new Error(`${video}: ffprobe reports no usable frame rate`);
  return { ...found, averageFps: (average ?? found).fps };
}

export function probeFps(video: string): number {
  return probeFrameRate(video).fps;
}

export function colourTagsOf(video: string): ColourReport {
  const stream = videoStream(video, 'stream=color_primaries,color_transfer,color_space', 'colour tags');
  const known = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' && value !== 'unknown' && value !== 'reserved' ? value : undefined;
  const declared: { -readonly [K in keyof ColourTags]?: string } = {};
  const primaries = known(stream.color_primaries);
  const transfer = known(stream.color_transfer);
  const space = known(stream.color_space);
  if (primaries) declared.primaries = primaries;
  if (transfer) declared.transfer = transfer;
  if (space) declared.space = space;
  // A partially tagged source is not carried through piecemeal: one declared axis with two assumed
  // ones describes a picture that does not exist.
  if (primaries && transfer && space) return { tags: { primaries, transfer, space }, assumed: false, declared };
  return { tags: ASSUMED_COLOUR, assumed: true, declared };
}

export function hasAudioStream(video: string): boolean {
  const streams = probeJson(video, ['-select_streams', 'a', '-show_entries', 'stream=index'], 'audio streams').streams as
    | unknown[]
    | undefined;
  return (streams?.length ?? 0) > 0;
}

/** Seconds in one stream; the container's figure only when the stream has none (Matroska). */
export function streamDurationOf(video: string, selector: 'a:0' | 'v:0'): number {
  const kind = selector === 'a:0' ? 'audio' : 'video';
  const stream = (probeJson(video, ['-select_streams', selector, '-show_entries', 'stream=duration'], `${kind} duration`).streams as
    | { duration?: string }[]
    | undefined)?.[0];
  if (!stream) throw new Error(`${video} has no ${kind} stream`);
  const fromStream = Number(stream.duration);
  if (Number.isFinite(fromStream) && fromStream > 0) return fromStream;
  const format = probeJson(video, ['-show_entries', 'format=duration'], 'duration').format as { duration?: string } | undefined;
  const fromFormat = Number(format?.duration);
  if (Number.isFinite(fromFormat) && fromFormat > 0) return fromFormat;
  throw new Error(`could not measure the ${kind} duration of ${video}`);
}

export const audioDurationOf = (video: string): number => streamDurationOf(video, 'a:0');
export const videoDurationOf = (video: string): number => streamDurationOf(video, 'v:0');
