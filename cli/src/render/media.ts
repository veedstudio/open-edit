// Seek-friendly stand-ins for the page's footage. Chrome decodes from the previous keyframe on every
// seek, so a camera file with a 10 s GOP costs hundreds of milliseconds per frame. An all-intra copy
// makes each seek decode exactly one frame; the page keeps its own URL and the server answers it with
// the copy, so nothing about the page changes. A copy is made at the size the page draws the picture
// when that is well below the source's, since every seek decodes the whole frame in software and
// hands it to Chrome to scale down, on every rendered and every replayed frame.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FFPROBE } from '../config.ts';
import { oneSourceFree } from '../hdr.ts';
import { alphaInput, NoVideoStream } from '../probe.ts';
import { ffmpegInto } from './encode.ts';

/** Past this many frames between keyframes a seek decodes enough to matter, and the file gets a copy. */
export const MAX_GOP = 12;

/**
 * A copy is made smaller only when it would be at most this fraction of the source on both sides: that
 * is under half the pixels to decode and upload per seek, which is where the copy pays for itself.
 */
export const SHRINK_TO_AT_MOST = 2 / 3;

export interface Size {
  width: number;
  height: number;
}

// Part of the cache key, so a change to how copies are made never serves one made the old way.
const PROXY_ARGS = ['-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '1', '-pix_fmt', 'yuv420p',
  '-fps_mode', 'passthrough', '-an', '-movflags', '+faststart'];
const PROXY_ENCODE = PROXY_ARGS.slice(2);
// A picture with alpha (a cut-out laid over the footage) would lose it in H.264, and its transparent parts would
// cover everything under it; VP9 in WebM is the alpha Chrome plays.
const ALPHA_ARGS = ['-map', '0:v:0', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '16', '-b:v', '0', '-g', '1', '-row-mt', '1',
  '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-fps_mode', 'passthrough', '-an'];

/**
 * The size to make a copy at for a source drawn at `scale` times its own size, or null for the
 * source's own: when the scale is unknown, or the copy would not be small enough to be worth it. Each
 * side is rounded to even for yuv420p, so the aspect may shift by a pixel. Never larger than the source.
 */
export function shownSize(source: Size, scale: number | null): Size | null {
  if (scale === null || !(scale > 0) || !(source.width > 0 && source.height > 0)) return null;
  const even = (n: number) => Math.max(2, 2 * Math.round((n * scale) / 2));
  const size = { width: even(source.width), height: even(source.height) };
  if (size.width > source.width * SHRINK_TO_AT_MOST || size.height > source.height * SHRINK_TO_AT_MOST) return null;
  return size;
}

/** The longest run of frames between keyframes, read from packet flags without decoding. */
export function longestGop(file: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', file],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  let longest = 0;
  let run = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.includes('K')) {
      longest = Math.max(longest, run);
      run = 1;
    } else run++;
  }
  return Math.max(longest, run);
}

/**
 * `probe`, asked once per version of a file (its path, size and time) for the life of the process: a render asks the
 * same questions of each page video while it decides how to serve it, how it was served, and as it copies it.
 */
export function perVersion<T>(probe: (file: string) => T): (file: string) => T {
  const seen = new Map<string, T>();
  return (file) => {
    const st = statSync(file);
    const key = `${file}\0${st.size}\0${st.mtimeMs}`;
    if (!seen.has(key)) seen.set(key, probe(file));
    return seen.get(key)!;
  };
}

/** The input that keeps `file`'s alpha, or null when it has none; a sound a <video> plays has no picture to copy alpha from. */
export const alphaInputOf = perVersion((file): { args: string[]; webm: boolean } | null => {
  try {
    return alphaInput(file);
  } catch (e) {
    if (e instanceof NoVideoStream) return null;
    throw e;
  }
});

/**
 * The all-intra copy of `file` under `dir`, at `size` or the source's own, made once per source
 * version and size and reused after that. The size is in the key, so a page that draws the video
 * larger later gets a copy of its own rather than the small one. An HDR source's conversion to SDR (`sdr`)
 * is applied in the copy, before it is scaled.
 */
export function seekableCopy(file: string, dir: string, size: Size | null = null, sdr?: string): { path: string; made: boolean } {
  const st = statSync(file);
  const chain = [...(sdr ? [sdr] : []), ...(size ? [`scale=${size.width}:${size.height}`] : [])];
  const vf = chain.length ? ['-vf', chain.join(',')] : [];
  // An HDR source's conversion ends in a format without alpha, so its copy is opaque either way.
  const alpha = sdr ? null : alphaInputOf(file);
  const own = alpha ? ALPHA_ARGS : PROXY_ARGS;
  const format = alpha ? 'webm' : 'mp4';
  // Spread, so a copy at the source's own size keeps the key it had before sizes were part of it.
  const key = createHash('sha1').update(JSON.stringify([file, st.size, st.mtimeMs, own, ...vf])).digest('hex').slice(0, 16);
  const path = join(dir, `${basename(file).replace(/[^\w.-]+/g, '_')}.${key}.${format}`);
  if (existsSync(path)) return { path, made: false };
  mkdirSync(dir, { recursive: true });
  // An HDR source goes through a graph with two sources, so no ffmpeg copies its HDR10 metadata into the copy.
  const args = sdr ? [...oneSourceFree(file, chain.join(',')), ...PROXY_ENCODE] : [...(alpha?.args ?? []), '-i', file, ...own, ...vf];
  ffmpegInto(`${path}.${process.pid}.tmp`, path, ['-v', 'error', '-y', ...args, '-f', format], `could not make a seekable copy of ${file}`);
  return { path, made: true };
}
