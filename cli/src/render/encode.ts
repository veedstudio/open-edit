// The ffmpeg side of a render: one encoder per segment fed PNGs on stdin, and the stream-copy join.
// Every segment is encoded with the same arguments and starts on its own keyframe, which is what lets
// the concat demuxer splice a re-rendered segment between untouched ones without re-encoding them.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FFMPEG, FFPROBE } from '../config.ts';
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
}

/**
 * The page's frames laid over the footage in RGB, blended by straight alpha as Chrome's PNGs carry it, with the
 * footage renumbered from zero so frame n of the pipe lands on the nth frame the input seek kept. It is scaled to
 * fill the frames, whose shape it has (render refuses another), so the crop takes only what rounding leaves over.
 */
export function overlayGraph(o: Overlay): string {
  return `[0:v:0]${[`settb=${o.fps.den}/${o.fps.num}`, 'setpts=N', o.sdr, ...(o.shown ?? [])].filter(Boolean).join(',')},`
    + `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase:in_color_matrix=${o.matrix},`
    + `crop=${o.width}:${o.height},format=rgba[bg];[1:v]format=rgba[fg];[bg][fg]overlay=format=auto:alpha=straight`;
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
  /** The input seek to the segment's first frame, placed before the footage input; empty for frame 0. */
  seek: string[];
  overlay: Overlay;
  frames: number;
}

// Encoders still running, so an interrupted render can stop them rather than leave them writing.
const live = new Set<ChildProcess>();

export function killEncoders(): void {
  for (const child of live) child.kill('SIGKILL');
}

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
  const inputs = footage ? [...footage.seek, '-i', footage.file] : [];
  const length = footage ? ['-frames:v', String(footage.frames)] : [];
  const args = ['-v', 'error', '-y', ...inputs, '-f', 'image2pipe', '-framerate', fpsLabel(fps), '-c:v', capture === 'jpeg' ? 'mjpeg' : 'png', '-i', 'pipe:0',
    ...encoderArgs(transparent, capture, footage?.overlay, x264), ...length, '-an', '-f', transparent ? 'mov' : 'mp4', out];
  const child: ChildProcess = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  live.add(child);
  child.on('close', () => live.delete(child));
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
  child.stdin!.on('error', () => {});
  return {
    // Over footage, every frame goes in as RGBA, so the stream never changes pixel format (see withAlpha).
    write: (frame) => new Promise<void>((ok, fail) => {
      const data = footage ? withAlpha(frame) : frame;
      const gone = () => exited.then(() => fail(new Error('ffmpeg exited before the segment was complete')), fail);
      if (child.exitCode !== null || child.signalCode !== null) {
        gone();
        return;
      }
      if (child.stdin!.write(data)) {
        ok();
        return;
      }
      // Waiting on 'drain' alone would wait forever on an ffmpeg that died with the pipe full.
      const onDrain = () => {
        child.off('close', onClose);
        ok();
      };
      const onClose = () => {
        child.stdin!.off('drain', onDrain);
        gone();
      };
      child.stdin!.once('drain', onDrain);
      child.once('close', onClose);
    }),
    finish: async () => {
      child.stdin!.end();
      await exited;
    },
    kill: () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * Runs ffmpeg with `tmp` as its output, then renames it to `out`, so a failed run leaves no half file
 * behind; the error carries ffmpeg's own words.
 */
export function ffmpegInto(tmp: string, out: string, args: string[], what: string): void {
  try {
    execFileSync(FFMPEG, [...args, tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`${what}: ${stderr || (e as Error).message}`);
  }
}

/** Joins segments in order by stream copy. */
export function joinSegments(files: string[], out: string): void {
  const list = join(dirname(files[0]), 'concat.txt');
  writeFileSync(list, `ffconcat version 1.0\n${files.map((f) => `file '${basename(f)}'`).join('\n')}\n`);
  const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.tmp${out.slice(out.lastIndexOf('.'))}`);
  ffmpegInto(tmp, out, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', '-movflags', '+faststart'],
    'joining the segments failed');
}

/** Video packets in the file: a count, without decoding. */
export function countFrames(file: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  // A stream with side data (HDR10's mastering metadata) prints an empty field after the count.
  return Number(out.trim().split(',')[0]);
}
