// A screen recording's frames as zoom reads them: one decode streams small grey samples into the frame differences,
// holding two frames at a time whatever the clip's length, and single full-size grey frames are read where text is measured.
import { spawn, spawnSync } from 'node:child_process';
import { FFMPEG } from '../config.ts';
import { gridSelect, parseShowinfo } from '../commands/faces.ts';
import { asShown } from '../shown.ts';
import { changedBlobs, CursorTracker, isWide, type Change } from './activity.ts';

export interface Shown { width: number; height: number; sar: number }

/** The differences between consecutive samples taken every `every` seconds, each at the presentation time of its later frame. */
export async function readChanges(video: string, shown: Shown, size: { width: number; height: number }, every: number): Promise<Change[]> {
  const filters = [...asShown(shown), gridSelect(every), 'showinfo@grid', `scale=${size.width}:${size.height}:flags=area`, 'format=gray'];
  const child = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-nostats', '-i', video, '-an', '-sn', '-dn', '-vf', filters.join(','),
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { log += d; });
  const closed = new Promise<number | null>((done, fail) => { child.on('error', fail); child.on('close', done); });
  const bytes = size.width * size.height;
  let frame = new Uint8Array(bytes), prev = new Uint8Array(bytes);
  let filled = 0, frames = 0;
  const tracker = new CursorTracker(size.width, size.height);
  const seen: Omit<Change, 'sec'>[] = [];
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(bytes - filled, chunk.length - at);
      frame.set(chunk.subarray(at, at + take), filled);
      filled += take;
      at += take;
      if (filled < bytes) continue;
      if (frames > 0) {
        const blobs = changedBlobs(prev, frame, size.width, size.height);
        seen.push({ blobs, ...tracker.step(prev, frame, blobs, isWide(blobs, size.width, size.height)) });
      }
      [prev, frame] = [frame, prev];
      filled = 0;
      frames++;
    }
  }
  const code = await closed;
  if (code !== 0) throw new Error(`ffmpeg could not read ${video}: ${log.trim().split('\n').slice(-3).join(' ')}`);
  const grid = parseShowinfo(log, 'grid');
  if (grid.pts.length !== frames) throw new Error(`ffmpeg sampled ${grid.pts.length} frame(s) of ${video} but wrote ${frames}`);
  return seen.map((s, i) => ({ sec: (grid.pts[i + 1] * grid.num) / grid.den, ...s }));
}

/** The frame shown at `sec`, grey and at the clip's display size, one byte a pixel. */
export function greyFrameAt(video: string, shown: Shown, sec: number): Uint8Array {
  const r = spawnSync(FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-ss', Math.max(0, sec).toFixed(3), '-i', video,
    '-frames:v', '1', '-vf', [...asShown(shown), 'format=gray'].join(','), '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const bytes = shown.width * shown.height;
  if (r.status !== 0 || r.stdout.length < bytes) {
    throw new Error(`ffmpeg could not read the frame at ${sec.toFixed(2)} s of ${video}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
  }
  return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, bytes);
}
