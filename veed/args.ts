// Strict flag parsing for every entry point in this repo that reads flags from a shell, plus the small
// input guards the commands share: path-segment safety, and a describer for a value that failed a check.
//
// The parsing is node:util's parseArgs, which is strict by default: an unrecognised flag, a flag missing
// its value, and a stray positional are each an error. That is the whole point — the hand-rolled
// `argv.indexOf` reader each script grew independently failed the same way, by not finding a flag it did
// not know and carrying on as though the run had obeyed. pipeline/scripts/sample-style.ts accepted
// `--style`, ignored it, re-rendered the previous pick, and printed the OLD id while looking like it had
// worked.
//
// This wrapper adds the one thing parseArgs does not: naming the valid flags, because "Unknown option
// '--stile'" on its own leaves someone guessing at the spelling of the one they meant.
import { parseArgs, type ParseArgsConfig } from 'node:util';

// `strict` is parseArgs' default, and callers may not turn it off: a lenient parser here would reintroduce
// the silent mis-parse this module exists to stop.
export function parseFlags<T extends ParseArgsConfig>(config: T & { strict?: never }) {
  try {
    return parseArgs(config);
  } catch (cause) {
    const flags = Object.keys(config.options ?? {}).sort().map((name) => `--${name}`);
    const valid = flags.length > 0 ? `Valid flags: ${flags.join(' ')}` : 'This command takes no flags.';
    throw new Error(`${(cause as Error).message}\n${valid}`, { cause });
  }
}

// Named for what the value IS: "expected a number" without the value it found cannot be diagnosed from
// the message alone, and this is the message a user reads instead of getting their result.
export function describeValue(value: unknown): string {
  if (value === undefined) return 'absent';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return value === null ? 'null' : JSON.stringify(value);
  return String(value);
}

// --key and a session id each name a path segment under runs/, so both are fenced the same way: anything
// that could climb out of the directory (a separator, a `..`, a leading dash) is refused rather than
// normalised, because a silently relocated read or write is worse than an error.
function assertSafeSegment(value: string, invalid: (v: string) => string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..' || value.startsWith('-')) {
    throw new Error(invalid(value));
  }
  return value;
}

export function assertSafeKey(key: string): string {
  return assertSafeSegment(key, (k) =>
    `invalid --key "${k}": use a single path segment of letters, digits, dot, dash or underscore (it names a directory under runs/)`,
  );
}

export function assertSafeSessionId(sessionId: string): string {
  return assertSafeSegment(sessionId, (id) =>
    `invalid session id "${id}": use letters, digits, dot, dash or underscore (it names a charge record under runs/<key>/)`,
  );
}
