// VEED access tokens come from the openedit CLI, crossed as a PROCESS boundary on
// purpose: login state and refresh live in exactly one codebase (the published
// @veedstudio/openedit-cli package), and this repo carries no code-level dependency
// on it. The CLI's stderr passes through so its own diagnostics (origin mismatch,
// refresh failure) reach the user unwrapped.
import { spawn } from 'node:child_process';

const CLI_PACKAGE = '@veedstudio/openedit-cli';

// npx caches the package after the first run; a version bump in the CLI reaches
// everyone without a lockfile edit here. `install: false` refuses a cold-cache
// fetch, for callers that promise to stay offline.
function runCli(args: string[], opts: { install: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    // shell on Windows: npx is npx.cmd there, which execFile/spawn cannot exec directly.
    const child = spawn('npx', [opts.install ? '--yes' : '--no-install', CLI_PACKAGE, ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

// The stored login, resolved FRESH each call so a token refresh is always picked up.
// The env token short-circuits WITHOUT spawning: tests and CI stay offline.
export async function resolveVeedToken(): Promise<string | null> {
  const envToken = process.env.VEED_ACCESS_TOKEN?.trim();
  if (envToken) return envToken;
  return runCli(['token'], { install: true });
}

// Where the CLI keeps the token, for status reports. Offline on purpose: a status
// probe must not install anything, so null also means "CLI not cached yet".
export function tokenStorePath(): Promise<string | null> {
  return runCli(['token', '--path'], { install: false });
}
