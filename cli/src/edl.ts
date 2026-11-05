// The EDL (edit decision list) both cut tools read: which intervals of which sources to keep, in output
// order. One reader, one validator and one snapping rule, so the assembled file and the retimed
// transcript are cut on the same instants.
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { describeValue } from './args.ts';
import { workspaceRoot } from './config.ts';
import { parseGrade, type Grade, type GradeOverride } from './grade.ts';
import { readJsonFile } from './json-file.ts';

/** One kept interval of one source, in that source's own seconds. */
export interface EdlRange {
  source: string;
  start: number;
  end: number;
  /** Free text carried through for the agent's own reading; ignored here. */
  note?: string;
  /** How fast the range plays: 0.5 is half speed, 2 double. Absent: 1. */
  speed?: number;
  /** Slow motion drawn by motion interpolation instead of repeated frames. */
  interpolate?: boolean;
  /** The range plays silent. */
  mute?: boolean;
  /** This range's grade, key by key over the cut's; a null key drops the cut's value. */
  grade?: GradeOverride;
}

export interface Edl {
  /** id -> video path. Relative paths resolve against the EDL file's directory (see locate). */
  sources: Record<string, string>;
  /** id -> transcript path. Absent: the transcript the transcribe command wrote for that source video. */
  transcripts?: Record<string, string>;
  /** The grade of every range, under each range's own. */
  grade?: Grade;
  ranges: EdlRange[];
}

/** A range whose edges sit on its source's frame grid. */
export interface SnappedRange extends EdlRange {
  fps: number;
}

/** The range checks both tools share, with one set of messages between them. */
export function assertRanges(ranges: EdlRange[]): void {
  if (ranges.length === 0) throw new Error('the EDL has no ranges');
  ranges.forEach((range, index) => {
    // ffmpeg reads a negative trim start as the whole clip, so the assembled file would be longer than promised.
    if (range.start < 0) throw new Error(`range ${index} of "${range.source}" starts at ${range.start}, before the file begins`);
    if (!(range.end > range.start)) {
      throw new Error(`range ${index} of "${range.source}" ends at ${range.end}, which is not after its start ${range.start}`);
    }
  });
}

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.values(value).every((v) => typeof v === 'string' && v !== '');

/** Shape-check a parsed EDL. `origin` names the file in every message. */
export function parseEdl(raw: unknown, origin: string): Edl {
  const bad = (what: string, value: unknown) => new Error(`${origin}: ${what} — got ${describeValue(value)}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('an EDL is a JSON object', raw);
  const o = raw as Record<string, unknown>;
  if (!isStringMap(o.sources)) throw bad('"sources" must map each id to a video path', o.sources);
  const sources = o.sources;
  if (o.transcripts !== undefined && !isStringMap(o.transcripts)) throw bad('"transcripts" must map ids to transcript paths', o.transcripts);
  if (!Array.isArray(o.ranges)) throw bad('"ranges" must be an array', o.ranges);
  const grade = o.grade === undefined ? undefined : parseGrade(o.grade, `${origin}: "grade"`, false) as Grade;
  const ranges = o.ranges.map((entry, index): EdlRange => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw bad(`range ${index} must be an object`, entry);
    const { source, start, end, note, speed, interpolate, mute, grade: own } = entry as Record<string, unknown>;
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) {
      throw bad(`range ${index} names a source the "sources" map has no entry for`, source);
    }
    for (const [name, value] of [['start', start], ['end', end]] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`range ${index} "${name}" must be a number of seconds`, value);
    }
    if (note !== undefined && typeof note !== 'string') throw bad(`range ${index} "note" must be text`, note);
    if (speed !== undefined && !(typeof speed === 'number' && Number.isFinite(speed) && speed > 0)) {
      throw bad(`range ${index} "speed" must be a number above 0 (0.5 plays at half speed, 2 at double)`, speed);
    }
    for (const [name, value] of [['interpolate', interpolate], ['mute', mute]] as const) {
      if (value !== undefined && typeof value !== 'boolean') throw bad(`range ${index} "${name}" must be true or false`, value);
    }
    // Interpolation draws the frames that slowing down leaves missing; at 1x or faster there are none to draw.
    if (interpolate === true && !((speed as number | undefined ?? 1) < 1)) {
      throw bad(`range ${index} "interpolate" draws frames for slow motion, so it needs a "speed" below 1`, speed ?? 1);
    }
    return {
      source, start: start as number, end: end as number,
      ...(note === undefined ? {} : { note }),
      ...(speed === undefined ? {} : { speed: speed as number }),
      ...(interpolate === undefined ? {} : { interpolate: interpolate as boolean }),
      ...(mute === undefined ? {} : { mute: mute as boolean }),
      ...(own === undefined ? {} : { grade: parseGrade(own, `${origin}: range ${index} "grade"`, true) }),
    };
  });
  assertRanges(ranges);
  return { sources, ...(o.transcripts === undefined ? {} : { transcripts: o.transcripts }), ...(grade ? { grade } : {}), ranges };
}

export interface LoadedEdl {
  edl: Edl;
  path: string;
  /** The EDL file's directory, which its relative paths resolve against. */
  base: string;
}

/** Read, parse and shape-check the EDL a --edl flag names. */
export function loadEdl(flagValue: string): LoadedEdl {
  const path = resolve(flagValue);
  if (!existsSync(path)) throw new Error(`EDL not found: ${path}`);
  return { edl: parseEdl(readJsonFile(path), path), path, base: dirname(path) };
}

export interface Located {
  path: string;
  /** Where a relative path was found when it is not beside the EDL; absent when it is, or is found nowhere. */
  from?: 'the working directory' | '$OPEN_EDIT_ROOT' | 'the workspace';
}

/**
 * A path the EDL names: beside the EDL, else, for a relative path not there, in the working directory and then the
 * workspace, wherever the file exists. An EDL is often written in a run's folder with paths from where the agent
 * stands, and a file found there is the one meant; one found nowhere is named at its place beside the EDL.
 */
export function locate(loaded: LoadedEdl, named: string): Located {
  const beside = resolve(loaded.base, named);
  if (isAbsolute(named) || existsSync(beside)) return { path: beside };
  const workspace = process.env.OPEN_EDIT_ROOT ? '$OPEN_EDIT_ROOT' : 'the workspace';
  for (const [from, root] of [['the working directory', process.cwd()], [workspace, workspaceRoot()]] as const) {
    const path = resolve(root, named);
    if (existsSync(path)) return { path, from };
  }
  return { path: beside };
}

/** One line for each path the EDL names that was found somewhere other than beside it. */
export function relocated(loaded: LoadedEdl, ids: string[], also: { what: string; named: string }[] = []): string[] {
  const named = [...ids.map((id) => ({ what: `source "${id}"`, named: loaded.edl.sources[id] })), ...also];
  return named.flatMap(({ what, named: path }) => {
    const found = locate(loaded, path);
    return found.from ? [`${what} (${path}) is not beside the EDL, so it was read from ${found.from}: ${found.path}`] : [];
  });
}

/** A source's video path, located (see locate) and checked. */
export function sourcePath(loaded: LoadedEdl, id: string): string {
  const named = loaded.edl.sources[id];
  const { path } = locate(loaded, named);
  if (!existsSync(path)) {
    const elsewhere = isAbsolute(named) ? '' : ', nor in the working directory or the workspace';
    throw new Error(`source "${id}" not found at ${path}${elsewhere}`);
  }
  return path;
}

/** The distinct sources, in first-use order. */
export function sourceOrder(ranges: EdlRange[]): string[] {
  return [...new Set(ranges.map((r) => r.source))];
}

/**
 * Both edges moved UP to the next frame instant. ffmpeg's `trim` keeps the frames whose time is at or
 * after `start` and before `end`, so a range cut between frames keeps a whole number of frames that
 * `end - start` does not describe; audio cut to the raw edges then differs from the picture by up to
 * a frame per range, in either direction, and the drift grows with every join. On the grid, picture,
 * sound and the retimed transcript are all exactly (end - start) long.
 */
export function snapToFrames(range: EdlRange, fps: number, index = 0): SnappedRange {
  const up = (t: number) => Math.ceil(t * fps - 1e-6) / fps;
  const snapped = { ...range, start: up(range.start), end: up(range.end), fps };
  if (!(snapped.end > snapped.start)) {
    throw new Error(`range ${index} of "${range.source}" (${range.start}-${range.end}) is shorter than one frame at ${fps} fps`);
  }
  return snapped;
}

/**
 * The frames a snapped range takes from its source and the frames it plays on the cut. A range at another
 * speed plays a whole number of frames too, so its picture, its sound and its words are all stretched by
 * played/kept rather than by the speed as written, which would leave a fraction of a frame at every join.
 */
export function framesOf(range: SnappedRange): { kept: number; played: number } {
  const kept = Math.round((range.end - range.start) * range.fps);
  const speed = range.speed ?? 1;
  return { kept, played: speed === 1 ? kept : Math.max(1, Math.round(kept / speed)) };
}

/** Seconds the range lasts on the cut's timeline. */
export function playedLength(range: SnappedRange): number {
  if ((range.speed ?? 1) === 1) return range.end - range.start;
  return framesOf(range).played / range.fps;
}

/** How much longer the range plays than it lasted in its source: 2 at half speed. */
export function stretchOf(range: SnappedRange): number {
  const { kept, played } = framesOf(range);
  return played / kept;
}

/**
 * The speeds whose sound is time-stretched rather than silenced: within them one atempo blends every sample,
 * pitch kept, and beyond 2 it skips samples instead.
 */
export const STRETCHED_SPEEDS: Readonly<{ min: number; max: number }> = Object.freeze({ min: 0.5, max: 2 });

/** What happens to a range's sound: kept as recorded, time-stretched to its speed, or silenced. */
export function soundOf(range: EdlRange): 'kept' | 'stretched' | 'muted' {
  if (range.mute) return 'muted';
  const speed = range.speed ?? 1;
  if (speed === 1) return 'kept';
  return speed >= STRETCHED_SPEEDS.min && speed <= STRETCHED_SPEEDS.max ? 'stretched' : 'muted';
}

/** Every range on its source's grid; `fpsBySource` is probed once per source, never per range. */
export function snapRanges(ranges: EdlRange[], fpsBySource: ReadonlyMap<string, number>): SnappedRange[] {
  return ranges.map((range, index) => {
    const fps = fpsBySource.get(range.source);
    if (fps === undefined) throw new Error(`no frame rate known for source "${range.source}"`);
    return snapToFrames(range, fps, index);
  });
}
