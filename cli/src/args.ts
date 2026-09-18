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

// One declaration per command carries its flags, their parser config and its help. The dispatcher
// renders the top-level list and `<command> --help` from these, so the help cannot drift from what
// the parser accepts. Declare with `satisfies Usage` so the flag names and types stay literal and
// `parseUsage` returns typed values.
export type Flag = {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  required?: boolean;
  /** What the value is, for the grammar line: `<file>`, `N`, `male|female`. String flags only. */
  value?: string;
  help: string;
};

export type Usage<F extends Record<string, Flag> = Record<string, Flag>> = {
  /** One line for the top-level command list. */
  summary: string;
  /** The positional grammar, e.g. `<video.mp4> [...]`; absent when the command takes none. */
  positionals?: string;
  flags: F;
  /** Extra prose under the flag table. */
  notes?: string;
};

function flagForm(name: string, f: Flag): string {
  return f.type === 'string' ? `--${name} ${f.value ?? '<value>'}` : `--${name}`;
}

function flagGrammar(name: string, f: Flag): string {
  const form = flagForm(name, f);
  const one = f.required ? form : `[${form}]`;
  return f.multiple ? `${one}...` : one;
}

/** The one-line grammar: `usage: openedit <command> <positionals> [--flag <value>] ...`. */
export function usageLine(command: string, usage: Usage): string {
  const parts = [`usage: openedit ${command}`];
  if (usage.positionals) parts.push(usage.positionals);
  for (const [name, f] of Object.entries(usage.flags)) parts.push(flagGrammar(name, f));
  return parts.join(' ');
}

/** The full help for one command: grammar, summary, every flag with what it does, notes. */
export function renderUsage(command: string, usage: Usage): string {
  const rows = Object.entries(usage.flags).map(([name, f]) => {
    const form = flagForm(name, f);
    return [f.short ? `-${f.short}, ${form}` : form, f.help] as const;
  });
  const width = Math.max(0, ...rows.map(([form]) => form.length));
  const lines = [usageLine(command, usage), '', usage.summary];
  if (rows.length) {
    lines.push('');
    for (const [form, help] of rows) lines.push(`  ${form.padEnd(width)}  ${help}`);
  }
  if (usage.notes) lines.push('', usage.notes);
  return `${lines.join('\n')}\n`;
}

/**
 * Parse a command's argv against its declared usage: the strict parser, positionals allowed only
 * when the usage names some, and the grammar line appended to every rejection. parseArgs reads
 * only type/short/multiple off each flag and ignores the help keys.
 */
export function parseUsage<F extends Record<string, Flag>>(command: string, usage: Usage<F>, args: string[]) {
  try {
    return parseFlags({ args, options: usage.flags, allowPositionals: usage.positionals !== undefined });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usageLine(command, usage)}`, { cause: error });
  }
}
