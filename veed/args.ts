// Strict flag parsing for every entry point in this repo that reads flags from a shell.
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
