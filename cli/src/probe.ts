// What ffprobe knows about a file, asked once here rather than re-typed by every command that needs it.
import { execFileSync, spawnSync } from 'node:child_process';
import { FFMPEG, FFPROBE } from './config.ts';

export interface Display {
  width: number;
  height: number;
}

export interface ColourTags {
  readonly primaries: string;
  readonly transfer: string;
  readonly space: string;
}

export const BT709: ColourTags = Object.freeze({ primaries: 'bt709', transfer: 'bt709', space: 'bt709' });
export const ASSUMED_COLOUR = BT709;

/**
 * The matrices of BT.601 (by both its names) and BT.709: the SD and HD pictures the bt709 assumption's primaries and
 * transfer describe, so a file that declares one of them and nothing else is not contradicted by the assumption, and a
 * join converts its picture from that matrix (see joinColour in colour.ts).
 */
export const SDR_MATRICES: ReadonlySet<string> = new Set(['bt709', 'bt470bg', 'smpte170m']);

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

/** A file ffprobe read, with no picture in it: a sound file, as a page's `<video>` may play one. */
export class NoVideoStream extends Error {}

/** The first video stream's requested entries. */
function videoStream(video: string, entries: string, what: string): Record<string, unknown> {
  const streams = probeJson(video, ['-select_streams', 'v:0', '-show_entries', entries], what).streams as
    | Record<string, unknown>[]
    | undefined;
  const stream = streams?.[0];
  if (!stream) throw new NoVideoStream(`no video stream in ${video}`);
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

/**
 * The size the picture is shown at in square pixels: probeDisplaySize stretched by a non-square sample aspect
 * (anamorphic footage stores 1440x1080 for a 1920x1080 picture), along the stored width, which a quarter-turn
 * rotation makes the shown height. `sar` is 1 for square pixels.
 */
export function probeSquareSize(video: string): Display & { sar: number } {
  const stream = videoStream(video, 'stream=width,height,sample_aspect_ratio:stream_side_data=rotation', 'pixel aspect');
  const [n, d] = String(stream.sample_aspect_ratio ?? '').split(':').map(Number);
  const sar = n > 0 && d > 0 ? n / d : 1;
  const { width, height } = probeDisplaySize(video);
  if (sar === 1) return { width, height, sar };
  const rotation = ((stream.side_data_list ?? []) as { rotation?: number }[]).find((s) => s.rotation !== undefined)?.rotation;
  const turned = rotation !== undefined && Math.abs(Math.round(Number(rotation))) % 180 === 90;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return turned ? { width, height: even(height * sar), sar } : { width: even(width * sar), height, sar };
}

/** The first video stream's codec as ffprobe names it, e.g. `hevc`. */
export function codecOf(video: string): string {
  return String(videoStream(video, 'stream=codec_name', 'codec').codec_name ?? '');
}

/** The first video stream's pixel format as ffmpeg names it, e.g. `yuv420p10le`. */
export function pixelFormatOf(video: string): string {
  return String(videoStream(video, 'stream=pix_fmt', 'pixel format').pix_fmt ?? '');
}

const WITH_ALPHA = /^(yuva|gbrap|ya\d|rgba|bgra|argb|abgr)/;

/**
 * Whether the first video stream carries alpha, and if so the input arguments that decode it with the alpha:
 * `args` go before `-i`, and are empty when ffmpeg's own decoder keeps it; `webm` says Chrome plays it as it is.
 * A WebM keeps VP8 or VP9 alpha beside the picture, tagged alpha_mode, and ffmpeg's native decoders drop it, so
 * libvpx is named for those.
 */
export function alphaInput(video: string): { args: string[]; webm: boolean } | null {
  const s = videoStream(video, 'stream=codec_name,pix_fmt:stream_tags', 'pixel format');
  const tags = (s.tags ?? {}) as Record<string, unknown>;
  const mode = Object.entries(tags).find(([k]) => k.toLowerCase() === 'alpha_mode')?.[1];
  if (String(mode) === '1' && (s.codec_name === 'vp9' || s.codec_name === 'vp8')) {
    const args = ['-c:v', s.codec_name === 'vp9' ? 'libvpx-vp9' : 'libvpx'];
    // The tag outlives a re-encode that dropped the alpha, so the first frame is decoded to see it is there.
    const r = spawnSync(FFMPEG, ['-nostdin', '-v', 'error', ...args, '-i', video, '-map', '0:v:0', '-frames:v', '1', '-vf', 'alphaextract', '-f', 'null', '-']);
    return r.status === 0 ? { args, webm: true } : null;
  }
  return WITH_ALPHA.test(String(s.pix_fmt ?? '')) ? { args: [], webm: false } : null;
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

const knownColour = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value !== 'unknown' && value !== 'reserved' ? value : undefined;

export function colourTagsOf(video: string): ColourReport {
  return reportOf(videoStream(video, 'stream=color_primaries,color_transfer,color_space', 'colour tags'));
}

/** A source's colour as its frames come out of the decoder (see decodedColourOf). */
export interface DecodedColour extends ColourReport {
  /** Full range; an unlabelled picture is read as limited. */
  full: boolean;
  /** The decoded pixel format, e.g. `yuv420p`, `yuvj420p` or `rgb24`. */
  pixFmt: string;
}

/**
 * colourTagsOf, with each axis the file leaves unset read from its first decoded frame: a decoder labels its frames
 * by its codec's own convention where the container says nothing, as VP8's BT.601 matrix in a WebM. Range likewise.
 */
export function decodedColourOf(video: string): DecodedColour {
  const stream = videoStream(video, 'stream=color_primaries,color_transfer,color_space,color_range,pix_fmt', 'colour tags');
  let frame: Record<string, unknown> = {};
  try {
    const frames = probeJson(video, ['-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries',
      'frame=color_primaries,color_transfer,color_space,color_range'], 'decoded colour').frames as Record<string, unknown>[] | undefined;
    frame = frames?.[0] ?? {};
  } catch {
    // Without a first frame ffprobe can decode, the file's own declaration stands.
  }
  const axis = (key: string) => knownColour(stream[key]) ?? knownColour(frame[key]);
  const pixFmt = String(stream.pix_fmt ?? '');
  return {
    ...reportOf({ color_primaries: axis('color_primaries'), color_transfer: axis('color_transfer'), color_space: axis('color_space') }),
    full: axis('color_range') === 'pc' || pixFmt.startsWith('yuvj'),
    pixFmt,
  };
}

function reportOf(axes: Record<string, unknown>): ColourReport {
  const declared: { -readonly [K in keyof ColourTags]?: string } = {};
  const primaries = knownColour(axes.color_primaries);
  const transfer = knownColour(axes.color_transfer);
  const space = knownColour(axes.color_space);
  if (primaries) declared.primaries = primaries;
  if (transfer) declared.transfer = transfer;
  if (space) declared.space = space;
  if (primaries && transfer && space) return { tags: { primaries, transfer, space }, assumed: false, declared };
  // A partially tagged source is not carried through piecemeal: one declared axis with two assumed ones describes a
  // picture that may not exist. What it does declare is kept in `declared`, where a join reads its matrix.
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

/**
 * The first video stream's own length: its duration, else the DURATION tag Matroska writes for each stream,
 * less where the stream starts, since the tag is where it ends. Null when only the container's length is
 * known, since that counts the audio too.
 */
export function ownVideoDurationOf(video: string): number | null {
  const stream = videoStream(video, 'stream=duration,start_time:stream_tags', 'video duration');
  const own = Number(stream.duration);
  if (Number.isFinite(own) && own > 0) return own;
  const tag = Object.entries((stream.tags ?? {}) as Record<string, string>).find(([k]) => /^DURATION(-\w+)?$/i.test(k))?.[1];
  const hms = tag?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!hms) return null;
  const start = Number(stream.start_time);
  return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) - (Number.isFinite(start) && start > 0 ? start : 0);
}

/** Where one stream starts on the file's timeline, in seconds; 0 when ffprobe declares no start. */
export function streamStartOf(video: string, selector: 'a:0' | 'v:0'): number {
  const kind = selector === 'a:0' ? 'audio' : 'video';
  const stream = (probeJson(video, ['-select_streams', selector, '-show_entries', 'stream=start_time'], `${kind} start`).streams as
    | { start_time?: string }[]
    | undefined)?.[0];
  const start = Number(stream?.start_time);
  return Number.isFinite(start) ? start : 0;
}

export const audioDurationOf = (video: string): number => streamDurationOf(video, 'a:0');
export const videoDurationOf = (video: string): number => streamDurationOf(video, 'v:0');
/** Seconds of picture alone: videoDurationOf falls back to a Matroska container's length, which counts the audio too. */
export const pictureDurationOf = (video: string): number => ownVideoDurationOf(video) ?? videoDurationOf(video);

/**
 * Where the video's first frame starts and its last ends, in seconds on the clock ffmpeg filters see, which
 * starts at the earliest stream: an MP4 whose picture begins a second after its sound has its frames from 1 s.
 */
export function probeVideoSpan(video: string): { start: number; end: number } {
  const format = probeJson(video, ['-show_entries', 'format=start_time,duration'], 'start time').format as
    | { start_time?: string; duration?: string }
    | undefined;
  const stream = videoStream(video, 'stream=start_time,duration', 'start time');
  const origin = Number(format?.start_time);
  const first = Number(stream.start_time);
  const start = Number.isFinite(origin) && Number.isFinite(first) ? Math.max(0, first - origin) : 0;
  const own = Number(stream.duration);
  if (Number.isFinite(own) && own > 0) return { start, end: start + own };
  // A stream with no duration of its own (Matroska): the container's, which is measured from that clock's start.
  const whole = Number(format?.duration);
  if (Number.isFinite(whole) && whole > 0) return { start, end: whole };
  throw new Error(`could not measure the video duration of ${video}`);
}
