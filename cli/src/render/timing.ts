// Frame arithmetic for the renderer. A rate is kept as the exact rational it is, so frame i sits at
// i·den/num seconds and 30000/1001 never drifts the way 29.97 does over a long render.

export interface Fps {
  num: number;
  den: number;
}

const DECIMAL_HINTS: Record<string, string> = {
  '23.976': '24000/1001',
  '23.98': '24000/1001',
  '29.97': '30000/1001',
  '47.952': '48000/1001',
  '59.94': '60000/1001',
};

/** `30` or `30000/1001`. A decimal is refused: 29.97 is not the rate a 30000/1001 source runs at. */
export function parseFps(raw: string): Fps {
  const s = raw.trim();
  const m = /^(\d+)(?:\/(\d+))?$/.exec(s);
  if (!m) {
    const hint = DECIMAL_HINTS[s];
    throw new Error(`--fps wants an integer or an exact rational such as 30000/1001; got "${raw}"${hint ? ` (did you mean ${hint}?)` : ''}`);
  }
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (num <= 0 || den <= 0 || num / den > 1000) throw new Error(`--fps ${raw} is not a usable frame rate`);
  return { num, den };
}

export const fpsLabel = (f: Fps): string => (f.den === 1 ? String(f.num) : `${f.num}/${f.den}`);

/** Seconds at which frame i is shown. */
export const frameTime = (i: number, f: Fps): number => (i * f.den) / f.num;

/** Frames in a duration, rounded to the nearest whole frame. */
export function framesForDuration(sec: number, f: Fps): number {
  return Math.round((sec * f.num) / f.den);
}

/** The frame on screen at `sec`: the last one whose time is not after it. */
export function frameAtTime(sec: number, f: Fps): number {
  return Math.floor((sec * f.num) / f.den + 1e-6);
}

export interface Segment {
  index: number;
  /** First frame. */
  start: number;
  frames: number;
}

export function segmentFramesFor(segmentSec: number, f: Fps): number {
  return Math.max(1, Math.round((segmentSec * f.num) / f.den));
}

export function planSegments(total: number, segmentFrames: number): Segment[] {
  const out: Segment[] = [];
  for (let start = 0, index = 0; start < total; start += segmentFrames, index++) {
    out.push({ index, start, frames: Math.min(segmentFrames, total - start) });
  }
  return out;
}

/**
 * The frames whose display interval meets [fromSec, toSec): a range that starts or ends inside a frame
 * takes that frame too, so a patch never leaves a sliver of the named moment unrendered, while the
 * frame that starts exactly at toSec lies past the range.
 */
export function frameSpan(fromSec: number, toSec: number, f: Fps, total: number): { from: number; to: number } {
  const from = Math.max(0, frameAtTime(fromSec, f));
  const to = Math.min(total, Math.ceil((toSec * f.num) / f.den - 1e-6));
  return { from, to: Math.max(to, from + 1) };
}

/** Segments that hold any frame of [from, to). */
export function segmentsTouching(segments: Segment[], from: number, to: number): Segment[] {
  return segments.filter((s) => s.start < to && s.start + s.frames > from);
}

/** Frames [from, to) of one segment. */
export interface Piece {
  segment: Segment;
  from: number;
  to: number;
}

/**
 * Cuts the frames of these segments into at most `n` contiguous runs of near-equal length. A run may
 * begin or end inside a segment, so a patch of two segments still keeps every worker busy.
 */
export function splitFrames(segments: Segment[], n: number): Piece[][] {
  const total = segments.reduce((sum, s) => sum + s.frames, 0);
  const count = Math.max(1, Math.min(n, total));
  const runs: Piece[][] = [[]];
  let taken = 0;
  let boundary = Math.round(total / count);
  for (const segment of segments) {
    let cursor = segment.start;
    const end = segment.start + segment.frames;
    while (cursor < end) {
      if (taken >= boundary) {
        runs.push([]);
        boundary = Math.round((total * runs.length) / count);
      }
      const take = Math.min(end - cursor, boundary - taken);
      runs[runs.length - 1].push({ segment, from: cursor, to: cursor + take });
      cursor += take;
      taken += take;
    }
  }
  return runs;
}

/**
 * Splits ordered items into at most `n` runs of neighbours of near-equal length. A session only steps
 * forward, so each run stays in order; runs stay contiguous to keep each worker's preroll short.
 */
export function splitContiguous<T>(items: T[], n: number): T[][] {
  const groups: T[][] = [];
  const total = items.length;
  const count = Math.max(1, Math.min(n, items.length));
  let acc = 0;
  let current: T[] = [];
  for (const item of items) {
    current.push(item);
    acc += 1;
    const boundary = (total * (groups.length + 1)) / count;
    if (acc >= boundary - 1e-9 && groups.length < count - 1) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Workers for `frames` frames: at most `wanted`, and never so many that one gets fewer than `perWorker`. */
export function workersFor(frames: number, wanted: number, perWorker: number): number {
  return Math.max(1, Math.min(wanted, Math.floor(frames / perWorker)));
}
