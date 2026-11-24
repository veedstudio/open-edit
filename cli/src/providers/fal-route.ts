// Which fal a command runs on: a fal key this process can read, or the fal command an environment gives in place of one.
import { spawnSync } from 'node:child_process';
import { findOnPath } from '../platform.ts';
import { errorText } from '../proxy.ts';
import { falKey, NoFalKey } from './fal.ts';

/**
 * The command `fal`, when it is one an environment gives in place of a fal key: it says it takes a model and that
 * model's input, which fal's own CLI of the same name does not. With none, why.
 */
function environmentFal(env: NodeJS.ProcessEnv): { fal: string } | { why: string } {
  const fal = findOnPath('fal', env);
  if (!fal) return { why: 'the environment gives no fal command of its own' };
  const r = spawnSync(fal, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error) return { why: `the fal command at ${fal} did not answer --help (${errorText(r.error)})` };
  return /fal run MODEL_ID INPUT_JSON/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`) ? { fal } : { why: `the fal command at ${fal} is not one that runs a model on its input` };
}

/**
 * A fal key this process reads, else the environment's own fal command, else neither and why. `unreadable` marks a
 * key that is set and cannot be read: a setting to fix, which the command is not turned to in place of.
 */
export type FalRoute = { how: 'key'; key: string } | { how: 'command'; fal: string } | { how: 'none'; why: string; unreadable?: true };

export function falRoute(env: NodeJS.ProcessEnv = process.env, command: (env: NodeJS.ProcessEnv) => { fal: string } | { why: string } = environmentFal): FalRoute {
  try {
    return { how: 'key', key: falKey(env) };
  } catch (e) {
    if (!(e instanceof NoFalKey)) return { how: 'none', why: errorText(e), unreadable: true };
  }
  const own = command(env);
  return 'fal' in own ? { how: 'command', fal: own.fal } : { how: 'none', why: `no fal key is readable here, and ${own.why}` };
}
