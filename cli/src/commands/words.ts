// A transcript as timed lines, so reading one needs no script: a transcript.json, or any speech-to-text JSON
// the whisper command maps, mapped in memory and named in the first line.
//
//   openedit words <transcript> [--from <sec>] [--to <sec>] [--cues]
import { parseUsage, usageLine, numberFlag, type Usage } from '../args.ts';
import { readTranscriptFile } from '../transcript/read-transcript.ts';
import { wordCount } from '../transcript/transcript-cache.ts';

export const usage = {
  summary: 'Print a transcript as timed lines, one per word (any format whisper maps; nothing is written)',
  positionals: '<transcript>',
  flags: {
    from: { type: 'string', value: '<sec>', help: 'Only lines that reach past this second' },
    to: { type: 'string', value: '<sec>', help: 'Only lines that start before this second' },
    cues: { type: 'boolean', help: 'One line per cue, the words of a caption together, instead of one per word' },
  },
  notes: 'Each line is its start and end in seconds, then its text.',
} satisfies Usage;

const line = (from: number, to: number, text: string) => `${from.toFixed(2).padStart(8)} ${to.toFixed(2).padStart(8)}  ${text}`;

export function wordsLines(path: string, o: { from?: number; to?: number; cues?: boolean } = {}): string[] {
  const read = readTranscriptFile(path);
  const { chunks } = read.transcript;
  const from = o.from ?? -Infinity;
  const to = o.to ?? Infinity;
  const timed = o.cues ? chunks : chunks.flatMap((c) => c.words);
  const shown = timed.filter((t) => t.timestamp[1] > from && t.timestamp[0] < to);
  // reduce, not a spread: one argument per cue can exceed the argument limit on a long recording.
  const end = chunks.reduce((t, c) => Math.max(t, c.timestamp[1]), -Infinity);
  const span = chunks.length ? `, ${chunks[0].timestamp[0].toFixed(2)}s to ${end.toFixed(2)}s` : '';
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  const head = `${path}: ${read.format}${read.mapped ? ', mapped in memory' : ''}; ${count(wordCount(read.transcript), 'word')} in ${count(chunks.length, 'cue')}${span}`;
  const untimed = read.interpolated > 0 ? [`${read.interpolated} of the words came without times of their own: theirs are interpolated`] : [];
  return [head, ...untimed, ...shown.map((t) => line(t.timestamp[0], t.timestamp[1], t.text))];
}

export function words(argv: string[]): number {
  const { values, positionals } = parseUsage('words', usage, argv);
  if (positionals.length !== 1) throw new Error(usageLine('words', usage));
  const from = values.from === undefined ? undefined : numberFlag('from', values.from, 0, (n) => n >= 0, 'seconds, 0 or more');
  const to = values.to === undefined ? undefined : numberFlag('to', values.to, (from ?? 0) + 10, (n) => n > (from ?? 0), 'seconds after --from');
  for (const l of wordsLines(positionals[0], { from, to, cues: values.cues === true })) console.log(l);
  return 0;
}
