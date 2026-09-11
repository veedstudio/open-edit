// Strict flag parsing for every command that reads flags from a shell. node:util's
// parseArgs is strict by default — an unrecognised flag, a flag missing its value, and
// a stray positional are each an error — and callers may not turn that off: a lenient
// parser silently mis-parses, which is exactly what this wrapper exists to stop. It
// adds the one thing parseArgs does not: naming the valid flags, because "Unknown
// option '--stile'" alone leaves someone guessing at the spelling of the one they meant.
import { parseArgs, type ParseArgsConfig } from 'node:util';

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

/**
 * A numeric flag with a default, refused by name when it is not a usable number. An empty value
 * (`--crf=`) is refused too: `Number('')` is 0, which would read as a selection nobody made.
 */
export function numberFlag(
  flag: string,
  raw: string | undefined,
  fallback: number,
  accept: (n: number) => boolean,
  wants: string,
): number {
  if (raw === undefined) return fallback;
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || !accept(n)) throw new Error(`--${flag} wants ${wants}, e.g. --${flag} ${fallback}`);
  return n;
}
