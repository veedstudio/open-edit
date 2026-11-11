// The sound of the videos a page plays, laid where the render played them. The render seeks every <video> of the page
// to its time on every frame and records, every sample, which second of which file each one shows (`<video>.text.json`),
// so that record is the one place a video's trims, loops and speed are known; read from there, no offset is typed by hand.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { FFMPEG } from './config.ts';
import { readRecord, recordPath, recordSeconds, type TextRecord } from './render/text-record.ts';
import { frameTime, parseFps } from './render/timing.ts';

/** A stretch of a file's sound on the page: from `in` to `out` in the file's seconds, starting at `at` on the page's clock. */
export interface Stretch {
  at: number;
  in: number;
  out: number;
  /** File seconds per page second: 1 as recorded, 2 at double speed. */
  rate: number;
}

/** What the page did with one file: where it showed it, the stretches whose sound is heard, and where it moved too fast or backwards to be. */
export interface PageSound {
  file: string;
  from: number;
  to: number;
  stretches: Stretch[];
  unheard: { from: number; to: number; rate: number }[];
}

/**
 * A clip whose time stays within this of one line plays on: a page that sets a clip's time in whole frames of a
 * 24 fps clip strays up to 42 ms from it. A seek any further starts a new stretch.
 */
export const STEADY_SEC = 0.05;

/** Chrome refuses a playbackRate outside 1/16 to 16, so a picture moving through its file faster or slower has no sound to lay. */
export const MIN_RATE = 1 / 16;
export const MAX_RATE = 16;

/** Each stretch fades in and out over this, a third of a frame at 30 fps: a sound cut off mid-wave clicks, and a cut still lands on its frame. */
export const EDGE_FADE_SEC = 0.01;

/** A stretch drifting less than this from playing at 1x is played at 1x, rather than stretched by a rounding error. */
const DRIFT_SEC = 0.001;

interface Point { k: number; p: number; f: number }

/** The points of one run of a clip's time, with the sums its least-squares line is read from, taken from its first point. */
class Run {
  readonly points: Point[] = [];
  private sp = 0;
  private sf = 0;
  private spp = 0;
  private spf = 0;

  constructor(first: Point) {
    this.add(first);
  }

  add(pt: Point): void {
    this.points.push(pt);
    const p = pt.p - this.points[0].p;
    const f = pt.f - this.points[0].f;
    this.sp += p;
    this.sf += f;
    this.spp += p * p;
    this.spf += p * f;
  }

  get last(): Point {
    return this.points[this.points.length - 1];
  }

  /** The file's time on the page as the run moves: f = c + rate * p. A run seen once plays at 1x, as the render plays any it is not told otherwise. */
  line(): { rate: number; c: number } {
    const [first] = this.points;
    const n = this.points.length;
    if (n < 2) return { rate: 1, c: first.f - first.p };
    const rate = (n * this.spf - this.sp * this.sf) / (n * this.spp - this.sp * this.sp);
    const meanP = first.p + this.sp / n;
    const meanF = first.f + this.sf / n;
    if (Math.abs(rate - 1) * (this.last.p - first.p) <= DRIFT_SEC) return { rate: 1, c: meanF - meanP };
    return { rate, c: meanF - rate * meanP };
  }

  /**
   * How far a time is from where the run would be. A run seen once takes the time nearest to playing on at 1x, at any
   * speed, so a clip played backwards or too fast is one run to name rather than a run per sample laid at 1x.
   */
  cost(p: number, f: number): number {
    if (this.points.length === 1) return Math.abs((f - this.last.f) / (p - this.last.p) - 1);
    const { rate, c } = this.line();
    const off = Math.abs(f - (c + rate * p));
    return off <= STEADY_SEC ? off : Infinity;
  }
}

/** Runs of one file's times from sample to sample: each time shown joins the run it continues, else starts one. */
function runsOf(shown: (number[] | undefined)[], times: number[]): Run[] {
  const done: Run[] = [];
  let open: Run[] = [];
  shown.forEach((fs = [], k) => {
    const p = times[k];
    const free = new Set(fs.keys());
    const next: Run[] = [];
    for (const run of [...open].sort((a, b) => b.points.length - a.points.length)) {
      let best = -1;
      let cost = Infinity;
      for (const j of free) {
        const c = run.cost(p, fs[j]);
        if (c < cost) { cost = c; best = j; }
      }
      if (best < 0) { done.push(run); continue; }
      run.add({ k, p, f: fs[best] });
      free.delete(best);
      next.push(run);
    }
    for (const j of free) next.push(new Run({ k, p, f: fs[j] }));
    open = next;
  });
  return [...done, ...open].sort((a, b) => a.points[0].k - b.points[0].k);
}

const ms = (v: number) => Math.round(v * 1000) / 1000;

/**
 * What the page played of each file, from the render's record, its sound `lengthOf` seconds long. A sample stands for
 * the frames up to the next, so a stretch runs from the first sample that shows it to the next sample that does not,
 * except where its line meets the file's start in between (a clip started from its beginning there) or, for a clip
 * that jumps (a loop back to its start), where the next stretch begins. Two elements showing one file at one moment
 * are one sound.
 */
export function pageSounds(record: TextRecord, lengthOf: (file: string) => number): PageSound[] {
  const fps = parseFps(record.fps);
  const times = record.samples.map((s) => frameTime(s.frame, fps));
  const end = recordSeconds(record);
  const after = (k: number) => (k + 1 < times.length ? times[k + 1] : end);
  const byFile = new Map<string, number[][]>();
  record.samples.forEach((s, k) => {
    for (const v of s.videos ?? []) {
      if (!byFile.has(v.file)) byFile.set(v.file, []);
      const at = byFile.get(v.file)!;
      at[k] ??= [];
      if (!at[k].some((f) => Math.abs(f - v.time) < 1e-3)) at[k].push(v.time);
    }
  });
  return [...byFile].map(([file, shown]) => {
    const runs = runsOf(Array.from({ length: times.length }, (_, k) => shown[k]), times);
    const lines = runs.map((r) => r.line());
    const starts = runs.map((r, i) => {
      const a = r.points[0].k;
      const { rate, c } = lines[i];
      const zero = rate > 0 ? -c / rate : NaN;
      return a > 0 && zero >= times[a - 1] && zero < times[a] ? zero : times[a];
    });
    const length = lengthOf(file);
    const sound: PageSound = { file, from: Infinity, to: 0, stretches: [], unheard: [] };
    runs.forEach((r, i) => {
      const b = r.last.k;
      const opening = runs.flatMap((o, j) => (o.points[0].k === b + 1 ? [j] : []));
      const closing = runs.filter((o) => o.last.k === b);
      let to = after(b);
      // One stretch giving way to one other of the same file is a seek, a loop back to the start among them.
      if (opening.length === 1 && closing.length === 1 && starts[opening[0]] > times[b]) to = Math.min(to, starts[opening[0]]);
      let from = starts[i];
      sound.from = Math.min(sound.from, from);
      sound.to = Math.max(sound.to, to);
      const { rate, c } = lines[i];
      if (rate < MIN_RATE || rate > MAX_RATE) {
        // A picture held on one frame is silent; one moving too slowly, too fast or backwards is named.
        if (Math.abs(rate) * Math.max(to - from, after(b) - times[b]) >= STEADY_SEC) sound.unheard.push({ from: ms(from), to: ms(to), rate });
        return;
      }
      if (c + rate * from < 0) from = -c / rate;
      if (c + rate * to > length) to = (length - c) / rate;
      if (to - from < 0.001) return;
      sound.stretches.push({ at: from, in: Math.max(0, c + rate * from), out: Math.min(length, c + rate * to), rate });
    });
    sound.stretches.sort((x, y) => x.at - y.at);
    return sound;
  });
}

/** `atempo` steps that change the speed by `rate`: one step takes 0.5 to 100, so a slower rate is halved until it fits. */
export function tempoOf(rate: number): string[] {
  if (rate === 1) return [];
  const steps: string[] = [];
  let left = rate;
  while (left < 0.5) {
    steps.push('atempo=0.5');
    left /= 0.5;
  }
  steps.push(`atempo=${Number(left.toFixed(6))}`);
  return steps;
}

/**
 * The filtergraph that lays one file's stretches into a track starting at `startAt` on the page and `lengthSec` long,
 * one input per stretch. Each is cut on the file's own clock, which is the one Chrome's currentTime counts, so a file
 * whose sound starts after its picture keeps the gap; then sped, faded at its edges and placed.
 */
export function stemGraph(stretches: readonly Stretch[], startAt: number, lengthSec: number): string {
  const parts = stretches.map((s, k) => {
    const len = (s.out - s.in) / s.rate;
    const fade = Math.min(EDGE_FADE_SEC, len / 2);
    return [`[${k}:a]atrim=start=${s.in}:end=${s.out}`, `asetpts=PTS-${s.in}/TB`, 'aresample=48000:async=1:first_pts=0',
      'aformat=sample_fmts=fltp:channel_layouts=stereo', ...tempoOf(s.rate), 'asetpts=N/SR/TB',
      `afade=t=in:d=${fade}`, `afade=t=out:st=${Math.max(0, len - fade)}:d=${fade}`,
      `adelay=delays=${((s.at - startAt) * 1000).toFixed(3)}:all=1[s${k}]`].join(',');
  });
  const labels = stretches.map((_, k) => `[s${k}]`).join('');
  const sum = stretches.length > 1 ? `${labels}amix=inputs=${stretches.length}:normalize=0,asetpts=N/SR/TB` : `${labels}anull`;
  return [...parts, `${sum},apad=whole_dur=${lengthSec},atrim=0:${lengthSec}[stem]`].join(';');
}

/** One file's stretches as a float WAV at `out`, from the first stretch's start, which is returned with the track's length. */
export function layStem(file: string, stretches: readonly Stretch[], out: string): { atSec: number; lengthSec: number } {
  // Started on a whole millisecond, which is what the mix places a track on, with the rest kept inside the stem.
  const atSec = Math.floor(stretches[0].at * 1000) / 1000;
  const lengthSec = ms(Math.max(...stretches.map((s) => s.at + (s.out - s.in) / s.rate)) - atSec);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...stretches.flatMap(() => ['-i', file])];
  args.push('-filter_complex', stemGraph(stretches, atSec, lengthSec), '-map', '[stem]', '-c:a', 'pcm_f32le', out);
  execFileSync(FFMPEG, args);
  return { atSec, lengthSec };
}

/**
 * The render whose record names the page's videos: `video` when given, else the newest render with a record in the
 * run or a folder of it (render caches aside). Null when there is none, or the record is older than its video, since
 * it then describes a picture written there before.
 */
export function pageRecordOf(runDir: string, video?: string): { video: string; record: TextRecord } | null {
  const current = (v: string) => existsSync(v) && existsSync(recordPath(v)) && statSync(recordPath(v)).mtimeMs >= statSync(v).mtimeMs;
  if (video !== undefined) return current(video) ? { video, record: readRecord(recordPath(video)) } : null;
  const found: { video: string; at: number }[] = [];
  const look = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && !e.name.endsWith('.render') && e.name !== 'node_modules') look(path, depth - 1);
      } else if (e.name.endsWith('.text.json')) {
        const v = path.slice(0, -'.text.json'.length);
        if (current(v)) found.push({ video: v, at: statSync(path).mtimeMs });
      }
    }
  };
  look(runDir, 1);
  const newest = found.sort((a, b) => b.at - a.at)[0];
  return newest ? { video: newest.video, record: readRecord(recordPath(newest.video)) } : null;
}

/** A path as the spec names it: from the run, when the file is in it. */
export function shownPath(runDir: string, file: string): string {
  const r = relative(resolve(runDir), file);
  return r.startsWith('..') || isAbsolute(r) ? file : r;
}

/** The same file by any of its names; a path that is not there stands for itself. */
export const sameFile = (file: string): string => (existsSync(file) ? realpathSync(file) : resolve(file));
