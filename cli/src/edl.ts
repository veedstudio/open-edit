// The EDL (edit decision list) both cut tools read: which intervals of which sources to keep, in output
// order. One reader, one validator and one snapping rule, so the assembled file and the retimed
// transcript are cut on the same instants.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describeValue } from './args.ts';
import { readJsonFile } from './json-file.ts';

/** One kept interval of one source, in that source's own seconds. */
export interface EdlRange {
  source: string;
  start: number;
  end: number;
  /** Free text carried through for the agent's own reading; ignored here. */
  note?: string;
}

export interface Edl {
  /** id -> video path. Relative paths resolve against the EDL file's directory. */
  sources: Record<string, string>;
  /** id -> transcript path. Absent: the transcript the transcribe command wrote for that source video. */
  transcripts?: Record<string, string>;
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
  const ranges = o.ranges.map((entry, index): EdlRange => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw bad(`range ${index} must be an object`, entry);
    const { source, start, end, note } = entry as Record<string, unknown>;
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) {
      throw bad(`range ${index} names a source the "sources" map has no entry for`, source);
    }
    for (const [name, value] of [['start', start], ['end', end]] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`range ${index} "${name}" must be a number of seconds`, value);
    }
    if (note !== undefined && typeof note !== 'string') throw bad(`range ${index} "note" must be text`, note);
    return { source, start: start as number, end: end as number, ...(note === undefined ? {} : { note }) };
  });
  assertRanges(ranges);
  return { sources, ...(o.transcripts === undefined ? {} : { transcripts: o.transcripts }), ranges };
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

/** A source's video path, resolved and checked. */
export function sourcePath(loaded: LoadedEdl, id: string): string {
  const path = resolve(loaded.base, loaded.edl.sources[id]);
  if (!existsSync(path)) throw new Error(`source "${id}" not found at ${path}`);
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

/** Every range on its source's grid; `fpsBySource` is probed once per source, never per range. */
export function snapRanges(ranges: EdlRange[], fpsBySource: ReadonlyMap<string, number>): SnappedRange[] {
  return ranges.map((range, index) => {
    const fps = fpsBySource.get(range.source);
    if (fps === undefined) throw new Error(`no frame rate known for source "${range.source}"`);
    return snapToFrames(range, fps, index);
  });
}
