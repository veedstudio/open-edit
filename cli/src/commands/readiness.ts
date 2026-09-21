// Readiness check for both the render flow and the VEED-native transcription path.
// Reports what is present vs what is still missing for a run, and exits 1 when a blocking item is
// missing. Read-only, no network.
//
//   openedit readiness
import { existsSync } from 'node:fs';
import { parseUsage, type Usage } from '../args.ts';
import { FFMPEG, engineBinPath } from '../config.ts';
import { FFMPEG_PROBE, probeVersion } from '../platform.ts';
import { VEED_API_BASE } from '../veed/api.ts';
import { DEFAULT_TOKEN_PATH } from '../veed/token-store.ts';

type Check = { label: string; ok: boolean; detail: string; blocking: boolean };

export const usage = {
  summary: 'Report what is present vs missing for a run (read-only, no network; exits 1 on a blocking miss)',
  flags: {},
} satisfies Usage;

export function readiness(argv: string[]): number {
  parseUsage('readiness', usage, argv);
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string, blocking = true): void => {
    checks.push({ label, ok, detail, blocking });
  };

  // --- toolchain (shared by both flows) ---
  add('node', true, process.version);

  // probeVersion, not a bare exec: a binary that exists but cannot start (the missing-DLL
  // Server case) must be diagnosed as such, not as absent with the wrong remedy.
  const ff = probeVersion(FFMPEG, FFMPEG_PROBE);
  add('ffmpeg', ff.banner !== '', ff.banner || `not runnable at "${FFMPEG}" — ${ff.failure} (set VEED_ENGINE_FFMPEG)`);

  const engineBin = engineBinPath();
  const firstTry = probeVersion(engineBin);
  const engine = firstTry.banner ? firstTry : probeVersion(engineBin, { args: ['version'] });
  add(
    'veed-engine-cli',
    engine.banner !== '',
    engine.banner || `not runnable at "${engineBin}" — ${engine.failure} (run: npx @veedstudio/openedit-cli install-engine; only needed for render, not transcription)`,
    false,
  );

  // --- VEED-native transcription path ---
  add('VEED API base', true, VEED_API_BASE, false);

  // Fabric generation rides the same login and the same REST edge as transcription — surface it so a user
  // who wonders "can this thing make me a video?" gets an answer without reading the source. This command
  // makes no network calls, so this reports the CONFIGURED url only; reachability is proven by the first real run.
  add('Fabric generation endpoint', true, `${VEED_API_BASE} (configured; not contacted)`, false);

  const tokenEnv = (process.env.VEED_ACCESS_TOKEN ?? '').trim() !== '';
  const tokenCached = existsSync(DEFAULT_TOKEN_PATH);
  // Optional, not blocking: only the VEED provider reads this token.
  add(
    'VEED login token',
    tokenEnv || tokenCached,
    tokenEnv ? 'VEED_ACCESS_TOKEN set' : tokenCached ? `cached at ${DEFAULT_TOKEN_PATH}` : 'not logged in yet; needed ONLY for the VEED provider — run: npx @veedstudio/openedit-cli login',
    false,
  );

  // --- report ---
  console.log('\nVEED local editor readiness\n' + '='.repeat(40));
  for (const c of checks) {
    const mark = c.ok ? 'OK  ' : c.blocking ? 'MISS' : 'opt ';
    console.log(`[${mark}] ${c.label.padEnd(22)} ${c.detail}`);
  }
  const blockingMisses = checks.filter((c) => !c.ok && c.blocking);
  console.log('='.repeat(40));
  if (blockingMisses.length === 0) {
    console.log('All blocking checks pass. Items marked "opt" are needed only by the step or provider named beside them.');
  } else {
    console.log(`${blockingMisses.length} blocking item(s) to resolve: ${blockingMisses.map((c) => c.label).join(', ')}`);
  }
  return blockingMisses.length === 0 ? 0 : 1;
}
