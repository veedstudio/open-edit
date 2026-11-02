// A shot list's storyboard: a few frames of every shot, each labelled with its shot number and time, in shot
// order, on sheets an agent can take in at once.
//
// One still says little about a shot that moves or changes, so a shot of a second or more shows its first,
// middle and last frame, and a shorter one its middle frame alone. Each still is decoded the way `frames`
// decodes one (its seek, its HDR conversion), as raw pixels: the labels and the sheet are put together here,
// in memory, so a sheet costs one encode rather than a file per tile.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { frameShowing, oneFrameOf, sdrFilterOf } from './commands/frames.ts';
import type { ShotListFile } from './commands/shots.ts';
import { FFMPEG } from './config.ts';
import { probeSquareSize } from './probe.ts';
import { processAlive } from './providers/exclusive-files.ts';

const execFileAsync = promisify(execFile);

// An agent may be shown only its newest four pictures, so a whole reference has to fit on four.
export const MAX_SHEETS = 4;

// Vision models take in a picture of up to 4784 patches of 28 px without scaling it down, and a request
// carrying many pictures refuses one over 2000 px a side.
export const SHEET_SIDE = 2000;
export const SHEET_PATCHES = 4784;
const PATCH = 28;

// 480x270 at 16:9 and 270x480 at 9:16: a quarter of 1080p's width and height, where a caption 48 px tall is
// 12 px, still legible. By area rather than width, so a portrait or square reference is shown as large.
export const TILE_AREA = 480 * 270;

// Below this a shot shows one frame: a single still of a shot under a second already shows most of it.
export const THREE_FRAMES_FROM_SEC = 1;

const PADDING = 4;
// A 5x7 glyph with two rows above and below it, times the label's scale.
const BAND_ROWS = 11;
const BLANK = 0x20;
// A marker this old belongs to a run that died, whatever its pid now names, since a live run renews its own.
// Sheets no list names are kept this long too: a run beside the one that replaced them may have printed them.
export const LEASE_MS = 10 * 60_000;
// Seeking a long-GOP source decodes from its last keyframe, so the stills are made several at once.
const STILL_WORKERS = Math.max(1, Math.min(8, availableParallelism() - 1));

export type ShotFrameAt = 'start' | 'middle' | 'end';

export interface StoryboardTile {
  shot: number;
  at: ShotFrameAt;
  /** The index `frames --frame` shows this picture at. */
  frame: number;
  /** When the picture appears, in seconds on the shot list's clock. */
  sec: number;
  /** What is printed above the picture. */
  label: string;
  /** The sheet it is on. */
  sheet: string;
  /** Counted from 1. */
  row: number;
  col: number;
}

export interface Storyboard {
  /** In shot order. */
  sheets: string[];
  /** Pixels: the picture, the label band above it, and the gap between tiles. */
  tile: { width: number; height: number; label: number; padding: number };
  /** Why the shots show fewer frames, or smaller ones, than the rule gives; null when they do not. */
  note: string | null;
  tiles: StoryboardTile[];
}

/** The storyboard, or why there is none. */
export type StoryboardResult = Storyboard | { sheets: []; why: string };

export interface ShotSpan {
  shot: number;
  start: number;
  end: number;
  duration: number;
}

export type Size = { width: number; height: number };
type Picked = Omit<StoryboardTile, 'sheet' | 'row' | 'col'>;

export interface StoryboardPlan {
  tiles: Picked[];
  tile: Size;
  /** Label scale: each glyph pixel is this many pixels square. */
  scale: number;
  cols: number;
  rows: number;
  /** Per sheet, row-major: the index into `tiles` each cell shows, or null for an empty cell. */
  cells: (number | null)[][];
  note: string | null;
}

// 5x7, a row per number, its high bit the leftmost pixel: the HD44780 character ROM's glyphs, only those a
// label holds.
const GLYPHS: Record<string, number[]> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  's': [0, 0, 0b01110, 0b10000, 0b01110, 0b00001, 0b11110],
  '#': [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

export const labelOf = (shot: number, sec: number): string => `#${shot} ${sec.toFixed(3)}s`;

/** A label band's height at `scale`. */
export const bandHeight = (scale: number): number => BAND_ROWS * scale;

/** How wide a label of `chars` characters is at `scale`, its margins included. */
const labelWidth = (chars: number, scale: number): number => 4 * scale + chars * 6 * scale - scale;

/** The pixel size of a sheet of `cells` cells laid out as `grid` lays them, its last row possibly short. */
export function sheetPixels(grid: { tile: Size; scale: number; cols: number }, cells: number): Size {
  const across = (n: number, size: number) => n * size + (n - 1) * PADDING;
  return {
    width: across(Math.min(cells, grid.cols), grid.tile.width),
    height: across(Math.ceil(cells / grid.cols), grid.tile.height + bandHeight(grid.scale)),
  };
}

/** The largest scale, 2 or 1, at which `chars` characters fit across `width` with a margin; 0 when none does. */
export function labelScale(width: number, chars: number): number {
  for (const scale of [2, 1]) if (labelWidth(chars, scale) <= width) return scale;
  return 0;
}

/**
 * A label band as raw rgb24, `width` wide: white glyphs on black. Drawn here because ffmpeg's drawtext needs
 * libfreetype, which builds such as Homebrew's leave out.
 */
export function labelBand(text: string, width: number, scale: number): Buffer {
  const band = Buffer.alloc(width * bandHeight(scale) * 3);
  [...text].forEach((ch, i) => {
    const rows = GLYPHS[ch];
    if (!rows) throw new Error(`a label holds "${ch}", which has no glyph`);
    rows.forEach((bits, gy) => {
      for (let gx = 0; gx < 5; gx++) {
        if (!((bits >> (4 - gx)) & 1)) continue;
        for (let dy = 0; dy < scale; dy++) {
          const y = (2 + gy) * scale + dy;
          const x = (2 + i * 6 + gx) * scale;
          band.fill(255, (y * width + x) * 3, (y * width + x + scale) * 3);
        }
      }
    });
  });
  return band;
}

/** A picture of `area` pixels in the source's shape, never wider than the source, with even sides. */
export function tileSize(source: Size, area = TILE_AREA): Size {
  // The epsilon keeps a square root that lands a hair under an even width from losing two pixels.
  const even = (v: number) => Math.max(2, Math.floor(v / 2 + 1e-6) * 2);
  const width = even(Math.min(source.width, Math.sqrt((area * source.width) / source.height)));
  return { width, height: even((width * source.height) / source.width + 1) };
}

/**
 * The frames each shot shows, in shot order, from `pts`: every decoded frame's time. A shot's first and last
 * frames are the first and last it decoded to, and its middle the one on screen halfway through it, so no
 * tile lands on a neighbouring shot whatever the frame rate does.
 */
export function pickFrames(shots: ShotSpan[], pts: number[], fps: number, three: boolean): Picked[] {
  const half = 0.5 / fps;
  let k = 0;
  return shots.flatMap((s, i) => {
    const shown: number[] = [];
    for (; k < pts.length && (i === shots.length - 1 || pts[k] < s.end - half); k++) if (pts[k] >= s.start - half) shown.push(pts[k]);
    if (!shown.length) return [];
    const halfway = (s.start + s.end) / 2;
    const middle = shown.reduce((on, p) => (p <= halfway + 1e-6 ? p : on), shown[0]);
    const picks: [ShotFrameAt, number][] = three && s.duration >= THREE_FRAMES_FROM_SEC && shown.length >= 3
      ? [['start', shown[0]], ['middle', middle], ['end', shown[shown.length - 1]]]
      : [['middle', middle]];
    return picks.filter(([, p], j) => picks.findIndex(([, q]) => q === p) === j).map(([at, p]) => {
      const sec = Number(p.toFixed(3));
      return { shot: s.shot, at, frame: frameShowing(p, fps), sec, label: labelOf(s.shot, sec) };
    });
  });
}

/**
 * Cells row by row, a shot's frames side by side on one row: a shot that does not fit what is left of a row
 * starts the next, and a full sheet starts the next sheet. Empty cells at a sheet's end are dropped.
 */
export function pack(groups: number[], cols: number, rows: number): (number | null)[][] {
  const sheets: (number | null)[][] = [];
  let cells: (number | null)[] = [];
  let next = 0;
  for (const size of groups) {
    if (size > cols) throw new Error(`a shot of ${size} frames cannot sit on a row of ${cols}`);
    if ((cells.length % cols) + size > cols) while (cells.length % cols) cells.push(null);
    if (cells.length === cols * rows) {
      sheets.push(cells);
      cells = [];
    }
    for (let k = 0; k < size; k++) cells.push(next++);
  }
  sheets.push(cells);
  for (const s of sheets) while (s.at(-1) === null) s.pop();
  return sheets;
}

/** How many frames each shot shows, in shot order. */
function groupsOf(tiles: Picked[]): number[] {
  const groups: number[] = [];
  tiles.forEach((t, i) => {
    if (i && tiles[i - 1].shot === t.shot) groups[groups.length - 1]++;
    else groups.push(1);
  });
  return groups;
}

type Layout = Omit<StoryboardPlan, 'tiles' | 'note'>;

/** Of the grids within the sheet limits, the one needing the fewest sheets, then the least picture area. */
function layout(groups: number[], tile: Size, scale: number): Layout | null {
  const cellHeight = tile.height + bandHeight(scale);
  let best: (Layout & { area: number }) | null = null;
  for (let cols = Math.max(...groups); sheetPixels({ tile, scale, cols }, cols).width <= SHEET_SIDE; cols++) {
    const width = sheetPixels({ tile, scale, cols }, cols).width;
    const tall = Math.min(SHEET_SIDE, Math.floor(SHEET_PATCHES / Math.ceil(width / PATCH)) * PATCH);
    const rows = Math.floor((tall + PADDING) / (cellHeight + PADDING));
    if (rows < 1) continue;
    const cells = pack(groups, cols, rows);
    const area = cells.reduce((sum, c) => {
      const size = sheetPixels({ tile, scale, cols }, c.length);
      return sum + size.width * size.height;
    }, 0);
    if (!best || cells.length < best.cells.length || (cells.length === best.cells.length && area < best.area)) {
      best = { tile, scale, cols, rows, cells, area };
    }
  }
  if (!best) return null;
  const { area: _, ...chosen } = best;
  return chosen;
}

/**
 * Three frames for a shot of a second or more while that fits the sheets; past that, every shot its middle frame;
 * past that, smaller tiles, until every shot fits or the tiles are too narrow for their labels.
 */
export function planStoryboard(shots: ShotSpan[], pts: number[], o: { fps: number; source: Size }): StoryboardPlan | { why: string } {
  const three = pickFrames(shots, pts, o.fps, true);
  if (!three.length) return { why: 'there are no shots to show' };
  const one = pickFrames(shots, pts, o.fps, false);
  const longest = Math.max(...three.map((t) => t.label.length));
  const base = tileSize(o.source);
  if (!labelScale(base.width, longest)) {
    return { why: `a tile of this picture's shape is ${base.width} px wide, narrower than the ${labelWidth(longest, 1)} px its labels need` };
  }
  const full = layout(groupsOf(three), base, labelScale(base.width, longest));
  if (full && full.cells.length <= MAX_SHEETS) return { tiles: three, ...full, note: null };
  const fewer = three.length === one.length ? null : `every shot shows its middle frame alone, since ${full
    ? `three frames a shot would need ${full.cells.length} sheets, more than ${MAX_SHEETS}`
    : `three tiles of this shape side by side are wider than a sheet's ${SHEET_SIDE} px`}`;
  for (let area = TILE_AREA; ; area *= 0.9) {
    const tile = tileSize(o.source, area);
    const scale = labelScale(tile.width, longest);
    if (!scale) break;
    const fit = layout(groupsOf(one), tile, scale);
    if (!fit || fit.cells.length > MAX_SHEETS) continue;
    const smaller = tile.width < base.width
      ? `tiles are ${tile.width}x${tile.height} rather than ${base.width}x${base.height}, so that all ${shots.length} shots fit ` +
        `${MAX_SHEETS} sheets; small on-screen text may need frames --frame for a closer look`
      : null;
    return { tiles: one, ...fit, note: [fewer, smaller].filter(Boolean).join('; ') || null };
  }
  return { why: `${shots.length} shots do not fit ${MAX_SHEETS} sheets at any tile wide enough for its label` };
}

// Each still's ffmpeg holds several decoded frames at the source's size, about 280 MB for 4K 10-bit with two
// decode threads, so a larger source runs fewer at once: sixteen 1080p decodes' worth of pixels, four for 4K.
const workersFor = (source: Size): number =>
  Math.max(1, Math.min(STILL_WORKERS, Math.floor((16 * 1920 * 1080) / (source.width * source.height))));

/** Each frame's still as raw rgb24 at the tile's size, decoded as `frames` decodes it, several at once. */
async function decodeStills(video: string, frames: number[], fps: number, tile: Size, source: Size): Promise<Map<number, Buffer>> {
  const sdr = sdrFilterOf(video);
  // Scaled to the exact tile first: the tile is in the picture's shown shape, which an anamorphic source's
  // stored pixels are not, and an HDR source's conversion then runs on the tile rather than on a 4K frame of
  // floats, which took a gigabyte a still, for 3 to 4 levels in 255 of difference from converting first.
  const vf = [`scale=${tile.width}:${tile.height}`, ...(sdr ? [sdr] : []), 'format=rgb24'].join(',');
  const bytes = tile.width * tile.height * 3;
  const stills = new Map<number, Buffer>();
  const queue = [...new Set(frames)];
  let failed = false;
  const worker = async () => {
    for (let frame = queue.shift(); frame !== undefined && !failed; frame = queue.shift()) {
      try {
        const { stdout } = await execFileAsync(FFMPEG, ['-v', 'error', '-threads', '2', ...oneFrameOf(video, frame, fps), '-vf', vf, '-f', 'rawvideo', '-'],
          { encoding: 'buffer', maxBuffer: bytes + 1 });
        if (stdout.length !== bytes) throw new Error(`ffmpeg decoded no picture at frame ${frame} of ${basename(video)}`);
        stills.set(frame, stdout);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workersFor(source), queue.length) }, worker));
  return stills;
}

/** One sheet: each cell's label above its still, on the padding's grey, encoded once. */
function drawSheet(path: string, cells: (number | null)[], plan: StoryboardPlan, stills: Map<number, Buffer>): void {
  const { width, height } = sheetPixels(plan, cells.length);
  const band = bandHeight(plan.scale);
  const sheet = Buffer.alloc(width * height * 3, BLANK);
  const place = (from: Buffer, x: number, y: number) => {
    const row = plan.tile.width * 3;
    for (let r = 0; r * row < from.length; r++) from.copy(sheet, ((y + r) * width + x) * 3, r * row, (r + 1) * row);
  };
  cells.forEach((index, i) => {
    if (index === null) return;
    const t = plan.tiles[index];
    const x = (i % plan.cols) * (plan.tile.width + PADDING);
    const y = Math.floor(i / plan.cols) * (plan.tile.height + band + PADDING);
    place(labelBand(t.label, plan.tile.width, plan.scale), x, y);
    place(stills.get(t.frame)!, x, y + band);
  });
  // JPEG: a 1640x1514 sheet of film frames measured 3.9 MB as PNG, over the 5 MB some hosts take once it is
  // base64-encoded, and 0.4 MB as JPEG with its labels still crisp. -update 1 writes one picture, so a % in
  // the path is a character, not image2's frame-number pattern.
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`,
    '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-update', '1', path], { input: sheet });
}

// Every file of a storyboard run is named for that run, so two runs over one video never write the same file,
// and the sheets a shot list names are always the ones made with it. A run's name is the time it started in
// base 36 and six random hex digits; nothing else in the folder is taken for one.
const RUN_FILE = /^storyboard-([0-9a-z]{9}[0-9a-f]{6})(?:-\d+\.jpg|\.pid)$/;
const markerOf = (dir: string, attempt: string) => join(dir, `storyboard-${attempt}.pid`);
const sheetOf = (dir: string, attempt: string, n: number) => join(dir, `storyboard-${attempt}-${n}.jpg`);

export interface StoryboardRun {
  dir: string;
  attempt: string;
  renew: NodeJS.Timeout;
}

/** A new run, with a marker that says it is alive, renewed until `sweepStoryboards` clears it. */
export function startStoryboard(dir: string): StoryboardRun {
  mkdirSync(dir, { recursive: true });
  const attempt = `${Date.now().toString(36).padStart(9, '0')}${randomBytes(3).toString('hex')}`;
  const marker = markerOf(dir, attempt);
  writeFileSync(marker, `${process.pid}\n`);
  // A draw longer than the lease would otherwise read as dead to a run sweeping beside it.
  const renew = setInterval(() => {
    try {
      utimesSync(marker, new Date(), new Date());
    } catch {
      // the marker went with a sweep; there is nothing left to keep alive
    }
  }, LEASE_MS / 4);
  renew.unref();
  return { dir, attempt, renew };
}

/**
 * Writes the storyboard of `shots` from `video` into `dir` as storyboard-<attempt>-<n>.jpg; on a failure it
 * removes what it wrote and throws.
 */
export async function writeStoryboard(
  video: string, shots: ShotSpan[], pts: number[], fps: number, dir: string, attempt: string,
): Promise<StoryboardResult> {
  const source = probeSquareSize(video);
  const plan = planStoryboard(shots, pts, { fps, source });
  if ('why' in plan) return { sheets: [], why: plan.why };
  const sheets = plan.cells.map((_, n) => sheetOf(dir, attempt, n + 1));
  try {
    const stills = await decodeStills(video, plan.tiles.map((t) => t.frame), fps, plan.tile, source);
    plan.cells.forEach((cells, n) => drawSheet(sheets[n], cells, plan, stills));
  } catch (e) {
    for (const path of sheets) {
      try {
        rmSync(path, { force: true });
      } catch {
        // held open elsewhere: a later run's sweep takes it, and the failure below is the one to report
      }
    }
    throw e;
  }
  const where = new Map<number, { sheet: string; row: number; col: number }>();
  plan.cells.forEach((cells, n) => cells.forEach((index, i) => {
    if (index !== null) where.set(index, { sheet: sheets[n], row: Math.floor(i / plan.cols) + 1, col: (i % plan.cols) + 1 });
  }));
  return {
    sheets,
    tile: { ...plan.tile, label: bandHeight(plan.scale), padding: PADDING },
    note: plan.note,
    tiles: plan.tiles.map((t, i) => ({ ...t, ...where.get(i)! })),
  };
}

/** The storyboard runs in a folder at one moment: each run's files, and the runs still drawing. */
export interface RunsSeen {
  runs: Map<string, string[]>;
  live: Set<string>;
}

/** What `dir` holds now. Taken before the list is read, so a run that finished since is named by the list. */
export function seeRuns(dir: string): RunsSeen {
  const runs = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    const run = RUN_FILE.exec(name)?.[1];
    if (run) runs.set(run, [...(runs.get(run) ?? []), join(dir, name)]);
  }
  return { runs, live: new Set([...runs.keys()].filter((run) => alive(markerOf(dir, run)))) };
}

/**
 * Removes the runs `seen` holds that the list on disk does not name, that were not drawing, and whose files are
 * older than `graceMs`: a run beside this one printed its sheets, and they stay for a while after its list is
 * replaced. A run only ever removes its own sheets on a failure, never here.
 */
export function clearRuns(seen: RunsSeen, attempt: string, list: string, graceMs = LEASE_MS): void {
  let named: string | undefined;
  try {
    const sheets = (JSON.parse(readFileSync(list, 'utf8')) as Partial<Pick<ShotListFile, 'storyboard'>>).storyboard?.sheets ?? [];
    named = sheets.length ? RUN_FILE.exec(basename(sheets[0]))?.[1] : undefined;
  } catch {
    // no list, or one being replaced: nothing on disk names a run
  }
  const now = Date.now();
  for (const [run, files] of seen.runs) {
    if (run === attempt || run === named || seen.live.has(run)) continue;
    if (graceMs > 0 && files.some((file) => now - mtimeOf(file) < graceMs)) continue;
    for (const file of files) {
      try {
        rmSync(file, { force: true });
      } catch {
        // held open elsewhere (Windows): the next run's sweep takes it
      }
    }
  }
}

/**
 * After the list is written: removes old runs' files and this run's marker. Best effort: a file another process
 * holds open stays for a later run to remove, and never fails a list already written.
 */
export function sweepStoryboards(run: StoryboardRun, list: string, graceMs = LEASE_MS): void {
  clearInterval(run.renew);
  try {
    clearRuns(seeRuns(run.dir), run.attempt, list, graceMs);
  } catch {
    // left for the next run's sweep
  }
  try {
    rmSync(markerOf(run.dir, run.attempt), { force: true });
  } catch {
    // a marker left behind reads as dead once its lease runs out
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function alive(marker: string): boolean {
  try {
    if (Date.now() - statSync(marker).mtimeMs > LEASE_MS) return false;
    return processAlive(Number(readFileSync(marker, 'utf8')));
  } catch {
    return false;
  }
}
