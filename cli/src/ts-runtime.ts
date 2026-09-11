// Recipe modules and, in development, the WCAG applier are TypeScript loaded by a CLI that ships
// compiled JS. Node strips types natively from 22.18 and behind a flag from 22.6, so the flagged
// range gets the flag rather than a refusal.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STRIP_TYPES_FLAG = '--experimental-strip-types';

/**
 * `--import tsx` as an absolute URL. Node resolves a bare --import specifier against the CWD, which
 * stopped naming the tree the script came from once content and workspace became separate roots: a
 * gate spawned from the content tree with the workspace as cwd looked for tsx in the wrong place and
 * failed with a module-not-found instead of running.
 */
export function tsxImportUrl(contentRoot: string): string {
  for (const from of [join(contentRoot, 'package.json'), fileURLToPath(import.meta.url)]) {
    try {
      return pathToFileURL(createRequire(from).resolve('tsx')).href;
    } catch { /* try the next tree */ }
  }
  throw new Error(`tsx is not installed under ${contentRoot} — a TypeScript content tree needs it to run its gates; install that checkout's dependencies, or use a packaged install whose gates ship compiled`);
}

// Set on the re-executed child so a flag that does not help cannot loop.
export const RETRY_ENV = 'OPEN_EDIT_STRIP_TYPES_RETRY';

function parts(version: string): [number, number] {
  const [maj, min] = version.replace(/^v/, '').split('.').map(Number);
  return [Number.isFinite(maj) ? maj : 0, Number.isFinite(min) ? min : 0];
}

export function stripsTypesNatively(version: string = process.version): boolean {
  const [maj, min] = parts(version);
  return maj >= 23 || (maj === 22 && min >= 18);
}

export function supportsStripTypesFlag(version: string = process.version): boolean {
  const [maj, min] = parts(version);
  return maj >= 23 || (maj === 22 && min >= 6);
}

// Keyed on the entry's extension, not on a version policy: a published install spawns compiled .js and
// needs nothing. Throws for a .ts no flag can load, so that failure lands before any work starts.
export function nodeTsArgs(entry: string, version: string = process.version): string[] {
  if (!entry.endsWith('.ts')) return [];
  if (stripsTypesNatively(version)) return [];
  if (!supportsStripTypesFlag(version)) {
    throw new Error(
      `Node ${version} cannot run the TypeScript entry ${entry}: it has no type-stripping (${STRIP_TYPES_FLAG} needs 22.6+; 22.18+ needs no flag)`,
    );
  }
  return [STRIP_TYPES_FLAG];
}

export type Spawn = typeof spawnSync;

export type ReexecOutcome =
  | { kind: 'ran'; code: number }
  | { kind: 'already-retried' }
  | { kind: 'no-flag'; version: string }
  | { kind: 'spawn-failed'; error: Error };

export interface ReexecDeps {
  spawn?: Spawn;
  version?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execArgv?: string[];
  execPath?: string;
}

// 128+N is the shell convention; 1 would read as one of this CLI's own gate failures.
function signalExit(signal: NodeJS.Signals): number {
  const n = (constants.signals as unknown as Record<string, number>)[signal];
  return typeof n === 'number' ? 128 + n : 1;
}

// An in-process import() cannot be given a loader after startup, so the whole invocation is re-run
// under the flag. The non-run outcomes stay distinct because each needs a different message.
export function reexecWithStripTypes(deps: ReexecDeps = {}): ReexecOutcome {
  const spawn = deps.spawn ?? spawnSync;
  const version = deps.version ?? process.version;
  const env = deps.env ?? process.env;
  const argv = deps.argv ?? process.argv;
  const execPath = deps.execPath ?? process.execPath;
  if (env[RETRY_ENV] === '1') return { kind: 'already-retried' };
  if (!supportsStripTypesFlag(version)) return { kind: 'no-flag', version };
  // The parent's own node flags are part of the invocation the caller asked for.
  const execArgv = (deps.execArgv ?? process.execArgv).filter((a) => a !== STRIP_TYPES_FLAG);
  const r = spawn(execPath, [...execArgv, STRIP_TYPES_FLAG, ...argv.slice(1)], {
    stdio: 'inherit',
    env: { ...env, [RETRY_ENV]: '1' },
  });
  if (r.error) return { kind: 'spawn-failed', error: r.error };
  if (r.status === null && r.signal) return { kind: 'ran', code: signalExit(r.signal) };
  return { kind: 'ran', code: r.status ?? 1 };
}

export function reexecFailureReason(outcome: Exclude<ReexecOutcome, { kind: 'ran' }>): string {
  switch (outcome.kind) {
    case 'already-retried':
      return `${STRIP_TYPES_FLAG} is already on and Node still refuses the file — a .ts inside node_modules is never stripped, on any version`;
    case 'no-flag':
      return `Node ${outcome.version} has no type-stripping (${STRIP_TYPES_FLAG} needs 22.6+; 22.18+ needs no flag)`;
    case 'spawn-failed':
      return `could not re-run this command with ${STRIP_TYPES_FLAG}: ${outcome.error.message}`;
  }
}
