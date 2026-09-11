// Clips ffmpeg synthesises for the tests that cannot be asserted on a string, and the probes that
// read the results back. One copy, so every ffmpeg-backed test builds its fixtures the same way.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG, FFPROBE } from '../../src/config.ts';

/** A temp directory removed when the process exits. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `open-edit-${prefix}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface SynthSpec {
  /** lavfi video source, e.g. `testsrc=size=320x240:rate=25`; omit for audio only. */
  video?: string;
  /** lavfi audio source, e.g. `sine=frequency=440:sample_rate=48000`; omit for a silent picture. */
  audio?: string;
  seconds?: number;
  /** A video filter chain applied before encoding, e.g. `setparams=...`. */
  vf?: string;
}

export const TESTSRC = 'testsrc=size=320x240:rate=25';
export const SINE = 'sine=frequency=440:sample_rate=48000';

export function synthClip(dir: string, name: string, spec: SynthSpec): string {
  const path = join(dir, name);
  const args = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error'];
  if (spec.video) args.push('-f', 'lavfi', '-i', spec.video);
  if (spec.audio) args.push('-f', 'lavfi', '-i', spec.audio);
  args.push('-t', String(spec.seconds ?? 2));
  if (spec.vf) args.push('-vf', spec.vf);
  if (spec.video) args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (spec.audio) args.push('-c:a', 'aac');
  args.push(path);
  execFileSync(FFMPEG, args);
  return path;
}

/** Remux `src` with a display-rotation tag, the way phone footage stores a portrait recording. */
export function rotatedCopy(src: string, dst: string, degrees: number): string {
  execFileSync(FFMPEG, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
    '-display_rotation', String(degrees), '-i', src, '-c', 'copy', dst,
  ]);
  return dst;
}

/** One stream's entries, as ffprobe prints them (strings). */
export function probeStream(file: string, selector: string, entries: string): Record<string, string> {
  const raw = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', selector, '-show_entries', `stream=${entries}`, '-of', 'json', file,
  ], { encoding: 'utf8' });
  return ((JSON.parse(raw).streams ?? []) as Record<string, string>[])[0] ?? {};
}

/** Frames actually present in the first video stream, counted rather than read off the header. */
export function countFrames(file: string): number {
  const raw = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' }).trim();
  return Number(raw);
}

/** Run `fn` with console output captured; returns what it printed. */
export function captureConsole<T>(fn: () => T): { result: T; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const warn = console.warn;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { err.push(a.join(' ')); };
  try {
    return { result: fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
}

/** The async twin of captureConsole: console is restored only after `fn` settles. */
export async function captureConsoleAsync<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const warn = console.warn;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { err.push(a.join(' ')); };
  try {
    return { result: await fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
}

/** Run `fn` with OPEN_EDIT_ROOT pointed at `root`, restoring whatever was there. */
export async function withRoot<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.OPEN_EDIT_ROOT;
  process.env.OPEN_EDIT_ROOT = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPEN_EDIT_ROOT; else process.env.OPEN_EDIT_ROOT = previous;
  }
}
