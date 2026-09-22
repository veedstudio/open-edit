// One contact sheet out of a list of tile images. The mechanic has two traps, and they belong in one
// place rather than in each caller's memory.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG } from './config.ts';

/** Runs `work` with a scratch directory for tiles, outside anything the user owns, gone when it returns or throws. */
export function withTileDir<T>(work: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-tiles-'));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const tilePath = (dir: string, index: number): string => join(dir, `t-${String(index).padStart(4, '0')}.png`);

/**
 * ffmpeg exits 0 and writes nothing when a seek lands past the last VIDEO frame, which a trailing
 * audio track makes ordinary. A missing tile ends the image sequence there, so the sheet comes out
 * short while the index still promises every tile. Refuse instead of mislabelling.
 */
export function assertTile(path: string, what: string): void {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`no frame came out for ${what}: the time is past the last decodable video frame, or the file has no picture there`);
  }
}

/**
 * Tiles `count` images named by `tilePath(dir, i)` into `sheet`, row-major.
 * Every tile must already share one size and one pixel format: a sequence whose members differ in
 * either makes ffmpeg's image reader stop at the first change.
 */
export function tileSheet(dir: string, count: number, cols: number, sheet: string, padding = 6): { cols: number; rows: number } {
  if (count < 1) throw new Error('nothing to tile: no frames were produced');
  const c = Math.max(1, Math.min(cols, count));
  const rows = Math.ceil(count / c);
  for (let i = 0; i < count; i++) assertTile(tilePath(dir, i), `tile ${i + 1}`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-framerate', '1', '-start_number', '0', '-i', join(dir, 't-%04d.png'),
    '-vf', `tile=${c}x${rows}:padding=${padding}:color=0x202020`, '-frames:v', '1', '-q:v', '3', sheet]);
  return { cols: c, rows };
}
