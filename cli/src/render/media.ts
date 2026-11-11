// Seek-friendly stand-ins for the page's footage. Chrome decodes from the previous keyframe on every
// seek, so a camera file with a 10 s GOP costs hundreds of milliseconds per frame. An all-intra copy
// makes each seek decode exactly one frame; the page keeps its own URL and the server answers it with
// the copy, so nothing about the page changes. A copy is made at the size the page draws the picture
// when that is well below the source's, since every seek decodes the whole frame in software and
// hands it to Chrome to scale down, on every rendered and every replayed frame.
//
// Copies are kept by what their source holds, not by its name or by what is rendered from it, in one cache per
// workspace: stills into any directory, renders and patches of any page then find the copy the first of them made.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FFPROBE, runsDir } from '../config.ts';
import { oneSourceFree } from '../hdr.ts';
import { alphaInput, NoVideoStream, pictureCodecOf } from '../probe.ts';
import { ffmpegInto } from './encode.ts';

/** Past this many frames between keyframes a seek decodes enough to matter, and the file gets a copy. */
export const MAX_GOP = 12;

/**
 * A copy is made smaller only when it would be at most this fraction of the source on both sides: that
 * is under half the pixels to decode and upload per seek, which is where the copy pays for itself.
 */
export const SHRINK_TO_AT_MOST = 2 / 3;

/**
 * Past this many bytes of copies, a render that adds one removes those used longest ago. Copies of long 1080p or short
 * 4K sources run to hundreds of MB each, and this keeps a dozen or more for a return to them after the lease has run out.
 */
export const MEDIA_CACHE_BYTES = 10 * 2 ** 30;

/**
 * A copy used this recently may be serving a render that is still running, so none is removed to make room, whatever
 * the cache's size: a day, far longer than a render or a working session.
 */
export const MEDIA_LEASE_MS = 24 * 3600 * 1000;

/** The workspace's one cache of copies, beside its runs. */
export function mediaCache(): string {
  return resolve(runsDir(), '.media');
}

// A copy is named by its key alone, so the same bytes under two names are one copy. These names, and only these, are
// what the cache ever removes.
const COPY = /^[0-9a-f]{20}\.(mp4|webm)$/;
const LEFTOVER = /^[0-9a-f]{20}\.(mp4|webm)\.[\w-]+\.(tmp|evict)$/;
const VERSION = /^[0-9a-f]{40}(\.[\w-]+\.tmp)?$/;

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

// The codecs Chrome decodes itself, 10-bit and 4:4:4 included; it plays any other (HEVC, ProRes, MPEG-4 part 2) only
// where the platform lends it a decoder.
const CHROME_CODECS: ReadonlySet<string> = new Set(['h264', 'vp8', 'vp9', 'av1']);

/**
 * `file`'s picture codec as ffprobe names it, when Chrome has no decoder of its own for it; null when it has, or the file
 * has no picture. Read from the file, not from whether Chrome played it: a file whose sound Chrome can play is played
 * without its picture rather than refused, and a host that lends a decoder would make the render differ by machine.
 */
export const foreignCodecOf = perVersion((file): string | null => {
  try {
    const codec = pictureCodecOf(file);
    return codec !== null && !CHROME_CODECS.has(codec) ? codec : null;
  } catch (e) {
    if (e instanceof NoVideoStream) return null;
    throw e;
  }
});

/** A name no other attempt, in this process or another, writes under. */
const attempt = () => `${process.pid}-${randomBytes(3).toString('hex')}`;

/**
 * A SHA-256 of `file`'s bytes. A path, a size or a date can stay the same while the picture changes, and a copy found
 * under the wrong key would be served for the wrong picture, so the whole file is read. That is once per version of
 * the file (its inode, size and times), remembered under `dir` for the renders that ask again of an unchanged file.
 */
export function contentId(file: string, dir: string): string {
  const versionOf = () => {
    const st = statSync(file, { bigint: true });
    return createHash('sha1').update([st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':')).digest('hex');
  };
  const version = versionOf();
  const memo = join(dir, 'versions', version);
  try {
    const known = readFileSync(memo, 'utf8');
    if (/^[0-9a-f]{64}$/.test(known)) return known;
  } catch {
    // Not hashed yet, or the memo was removed with the stale ones: read the file.
  }
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 22);
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  const id = hash.digest('hex');
  // A file written to while it was read hashed as neither version, and is not remembered as either.
  if (versionOf() === version) {
    mkdirSync(join(dir, 'versions'), { recursive: true });
    const tmp = `${memo}.${attempt()}.tmp`;
    writeFileSync(tmp, id);
    renameSync(tmp, memo);
  }
  return id;
}

/** Marks a copy as just used, so it is the last to go when the cache makes room; false when it is not there. */
function markUsed(path: string): boolean {
  const now = new Date();
  try {
    utimesSync(path, now, now);
    return true;
  } catch (e) {
    // A cache this user may read but not write still serves the copies in it.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT' && existsSync(path);
  }
}

/** What the cache holds after a render added to it, and what was removed to make room. */
export interface CacheReport {
  dir: string;
  copies: number;
  bytes: number;
  removed: number;
  freed: number;
}

/**
 * Removes the copies in `dir` used longest ago while they add up to more than `cap`, except one in `keep` or used
 * within `lease`, and the leftovers of renders that died writing or removing one. A copy is moved aside before it goes,
 * so a render that marks it used in the meantime keeps it, and of two renders making room only one takes each copy.
 */
export function boundCache(dir: string, keep: string[] = [], cap = MEDIA_CACHE_BYTES, lease = MEDIA_LEASE_MS): CacheReport {
  const stale = (path: string) => {
    try {
      return Date.now() - statSync(path).mtimeMs >= lease;
    } catch {
      return false;
    }
  };
  const copies: { path: string; bytes: number; used: number }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (LEFTOVER.test(name)) {
      if (stale(path)) rmSync(path, { force: true });
      continue;
    }
    if (!COPY.test(name)) continue;
    try {
      const st = statSync(path);
      copies.push({ path, bytes: st.size, used: st.mtimeMs });
    } catch {
      // Taken by another render making room.
    }
  }
  const versions = join(dir, 'versions');
  if (existsSync(versions)) {
    for (const name of readdirSync(versions)) if (VERSION.test(name) && stale(join(versions, name))) rmSync(join(versions, name), { force: true });
  }
  let bytes = copies.reduce((n, c) => n + c.bytes, 0);
  let removed = 0;
  let freed = 0;
  for (const c of copies.sort((a, b) => a.used - b.used)) {
    if (bytes <= cap) break;
    if (keep.includes(c.path) || Date.now() - c.used < lease) continue;
    const aside = `${c.path}.${attempt()}.evict`;
    try {
      renameSync(c.path, aside);
    } catch {
      continue; // gone already, or held open where an open file cannot be moved
    }
    if (!stale(aside)) {
      if (existsSync(c.path)) rmSync(aside, { force: true });
      else renameSync(aside, c.path);
      continue;
    }
    rmSync(aside, { force: true });
    bytes -= c.bytes;
    freed += c.bytes;
    removed++;
  }
  return { dir, copies: copies.length - removed, bytes, removed, freed };
}

/**
 * The all-intra copy of `file`, at `size` or the source's own, in the cache `dir`: made once per content of the file
 * and size, and found again by any render after that. The size is in the key, so a page that draws the video larger
 * later gets a copy of its own rather than the small one. An HDR source's conversion to SDR (`sdr`) is applied in the
 * copy, before it is scaled. A render that makes a copy then makes room in the cache, and reports what it holds.
 */
export async function seekableCopy(file: string, dir = mediaCache(), size: Size | null = null, sdr?: string): Promise<{ path: string; made: boolean; cache?: CacheReport }> {
  const chain = [...(sdr ? [sdr] : []), ...(size ? [`scale=${size.width}:${size.height}`] : [])];
  const vf = chain.length ? ['-vf', chain.join(',')] : [];
  // An HDR source's conversion ends in a format without alpha, so its copy is opaque either way.
  const alpha = sdr ? null : alphaInputOf(file);
  const own = alpha ? ALPHA_ARGS : PROXY_ARGS;
  const format = alpha ? 'webm' : 'mp4';
  const key = createHash('sha1').update(JSON.stringify([contentId(file, dir), own, vf])).digest('hex').slice(0, 20);
  const path = join(dir, `${key}.${format}`);
  if (markUsed(path)) return { path, made: false };
  mkdirSync(dir, { recursive: true });
  // An HDR source goes through a graph with two sources, so no ffmpeg copies its HDR10 metadata into the copy.
  const args = sdr ? [...oneSourceFree(file, chain.join(',')), ...PROXY_ENCODE] : [...(alpha?.args ?? []), '-i', file, ...own, ...vf];
  try {
    await ffmpegInto(`${path}.${attempt()}.tmp`, path, ['-v', 'error', '-y', ...args, '-f', format], `could not make a seekable copy of ${file}`);
  } catch (e) {
    // Another render made the same copy meanwhile; where it is open, it cannot be replaced, and need not be.
    if (!existsSync(path)) throw e;
  }
  return { path, made: true, cache: boundCache(dir, [path]) };
}
