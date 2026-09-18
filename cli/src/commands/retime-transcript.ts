// Move per-word timings onto the timeline an EDL produced, instead of transcribing the cut again.
//
//   openedit retime-transcript --edl <edl.json> --out <transcript.json>
//
// A cut changes when words were said, never which, so every word keeps its window and shifts by its
// range's offset. A word straddling a cut edge is kept only if most of it survives, decided on overlap
// rather than on its start time alone.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { assertRanges, loadEdl, snapRanges, sourceOrder, sourcePath, type EdlRange, type SnappedRange } from '../edl.ts';
import { readJsonFile } from '../json-file.ts';
import { probeFps } from '../probe.ts';
import { collidingRunKey, transcriptPathFor, wordCount } from '../prep/transcript-cache.ts';
import type { Transcript, TranscriptChunk, TranscriptWord } from '../prep/transcript-types.ts';

/** A word kept by the edit, already on the output timeline. */
interface Placed {
  word: TranscriptWord;
  /** Index of the chunk it came from, so a chunk is not silently merged with its neighbour. */
  chunk: number;
  /** Which range placed it, so one chunk cannot span a cut. */
  range: number;
  /** Identity of the source word, so a word placed by two ranges is still one word. */
  key: string;
}

/** Whether any of the word lies inside the range. A zero-length word has no overlap to measure and is judged by its instant. */
function touches([a, b]: [number, number], range: EdlRange): boolean {
  if (b - a <= 0) return a >= range.start && a < range.end;
  return Math.min(b, range.end) - Math.max(a, range.start) > 0;
}

/**
 * Words whose majority lies inside [start, end), moved so that `start` becomes `offset`.
 * A word overlapping the edge by half its length or less is dropped rather than clipped.
 */
export function placeRange(
  transcript: Transcript,
  range: EdlRange,
  offset: number,
  rangeIndex: number,
): Placed[] {
  const out: Placed[] = [];
  const { start, end } = range;
  transcript.chunks.forEach((chunk, chunkIndex) => {
    chunk.words.forEach((word, wordIndex) => {
      const [a, b] = word.timestamp;
      if (!touches(word.timestamp, range)) return;
      const duration = b - a;
      if (duration > 0 && Math.min(b, end) - Math.max(a, start) <= duration / 2) return;
      const shifted: TranscriptWord = {
        text: word.text,
        timestamp: [offset + Math.max(a, start) - start, offset + Math.min(b, end) - start],
      };
      out.push({ word: shifted, chunk: chunkIndex, range: rangeIndex, key: `${range.source}#${chunkIndex}#${wordIndex}` });
    });
  });
  return out;
}

/** Regroup placed words into chunks, breaking wherever the source chunk or the range changes. */
export function regroup(placed: Placed[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let current: Placed[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const words = current.map((p) => p.word);
    // The window spans every word, not the first and last: a provider may list an item's words out of
    // start order, and a window that excluded one would fail prep's own reading of the file.
    chunks.push({
      text: words.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'),
      timestamp: [Math.min(...words.map((w) => w.timestamp[0])), Math.max(...words.map((w) => w.timestamp[1]))],
      words,
    });
    current = [];
  };
  for (const p of placed) {
    const previous = current.at(-1);
    if (previous && (previous.chunk !== p.chunk || previous.range !== p.range)) flush();
    current.push(p);
  }
  flush();
  return chunks;
}

export interface RetimeResult extends Transcript {
  /** Words that overlapped a kept range but were split too finely by its edge to survive. */
  droppedAtEdges: number;
}

/** Ranges arrive SNAPPED: the type is the promise that the words land where apply-edl cut the picture. */
export function retime(ranges: SnappedRange[], loadTranscript: (id: string) => Transcript): RetimeResult {
  assertRanges(ranges);
  const transcripts = new Map(sourceOrder(ranges).map((id) => [id, loadTranscript(id)]));
  const placed: Placed[] = [];
  let offset = 0;
  ranges.forEach((range, index) => {
    // A single range may legitimately keep nothing — a b-roll shot, a held title, a pause. Only an
    // edit that keeps nothing ANYWHERE is the mistake, and that is checked once, after the loop.
    placed.push(...placeRange(transcripts.get(range.source)!, range, offset, index));
    offset += range.end - range.start;
  });

  if (placed.length === 0) {
    throw new Error(
      'no range in this EDL kept a single word. Check the ranges are in SECONDS and that the ' +
        'transcripts belong to these sources.',
    );
  }

  // A word split near-evenly by a cut fails the majority test on both sides and disappears; usually
  // right, but counted rather than lost quietly. Counted by IDENTITY: a word two ranges both offered
  // is one word, and a word a repeated take placed twice is one word.
  const touched = new Set<string>();
  for (const range of ranges) {
    transcripts.get(range.source)!.chunks.forEach((chunk, chunkIndex) => {
      chunk.words.forEach((word, wordIndex) => {
        if (touches(word.timestamp, range)) touched.add(`${range.source}#${chunkIndex}#${wordIndex}`);
      });
    });
  }
  const kept = new Set(placed.map((p) => p.key));
  const chunks = regroup(placed);
  return { text: chunks.map((c) => c.text).join(' '), chunks, droppedAtEdges: touched.size - kept.size };
}

/**
 * A transcript.json read back for retiming: the shape the arithmetic touches, checked so a malformed
 * file is named rather than crashing mid-word. Only the shape: a hosted transcript can carry
 * overlapping items that the local providers' validator refuses, and retiming must not be stricter
 * than what it was given.
 */
function readTranscript(path: string): Transcript {
  const raw = readJsonFile(path) as { chunks?: unknown };
  const isWord = (w: unknown) => {
    const word = w as { text?: unknown; timestamp?: unknown };
    return typeof word.text === 'string' && Array.isArray(word.timestamp) && word.timestamp.length === 2
      && word.timestamp.every((t) => typeof t === 'number' && Number.isFinite(t));
  };
  const chunks = raw.chunks;
  if (!Array.isArray(chunks) || chunks.some((c) => !Array.isArray((c as { words?: unknown }).words))) {
    throw new Error(`${path} is not a transcript.json: expected chunks[] with words[] in each`);
  }
  if (chunks.some((c) => !(c as { words: unknown[] }).words.every(isWord))) {
    throw new Error(`${path} is not a transcript.json: every word needs text and a [start, end] timestamp in seconds`);
  }
  return raw as Transcript;
}

export const usage = {
  summary: "Move existing per-word timings onto an EDL's timeline instead of transcribing again",
  flags: {
    edl: { type: 'string', value: '<edl.json>', required: true, help: 'The edit decision list whose timeline the words move onto' },
    out: { type: 'string', value: '<transcript.json>', required: true, help: 'Where the retimed transcript is written' },
  },
} satisfies Usage;

export function retimeTranscript(argv: string[]): number {
  const { values } = parseUsage('retime-transcript', usage, argv);
  if (!values.edl || !values.out) {
    throw new Error(usageLine('retime-transcript', usage));
  }
  const loaded = loadEdl(values.edl);
  // The same snapping apply-edl cuts on, from the same probe, so the two tools agree to the frame.
  const ids = sourceOrder(loaded.edl.ranges);
  const videos = new Map(ids.map((id) => [id, sourcePath(loaded, id)]));
  const ranges = snapRanges(loaded.edl.ranges, new Map(ids.map((id) => [id, probeFps(videos.get(id)!)])));

  // An explicit `transcripts` entry may point anywhere; the default is where the transcribe command
  // wrote this source's transcript, so the id stays a free label — and two sources with one basename
  // would share that default, which is the collision the transcribe command already refuses.
  const declaredPath = (id: string) => (Object.hasOwn(loaded.edl.transcripts ?? {}, id) ? loaded.edl.transcripts![id] : undefined);
  const collision = collidingRunKey([...new Set(ids.filter((id) => declaredPath(id) === undefined).map((id) => videos.get(id)!))]);
  if (collision) {
    throw new Error(
      `sources ${collision.videos.map((v) => `"${v}"`).join(' and ')} share the run key "${collision.key}", so they would read ` +
        'one transcript — point the EDL\'s "transcripts" map at each source\'s file.',
    );
  }

  const load = (id: string): Transcript => {
    const declared = declaredPath(id);
    const path = declared === undefined ? transcriptPathFor(videos.get(id)!) : resolve(loaded.base, declared);
    try {
      return readTranscript(path);
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
      throw new Error(
        missing
          ? `no transcript for source "${id}" at ${path}. Transcribe the sources once, or point the EDL's "transcripts" map at the file.`
          : `transcript for source "${id}": ${(cause as Error).message}`,
        { cause },
      );
    }
  };

  const { droppedAtEdges, ...result } = retime(ranges, load);
  const outPath = resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  if (droppedAtEdges > 0) {
    console.warn(
      `  ${droppedAtEdges} word(s) sat across a cut edge with too little of them left to keep. ` +
        'Move that edge to a gap the speech probe found if any of them mattered.',
    );
  }
  const duration = result.chunks.at(-1)?.timestamp[1] ?? 0;
  console.log(
    `retimed ${wordCount(result)} words into ${result.chunks.length} chunks over ${duration.toFixed(3)}s -> ${outPath}`,
  );
  return 0;
}
