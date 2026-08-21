// Readiness check for both the render flow and the VEED-native transcription path.
// Reports what is present vs what is still missing for a run. Read-only, no network.
//   Run:  node --import tsx veed/readiness.ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { FFMPEG, VEED_ENGINE_BIN } from '../config.ts';
import { VEED_API_BASE } from './api.ts';
import { tokenStorePath } from './cli-token.ts';

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
  engine ? engine.split('\n')[0] : `not found at "${VEED_ENGINE_BIN}" (run: node pipeline/scripts/install-veed-engine.mjs; only needed for render, not transcription)`,
  false,
);

// --- VEED-native transcription path ---
add('VEED API base', true, VEED_API_BASE, false);

// Fabric generation rides the same login and the same REST edge as transcription — surface it so a user
// who wonders "can this thing make me a video?" gets an answer without reading the source. This file makes
// no network calls, so this reports the CONFIGURED url only; reachability is proven by the first real run.
add('Fabric generation endpoint', true, `${VEED_API_BASE} (configured; not contacted)`, false);

const tokenEnv = (process.env.VEED_ACCESS_TOKEN ?? '').trim() !== '';
// The openedit CLI owns the token store; asked offline, so a cold npx cache reads as
// "not logged in" rather than pulling the network into a no-network file. Running the
// login command below both caches the CLI and logs in.
const tokenPath = tokenEnv ? null : await tokenStorePath();
const tokenCached = tokenPath !== null && existsSync(tokenPath);
// Optional, not blocking: only the VEED provider reads this token.
add(
  'VEED login token',
  tokenEnv || tokenCached,
  tokenEnv ? 'VEED_ACCESS_TOKEN set' : tokenCached ? `cached at ${tokenPath}` : 'not logged in yet; needed ONLY for the VEED provider — run: npx @veedstudio/openedit-cli login',
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
