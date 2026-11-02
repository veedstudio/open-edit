// The record of on-screen text a video render writes beside its output, `<out>.text.json`, for the review's checks.
// Only the renderer can write it: it alone knows how the page's frames land on the video's timeline and pixels (the
// stage's place in the page, the capture scale, the frame rate). It holds the text the page draws in its own HTML and
// SVG, not text inside an image, a canvas or the footage.
//
// An example of the shape (version 1; the fields are documented on TextRecord, TextSample and TextEntry):
//   { "version": 1, "page": "/abs/index.html", "width": 1080, "height": 1920, "fps": "30000/1001", "frames": 900,
//     "transparent": false, "framesPerSample": 3,
//     "samples": [{ "frame": 0, "time": 0, "texts": [{ "text": "Hello", "box": [96, 1500, 410, 74], "fontSize": 64,
//       "color": [255, 255, 255, 1], "opacity": 1, "selector": "#stage>div:nth-child(2)" }] }, ...] }
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readJsonFile } from '../json-file.ts';
import { writeTextAtomic } from '../providers/exclusive-files.ts';
import { TEXT_SAMPLER_SCRIPT, type TextEntry } from './text-sampler.ts';
import { frameTime, parseFps, type Fps, type Segment } from './timing.ts';

export type { TextEntry } from './text-sampler.ts';

/**
 * How often, in page time, the text is read, to the nearest whole frame. A spoken word lasts about a quarter of a
 * second, so even a caption showing one word at a time is read at least twice, and reading the page stays a small
 * share of a frame's cost.
 */
export const SAMPLE_MS = 100;

const RECORD_VERSION = 1;

export interface TextSample {
  /** The sampled frame, a multiple of the record's framesPerSample; it stands for the frames up to the next sample. */
  frame: number;
  /** The frame's time in seconds, to the millisecond, for a reader of the file; the checks go by the frame. */
  time: number;
  /** Every text the frame shows; empty when it shows none. */
  texts: TextEntry[];
}

export interface TextRecord {
  version: typeof RECORD_VERSION;
  /** The rendered page's absolute path. */
  page: string;
  /** The video's size in pixels, which every box and font size is in. */
  width: number;
  height: number;
  /** The frame rate, an integer or an exact rational such as 30000/1001. */
  fps: string;
  frames: number;
  /** A render with alpha, whose background is not in the video. */
  transparent: boolean;
  framesPerSample: number;
  /** Frames 0, framesPerSample, 2 x framesPerSample and so on, below `frames`. */
  samples: TextSample[];
}

/** Frames from one sample to the next: the frame rate's nearest whole number of frames to SAMPLE_MS. */
export const sampleEvery = (fps: Fps): number => Math.max(1, Math.round((SAMPLE_MS * fps.num) / (1000 * fps.den)));

/** The sampled frames of one segment. */
export function sampledFrames(segment: Segment, every: number): number[] {
  const frames: number[] = [];
  for (let f = Math.ceil(segment.start / every) * every; f < segment.start + segment.frames; f += every) frames.push(f);
  return frames;
}

export const sampleAt = (frame: number, fps: Fps, texts: TextEntry[]): TextSample =>
  ({ frame, time: Math.round(frameTime(frame, fps) * 1000) / 1000, texts });

/** Seconds into the video at which a frame of the record is shown. */
export const timeOf = (record: TextRecord, frame: number): number => frameTime(frame, parseFps(record.fps));

/** Seconds from one sample to the next. */
export const sampleSeconds = (record: TextRecord): number => timeOf(record, record.framesPerSample);

/** Seconds of picture the record covers. */
export const recordSeconds = (record: TextRecord): number => timeOf(record, record.frames);

/** `<video>.text.json`: where a video's record is, beside it. */
export const recordPath = (video: string): string => `${video}.text.json`;

// A cached segment's samples are kept only while the sampler that read them is the one running, so a patch after an
// upgrade never splices samples measured one way beside samples measured another.
const SAMPLER = createHash('sha256').update(TEXT_SAMPLER_SCRIPT).digest('hex').slice(0, 16);

interface SegmentText {
  version: typeof RECORD_VERSION;
  sampler: string;
  framesPerSample: number;
  samples: TextSample[];
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A segment's samples, kept in the render's cache beside its video so a patch re-reads only what it re-renders. */
export function writeSegmentText(file: string, framesPerSample: number, samples: TextSample[]): void {
  writeTextAtomic(file, json({ version: RECORD_VERSION, sampler: SAMPLER, framesPerSample, samples } satisfies SegmentText));
}

/**
 * A cached segment's samples, or why they cannot be reused (missing, unreadable, read by another sampler or on other
 * frames), so the segment is rendered again.
 */
export function readSegmentText(file: string, segment: Segment, framesPerSample: number): TextSample[] | { unusable: string } {
  if (!existsSync(file)) return { unusable: 'no text cached' };
  let kept: SegmentText;
  try {
    kept = readJsonFile(file) as SegmentText;
  } catch (error) {
    return { unusable: `its cached text is unreadable (${(error as Error).message})` };
  }
  if (kept?.version !== RECORD_VERSION || kept.sampler !== SAMPLER || kept.framesPerSample !== framesPerSample) {
    return { unusable: 'its text was read by another version of render' };
  }
  const want = sampledFrames(segment, framesPerSample);
  const whole = Array.isArray(kept.samples) && kept.samples.length === want.length
    && kept.samples.every((s, i) => s?.frame === want[i] && Array.isArray(s.texts) && s.texts.every(isEntry));
  return whole ? kept.samples : { unusable: 'its cached text is damaged' };
}

export function writeRecord(video: string, record: Omit<TextRecord, 'version'>): void {
  writeTextAtomic(recordPath(video), json({ version: RECORD_VERSION, ...record }));
}

/** Removes a video's record, before the video is replaced, so a failure in between never leaves it describing the old picture. */
export const dropRecord = (video: string): void => rmSync(recordPath(video), { force: true });

/**
 * A video's record as it stands, for a command that copies the picture unchanged into a new file, or null when there
 * is none or it is older than the video, so describes a picture written there before.
 */
export function takeRecord(video: string): string | null {
  const file = recordPath(video);
  if (!existsSync(file) || statSync(file).mtimeMs < statSync(video).mtimeMs) return null;
  return readFileSync(file, 'utf8');
}

/** Gives a video the record taken from the one its picture was copied from, newer than the video as a record must be. */
export const putRecord = (video: string, record: string): void => writeTextAtomic(recordPath(video), record);

const numbers = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

function isEntry(e: unknown): e is TextEntry {
  const x = e as TextEntry;
  return !!x && typeof x.text === 'string' && Number.isFinite(x.fontSize) && Number.isFinite(x.opacity) && typeof x.selector === 'string'
    && numbers(x.box, 4) && numbers(x.color, 4);
}

const positive = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

/** A record read back, or an error naming the file and what is wrong with it. */
export function readRecord(file: string): TextRecord {
  const record = readJsonFile(file) as TextRecord;
  const fail = (what: string): never => { throw new Error(`${file} is not a text record ${what}; render the video again to write one`); };
  if (record?.version !== RECORD_VERSION) fail(`this version reads (version ${JSON.stringify(record?.version)})`);
  if (typeof record.page !== 'string' || typeof record.transparent !== 'boolean' || typeof record.fps !== 'string') {
    fail('(its page, transparent or fps field is missing)');
  }
  if (!positive(record.width) || !positive(record.height) || !positive(record.frames) || !positive(record.framesPerSample)) {
    fail('(its width, height, frames or framesPerSample is not a positive whole number)');
  }
  let fps: Fps;
  try {
    fps = parseFps(record.fps);
  } catch {
    return fail(`(its fps ${JSON.stringify(record.fps)} is not a frame rate)`);
  }
  const { samples, framesPerSample: every } = record;
  if (!Array.isArray(samples) || samples.length !== Math.ceil(record.frames / every)) fail(`(it should hold ${Math.ceil(record.frames / every)} samples)`);
  samples.forEach((s, k) => {
    if (s?.frame !== k * every || !(Math.abs(s.time - frameTime(s.frame, fps)) <= 0.001)) fail(`(sample ${k} is not frame ${k * every} at its time)`);
    if (!Array.isArray(s.texts) || !s.texts.every(isEntry)) fail(`(a text of frame ${s.frame} is missing a field or has one of the wrong kind)`);
  });
  return record;
}
