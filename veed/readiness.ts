// Readiness check for both the render flow and the VEED-native transcription path.
// Reports what is present vs what is still missing for a run. Read-only, no network.
//   Run:  node --import tsx veed/readiness.ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { FFMPEG, VEED_ENGINE_BIN } from '../config.ts';
import { VEED_API_BASE } from './api.ts';
import { DEFAULT_TOKEN_PATH } from './token-store.ts';

type Check = { label: string; ok: boolean; detail: string; blocking: boolean };
const checks: Check[] = [];
function add(label: string, ok: boolean, detail: string, blocking = true): void {
  checks.push({ label, ok, detail, blocking });
}

function tryCmd(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

// --- toolchain (shared by both flows) ---
add('node', true, process.version);

const ff = tryCmd(FFMPEG, ['-version']);
add('ffmpeg', ff !== null, ff ? ff.split('\n')[0] : `not found at "${FFMPEG}" (set VEED_ENGINE_FFMPEG)`);

const engine = tryCmd(VEED_ENGINE_BIN, ['--version']) ?? tryCmd(VEED_ENGINE_BIN, ['version']);
add(
  'veed-engine-cli',
  engine !== null,
  engine ? engine.split('\n')[0] : `not found at "${VEED_ENGINE_BIN}" (run: bash pipeline/scripts/install-veed-engine.sh; only needed for render, not transcription)`,
  false,
);

// --- VEED-native transcription path ---
add('VEED API base', true, VEED_API_BASE, false);

const tokenPath = DEFAULT_TOKEN_PATH;
const tokenEnv = (process.env.VEED_ACCESS_TOKEN ?? '').trim() !== '';
// Optional, not blocking: only the VEED provider reads this token.
add(
  'VEED login token',
  tokenEnv || existsSync(tokenPath),
  tokenEnv ? 'VEED_ACCESS_TOKEN set' : existsSync(tokenPath) ? `cached at ${tokenPath}` : 'not logged in yet; needed ONLY for the VEED provider — run: node --import tsx veed/login.ts',
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
