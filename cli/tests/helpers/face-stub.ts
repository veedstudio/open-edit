// A stand-in for MediaPipe, so a command's sampling, timing and scaling run on real ffmpeg without Python.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FFMPEG } from '../../src/config.ts';
import type { Spawn } from '../../src/faces/mediapipe.ts';
import { scratchDir } from './synth.ts';

/** x, y, w, h in the still's pixels. */
export type StubBox = [number, number, number, number];

/** Width and height from a PNG's header. */
export function pngSize(file: string): [number, number] {
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(24);
  readSync(fd, head, 0, 24, 0);
  closeSync(fd);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

/** The box around a still's bright pixels, or none: a detector for footage whose one "face" is a white square. */
export function brightBox(png: string): StubBox[] {
  const [width, height] = pngSize(png);
  const grey = execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grey[y * width + x] < 200) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  return x1 < 0 ? [] : [[x0, y0, x1 - x0 + 1, y1 - y0 + 1]];
}

/**
 * Real ffmpeg, and for the detector the faces `boxesOf` gives each still by its file name (`c0000003.png`) and its
 * path.
 */
export function stubDetector(boxesOf: (file: string, path: string) => StubBox[]): { spawn: Spawn; python: string; model: string } {
  const dir = scratchDir('faces-stub');
  const python = join(dir, 'python');
  const model = join(dir, 'model.tflite');
  writeFileSync(python, '');
  writeFileSync(model, '');
  const spawn = ((cmd: string, args: string[], opts: object) => {
    if (cmd !== python) return spawnSync(cmd, args, opts);
    const folder = args.at(-1)!;
    const lines = ['{"ready_ms": 1}', ...readdirSync(folder).filter((n) => n.endsWith('.png')).sort().map((file) => {
      const [width, height] = pngSize(join(folder, file));
      return JSON.stringify({ file, ms: 1, width, height, faces: boxesOf(file, join(folder, file)).map((b) => [...b, 0.9]) });
    })];
    return { status: 0, signal: null, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }) as unknown as Spawn;
  return { spawn, python, model };
}
