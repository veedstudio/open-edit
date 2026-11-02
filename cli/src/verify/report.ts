// Phrasing the checks share in their report lines, so every check prints times, quotes and long lists alike.
import type { CheckReport } from './checks.ts';

export const seconds = (t: number): string => `${t.toFixed(2)}s`;

/** A text as the report quotes it: on one line, and cut short past 60 characters. */
export const quoted = (text: string): string => `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;

export const fromTo = (from: number, to: number): string => `from ${seconds(from)} to ${seconds(to)}`;

/** Report lines in time order, the tail past `max` folded into one line. */
export function listed(findings: { start: number; line: string }[], max = 12): string[] {
  const lines = [...findings].sort((a, b) => a.start - b.start).map((f) => f.line);
  return lines.length > max ? [...lines.slice(0, max - 1), `and ${lines.length - max + 1} more`] : lines;
}

/** A check that had nothing to compare, and why. */
export const skippedFor = (...reasons: string[]): CheckReport => ({ verdict: 'skipped', lines: [], skipped: reasons });
