// The on-disk shape of runs/<key>/word-timings.json — per-word caption reveal timings for the
// word-level caption animation. Beats ARE the transcript's segment chunks (identical to
// transcript.json, in order); within each beat every displayed word gets an ABSOLUTE timeline
// animation-delay in ms — the exact format the .wv word spans already use.
//
// TYPES ONLY: the artifact, not a module, is the contract. The synthesis itself is the
// `@veedstudio/openedit-cli` prep command (`npx @veedstudio/openedit-cli prep <video>`), and the
// standalone even-split fallback (one beat's window + its displayed words) is its synth-timings
// command. The package pins these interfaces against its own copy with shared test vectors.

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
