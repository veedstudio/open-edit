// Clips ffmpeg synthesises for the tests that cannot be asserted on a string, and the probes that
// read the results back. One copy, so every ffmpeg-backed test builds its fixtures the same way.
import { execFileSync, spawnSync } from 'node:child_process';
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

/** Frame `index` of `file` as raw pixels, after `vf` when given: what a comparison reads. */
export function rawFrame(file: string, index: number, vf?: string, pixFmt = 'yuv420p'): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `${vf ? `${vf},` : ''}select=eq(n\\,${index}),format=${pixFmt}`,
    '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
}

/** The mean absolute difference of two equal-sized buffers, in levels. */
export const meanAbsDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) throw new Error(`frames differ in size: ${a.length} and ${b.length} bytes`);
  return a.reduce((sum, x, i) => sum + Math.abs(x - b[i]), 0) / a.length;
};

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

/** The colour the flat clips below are made of, as RGB. */
export const FLAT_RGB = [0x33, 0xcc, 0x66];

/**
 * One second of FLAT_RGB with a tone, labelled no more than `kind` says, each the way its footage arrives: a VP8 WebM
 * (BT.601 by the codec, which its decoder alone labels, matrix and range), the BT.601 matrix declared on its own, no
 * label at all over a BT.709 picture (what an untagged file is taken for), a full-range BT.709 file, and RGB in a MOV.
 */
export function flatClip(dir: string, kind: 'vp8' | 'matrix' | 'untagged' | 'full' | 'rgb'): string {
  const out = join(dir, `${kind}.${kind === 'vp8' ? 'webm' : kind === 'rgb' ? 'mov' : 'mp4'}`);
  // Drawn in RGB and converted with exact rounding, so each file holds the colour itself, not swscale's rounding of it.
  const to = (matrix: string, range = 'tv') => `scale=out_color_matrix=${matrix}:out_range=${range}:flags=accurate_rnd+full_chroma_int,format=yuv420p`;
  const vf = {
    vp8: to('bt601'),
    matrix: `${to('bt601')},setparams=colorspace=bt470bg`,
    untagged: to('bt709'),
    full: `${to('bt709', 'pc')},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=pc`,
    rgb: 'null',
  }[kind];
  const codec = kind === 'vp8' ? ['-c:v', 'libvpx', '-b:v', '2M', '-c:a', 'libopus'] : ['-c:v', kind === 'rgb' ? 'png' : 'libx264', '-c:a', 'aac'];
  const colour = `0x${FLAT_RGB.map((c) => c.toString(16)).join('')}`;
  execFileSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=640x360:r=30:d=1,format=rgb24`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=1', '-vf', vf, ...codec, '-shortest', out]);
  return out;
}

/** The mean colour of frame `index` as a player shows it: decoded by the matrix and range its frames are labelled with. */
export function shownRgb(file: string, index = 0): number[] {
  const px = rawFrame(file, index, 'scale=in_color_matrix=auto:in_range=auto:flags=accurate_rnd+full_chroma_int,format=rgb24', 'rgb24');
  const sum = [0, 0, 0];
  px.forEach((v, i) => { sum[i % 3] += v; });
  return sum.map((v) => v / (px.length / 3));
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

/**
 * Each channel's RMS level in one narrow band around `hz`, in dBFS, over the whole file or the `window` in
 * seconds: one tone's level when each source is a tone of its own.
 */
export function bandLevels(file: string, hz: number, window?: [number, number]): number[] {
  const trim = window ? `atrim=${window[0]}:${window[1]},` : '';
  const { stderr } = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', `${trim}bandpass=f=${hz}:width_type=q:w=8,astats=measure_overall=none:measure_perchannel=RMS_level`, '-f', 'null', '-',
  ], { encoding: 'utf8' });
  return [...(stderr ?? '').matchAll(/RMS level dB: (\S+)/g)].map(([, v]) => (v === '-inf' ? -Infinity : Number(v)));
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
