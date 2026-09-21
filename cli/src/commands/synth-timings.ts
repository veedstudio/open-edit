// The agent's fallback when the inline creative pass drops or merges the displayed words of a
// beat: one beat's window + its displayed words → even-split delays, in the word-timings.json
// per-beat shape.
//
//   openedit synth-timings --start 1.2 --end 3.4 --words "COFFEE BEFORE WORDS" [--out file.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { evenSplitDelays, tokenize } from '../prep/synth-word-timings.ts';

export const usage = {
  summary: 'Even-split word reveal delays for one beat window (the creative-pass fallback)',
  flags: {
    start: { type: 'string', value: '<s>', required: true, help: 'Beat window start, in seconds' },
    end: { type: 'string', value: '<s>', required: true, help: 'Beat window end, in seconds' },
    words: { type: 'string', value: '"A B C"', required: true, help: 'The displayed words, space separated' },
    out: { type: 'string', value: '<file.json>', help: 'Write the timings here instead of stdout' },
  },
} satisfies Usage;

const USAGE = usageLine('synth-timings', usage);

export function synthTimings(argv: string[]): number {
  const { values } = parseUsage('synth-timings', usage, argv);
  const start = Number(values.start);
  const end = Number(values.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !values.words) {
    throw new Error(USAGE);
  }
  const result = {
    cueDelayMs: Math.round(start * 1000),
    cueDurMs: Math.max(0, Math.round((end - start) * 1000)),
    words: evenSplitDelays(start, end, tokenize(values.words)),
  };
  const json = JSON.stringify(result, null, 2);
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, json);
  } else console.log(json);
  return 0;
}
