// Where speech starts and stops, measured from the audio rather than read off a transcript.
//
//   openedit speech-probe <video> [--range 1.2:4.8] [--window 10] [--gap 250] [--json]
//
// Word boundaries are not cut points: ASR can report a gap between two words where the waveform shows
// unbroken voicing, and cutting there slices a phoneme. The noise floor is measured per clip, since a
// street sits 20 dB above a quiet room and one fixed threshold finds gaps in one but not the other.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { numberFlag, parseFlags } from '../args.ts';
import { FFMPEG } from '../config.ts';

const SAMPLE_RATE = 16_000;

export interface Gap {
  start: number;
  end: number;
  duration: number;
}

export interface ProbeResult {
  /** Measured noise floor in dBFS: the 10th percentile of the envelope. */
  floor: number;
  /** Loudest window in dBFS. */
  peak: number;
  /** Threshold used to separate speech from floor, in dBFS. */
  threshold: number;
  /** First window at or above threshold, in seconds FROM THE START OF THE FILE — an EDL in-point. */
  onset: number | null;
  /** End of the last window at or above threshold, also in file seconds. */
  decay: number | null;
  /** Sub-threshold stretches at least `--gap` milliseconds long, in file seconds — the safe cut targets. */
  gaps: Gap[];
  /** False when the signal has no dynamic range to separate speech from floor. `floor`, `peak` and
   *  `threshold` still hold real measurements; `onset`, `decay` and `gaps` do not. */
  speechFound: boolean;
  /** Per-window dBFS, so a caller can render or re-threshold without decoding again. Omitted from
   *  --json: a ten-minute clip is sixty thousand numbers, and the caller of --json is an agent whose
   *  context they would fill for nothing. */
  envelope: number[];
  windowMs: number;
  rangeStart: number;
}

/** dBFS of each fixed-length window of 16-bit mono PCM. */
export function envelopeOf(pcm: Int16Array, windowSamples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + windowSamples <= pcm.length; i += windowSamples) {
    let sum = 0;
    for (let j = i; j < i + windowSamples; j++) sum += pcm[j] * pcm[j];
    const rms = Math.sqrt(sum / windowSamples);
    out.push(rms > 0 ? 20 * Math.log10(rms / 32768) : -100);
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return -100;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

// Below this the clip is one flat level — digital silence, room tone with nobody talking, or a decode
// that returned nothing. A threshold derived from it equals the floor, every window then counts as
// speech, and the probe reports unbroken voicing over a clip with no voice in it.
export const MIN_DYNAMIC_RANGE_DB = 6;

/**
 * Speech is separated from the floor by a margin above the MEASURED floor, so the same numbers work
 * on a street and in a booth. The margin is deliberately generous: a false gap costs a bad cut, a
 * missed gap only costs a cut opportunity.
 */
export function analyse(envelope: number[], windowMs: number, gapMs: number, rangeStart: number): ProbeResult {
  const floor = percentile(envelope, 0.1);
  // reduce, not Math.max(...envelope): spreading one argument per window throws RangeError past about
  // 125k of them, which at a 10ms window is any clip over roughly twenty minutes.
  const peak = envelope.reduce((hi, v) => (v > hi ? v : hi), -100);
  const threshold = Math.min(floor + 12, floor + (peak - floor) * 0.35);
  if (envelope.length === 0 || peak - floor < MIN_DYNAMIC_RANGE_DB) {
    return { floor, peak, threshold, onset: null, decay: null, gaps: [], speechFound: false, envelope, windowMs, rangeStart };
  }
  const perSecond = 1000 / windowMs;
  const at = (index: number) => rangeStart + index / perSecond;

  const first = envelope.findIndex((v) => v >= threshold);
  const last = envelope.findLastIndex((v) => v >= threshold);
  const onset = first < 0 ? null : at(first);
  const decay = last < 0 ? null : at(last + 1);

  // ceil, not round: a reported gap is AT LEAST --gap long.
  const minWindows = Math.max(1, Math.ceil(gapMs / windowMs - 1e-9));
  const gaps: Gap[] = [];
  let runStart = -1;
  for (let i = 0; i <= envelope.length; i++) {
    const quiet = i < envelope.length && envelope[i] < threshold;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if (i - runStart >= minWindows) {
        gaps.push({ start: at(runStart), end: at(i), duration: (i - runStart) / perSecond });
      }
      runStart = -1;
    }
  }

  return { floor, peak, threshold, onset, decay, gaps, speechFound: true, envelope, windowMs, rangeStart };
}

export function decode(video: string, range: { start: number; end: number } | null): Int16Array {
  const args = ['-v', 'error'];
  if (range) args.push('-ss', range.start.toFixed(3), '-to', range.end.toFixed(3));
  args.push('-i', video, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-');
  const raw = execFileSync(FFMPEG, args, { maxBuffer: 1 << 30 });
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
}

function parseRange(value: string): { start: number; end: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) throw new Error(`--range wants seconds as start:end, e.g. --range 1.2:4.8 (got "${value}")`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!(end > start)) throw new Error(`--range end ${end} must be after start ${start}`);
  return { start, end };
}

export function speechProbe(argv: string[]): number {
  const { values, positionals } = parseFlags({
    args: argv,
    options: {
      range: { type: 'string' },
      window: { type: 'string' },
      gap: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const video = positionals[0];
  if (!video) {
    throw new Error('usage: openedit speech-probe <video> [--range <seconds>:<seconds>] [--window <ms>, default 10] [--gap <ms>, default 250] [--json]');
  }
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);

  const range = values.range ? parseRange(values.range) : null;
  const windowMs = numberFlag('window', values.window, 10, (n) => n > 0, 'milliseconds');
  const gapMs = numberFlag('gap', values.gap, 250, (n) => n > 0, 'milliseconds');

  const pcm = decode(video, range);
  const windowSamples = Math.max(1, Math.round((SAMPLE_RATE * windowMs) / 1000));
  // The window the envelope was actually cut with: a whole number of samples, so times are derived from
  // it rather than from the requested figure (a 0.1 ms request is two samples, which is 0.125 ms).
  const effectiveWindowMs = (windowSamples * 1000) / SAMPLE_RATE;
  const result = analyse(envelopeOf(pcm, windowSamples), effectiveWindowMs, gapMs, range?.start ?? 0);

  if (values.json) {
    const { envelope, ...summary } = result;
    console.log(JSON.stringify({ ...summary, measuredWindows: envelope.length }, null, 2));
    return 0;
  }

  const s = (v: number | null) => (v === null ? '   —  ' : `${v.toFixed(3)}s`);
  console.log(`${video}${range ? ` [${range.start}-${range.end}]` : ''}`);
  console.log(`  floor ${result.floor.toFixed(1)} dBFS   peak ${result.peak.toFixed(1)} dBFS   threshold ${result.threshold.toFixed(1)} dBFS`);
  if (!result.speechFound) {
    // Saying "no gaps" here would read as "this is all speech, do not cut" over a clip with no speech.
    console.log(
      result.envelope.length === 0
        ? `  NO AUDIO MEASURED — not one full ${windowMs}ms window came back. Check the range lies inside `
          + 'the file, and that it is longer than one window.'
        : `  NO SPEECH FOUND — the level never rises ${MIN_DYNAMIC_RANGE_DB} dB above its own floor: either ` +
          'nothing is said here, or the whole range is one continuous voicing. Either way there is no gap in it to cut.',
    );
    return 0;
  }
  console.log(`  speech onset ${s(result.onset)}   decay ${s(result.decay)}`);
  if (result.gaps.length === 0) {
    console.log(`  no gap of ${gapMs}ms or more — every boundary here is inside continuous voicing, so none of them is a safe cut`);
    return 0;
  }
  console.log(`  ${result.gaps.length} gap(s) of ${gapMs}ms or more — the safe cut targets:`);
  for (const gap of result.gaps) {
    console.log(`    ${gap.start.toFixed(3)}s -> ${gap.end.toFixed(3)}s  (${(gap.duration * 1000).toFixed(0)}ms)`);
  }
  return 0;
}
