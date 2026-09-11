// The agent's fallback when the inline creative pass drops or merges the displayed words of a
// beat: one beat's window + its displayed words → even-split delays, in the word-timings.json
// per-beat shape.
//
//   openedit synth-timings --start 1.2 --end 3.4 --words "COFFEE BEFORE WORDS" [--out file.json]
import { writeFileSync } from 'node:fs';
import { parseFlags } from '../args.ts';
import { evenSplitDelays, tokenize } from '../prep/synth-word-timings.ts';

const USAGE = 'usage: openedit synth-timings --start <s> --end <s> --words "A B C" [--out file.json]';

export function synthTimings(argv: string[]): number {
  const { values } = parseFlags({
    args: argv,
    options: {
      start: { type: 'string' },
      end: { type: 'string' },
      words: { type: 'string' },
      out: { type: 'string' },
    },
  });
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
  if (values.out) writeFileSync(values.out, json);
  else console.log(json);
  return 0;
}
