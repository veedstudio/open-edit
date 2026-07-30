// Per-word caption reveal timings for the word-level caption animation. Beats ARE the transcript's
// segment chunks (identical to transcript.json, in order); within each beat every displayed word gets an
// ABSOLUTE timeline animation-delay in ms — the exact format the .wv word spans already use
// (e.g. runs/<key>/final/template.wv: cue delay 31ms + word delays 487/943/… run continuously).
//
// PRIMARY: the VEED transcript's real per-word start times (each chunk's words:[{text,timestamp}],
// flattened by prep), mapped into each segment beat by time-overlap (a word belongs to the beat whose
// window contains its midpoint).
// FALLBACK (no word data, or a beat matched none): even split of the beat's window across its words
// (slot = window/wordCount, back-to-back from cue start — a natural one-slot tail before the window
// closes). This is the mechanic pipeline/director-brief.md documents — an even split tracks the
// spoken window best.
//
// Importable (prep.ts calls synthWordTimings) OR runnable as a standalone fallback CLI (e.g. when the
// inline creative pass drops/merges the displayed words of a beat):
//   node --import tsx pipeline/scripts/synth-word-timings.ts --start 1.2 --end 3.4 --words "COFFEE BEFORE WORDS"
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// One transcript chunk at either granularity: [startSec, endSec] + its text. Segment chunks are beats;
// word chunks are single words. Same shape at both granularities.
export interface TimedChunk {
  timestamp: [number, number];
  text: string;
}

export interface WordTiming {
  w: string;
  delayMs: number; // absolute timeline delay for this word's reveal
}

export interface BeatTiming {
  i: number;
  startSec: number;
  endSec: number;
  cueDelayMs: number; // = round(startSec*1000) — the cue's own animation-delay
  cueDurMs: number; // = round((endSec-startSec)*1000) — the cueWin window
  words: WordTiming[];
}

export interface WordTimings {
  beats: BeatTiming[];
}

function cleanWord(text: string): string {
  return text.trim();
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

// Even-split fallback: words revealed back-to-back from cue start at slot = window/wordCount, so the
// last word lands one slot before the window closes (the reserved tail). Always in-window + monotonic.
export function evenSplitDelays(startSec: number, endSec: number, words: string[]): WordTiming[] {
  const cueDelayMs = Math.round(startSec * 1000);
  const winMs = Math.max(0, Math.round((endSec - startSec) * 1000));
  const n = words.length;
  const slot = n > 0 ? winMs / n : 0;
  return words.map((w, i) => ({ w: cleanWord(w), delayMs: cueDelayMs + Math.round(i * slot) }));
}

function isTimed(c: unknown): c is TimedChunk {
  const t = (c as TimedChunk)?.timestamp;
  return Array.isArray(t) && t.length === 2 && typeof t[0] === 'number' && typeof t[1] === 'number'
    && typeof (c as TimedChunk).text === 'string';
}

// Map real word times into a beat, in order, as absolute-ms delays clamped into the beat window and
// kept monotonic (transcript word starts are already sorted, but guard against jitter/overlap).
function realWordDelays(seg: TimedChunk, words: TimedChunk[]): WordTiming[] {
  const [s, e] = seg.timestamp;
  const cueDelayMs = Math.round(s * 1000);
  const cueEndMs = cueDelayMs + Math.max(0, Math.round((e - s) * 1000));
  const inBeat = words
    .filter((w) => { const m = (w.timestamp[0] + w.timestamp[1]) / 2; return m >= s && m < e; })
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  let prev = cueDelayMs;
  return inBeat.map((w) => {
    let d = Math.round(w.timestamp[0] * 1000);
    if (d < cueDelayMs) d = cueDelayMs;
    if (d < prev) d = prev;
    if (d > cueEndMs) d = cueEndMs;
    prev = d;
    return { w: cleanWord(w.text), delayMs: d };
  });
}

// Build per-beat word timings. `segments` = transcript segment chunks (beats). `words` = per-word
// chunks (from the chunks' words:[] arrays) or null/undefined to force the even-split fallback for
// every beat.
export function synthWordTimings(segments: TimedChunk[], words?: TimedChunk[] | null): WordTimings {
  const wordChunks = (words ?? []).filter(isTimed);
  const beats = segments.map((seg, idx) => {
    if (!isTimed(seg)) throw new Error(`transcript chunk ${idx + 1} has no usable timestamp — cannot derive its cue window`);
    const [s, e] = seg.timestamp;
    const tokens = tokenize(seg.text);
    const real = wordChunks.length > 0 ? realWordDelays(seg, wordChunks) : [];
    // COMPLETENESS GUARD: the caption must equal the transcript. Midpoint binning can drop words whose
    // midpoint lands in an inter-segment gap / on a boundary, or disagree with the segment tokenization —
    // any count mismatch means the real timings are unsafe for THIS beat, so even-split its own tokens
    // (a partial real list would render a caption missing spoken words).
    const wordTimings = real.length === tokens.length && real.length > 0 ? real : evenSplitDelays(s, e, tokens);
    return {
      i: idx + 1,
      startSec: s,
      endSec: e,
      cueDelayMs: Math.round(s * 1000),
      cueDurMs: Math.max(0, Math.round((e - s) * 1000)),
      words: wordTimings,
    };
  });
  return { beats };
}

function parseArgs(argv: string[]): { start: number; end: number; words: string[]; out?: string } {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const start = Number(get('--start'));
  const end = Number(get('--end'));
  const wordsRaw = get('--words');
  if (!Number.isFinite(start) || !Number.isFinite(end) || !wordsRaw) {
    throw new Error('usage: node --import tsx pipeline/scripts/synth-word-timings.ts --start <s> --end <s> --words "A B C" [--out file.json]');
  }
  return { start, end, words: tokenize(wordsRaw), out: get('--out') };
}

// Run directly = the agent's fallback: one beat's window + its displayed words → even-split delays.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { start, end, words, out } = parseArgs(process.argv.slice(2));
  const result = {
    cueDelayMs: Math.round(start * 1000),
    cueDurMs: Math.max(0, Math.round((end - start) * 1000)),
    words: evenSplitDelays(start, end, words),
  };
  const json = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, json);
  else console.log(json);
}
