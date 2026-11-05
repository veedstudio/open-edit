// The dead-air check: a stretch with nothing happening, to see or to hear, anywhere in the video. It reports a picture
// held still, frozen or nearly so, for longer than a still may hold, end cards included; a silent opening longer than
// HEAD_SECONDS; and a silence between two sounds longer than GAP_SECONDS. The silence after the last sound is the
// dead-tail check's, which measures sound and speech but never the picture, so no silence is reported twice.
import { spawn } from 'node:child_process';
import { FFMPEG } from '../config.ts';
import { alphaInput, probeSquareSize } from '../probe.ts';
import { sampleSeconds, timeOf, type TextRecord } from '../render/text-record.ts';
import type { Transcript } from '../transcript/transcript-types.ts';
import type { CheckReport, ReviewContext, TextRecordInput, TranscriptInput } from './checks.ts';
import { endCardLimit, readingSeconds, soundGateOf, soundIn, TAIL_SECONDS, WINDOW_MS, wordsIn, type Sound } from './dead-tail.ts';
import { listed, seconds as s } from './report.ts';
import { blocksOf } from './text-blocks.ts';

/** The picture is compared this many times a second, so every change spans a tenth of a second whatever the frame rate. */
export const SCAN_RATE = 10;

/** Compared on a grey copy this wide, which keeps the pass near the cost of the decode alone. */
export const SCAN_WIDTH = 128;

/** Where a change is, is told in squares this many scan pixels across: a sixteenth of the width. */
export const BLOCK = 8;

/**
 * Frozen: the square that changes most moves by less than this many 8-bit levels on average in a tenth of a second,
 * as the median over STILL_WINDOW. Re-encoded stills stay under a tenth of a level, and the stillest camera footage
 * measured holds under it for no more than 1.6 s.
 */
export const FROZEN_LEVELS = 0.5;

/**
 * The median lets an encoder's keyframe, which nudges a frozen picture by a level or so once or twice in a row, leave
 * it frozen; a change that moves a square by this many levels never does, as a word or a line appearing moves one by
 * ten or more.
 */
export const NUDGE_LEVELS = 4;

/**
 * Nearly still, first: the picture changes by less than this many levels on average in a tenth of a second, half a
 * level a frame at 30 fps, while a cut changes it by four or more. Measured change by change, so a cut ends a still.
 */
export const STILL_LEVELS = 1.5;

/**
 * Nearly still, second: less than this fraction of the picture changes at all, by a level, in a tenth of a second.
 * Camera footage that moves, a slow pan or a hovering drone shot, changes almost everywhere; a held card with something
 * drifting over it changes in a few places.
 */
export const STILL_AREA = 0.2;

/**
 * Nearly still, third: no BLOCK square changes by this many levels on average in a tenth of a second, so a line drawing
 * itself or a word typed out is motion, and a drift is not.
 */
export const STILL_PEAK = 15;

/**
 * The area and the peak are taken as their median over this many changes, about a second: an encoder's keyframe can
 * nudge a whole still frame by a level once, and a pulse can flare one square for a moment.
 */
export const STILL_WINDOW = 11;

/**
 * A still with nothing on it to read may hold this long: the time a viewer is given to find text on a fresh frame,
 * then the beat after the last thing to take in. A still with words on it holds as an end card does, by endCardLimit.
 */
export const STILL_SECONDS = readingSeconds(0) + TAIL_SECONDS;

/** A silent opening longer than this is reported, by the bar TAIL_SECONDS sets for a silent ending. */
export const HEAD_SECONDS = TAIL_SECONDS;

/**
 * A silence between two sounds longer than this is reported: no pause in read speech runs past 2 s, and in unedited
 * spontaneous speech under 3% do (Campione and Veronis 2002). A voice that never pauses longer also carries a nearly
 * still picture, as a talking head can measure as still as a held card.
 */
export const GAP_SECONDS = 2;

export interface Change {
  /** Seconds on the picture's timeline of the later of the two frames compared. */
  sec: number;
  /** Mean absolute difference of luma over the picture, in 8-bit levels. */
  mean: number;
  /** The same over the BLOCK square that changed most. */
  peak: number;
  /** The fraction of the picture's pixels that changed by a level or more. */
  area: number;
}

/** How grey frame `b` differs from frame `a`, both `width` by `height` and a whole number of BLOCK squares. */
export function changeOf(a: Uint8Array, b: Uint8Array, width: number, height: number): Omit<Change, 'sec'> {
  const across = width / BLOCK;
  const squares = new Float64Array(across * (height / BLOCK));
  let sum = 0;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / BLOCK) * across;
    for (let x = 0; x < width; x++) {
      const d = Math.abs(a[y * width + x] - b[y * width + x]);
      sum += d;
      if (d > 0) changed++;
      squares[row + Math.floor(x / BLOCK)] += d;
    }
  }
  const pixels = width * height;
  return { mean: sum / pixels, peak: Math.max(...squares) / (BLOCK * BLOCK), area: changed / pixels };
}

/** The scan's height: the picture's shape as shown, in whole BLOCK squares. */
function scanHeight(video: string): number {
  const { width, height } = probeSquareSize(video);
  return Math.max(BLOCK, Math.round((SCAN_WIDTH * height) / width / BLOCK) * BLOCK);
}

/**
 * One decode of the picture, SCAN_RATE grey frames a second: how each differs from the one before. Within `within`,
 * only that stretch is decoded, its times still on the picture's timeline.
 */
export function changesIn(video: string, within?: Span): Promise<Change[]> {
  const width = SCAN_WIDTH;
  const height = scanHeight(video);
  const size = width * height;
  const from = within?.start ?? 0;
  const range = within ? ['-ss', String(within.start), '-t', String(within.end - within.start)] : [];
  const args = ['-nostdin', '-v', 'error', ...range, '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${SCAN_RATE},scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const changes: Change[] = [];
    // Two frames at a time, read as they arrive, so a long video never sits whole in memory.
    let frame: Buffer = Buffer.alloc(size);
    let previous: Buffer | null = null;
    let filled = 0;
    let frames = 0;
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => {
      for (let at = 0; at < chunk.length;) {
        const n = Math.min(size - filled, chunk.length - at);
        chunk.copy(frame, filled, at, at + n);
        filled += n;
        at += n;
        if (filled < size) continue;
        if (previous) changes.push({ sec: from + frames / SCAN_RATE, ...changeOf(previous, frame, width, height) });
        [previous, frame] = [frame, previous ?? Buffer.alloc(size)];
        filled = 0;
        frames++;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const last = said.trim().split('\n').pop();
      const why = last || (signal ? `stopped by ${signal}` : `exit code ${code}`);
      if (code !== 0) reject(new Error(`ffmpeg could not decode the picture of ${video} (${why})`));
      else if (frames === 0) reject(new Error(`ffmpeg decoded no frames from ${video}`));
      else resolve(changes);
    });
  });
}

export interface Span {
  start: number;
  end: number;
}

export interface Still extends Span {
  /** The longest part of it with nothing moving at all, or null. */
  frozen: Span | null;
}

export const lengthOf = (span: Span): number => span.end - span.start;
/** In whole milliseconds: printed times are rounded, and a span of exactly its limit must not read as longer. */
const longer = (span: Span, limit: number) => Math.round(lengthOf(span) * 1000) > Math.round(limit * 1000);

/**
 * Runs of `changes` from index `from` to `to` that pass `test`, as spans of the picture: a run of changes from frame a to
 * frame b holds those frames alike from a's time until the frame after b, and the last frame until the picture ends.
 */
function runsOf(changes: Change[], test: (c: Change) => boolean, duration: number, from = 0, to = changes.length): (Span & { first: number; last: number })[] {
  const runs: (Span & { first: number; last: number })[] = [];
  let first: number | null = null;
  for (let i = from; i <= to; i++) {
    const passes = i < to && test(changes[i]);
    if (passes && first === null) first = i;
    if (passes || first === null) continue;
    const last = i - 1;
    runs.push({ start: changes[first].sec - 1 / SCAN_RATE, end: Math.min(duration, changes[last].sec + 1 / SCAN_RATE), first, last });
    first = null;
  }
  return runs;
}

/** The median of `values` over the STILL_WINDOW centred on each one, fewer at the ends. */
function medians(values: number[]): number[] {
  const half = Math.floor(STILL_WINDOW / 2);
  return values.map((_, i) => {
    const near = values.slice(Math.max(0, i - half), i + half + 1).sort((a, b) => a - b);
    return near[Math.floor(near.length / 2)];
  });
}

/** Every stretch of the picture held nearly still, each with its longest frozen part. */
export function stillsOf(changes: Change[], duration: number): Still[] {
  const area = medians(changes.map((c) => c.area));
  const peak = medians(changes.map((c) => c.peak));
  const still = new Set(changes.flatMap((c, i) => (c.mean < STILL_LEVELS && area[i] < STILL_AREA && peak[i] < STILL_PEAK ? [c] : [])));
  const frozen = new Set(changes.flatMap((c, i) => (c.peak < NUDGE_LEVELS && peak[i] < FROZEN_LEVELS ? [c] : [])));
  return runsOf(changes, (c) => still.has(c), duration).map(({ start, end, first, last }) => {
    const longest = runsOf(changes, (c) => frozen.has(c), duration, first, last + 1).reduce<Span | null>(
      (best, run) => (!best || lengthOf(run) > lengthOf(best) ? { start: run.start, end: run.end } : best), null);
    return { start, end, frozen: longest };
  });
}

/** The most words on screen at once while `span` is: what a still asks a viewer to read. */
export function wordsDuring(record: TextRecord, span: Span): number {
  const step = sampleSeconds(record);
  let most = 0;
  for (const sample of record.samples) {
    const t = timeOf(record, sample.frame);
    if (t + step <= span.start + 1e-9 || t >= span.end - 1e-9) continue;
    most = Math.max(most, blocksOf(sample.texts).reduce((n, b) => n + wordsIn(b.text), 0));
  }
  return most;
}

/** How long a still may hold with `words` on screen to read. */
export const stillLimit = (words: number): number => (words > 0 ? endCardLimit(words) : STILL_SECONDS);

/** The longest part of `span` with no word spoken in it, by the transcript's word times. */
export function longestUnspoken(transcript: Transcript, span: Span): Span {
  const words = transcript.chunks.flatMap((chunk) => chunk.words).map((w) => w.timestamp)
    .filter(([a, b]) => b > span.start && a < span.end).sort((x, y) => x[0] - y[0]);
  let longest: Span = { start: span.start, end: span.start };
  let heard = span.start;
  for (const [a, b] of words) {
    if (a - heard > lengthOf(longest)) longest = { start: heard, end: a };
    heard = Math.max(heard, b);
  }
  return span.end - heard > lengthOf(longest) ? { start: heard, end: span.end } : longest;
}

export interface Silences {
  /** Where the first sound starts on the picture's timeline, or null when nothing counts as sound. */
  firstSound: number | null;
  /** Silences between the first sound and the last longer than GAP_SECONDS, within the picture. */
  gaps: Span[];
}

/** Where the sound starts, and the long silences between sounds, gated as the dead-tail check gates its last sound. */
export function silencesOf({ envelope, start }: Sound, duration: number): Silences {
  const gate = soundGateOf(envelope);
  const loud = gate === null ? [] : envelope.flatMap((db, i) => (db >= gate ? [i] : []));
  if (loud.length === 0) return { firstSound: null, gaps: [] };
  const at = (i: number) => start + (i * WINDOW_MS) / 1000;
  const gaps: Span[] = [];
  for (let k = 1; k < loud.length; k++) {
    const gap = { start: Math.max(0, at(loud[k - 1] + 1)), end: Math.min(duration, at(loud[k])) };
    if (longer(gap, GAP_SECONDS)) gaps.push(gap);
  }
  return { firstSound: at(loud[0]), gaps };
}

export interface DeadAirInput {
  /** Seconds of picture. */
  duration: number;
  /** How the picture changes, or why it was not measured. */
  picture: Change[] | { missing: string };
  /** The audio, or null when the video has no audio track. */
  sound: Sound | null;
  /** What is said when, to tell a talking head from a held card: both can measure as nearly still. */
  transcript: TranscriptInput;
  /** What text the video shows, so a still with words on it may hold as long as they take to read. */
  textRecord: TextRecordInput;
}

const fromTo = (span: Span) => `from ${s(span.start)} to ${s(span.end)}`;

function wordsPhrase(words: number, textRecord: TextRecordInput): string {
  if (words > 0) return `with ${words} word${words === 1 ? '' : 's'} on screen to read`;
  return 'missing' in textRecord ? 'with no record of the words on it' : 'with no page text on it to read';
}

/** A still held longer than its words allow. */
export interface HeldStill {
  kind: 'frozen' | 'nearly still';
  span: Span;
  /** The most words on screen while it holds, which set how long it may. */
  words: number;
  /** The longest part of it with no word spoken, when a transcript was asked; null when it was not. */
  unspoken: Span | null;
  /** True when the words on screen could have let it hold longer, but there is no record to count them. */
  unread: boolean;
  /** True when a voice could have carried it, but there is no transcript to say. */
  unheard: boolean;
}

/**
 * A still held longer than its words allow, unless a voice carries it: one that never pauses past GAP_SECONDS, as over a
 * talking head. A frozen part held too long is reported however much is said over it, as nothing frozen is camera footage.
 */
export function heldStill(still: Still, transcript: TranscriptInput, textRecord: TextRecordInput): HeldStill | null {
  const wordsOf = (span: Span) => ('missing' in textRecord ? 0 : wordsDuring(textRecord.record, span));
  const words = wordsOf(still);
  const frozen = still.frozen;
  const frozenWords = frozen ? wordsOf(frozen) : 0;
  const frozenTooLong = frozen !== null && longer(frozen, stillLimit(frozenWords));
  // Frozen nearly throughout, the still is judged as frozen, and what is said over it does not matter.
  const allFrozen = frozen !== null && lengthOf(still) - lengthOf(frozen) < 1 / SCAN_RATE + 1e-9;
  let unspoken: Span | null = null;
  let carried = allFrozen || !longer(still, stillLimit(words));
  if (!carried && !('missing' in transcript)) {
    unspoken = longestUnspoken(transcript.transcript, still);
    carried = !longer(unspoken, GAP_SECONDS);
  }
  if (carried && !frozenTooLong) return null;
  return {
    kind: carried || allFrozen ? 'frozen' : 'nearly still',
    span: carried ? frozen! : still,
    words: carried ? frozenWords : words,
    unspoken: carried ? null : unspoken,
    unread: 'missing' in textRecord,
    unheard: !carried && 'missing' in transcript,
  };
}

function stillLine(held: HeldStill, textRecord: TextRecordInput): string {
  const { kind, span, words, unspoken } = held;
  const what = kind === 'frozen' ? 'nothing moving' : 'only slight motion, such as a slow zoom or a drift';
  let speech = '';
  if (unspoken) speech = lengthOf(unspoken) >= lengthOf(span) - 1e-9 ? ', and no word is spoken in it' : `, and no word is spoken ${fromTo(unspoken)}`;
  return `${kind} ${fromTo(span)}: ${s(lengthOf(span))} with ${what}, longer than the ${s(stillLimit(words))} a still may hold ${wordsPhrase(words, textRecord)}${speech}`;
}

export function judgeDeadAir({ duration, picture, sound, transcript, textRecord }: DeadAirInput): CheckReport {
  const findings: { start: number; line: string }[] = [];
  const skipped: string[] = [];
  const measured: string[] = [];

  if ('missing' in picture) {
    skipped.push(`whether the picture holds still: ${picture.missing}`);
  } else {
    const held = stillsOf(picture, duration).flatMap((still) => heldStill(still, transcript, textRecord) ?? []);
    findings.push(...held.map((h) => ({ start: h.span.start, line: stillLine(h, textRecord) })));
    measured.push('the picture never holds still longer than a still may');
    if (held.some((h) => h.unread)) skipped.push(`the words on screen through a still, which let it hold longer: ${(textRecord as { missing: string }).missing}`);
    if (held.some((h) => h.unheard)) {
      skipped.push(`whether a voice carries the nearly still picture, as a talking head can be that still: ${(transcript as { missing: string }).missing}`);
    }
  }

  if (!sound) {
    skipped.push('silence at the start and between sounds: the video has no audio track');
  } else {
    const { firstSound, gaps } = silencesOf(sound, duration);
    if (firstSound === null) {
      skipped.push('silence at the start and between sounds: nothing in the audio track is loud enough to count as sound, and a silent '
        + 'track is reported once, as a silent ending');
    } else {
      if (firstSound > HEAD_SECONDS + 1e-9) {
        const silent = Math.min(firstSound, duration);
        findings.push({ start: 0, line: `the first ${s(silent)} are silent: nothing is heard until ${s(firstSound)}` });
      }
      for (const gap of gaps) findings.push({ start: gap.start, line: `silent ${fromTo(gap)}: ${s(lengthOf(gap))} with nothing heard between two sounds` });
      measured.push(`sound starts at ${s(Math.max(0, firstSound))} with no silence between sounds over ${s(GAP_SECONDS)}`);
    }
  }

  if (findings.length) return { verdict: 'found', lines: listed(findings), skipped };
  if (!measured.length) return { verdict: 'skipped', lines: [], skipped };
  return { verdict: 'pass', lines: [`nothing dead: ${measured.join(', and ')}`], skipped };
}

export async function measureDeadAir({ video, duration, transcript, textRecord }: ReviewContext): Promise<CheckReport> {
  // A transparent picture's colour planes hold whatever lies under its clear pixels, which nobody sees once it is laid
  // over something, so how they change says nothing.
  const picture = alphaInput(video)
    ? { missing: 'the picture has an alpha channel, so what shows through it depends on what it is laid over' }
    : await changesIn(video);
  return judgeDeadAir({ duration, picture, sound: soundIn(video), transcript, textRecord });
}
