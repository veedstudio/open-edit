// The length check: a render whose picture misses the length the user asked for, such as a 25-second ask
// rendered at 20.8 seconds. The asked length is --length's, else the piece's brief.json's; without either there is
// nothing to compare, and the check is skipped.
import { readBrief, type FoundBrief } from '../brief.ts';
import type { CheckReport, Found, LengthInput, ReviewContext } from './checks.ts';
import { seconds as s } from './report.ts';

/**
 * A player shows length in whole seconds, so a miss of a second or less moves its clock one tick at most; on a
 * longer piece, 5% either side is a judgement of how loosely a round figure is meant, not a measurement.
 */
export const TOLERANCE = { seconds: 1, fraction: 0.05 } as const;

export const toleranceFor = (asked: number): number => Math.max(TOLERANCE.seconds, TOLERANCE.fraction * asked);

// Judged on the figures the line prints, so float noise never reports a miss it prints as equal to the allowance.
const printed = (seconds: number) => Number(seconds.toFixed(2));

export function measureLength({ duration, askedLength }: ReviewContext): CheckReport {
  if ('missing' in askedLength) {
    return { verdict: 'skipped', lines: [], skipped: [`the length asked for: ${askedLength.missing}`] };
  }
  return judgeLength(duration, askedLength);
}

/** A picture of `duration` seconds against the length asked for, which render also judges as it finishes. */
export function judgeLength(duration: number, { seconds: asked, from }: Found<LengthInput>): CheckReport {
  const allowed = toleranceFor(asked);
  const miss = duration - asked;
  const off = Math.abs(miss);
  if (printed(off) <= printed(allowed)) {
    return {
      verdict: 'pass',
      lines: [`on length: ${s(duration)} against the ${s(asked)} asked for (${from}), ${s(off)} off, within the ${s(allowed)} allowed`],
      skipped: [],
    };
  }
  const way = miss < 0 ? 'shorter' : 'longer';
  return {
    verdict: 'found',
    lines: [`the video is ${s(duration)}, ${s(off)} ${way} than the ${s(asked)} asked for (${from}), more than the ${s(allowed)} allowed`],
    skipped: [],
  };
}

/**
 * A line when a video runs further from the length in the piece's brief than review allows, worded as review words
 * it, so the miss shows while what made it is fresh; null when it is on length or no brief asks one. The brief is
 * the nearest to the first of `from` that has one; `what` names the video in the line.
 */
export function lengthAgainstBrief(duration: number, from: string[], what = 'the video'): string | null {
  for (const file of from) {
    let found: FoundBrief | null;
    try {
      found = readBrief(file);
    } catch (error) {
      return `length: not compared, since ${(error as Error).message}`;
    }
    if (!found) continue;
    if (found.brief.length === undefined) return null;
    const judged = judgeLength(duration, { seconds: found.brief.length, from: found.path });
    return judged.verdict === 'found' ? `length: ${judged.lines[0].replace(/^the video/, what)}` : null;
  }
  return null;
}
