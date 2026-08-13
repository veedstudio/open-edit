// Maps a Whisper-family transcription JSON into the editor's on-disk transcript shape
// ({ text, chunks:[{ text, timestamp:[startSec,endSec], words:[...] }] }) — the same shape
// veed/transcript-mapper.ts produces, so downstream (prep, extract-beat-frames, synth-word-timings)
// cannot tell which provider ran. This is the path for every provider except VEED itself.
//
// Accepted inputs:
//   - the Python Whisper family — WhisperX, openai-whisper, whisper-timestamped, mlx-whisper:
//     { segments:[{ start, end, text, words:[{ word|text, start, end }] }] }
//   - the OpenAI API's verbose_json with timestamp_granularities:["word"]:
//     { segments:[{ start, end, text }], words:[{ word, start, end }] }
//   - a flat word list, including whisper.cpp `-oj`:
//     { transcription:[{ offsets:{ from, to }, text }] }  (offsets are MILLISECONDS)
//
// ONE PIPELINE, because a branch per family is a branch per way of losing a word:
//
//   normalise → flat Pending[] (+ segment bounds)   every family, one shape, multi-word entries split
//     → time     interpolate untimed words from their neighbours ACROSS segment boundaries
//     → group    one chunk per provider segment, or prosody grouping when there is no segmentation
//     → order    sort chunks, and words within a chunk, since provider order is not guaranteed
//     → assert   output word count === input word count, or throw
//
// Words a provider left untimed keep their text and get an interpolated window, counted in
// `interpolated`. Only a transcript with no timed word anywhere is refused: nothing to interpolate from.

import type { Transcript, TranscriptChunk, TranscriptWord } from '../veed/transcript-mapper.ts';

export type { Transcript, TranscriptChunk, TranscriptWord };

// `word` is openai/WhisperX/mlx; `text` is whisper-timestamped. Times are seconds.
export interface WhisperWord {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
}

export interface WhisperSegment {
  start?: number;
  end?: number;
  text?: string;
  words?: WhisperWord[];
}

// whisper.cpp --output-json: offsets are integer milliseconds from the start of the media.
export interface WhisperCppEntry {
  text?: string;
  offsets?: { from?: number; to?: number };
}

export interface WhisperJson {
  text?: string;
  segments?: WhisperSegment[];
  words?: WhisperWord[];
  transcription?: WhisperCppEntry[];
}

export interface GroupOptions {
  /** Start a new cue when the silence before a word is at least this long. */
  gapSec?: number;
  /** Hard cap on words per cue, so a pauseless monologue still yields beats. */
  maxWords?: number;
}

export interface MapResult {
  transcript: Transcript;
  /** Words the provider left untimed, whose windows were inferred. */
  interpolated: number;
  /** Words whose times ran backwards and were reordered to match their reveals. */
  reordered: number;
}

const DEFAULT_GAP_SEC = 0.6;
const DEFAULT_MAX_WORDS = 8;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** One token on its way to becoming a word. `inferred` marks a window we made up. */
interface Pending {
  text: string;
  start?: number;
  end?: number;
  inferred?: boolean;
  /** Index of the provider segment this came from; undefined when there is no segmentation. */
  group?: number;
}

// A provider "word" containing whitespace is a segment in disguise — whisper.cpp without `-ml 1`
// emits whole sentences this way. Splitting marks the windows inferred, so such a transcript reports a
// large interpolation count instead of passing as word-timed.
function tokenize(p: Pending): Pending[] {
  const parts = p.text.split(/\s+/).filter((t) => t !== '');
  if (parts.length <= 1) return parts.length === 1 ? [{ ...p, text: parts[0] }] : [];
  if (!finite(p.start) || !finite(p.end)) {
    return parts.map((text) => ({ text, group: p.group, inferred: true }));
  }
  // Proportional to token length: longer words take longer to say than shorter ones.
  const total = parts.reduce((n, t) => n + t.length, 0) || parts.length;
  const span = Math.max(0, p.end - p.start);
  let cursor = p.start;
  return parts.map((text) => {
    const width = (span * text.length) / total;
    const word = { text, start: cursor, end: cursor + width, inferred: true, group: p.group };
    cursor += width;
    return word;
  });
}

function pendingFromWords(words: WhisperWord[], group?: number): Pending[] {
  return words
    .map((w) => ({ text: (w.word ?? w.text ?? '').trim(), start: w.start, end: w.end, group }))
    .flatMap((p) => tokenize(p));
}

function pendingFromCpp(entries: WhisperCppEntry[]): Pending[] {
  return entries
    .map((e) => {
      const from = e.offsets?.from;
      const to = e.offsets?.to;
      return {
        text: (e.text ?? '').trim(),
        start: finite(from) ? from / 1000 : undefined,
        end: finite(to) ? to / 1000 : undefined,
      };
    })
    .flatMap((p) => tokenize(p));
}

/** Spreads `count` windows evenly across [from,to]; a zero-width span yields zero-width windows. */
function spread(from: number, to: number, count: number): [number, number][] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const step = count > 0 ? (hi - lo) / count : 0;
  return Array.from({ length: count }, (_, i) => [lo + step * i, lo + step * (i + 1)]);
}

// Timing runs over the WHOLE transcript, not per segment: a segment whose alignment failed entirely
// then borrows the gap between its neighbours' anchors instead of vanishing for want of a window.
function timeAll(
  pending: Pending[],
  bounds: { start?: number; end?: number }[],
): { words: TranscriptWord[]; groups: (number | undefined)[]; interpolated: number } {
  const anchored = pending.map((p) => finite(p.start) && finite(p.end));
  const firstAnchor = anchored.indexOf(true);
  const lastAnchor = anchored.lastIndexOf(true);
  if (firstAnchor === -1) {
    return { words: [], groups: [], interpolated: 0 };
  }

  const words: TranscriptWord[] = [];
  const groups: (number | undefined)[] = [];
  let interpolated = 0;
  let i = 0;
  while (i < pending.length) {
    if (anchored[i]) {
      words.push({ text: pending[i].text, timestamp: [pending[i].start as number, pending[i].end as number] });
      groups.push(pending[i].group);
      if (pending[i].inferred) interpolated += 1;
      i += 1;
      continue;
    }
    let j = i; // [i, j) is a maximal run of untimed words
    while (j < pending.length && !anchored[j]) j += 1;
    const groupStart = bounds[pending[i].group ?? -1]?.start;
    const groupEnd = bounds[pending[j - 1].group ?? -1]?.end;
    const from = i > firstAnchor
      ? (pending[i - 1].end as number)
      : (finite(groupStart) ? groupStart : (pending[firstAnchor].start as number));
    const to = j <= lastAnchor
      ? (pending[j].start as number)
      : (finite(groupEnd) ? groupEnd : (pending[lastAnchor].end as number));
    const windows = spread(from, to, j - i);
    for (let k = i; k < j; k += 1) {
      words.push({ text: pending[k].text, timestamp: windows[k - i] });
      groups.push(pending[k].group);
      interpolated += 1;
    }
    i = j;
  }
  return { words, groups, interpolated };
}

/** The window must cover its own words: synth-word-timings discards a beat whose words fall outside. */
function chunkOf(words: TranscriptWord[], start?: number, end?: number): TranscriptChunk | undefined {
  if (words.length === 0) return undefined;
  // The MIN start and MAX end across every word, not the first/last by start-order: overlaps are normal
  // in ASR, so an interior word can start after the first yet end after the last, and a window bounded by
  // the last word's end would leave that word's midpoint outside it — synth-word-timings then drops the beat.
  // reduce, not Math.min(...spread): a pathologically long single cue would blow the argument/stack limit.
  const earliest = words.reduce((min, w) => Math.min(min, w.timestamp[0]), Infinity);
  const latest = words.reduce((max, w) => Math.max(max, w.timestamp[1]), -Infinity);
  const from = Math.min(finite(start) ? start : earliest, earliest);
  const to = Math.max(finite(end) ? end : latest, latest);
  return { text: words.map((w) => w.text).join(' '), timestamp: [from, to], words };
}

// Cue boundaries from prosody, not from the model: sentence-ending punctuation, a real pause, or the
// word cap. Used only when the provider gave no segmentation of its own.
export function groupWordsIntoChunks(words: TranscriptWord[], opts: GroupOptions = {}): TranscriptChunk[] {
  const gapSec = opts.gapSec ?? DEFAULT_GAP_SEC;
  const maxWords = Math.max(1, opts.maxWords ?? DEFAULT_MAX_WORDS);
  const chunks: TranscriptChunk[] = [];
  let current: TranscriptWord[] = [];

  const flush = (): void => {
    const chunk = chunkOf(current);
    if (chunk) chunks.push(chunk);
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous && word.timestamp[0] - previous.timestamp[1] >= gapSec) flush();
    current.push(word);
    if (current.length >= maxWords || /[.!?…]["')\]]?$/.test(word.text)) flush();
  }
  flush();
  return chunks;
}

// Assigns a flat word list to wordless segments by midpoint. Words past the last segment stay with
// the last one rather than being discarded: provider word times routinely run past a segment's end.
function assignToSegments(segments: WhisperSegment[], pending: Pending[]): Pending[] {
  // Where one segment stops claiming words. A segment with no `end` is bounded by the NEXT segment's
  // start — using a later segment's end instead would let it swallow that segment's words.
  const cuts: (number | undefined)[] = segments.map((s, i) => {
    if (finite(s.end)) return s.end;
    const nextStart = segments[i + 1]?.start;
    return finite(nextStart) ? nextStart : undefined;
  });
  for (let i = cuts.length - 2; i >= 0; i -= 1) {
    if (cuts[i] === undefined) cuts[i] = cuts[i + 1];
  }

  let group = 0;
  return pending.map((p) => {
    const mid = finite(p.start) && finite(p.end) ? (p.start + p.end) / 2 : undefined;
    if (mid !== undefined) {
      while (group < segments.length - 1) {
        const cut = cuts[group];
        if (cut === undefined || mid <= cut) break;
        group += 1;
      }
    }
    return { ...p, group };
  });
}

// Provider order is not guaranteed (veed/transcript-mapper.ts sorts for the same reason). Overlapping
// word windows are normal in ASR and left alone; starts that run BACKWARDS are not, and are sorted so
// the caption text and the reveal order agree — the text is rebuilt from the sorted order.
function orderWords(words: TranscriptWord[]): { words: TranscriptWord[]; reordered: number } {
  let reordered = 0;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].timestamp[0] < words[i - 1].timestamp[0]) reordered += 1;
  }
  if (reordered === 0) return { words, reordered };
  return { words: [...words].sort((a, b) => a.timestamp[0] - b.timestamp[0]), reordered };
}

export function mapWhisperTranscript(input: WhisperJson, opts: GroupOptions = {}): MapResult {
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const flatWords = Array.isArray(input.words) ? input.words : [];
  const cppEntries = Array.isArray(input.transcription) ? input.transcription : [];

  // 1. normalise every family to one flat list, tagged with its provider segment where there is one
  const segmentsCarryWords = segments.some((s) => Array.isArray(s.words) && s.words.length > 0);
  let pending: Pending[];
  if (segmentsCarryWords) {
    pending = segments.flatMap((s, i) => pendingFromWords(Array.isArray(s.words) ? s.words : [], i));
  } else {
    const loose = flatWords.length > 0 ? pendingFromWords(flatWords) : pendingFromCpp(cppEntries);
    pending = segments.length > 0 ? assignToSegments(segments, loose) : loose;
  }
  const inputWords = pending.length;

  // 2. time it, crossing segment boundaries so a wholly-unaligned segment still gets windows
  const bounds = segments.map((s) => ({ start: s.start, end: s.end }));
  const { words, groups, interpolated } = timeAll(pending, bounds);

  if (words.length === 0) {
    throw new Error(
      'mapWhisperTranscript: no per-word timings found. Re-run the transcription with word timestamps ' +
      '(WhisperX emits them by default · openai-whisper/mlx-whisper: --word_timestamps True · ' +
      'whisper.cpp: -oj -ml 1 · OpenAI API: timestamp_granularities=["word"]). ' +
      'Without them the caption animation desynchronises.',
    );
  }

  // 3. group into chunks: one per provider segment, else by prosody
  let chunks: TranscriptChunk[];
  let reordered = 0;
  if (segments.length > 0) {
    chunks = segments
      .map((s, i) => {
        const mine = words.filter((_, k) => groups[k] === i);
        const ordered = orderWords(mine);
        reordered += ordered.reordered;
        // An absent end borrows the next segment's start rather than swallowing the rest of the words.
        const end = finite(s.end) ? s.end : segments.slice(i + 1).map((n) => n.start).find(finite);
        return chunkOf(ordered.words, s.start, end);
      })
      .filter((c): c is TranscriptChunk => c !== undefined);
  } else {
    const ordered = orderWords(words);
    reordered += ordered.reordered;
    chunks = groupWordsIntoChunks(ordered.words, opts);
  }

  // 4. chunks in transcript order, whatever order the provider used
  chunks.sort((a, b) => a.timestamp[0] - b.timestamp[0]);

  // 5. the invariant that makes silent word loss impossible, wherever it might be introduced
  const outputWords = chunks.reduce((n, c) => n + c.words.length, 0);
  if (outputWords !== inputWords) {
    throw new Error(
      `mapWhisperTranscript: internal error — ${inputWords} words in, ${outputWords} out. ` +
      'A word was lost while mapping; this is a bug in the mapper, not in your transcript.',
    );
  }

  return { transcript: { text: chunks.map((c) => c.text).join(' '), chunks }, interpolated, reordered };
}
