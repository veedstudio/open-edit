// A still at the moment you name.
//
// Every session's transcripts carry the same retyped ffmpeg line: a frame at 12.5s, frame 300, one
// every half second between two cuts, a grid of them on one sheet — each time with the seek
// arithmetic redone (and often a frame off), the file named by hand, and no record of which frame it
// was. This is that line once, with the frame index and the second of every still written beside it.
//
//   openedit frames <video> --at 12.5,1:02 --frame 300 --every 0.5 --from 8 --to 11 [--sheet]
//   openedit frames --images <file|dir> [...]      pictures that already exist, on one sheet
//
// The second form is for a set of reference pictures: opened one at a time, each is a turn on a
// context already deep, and one sheet is one turn.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { parseUsage, usageLine, numberFlag, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { probeFps, probeDisplaySize, videoDurationOf } from '../probe.ts';
import { tilePath, tileSheet, withTileDir } from '../sheet.ts';

export interface Still { frame: number; sec: number; path: string }
export interface Sheet { path: string; cols: number; rows: number; tileWidth: number }
export interface FramePlan {
  video: string;
  fps: number;
  durationSec: number;
  width: number;
  height: number;
  /** In frame order, row-major on the sheet. */
  stills: Still[];
  sheet?: Sheet;
}

export interface Selection {
  at?: string[];
  frame?: string[];
  every?: number;
  count?: number;
  from?: number;
  to?: number;
}

/** `12.5`, `12.5s`, `1:02.5`, `0:01:02.5` → seconds. */
export function parseTimeSpec(raw: string): number {
  const parts = raw.trim().replace(/s$/, '').split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`not a time: "${raw}" (want seconds such as 12.5, or m:ss / h:mm:ss)`);
  }
  return parts.map(Number).reduce((acc, p) => acc * 60 + p, 0);
}

/** `12`, `100-104` → frame indices. */
export function parseFrameSpec(raw: string): number[] {
  const m = raw.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`not a frame: "${raw}" (want an index such as 300, or a range such as 300-306)`);
  const [a, b] = [Number(m[1]), m[2] === undefined ? Number(m[1]) : Number(m[2])];
  if (b < a) throw new Error(`frame range runs backwards: "${raw}"`);
  if (b - a > 10_000) throw new Error(`frame range "${raw}" is more than 10000 frames; use --every for a sweep`);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** The frame on screen at `sec`: the last one whose time is not after it. */
export function frameAt(sec: number, fps: number): number {
  return Math.floor(sec * fps + 1e-6);
}

/**
 * ffmpeg emits the first frame whose pts is not before `-ss`, so seeking to n/fps exactly lands on
 * n or n+1 depending on how the rational rate rounded. Half a frame early lands on n every time.
 */
export function seekFor(frame: number, fps: number): number {
  return Math.max(0, (frame - 0.5) / fps);
}

const splitList = (raw: string[] | undefined): string[] =>
  (raw ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

/** The frame indices a selection names, deduplicated and in order; a named moment past the picture is refused. */
export function selectFrames(sel: Selection, fps: number, durationSec: number): number[] {
  const last = frameAt(durationSec, fps) - 1;
  const named: number[] = [];
  for (const t of splitList(sel.at)) named.push(frameAt(parseTimeSpec(t), fps));
  for (const f of splitList(sel.frame)) named.push(...parseFrameSpec(f));
  const past = named.filter((n) => n > last);
  if (past.length) {
    throw new Error(
      `${past.length} requested frame(s) lie past the last frame of the picture (frame ${last}, ${(last / fps).toFixed(3)}s): ` +
      past.map((n) => `${n} (${(n / fps).toFixed(3)}s)`).join(', '),
    );
  }

  // Sweeps are clipped to the picture rather than refused: an --every that lands on the duration is
  // the ordinary case, not a mistake.
  const from = sel.from ?? 0;
  const to = Math.min(sel.to ?? durationSec, durationSec);
  if (to < from) throw new Error(`--to (${to}s) is before --from (${from}s)`);
  const swept: number[] = [];
  if (sel.every !== undefined) {
    for (let t = from; t <= to + 1e-9; t += sel.every) swept.push(frameAt(t, fps));
  }
  if (sel.count !== undefined) {
    // Bin midpoints, so a count of one is the middle of the span rather than its first frame.
    for (let i = 0; i < sel.count; i++) swept.push(frameAt(from + ((i + 0.5) * (to - from)) / sel.count, fps));
  }

  const all = [...named, ...swept.filter((n) => n <= last)];
  if (!all.length) throw new Error('nothing selected: give --at, --frame, --every or --count');
  return [...new Set(all)].sort((a, b) => a - b);
}

export interface ExtractOptions extends Selection {
  out: string;
  width?: number;
  crop?: { x: number; y: number; w: number; h: number };
  sheet?: boolean;
  cols?: number;
}

/** `x,y,w,h` in source pixels. */
export function parseCrop(raw: string): { x: number; y: number; w: number; h: number } {
  const p = raw.split(',').map((s) => Number(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0) || p[2] === 0 || p[3] === 0) {
    throw new Error(`--crop wants x,y,w,h in source pixels, e.g. --crop 0,900,1920,180; got "${raw}"`);
  }
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

function stillFilters(o: ExtractOptions): string[] {
  const chain: string[] = [];
  if (o.crop) chain.push(`crop=${o.crop.w}:${o.crop.h}:${o.crop.x}:${o.crop.y}`);
  // -2 keeps the height even, which every codec downstream of a still will want.
  if (o.width) chain.push(`scale=${o.width}:-2`);
  return chain.length ? ['-vf', chain.join(',')] : [];
}

export function extractFrames(video: string, o: ExtractOptions): FramePlan {
  const fps = probeFps(video);
  const durationSec = videoDurationOf(video);
  const { width, height } = probeDisplaySize(video);
  const frames = selectFrames(o, fps, durationSec);
  mkdirSync(o.out, { recursive: true });

  const stills: Still[] = frames.map((frame) => {
    const sec = Number((frame / fps).toFixed(3));
    return { frame, sec, path: join(o.out, `f${String(frame).padStart(6, '0')}-${sec.toFixed(3)}s.png`) };
  });
  const missing: string[] = [];
  for (const s of stills) {
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(seekFor(s.frame, fps)), '-i', video,
      '-frames:v', '1', ...stillFilters(o), s.path]);
    // A seek past the picture exits 0 and writes nothing; the duration probe catches most of these,
    // but a stream whose declared length outruns its frames still reaches here.
    if (!existsSync(s.path) || statSync(s.path).size === 0) missing.push(`frame ${s.frame} (${s.sec}s)`);
  }
  if (missing.length) throw new Error(`ffmpeg wrote no still for ${missing.join(', ')}: past the last decodable frame`);

  const plan: FramePlan = { video, fps, durationSec, width, height, stills };
  if (o.sheet) {
    const cols = o.cols ?? Math.ceil(Math.sqrt(stills.length));
    const rows = Math.ceil(stills.length / cols);
    const tileWidth = o.width ?? 320;
    const path = join(o.out, 'sheet.png');
    execFileSync(FFMPEG, ['-y', '-v', 'error',
      ...stills.flatMap((s) => ['-i', s.path]),
      '-filter_complex',
      `concat=n=${stills.length}:v=1:a=0,scale=${tileWidth}:-2,tile=${cols}x${rows}:padding=4:margin=4:color=0x202020`,
      '-frames:v', '1', path]);
    plan.sheet = { path, cols, rows, tileWidth };
  }
  writeFileSync(join(o.out, 'frames.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

export interface ImageTile { tile: number; row: number; col: number; source: string; width: number; height: number }
export interface ImagePlan { images: ImageTile[]; sheet: Sheet }

/** Files named directly, plus the images of any directory named, in name order and without repeats. */
export function collectImages(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const p = resolve(a);
    if (!existsSync(p)) throw new Error(`${a} does not exist`);
    if (statSync(p).isDirectory()) {
      const names = readdirSync(p).filter((n) => IMAGE.test(n)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
      out.push(...names.map((n) => join(p, n)));
    } else out.push(p);
  }
  return [...new Set(out)];
}

/**
 * One sheet of pictures that already exist. Unlike stills of one video they share no size, so each is
 * fitted into a square cell first, over the cell's own grey: a logo on a transparent ground stays a logo.
 */
export function sheetImages(images: string[], o: { out: string; width?: number; cols?: number }): ImagePlan {
  if (!images.length) throw new Error('no images found');
  mkdirSync(o.out, { recursive: true });
  const cols = Math.min(o.cols ?? Math.ceil(Math.sqrt(images.length)), images.length);
  const cell = o.width ?? 320;
  const path = join(o.out, 'sheet.png');
  const fit = `color=0x808080:s=${cell}x${cell}[bg];[0:v]trim=end_frame=1,scale=${cell}:${cell}:force_original_aspect_ratio=decrease[fg];` +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24';
  const plan = withTileDir((dir): ImagePlan => {
    const tiles = images.map((source, i) => {
      // ffmpeg reads a `%d` in an image's name as a sequence pattern and opens a sibling, or nothing.
      // A copy under a plain name is read as the one file it is.
      const plain = join(dir, `src-${i}${extname(source)}`);
      copyFileSync(source, plain);
      // One frame per picture: an animation left whole pushes every later tile off the sheet.
      execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', plain, '-filter_complex', fit, '-frames:v', '1', tilePath(dir, i)]);
      return { tile: i + 1, row: Math.floor(i / cols) + 1, col: (i % cols) + 1, source, ...probeDisplaySize(plain) };
    });
    const grid = tileSheet(dir, images.length, cols, path, 4);
    return { images: tiles, sheet: { path, ...grid, tileWidth: cell } };
  });
  writeFileSync(join(o.out, 'images.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

export const usage = {
  summary: 'Stills at the moments you name',
  positionals: '<video> | <image|dir> [...]',
  flags: {
    images: { type: 'boolean', help: 'The positionals are pictures, or directories of them: tile them on one sheet.png, listed in images.json' },
    at: { type: 'string', multiple: true, value: '<sec,...>', help: 'Seconds (12.5, 1:02.5, 0:01:02.5); repeatable or comma-separated' },
    frame: { type: 'string', multiple: true, value: '<n,...>', help: 'Frame indices (300) or ranges (300-306); repeatable or comma-separated' },
    every: { type: 'string', value: '<sec>', help: 'One still every N seconds across --from/--to' },
    count: { type: 'string', value: 'N', help: 'N stills spread evenly across --from/--to' },
    from: { type: 'string', value: '<sec>', help: 'Start of the sweep (default 0)' },
    to: { type: 'string', value: '<sec>', help: 'End of the sweep (default: end of the picture)' },
    out: { type: 'string', value: '<dir>', help: 'Where the stills, frames.json and the sheet are written (default qa/frames-<video>)' },
    width: { type: 'string', value: 'N', help: 'Scale each still to N px wide, keeping the aspect; without it a still is a PNG at source size (many MB each). With --images: the edge of each square cell (default 320)' },
    crop: { type: 'string', value: 'x,y,w,h', help: 'Crop each still to this source-pixel box before scaling' },
    sheet: { type: 'boolean', help: 'Also tile every still on one sheet.png, row-major in frame order (tiles 320 wide unless --width)' },
    cols: { type: 'string', value: 'N', help: 'Columns on the sheet (default: square)' },
    json: { type: 'boolean', help: 'Print the plan as JSON' },
  },
  notes: 'A still is named f<frame>-<sec>s.png and frames.json lists every one, so a finding can cite a frame rather than "around 12s". The sheet has no labels: read tile positions off frames.json. With --images nothing is extracted: sheet.png and images.json (tile, place, file, native size) are the output.',
} satisfies Usage;

export function frames(argv: string[]): number {
  const { values, positionals } = parseUsage('frames', usage, argv);
  const int = (flag: 'count' | 'width' | 'cols') =>
    values[flag] === undefined ? undefined : numberFlag(flag, values[flag], 1, (n) => Number.isInteger(n) && n > 0, 'a positive integer');
  if (values.images) {
    const videoOnly = (['at', 'frame', 'every', 'count', 'from', 'to', 'crop'] as const).filter((f) => values[f] !== undefined);
    if (!positionals.length || videoOnly.length) {
      console.error(videoOnly.length ? `--images tiles pictures that already exist; --${videoOnly.join(', --')} pick moments in a video` : usageLine('frames', usage));
      return 2;
    }
    let pictures: string[];
    try { pictures = collectImages(positionals); } catch (e) { console.error((e as Error).message); return 2; }
    const named = basename(resolve(positionals[0])).replace(/\.\w+$/, '');
    const plan = sheetImages(pictures, { out: values.out ?? join(process.cwd(), 'qa', `images-${named}`), width: int('width'), cols: int('cols') });
    if (values.json) {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    console.log(`frames: ${plan.images.length} picture(s) on one sheet, ${plan.sheet.cols}x${plan.sheet.rows}, row-major → ${plan.sheet.path}`);
    for (const t of plan.images) console.log(`  tile ${String(t.tile).padStart(2)}  row ${t.row} col ${t.col}  ${basename(t.source)}  ${t.width}x${t.height}`);
    console.log(`  plan: ${join(plan.sheet.path, '..', 'images.json')}`);
    return 0;
  }
  const [video] = positionals;
  if (!video || !existsSync(video)) {
    console.error(usageLine('frames', usage));
    return 2;
  }
  const sec = (flag: 'every' | 'from' | 'to') =>
    values[flag] === undefined ? undefined : numberFlag(flag, values[flag], 0, (n) => n >= 0 && (flag !== 'every' || n > 0), 'seconds');
  const plan = extractFrames(video, {
    at: values.at,
    frame: values.frame,
    every: sec('every'),
    count: int('count'),
    from: sec('from'),
    to: sec('to'),
    out: values.out ?? join(process.cwd(), 'qa', `frames-${basename(video).replace(/\.\w+$/, '')}`),
    width: int('width'),
    crop: values.crop === undefined ? undefined : parseCrop(values.crop),
    sheet: values.sheet,
    cols: int('cols'),
  });

  if (values.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const out = join(plan.stills[0].path, '..');
  console.log(`frames: ${plan.stills.length} still(s) from ${video} (${plan.fps} fps, ${plan.width}x${plan.height}, ${plan.durationSec.toFixed(3)}s) → ${out}`);
  for (const s of plan.stills) console.log(`  f${String(s.frame).padStart(6, '0')}  ${s.sec.toFixed(3)}s  ${s.path}`);
  if (plan.sheet) console.log(`  sheet: ${plan.sheet.cols}x${plan.sheet.rows}, row-major in the order above → ${plan.sheet.path}`);
  console.log(`  plan: ${join(out, 'frames.json')}`);
  return 0;
}
