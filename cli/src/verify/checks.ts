// Every check the review command runs on a render before it is delivered: defects no tool can stop
// while the video is made. A check reports what it measured and never changes the video. A new check is
// a module in this folder, one entry in CHECKS, and its sentence in the README's review section; an input
// the review does not resolve yet becomes a ReviewContext field, typed like TranscriptInput, so a missing
// one skips the checks that need it instead of stopping the review.
import type { Transcript } from '../transcript/transcript-types.ts';
import { measureDeadTail } from './dead-tail.ts';
import { measureLength } from './length.ts';

/** The transcript on the render's timeline, or why there is none: the reason is printed in the report. */
export type TranscriptInput = { path: string; transcript: Transcript } | { missing: string };

/** The length the user asked for, in seconds, or why there is none: the reason is printed in the report. */
export type LengthInput = { seconds: number } | { missing: string };

export interface ReviewContext {
  video: string;
  /** Seconds of picture, probed once by the review. */
  duration: number;
  /** Resolved once by the review, so every check that compares against speech reads the same words. */
  transcript: TranscriptInput;
  /** From --length: how long the user asked the video to run, where `duration` is how long it does. */
  askedLength: LengthInput;
}

export type Verdict = 'found' | 'pass' | 'skipped';

export interface CheckReport {
  /** `skipped` when nothing could be compared, so a check that measured nothing never reads as a pass. */
  verdict: Verdict;
  /** What was measured, one sentence a line; the first states the result. */
  lines: string[];
  /** Each comparison that could not run, and why. */
  skipped: string[];
}

export interface Check {
  name: string;
  run: (context: ReviewContext) => CheckReport | Promise<CheckReport>;
}

export const CHECKS: readonly Check[] = [
  { name: 'dead-tail', run: measureDeadTail },
  { name: 'length', run: measureLength },
];
