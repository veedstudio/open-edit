// The ffmpeg side of a render: one encoder per segment fed PNGs on stdin, and the stream-copy join.
// Every segment is encoded with the same arguments and starts on its own keyframe, which is what lets
// the concat demuxer splice a re-rendered segment between untouched ones without re-encoding them.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FFMPEG, FFPROBE } from '../config.ts';
import { runBuffered, track } from './children.ts';
import { BUDGET_MS } from './lead.ts';
import type { Capture } from './session.ts';
import { withAlpha } from './png.ts';
import { fpsLabel, type Fps } from './timing.ts';

/** Footage under the page's frames: ffmpeg's first input, with the PNG pipe as its second. */
export interface Overlay {
  width: number;
  height: number;
  fps: Fps;
  /** The matrix the footage's YUV is decoded with (`auto` reads its tags). */
  matrix: string;
  /** HDR footage's conversion to SDR, applied before it is scaled. */
  sdr?: string;
  /** asShown for footage stored turned or in pixels that are not square, after the conversion. */
  shown?: string[];
  /** Black frames in place of footage within one segment: before the footage's first frame and after its last. */
  before?: number;
  after?: number;
  /** No footage under any of the segment's frames: the page is laid over black, and the pipe is ffmpeg's only input. */
  bare?: boolean;
}

/**
 * The page's frames laid over the footage in RGB, blended by straight alpha as Chrome's PNGs carry it, with the
 * footage renumbered from zero so frame n of the pipe lands on the nth frame the input seek kept. It is scaled to
 * fill the frames, whose shape it has (render refuses another), so the crop takes only what rounding leaves over.
 * Where the footage starts after the segment's first frame or ends before its last, black fills in, numbered with it.
 */
export function overlayGraph(o: Overlay): string {
  const pad = o.before || o.after ? `,tpad=start=${o.before ?? 0}:stop=${o.after ?? 0}:color=black,setpts=N` : '';
  const under = o.bare
    ? `color=c=black:s=${o.width}x${o.height}:r=${fpsLabel(o.fps)},format=rgba`
    : `[0:v:0]${[`settb=${o.fps.den}/${o.fps.num}`, 'setpts=N', o.sdr, ...(o.shown ?? [])].filter(Boolean).join(',')},`
      + `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase:in_color_matrix=${o.matrix},crop=${o.width}:${o.height},format=rgba${pad}`;
  return `${under}[bg];[${o.bare ? 0 : 1}:v]format=rgba[fg];[bg][fg]overlay=format=auto:alpha=straight`;
}

/** x264's speed and quality, and whether frames may come in with an odd side (a scaled capture). */
export interface Encode {
  preset: string;
  crf: number;
  /** Crop a row or column off an odd side, which H.264 4:2:0 cannot hold; ProRes 4444 keeps every one. */
  even?: boolean;
}

export const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;
// Keep encoding fast on grainy footage, where the encoder rather than Chrome would otherwise set the pace.
export const FULL_ENCODE: Encode = { preset: 'veryfast', crf: 20 };

/**
 * The encode, as recorded in the cache manifest: a segment is reusable only under identical settings.
 * x264's output depends on its thread count, so the count is fixed rather than scaled to the workers:
 * the same page gives the same bytes whatever --workers was.
 */
export function encoderArgs(transparent: boolean, capture: Capture = 'png', overlay: Overlay | null = null, x264: Encode = FULL_ENCODE): string[] {
  const even = x264.even ? 'crop=trunc(iw/2)*2:trunc(ih/2)*2,' : '';
  // Chrome captures sRGB; the matrix is stated so the conversion and the tags agree on BT.709 rather
  // than ffmpeg's BT.601 default, which shifts every colour a player decodes as HD.
  const colour = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  if (transparent) {
    if (overlay) throw new Error('footage cannot be laid under a transparent render');
    return ['-vf', `scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le`, '-c:v', 'prores_ks', '-profile:v', '4444',
      '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', ...colour];
  }
  // The page is laid over footage with its alpha, which a JPEG does not carry.
  if (overlay && capture === 'jpeg') throw new Error('footage cannot be laid under a JPEG capture');
  // A JPEG from Chrome is JFIF: BT.601 matrix, full range. Stated on the input side rather than left to
  // swscale's default, so the conversion lands on the values the PNG path's RGB does. Chrome also embeds
  // an sRGB ICC profile, which ffmpeg would otherwise write into the file beside the BT.709 tags; the PNG
  // path carries none, so it is dropped.
  const from = capture === 'jpeg' ? 'sidedata=mode=delete:type=ICC_PROFILE,scale=in_color_matrix=bt601:in_range=pc:' : 'scale=';
  const toYuv = `${even}${from}out_color_matrix=bt709:out_range=tv,format=yuv420p`;
  const filter = overlay ? ['-filter_complex', `${overlayGraph(overlay)},${toYuv}[out]`, '-map', '[out]'] : ['-vf', toYuv];
  return [...filter, '-c:v', 'libx264', '-preset', x264.preset,
    '-crf', String(x264.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', '4', ...colour];
}

/** The footage a segment is laid over, and where in it the segment starts. */
export interface SegmentFootage {
  file: string;
  /** The input seek to the first footage frame the segment shows, placed before the footage input; empty for frame 0. */
  seek: string[];
  overlay: Overlay;
  frames: number;
}

/**
 * How long an encoder may go without taking a frame, or without exiting once its input is closed, before the render
 * fails rather than wait on it: the budget of any single wait (BUDGET_MS).
 */
export const ENCODER_STALL_MS = BUDGET_MS;

export interface SegmentEncoder {
  /** One frame, in the encoder's capture format. */
  write(frame: Buffer): Promise<void>;
  /** Closes the input and waits for the file; rejects with ffmpeg's own words when it failed. */
  finish(): Promise<void>;
  kill(): void;
}

export function startSegmentEncoder(out: string, fps: Fps, transparent: boolean, capture: Capture = 'png', footage?: SegmentFootage | null, x264: Encode = FULL_ENCODE): SegmentEncoder {
  // The footage is read ahead of the pipe, so its decode to the segment's first frame overlaps the
  // page's first captures; -frames:v ends the segment where the pipe does rather than where the footage does.
  const inputs = footage && !footage.overlay.bare ? [...footage.seek, '-i', footage.file] : [];
  const length = footage ? ['-frames:v', String(footage.frames)] : [];
  // The output's rate is stated, or ffmpeg 7 writes a segment laid over footage with its last frame lasting nothing (so
  // the file is a frame short) and 7.0 at 25 fps whatever the input's; the encoded frames are the same bytes either way.
  const args = ['-v', 'error', '-y', ...inputs, '-f', 'image2pipe', '-framerate', fpsLabel(fps), '-c:v', capture === 'jpeg' ? 'mjpeg' : 'png', '-i', 'pipe:0',
    ...encoderArgs(transparent, capture, footage?.overlay, x264), '-r', fpsLabel(fps), ...length, '-an', '-f', transparent ? 'mov' : 'mp4', out];
  const child: ChildProcess = track(spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] }));
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr += d; });
  const exited = new Promise<void>((ok, fail) => {
    child.on('error', (e) => fail(new Error(`ffmpeg could not start (${FFMPEG}): ${e.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) ok();
      else fail(new Error(`ffmpeg failed on ${basename(out)} (${signal ?? `exit ${code}`}): ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
  // A write that fails because ffmpeg died is reported by `exited`, which carries the reason.
  exited.catch(() => {});
  // An ffmpeg that is alive but no longer reading or exiting is killed, so the render fails by name instead of waiting.
  const stalled = <T>(work: Promise<T>, how: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([work, new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`ffmpeg ${how} within ${ENCODER_STALL_MS / 1000} s while encoding ${basename(out)}`));
      }, ENCODER_STALL_MS);
    })]).finally(() => clearTimeout(timer));
  };
  child.stdin!.on('error', () => {});
  return {
    // Over footage, every frame goes in as RGBA, so the stream never changes pixel format (see withAlpha).
    write: (frame) => {
      const data = footage ? withAlpha(frame) : frame;
      const gone = () => exited.then(() => { throw new Error('ffmpeg exited before the segment was complete'); });
      if (child.exitCode !== null || child.signalCode !== null) return gone();
      if (child.stdin!.write(data)) return Promise.resolve();
      // Waiting on 'drain' alone would wait forever on an ffmpeg that died with the pipe full.
      return stalled(new Promise<void>((ok, fail) => {
        const onDrain = () => {
          child.off('close', onClose);
          ok();
        };
        const onClose = () => {
          child.stdin!.off('drain', onDrain);
          gone().then(ok, fail);
        };
        child.stdin!.once('drain', onDrain);
        child.once('close', onClose);
      }), 'stopped taking frames');
    },
    finish: async () => {
      child.stdin!.end();
      await stalled(exited, 'did not finish');
    },
    kill: () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * Runs ffmpeg with `tmp` as its output, then renames it to `out`, so a failed run leaves no half file
 * behind; the error carries ffmpeg's own words. Tracked, so a signal stops a copy or a join and kills its ffmpeg;
 * unbounded, since how long a copy takes grows with its source.
 */
export async function ffmpegInto(tmp: string, out: string, args: string[], what: string): Promise<void> {
  try {
    await runBuffered(FFMPEG, [...args, tmp], { what });
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, out);
}

/**
 * Each segment's length in the ffconcat list, in the whole microseconds the list holds, rounded from the exact
 * running time so the rounding never adds up: the demuxer starts each file where the one before ends by this, not by
 * the file's own duration, which ffmpeg 7 writes a frame short over footage (its last frame carries no duration).
 */
export function concatList(parts: { file: string; frames: number }[], fps: Fps): string {
  const us = (frames: number) => Math.round((frames * fps.den * 1e6) / fps.num);
  let at = 0;
  const lines = parts.map((p) => {
    const length = us(at + p.frames) - us(at);
    at += p.frames;
    return `file '${basename(p.file)}'\nduration ${(length / 1e6).toFixed(6)}`;
  });
  return `ffconcat version 1.0\n${lines.join('\n')}\n`;
}

/** Joins segments in order by stream copy, each starting where the frames before it end. */
export async function joinSegments(parts: { file: string; frames: number }[], out: string, fps: Fps): Promise<void> {
  const list = join(dirname(parts[0].file), 'concat.txt');
  writeFileSync(list, concatList(parts, fps));
  const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.tmp${out.slice(out.lastIndexOf('.'))}`);
  await ffmpegInto(tmp, out, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', '-movflags', '+faststart'],
    'joining the segments failed');
}

/**
 * What is wrong with the timing of a video of `frames` frames at `fps`, read from its packets without decoding:
 * the count, each frame's time against i·den/num (to within one tick of the file's time base), and the length.
 * Empty when it is right.
 */
export function timingProblems(file: string, frames: number, fps: Fps): string[] {
  const probed = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base,duration:packet=pts',
    '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 })) as { streams?: { time_base?: string; duration?: string }[]; packets?: { pts?: number }[] };
  const [tbNum, tbDen] = (probed.streams?.[0]?.time_base ?? '').split('/').map(Number);
  const packets = probed.packets ?? [];
  if (!tbNum || !tbDen) return ['it has no video stream with a time base'];
  const problems: string[] = [];
  if (packets.length !== frames) problems.push(`it holds ${packets.length} frames, not ${frames}`);
  const pts = packets.map((p) => p.pts).filter((t): t is number => typeof t === 'number').sort((a, b) => a - b);
  if (pts.length !== packets.length) problems.push(`${packets.length - pts.length} frame(s) carry no time`);
  // Ticks per frame, exact: frame i is due at i·den/num s, which is i·den·tbDen/(num·tbNum) ticks.
  const due = (i: number) => (i * fps.den * tbDen) / (fps.num * tbNum);
  const frameSec = fps.den / fps.num;
  const off = pts.map((t, i) => t - pts[0] - due(i)).map((d, i) => ({ i, d })).filter(({ d }) => Math.abs(d) > 1);
  if (pts.length && Math.abs(pts[0]) > 1) problems.push(`its first frame is at ${((pts[0] * tbNum) / tbDen).toFixed(3)} s, not 0`);
  if (off.length) {
    const first = off[0];
    const sec = (ticks: number) => (ticks * tbNum) / tbDen;
    problems.push(`${off.length} frame(s) are off the ${fpsLabel(fps)} fps grid, the first frame ${first.i}, due at ${frameTimeOf(first.i, fps)} s, `
      + `${Math.abs(sec(first.d) / frameSec).toFixed(2)} frame(s) ${first.d < 0 ? 'early' : 'late'}`);
  }
  const length = Number(probed.streams?.[0]?.duration);
  const want = frames * frameSec;
  if (Number.isFinite(length) && Math.abs(length - want) > frameSec / 2) problems.push(`it lasts ${length.toFixed(3)} s, not ${want.toFixed(3)} s`);
  return problems;
}

const frameTimeOf = (i: number, fps: Fps): string => ((i * fps.den) / fps.num).toFixed(3);

/** Video packets in the file: a count, without decoding. */
export function countFrames(file: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  // A stream with side data (HDR10's mastering metadata) prints an empty field after the count.
  return Number(out.trim().split(',')[0]);
}
