// Where a picture holds still: a grey, small copy of it, each frame compared with the one a tenth of a second
// before. The copy can come off a decode that runs anyway, as apply-edl's encode of each range, or a decode of its own.
import { spawn } from 'node:child_process';
import { FFMPEG } from './config.ts';
import { probeSquareSize } from './probe.ts';
import { readingSeconds, TAIL_SECONDS } from './verify/dead-tail.ts';

/** The picture is compared this many times a second, so every change spans a tenth of a second whatever the frame rate. */
export const SCAN_RATE = 10;

/** Compared on a grey copy this wide, which averages away grain and keeps the pass near the cost of the decode. */
export const SCAN_WIDTH = 128;

/** A change is measured in squares this many scan pixels across: a sixteenth of the width. */
export const BLOCK = 8;

/** Frozen: no square changes by this many 8-bit levels on average in a tenth of a second. */
export const FROZEN_LEVELS = 0.5;

/** Nearly still: the square that changes most changes by less than this, as a median over STILL_WINDOW changes. */
export const STILL_LEVELS = 2;

/** About a second of changes, so one encoder keyframe nudging a still, or one flicker, does not end it. */
export const STILL_WINDOW = 11;

/**
 * A still with nothing heard under it may hold this long: the time a viewer is given to find text on a fresh frame,
 * then the beat after the last thing to take in.
 */
export const STILL_SECONDS = readingSeconds(0) + TAIL_SECONDS;

/** The mean absolute difference of the BLOCK square of grey frame `b` that differs most from frame `a`, in levels. */
export function peakChange(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const across = width / BLOCK;
  const squares = new Float64Array(across * (height / BLOCK));
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / BLOCK) * across;
    for (let x = 0; x < width; x++) squares[row + Math.floor(x / BLOCK)] += Math.abs(a[y * width + x] - b[y * width + x]);
  }
  return Math.max(...squares) / (BLOCK * BLOCK);
}

/** The grey copy's size for a picture of `width` by `height`: SCAN_WIDTH across, its shape kept in whole BLOCK squares. */
export function scanSize(width: number, height: number): { width: number; height: number } {
  return { width: SCAN_WIDTH, height: Math.max(BLOCK, Math.round((SCAN_WIDTH * height) / width / BLOCK) * BLOCK) };
}

/** The filter that turns a picture into the scan's grey copy. */
export const scanFilter = (size: { width: number; height: number }): string =>
  `fps=${SCAN_RATE},scale=${size.width}:${size.height}:flags=area,format=gray`;

/**
 * Reads the grey copy as raw frames arrive, two at a time so a long picture never sits whole in memory, into how
 * much it changes in each tenth of a second, by peakChange: entry i compares frames i and i + 1.
 */
export class ChangeReader {
  readonly changes: number[] = [];
  private readonly size: { width: number; height: number };
  private frame: Buffer;
  private previous: Buffer | null = null;
  private filled = 0;

  constructor(size: { width: number; height: number }) {
    this.size = size;
    this.frame = Buffer.alloc(size.width * size.height);
  }

  push(chunk: Buffer): void {
    const bytes = this.frame.length;
    for (let at = 0; at < chunk.length;) {
      const n = Math.min(bytes - this.filled, chunk.length - at);
      chunk.copy(this.frame, this.filled, at, at + n);
      this.filled += n;
      at += n;
      if (this.filled < bytes) continue;
      if (this.previous) this.changes.push(peakChange(this.previous, this.frame, this.size.width, this.size.height));
      [this.previous, this.frame] = [this.frame, this.previous ?? Buffer.alloc(bytes)];
      this.filled = 0;
    }
  }
}

/** How much `video`'s picture changes in each tenth of a second, from a decode of its own (see ChangeReader). */
export function changesIn(video: string): Promise<number[]> {
  const shown = probeSquareSize(video);
  const reader = new ChangeReader(scanSize(shown.width, shown.height));
  const args = ['-nostdin', '-v', 'error', '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', scanFilter(scanSize(shown.width, shown.height)), '-f', 'rawvideo', '-'];
  return new Promise((done, fail) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => reader.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString(); });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (code === 0) done(reader.changes);
      else fail(new Error(`ffmpeg could not decode the picture of ${video} (${said.trim().split('\n').pop() || signal || `exit ${code}`})`));
    });
  });
}

export interface Span {
  start: number;
  end: number;
}

export interface Still extends Span {
  /** Seconds of its longest part with nothing in the picture changing at all. */
  frozen: number;
}

/** Each change's median over the STILL_WINDOW centred on it, fewer at the ends. */
function medians(values: number[]): number[] {
  const half = Math.floor(STILL_WINDOW / 2);
  return values.map((_, i) => {
    const near = values.slice(Math.max(0, i - half), i + half + 1).sort((a, b) => a - b);
    return near[Math.floor(near.length / 2)];
  });
}

/**
 * The stretches of `changes` between `from` and `to` seconds held nearly still where `quiet` says nothing is heard,
 * longer than STILL_SECONDS, each with its longest frozen part. A run of changes from frame a to frame b holds the
 * picture from a's time until b's frame gives way, a tenth of a second after it, or `to`.
 */
export function quietStillsOf(changes: number[], from: number, to: number, quiet: (span: Span) => boolean): Still[] {
  const median = medians(changes);
  const first = Math.ceil(from * SCAN_RATE - 1e-6);
  const last = Math.floor(to * SCAN_RATE + 1e-6) - 1;
  const held = (frames: number) => frames / SCAN_RATE;
  const stills: Still[] = [];
  let run: number | null = null;
  let frozen = 0;
  let longest = 0;
  for (let i = first; i <= last + 1; i++) {
    const span = { start: i / SCAN_RATE, end: (i + 1) / SCAN_RATE };
    if (i <= last && i < changes.length && median[i] < STILL_LEVELS && quiet(span)) {
      run ??= i;
      frozen = changes[i] < FROZEN_LEVELS ? frozen + 1 : 0;
      longest = Math.max(longest, frozen);
      continue;
    }
    if (run !== null) {
      const end = Math.min(to, held(i + 1));
      if (end - held(run) > STILL_SECONDS + 1e-9) {
        stills.push({ start: held(run), end, frozen: longest > 0 ? Math.min(end - held(run), held(longest + 1)) : 0 });
      }
    }
    run = null;
    frozen = 0;
    longest = 0;
  }
  return stills;
}
