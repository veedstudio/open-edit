// Seek-friendly stand-ins for the page's footage. Chrome decodes from the previous keyframe on every
// seek, so a camera file with a 10 s GOP costs hundreds of milliseconds per frame. An all-intra copy
// makes each seek decode exactly one frame; the page keeps its own URL and the server answers it with
// the copy, so nothing about the page changes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FFPROBE } from '../config.ts';
import { ffmpegInto } from './encode.ts';

/** Past this many frames between keyframes a seek decodes enough to matter, and the file gets a copy. */
export const MAX_GOP = 12;

// Part of the cache key, so a change to how copies are made never serves one made the old way.
const PROXY_ARGS = ['-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '1', '-pix_fmt', 'yuv420p',
  '-fps_mode', 'passthrough', '-an', '-movflags', '+faststart'];

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

/** The all-intra copy of `file` under `dir`, made once per source version and reused after that. */
export function seekableCopy(file: string, dir: string): { path: string; made: boolean } {
  const st = statSync(file);
  const key = createHash('sha1').update(JSON.stringify([file, st.size, st.mtimeMs, PROXY_ARGS])).digest('hex').slice(0, 16);
  const path = join(dir, `${basename(file).replace(/[^\w.-]+/g, '_')}.${key}.mp4`);
  if (existsSync(path)) return { path, made: false };
  mkdirSync(dir, { recursive: true });
  ffmpegInto(`${path}.${process.pid}.tmp`, path, ['-v', 'error', '-y', '-i', file, ...PROXY_ARGS, '-f', 'mp4'], `could not make a seekable copy of ${file}`);
  return { path, made: true };
}
