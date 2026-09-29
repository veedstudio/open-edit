// The ffmpeg side of a render: one encoder per segment fed PNGs on stdin, and the stream-copy join.
// Every segment is encoded with the same arguments and starts on its own keyframe, which is what lets
// the concat demuxer splice a re-rendered segment between untouched ones without re-encoding them.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FFMPEG, FFPROBE } from '../config.ts';
import { fpsLabel, type Fps } from './timing.ts';

/**
 * The encode, as recorded in the cache manifest: a segment is reusable only under identical settings.
 * x264's output depends on its thread count, so the count is fixed rather than scaled to the workers:
 * the same page gives the same bytes whatever --workers was.
 */
export function encoderArgs(transparent: boolean): string[] {
  // Chrome captures sRGB; the matrix is stated so the conversion and the tags agree on BT.709 rather
  // than ffmpeg's BT.601 default, which shifts every colour a player decodes as HD.
  const colour = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  if (transparent) {
    return ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444',
      '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', ...colour];
  }
  // veryfast at CRF 15 spends about the bits medium does at CRF 16, for a third of the CPU on grainy
  // footage, where the encoder rather than Chrome would otherwise set the pace.
  return ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '15', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', '4', ...colour];
}

// Encoders still running, so an interrupted render can stop them rather than leave them writing.
const live = new Set<ChildProcess>();

export function killEncoders(): void {
  for (const child of live) child.kill('SIGKILL');
}

export interface SegmentEncoder {
  write(png: Buffer): Promise<void>;
  /** Closes the input and waits for the file; rejects with ffmpeg's own words when it failed. */
  finish(): Promise<void>;
  kill(): void;
}

export function startSegmentEncoder(out: string, fps: Fps, transparent: boolean): SegmentEncoder {
  const args = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', fpsLabel(fps), '-c:v', 'png', '-i', 'pipe:0',
    ...encoderArgs(transparent), '-an', '-f', transparent ? 'mov' : 'mp4', out];
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
    write: (png) => new Promise<void>((ok, fail) => {
      const gone = () => exited.then(() => fail(new Error('ffmpeg exited before the segment was complete')), fail);
      if (child.exitCode !== null || child.signalCode !== null) {
        gone();
        return;
      }
      if (child.stdin!.write(png)) {
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
  return Number(out.trim());
}
