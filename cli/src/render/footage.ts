// Footage laid under the page by ffmpeg instead of played by a <video> in Chrome. The page is captured
// with alpha, and each segment's encoder decodes the footage once, in order, from the segment's first
// frame: Chrome never seeks or decodes it, a worker's replay of earlier frames costs no video seek, and
// no all-intra copy is made.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { FFMPEG, FFPROBE } from '../config.ts';
import { hdrKind, toSdr } from '../hdr.ts';
import { colourTagsOf, probeSquareSize, type ColourReport } from '../probe.ts';
import { asShown } from '../shown.ts';
import { runBuffered } from './children.ts';
import { countFrames, overlayGraph, type Overlay, type SegmentFootage } from './encode.ts';
import { BUDGET_MS } from './lead.ts';
import { fpsLabel, type Fps, type Segment } from './timing.ts';

export interface Footage {
  file: string;
  /** Its picture as shown: upright, in square pixels. */
  width: number;
  height: number;
  /** Turned by a rotation tag or stored in pixels that are not square, so it is shown through asShown. */
  turned: boolean;
  sar: number;
  /** Its frame rate, the exact rational ffprobe reports as r_frame_rate. */
  fps: Fps;
  frames: number;
  /** Seconds from the file's start to its first video frame, which an audio stream that starts first puts above 0. */
  offset: number;
  /** The matrix its YUV is decoded with: `auto` reads its own tag; untagged footage gets what players assume for its size. */
  matrix: string;
  /** Its colour as declared, which says whether it is HDR (see hdrKind). */
  colour: ColourReport;
  /** Path, size and mtime: the manifest's record of which file the segments were laid over. */
  identity: string;
}

export const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** `25/1` → 25, `30000/1001` as it is; refused when it is not a rate. */
export function parseRate(raw: string): Fps {
  const m = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) throw new Error(`frame rate "${raw}" is not a rate`);
  const g = gcd(Number(m[1]), Number(m[2]));
  return { num: Number(m[1]) / g, den: Number(m[2]) / g };
}

export const sameRate = (a: Fps, b: Fps): boolean => a.num * b.den === b.num * a.den;

/** What the footage is, read without decoding it; throws when the file holds no video. */
export function probeFootage(file: string): Footage {
  const st = statSync(file);
  let out: string;
  try {
    out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,color_space,start_time:stream_side_data=rotation:format=start_time', '-of', 'json', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`${file} could not be read as video: ${stderr || (e as Error).message}`);
  }
  const probed = JSON.parse(out) as {
    streams?: { width?: number; height?: number; r_frame_rate?: string; color_space?: string; start_time?: string; side_data_list?: { rotation?: number }[] }[];
    format?: { start_time?: string };
  };
  const s = (probed.streams ?? [])[0];
  if (!s || !s.width || !s.height || !s.r_frame_rate) throw new Error(`${file} holds no video stream`);
  const tagged = s.color_space && s.color_space !== 'unknown';
  const offset = Number(s.start_time) - Number(probed.format?.start_time);
  const colour = colourTagsOf(file);
  const shown = probeSquareSize(file);
  const rotated = (s.side_data_list ?? []).some((d) => d.rotation !== undefined && Math.round(d.rotation) % 360 !== 0);
  return {
    file, width: shown.width, height: shown.height, turned: rotated || shown.sar !== 1, sar: shown.sar,
    fps: parseRate(s.r_frame_rate), frames: countFrames(file), offset: offset > 0 ? offset : 0,
    // swscale decodes untagged YUV as BT.601 whatever its size, where players assume BT.709 for HD.
    // HDR footage reaches the scale already converted, and labelled BT.709.
    matrix: hdrKind(colour) ? 'bt709' : tagged ? 'auto' : s.height >= 720 || s.width >= 1280 ? 'bt709' : 'bt601',
    colour,
    identity: `${file} (${st.size} bytes, modified ${st.mtime.toISOString()})`,
  };
}

/**
 * ffmpeg's input seek to frame `start` of the footage. Half a frame early, so the first frame the seek
 * keeps is `start` whichever way the rounding of its time falls; the encoder's graph then renumbers the
 * frames it keeps from zero. The seek counts from the file's start, so the video's own `offset` is added.
 */
export function seekArgs(start: number, fps: Fps, offset = 0): string[] {
  return start === 0 ? [] : ['-ss', (offset + ((start - 0.5) * fps.den) / fps.num).toFixed(6)];
}

// Footage shown as it is stored gets no turning filters, so its graph, and a render's cached segments, do not change.
export const overlayFor = (f: Footage, canvas: { width: number; height: number }, fps: Fps): Overlay =>
  ({ width: canvas.width, height: canvas.height, fps, matrix: f.matrix, sdr: hdrKind(f.colour) ? toSdr(f.colour) : undefined, ...(f.turned ? { shown: asShown(f) } : {}) });

/**
 * What a segment is laid over: the footage from the first of its frames the footage reaches, with black before the
 * footage's first frame and after its last, or black alone when the footage lies wholly outside it. `at` is the
 * render frame the footage's first frame lands on.
 */
export function underSegment(f: Footage, at: number, seg: Segment, fps: Fps, overlay: Overlay): SegmentFootage {
  const end = seg.start + seg.frames;
  const from = Math.max(seg.start, at);
  const to = Math.min(end, at + f.frames);
  if (to <= from) return { file: f.file, seek: [], overlay: { ...overlay, bare: true }, frames: seg.frames };
  return { file: f.file, seek: seekArgs(from - at, fps, f.offset), overlay: { ...overlay, before: from - seg.start, after: end - to }, frames: seg.frames };
}

/**
 * The page's still at `frame`, laid over the footage's frame under it, or over black where the footage does not reach:
 * an opaque PNG. Run without blocking, so a render answers a signal while ffmpeg works, and bounded by the budget of
 * any single wait.
 */
export async function composeStill(f: Footage, at: number, frame: number, fps: Fps, canvas: { width: number; height: number }, png: Buffer): Promise<Buffer> {
  const under = underSegment(f, at, { index: 0, start: frame, frames: 1 }, fps, overlayFor(f, canvas, fps));
  const footage = under.overlay.bare ? [] : [...under.seek, '-i', f.file];
  const args = ['-v', 'error', ...footage, '-f', 'image2pipe', '-framerate', fpsLabel(fps), '-c:v', 'png', '-i', 'pipe:0',
    '-filter_complex', `${overlayGraph(under.overlay)},format=rgb24[out]`, '-map', '[out]', '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'];
  const still = await runBuffered(FFMPEG, args, { input: png, timeoutMs: BUDGET_MS, what: `laying frame ${frame} over the footage` });
  // A seek past the last frame ffmpeg can decode exits 0 with nothing written.
  if (!still.length) throw new Error(`the footage has no frame ${frame - at} to lay the page over: it decodes to fewer frames than its ${f.frames} packets`);
  return still;
}
