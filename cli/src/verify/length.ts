// The length check: a render whose picture misses the length the user asked for, such as a 25-second ask
// rendered at 20.8 seconds. The agent passes the asked length with --length; without one there is nothing
// to compare, and the check is skipped.
import type { CheckReport, ReviewContext } from './checks.ts';

/**
 * A player shows length in whole seconds, so a miss of a second or less moves its clock one tick at most; on a
 * longer piece, 5% either side is a judgement of how loosely a round figure is meant, not a measurement.
 */
export const TOLERANCE = { seconds: 1, fraction: 0.05 } as const;

export const toleranceFor = (asked: number): number => Math.max(TOLERANCE.seconds, TOLERANCE.fraction * asked);

const s = (seconds: number) => `${seconds.toFixed(2)}s`;

// Judged on the figures the line prints, so float noise never reports a miss it prints as equal to the allowance.
const printed = (seconds: number) => Number(seconds.toFixed(2));

export function measureLength({ duration, askedLength }: ReviewContext): CheckReport {
  if ('missing' in askedLength) {
    return { verdict: 'skipped', lines: [], skipped: [`the length asked for: ${askedLength.missing}`] };
  }
  const asked = askedLength.seconds;
  const allowed = toleranceFor(asked);
  const miss = duration - asked;
  const off = Math.abs(miss);
  if (printed(off) <= printed(allowed)) {
    return {
      verdict: 'pass',
      lines: [`on length: ${s(duration)} against the ${s(asked)} asked for, ${s(off)} off, within the ${s(allowed)} allowed`],
      skipped: [],
    };
  }
  const way = miss < 0 ? 'shorter' : 'longer';
  return {
    verdict: 'found',
    lines: [`the video is ${s(duration)}, ${s(off)} ${way} than the ${s(asked)} asked for, more than the ${s(allowed)} allowed`],
    skipped: [],
  };
}
