// Installs the packed tarball and spawns the INSTALLED cli/dist. Tool paths come from the package's
// own modules, never re-derived: drift must not silently SKIP suites.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG, FFPROBE } from '../src/config.ts';

export const IT_DIR = process.env.OPENEDIT_IT_DIR ?? '';
export const IT_VERSION = process.env.OPENEDIT_IT_VERSION ?? '1.2.3';
export const BASE_TGZ = join(IT_DIR, `cli-${IT_VERSION}.tgz`);
export const NEXT_TGZ = join(IT_DIR, 'cli-1.3.0.tgz');
if (!IT_DIR) throw new Error('run these suites through `npm run test:integration`, which packs the tarballs they install');

// A registry nothing listens on — no test may consult the real registry for this real package name.
export const DEAD_REGISTRY = 'http://127.0.0.1:9/';

// .native expands Windows 8.3 short names (RUNNER~1), which plain realpathSync leaves in place.
export const real = (p: string): string => realpathSync.native(p);

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A global install without touching the machine.
export function installCli(tgz: string, host: string): string {
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, 'package.json'), '{"private":true}');
  const r = process.platform === 'win32'
    ? spawnSync(`npm install --no-audit --no-fund "${tgz}"`, { cwd: host, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['install', '--no-audit', '--no-fund', tgz], { cwd: host, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm install ${tgz} failed:\n${r.stderr}`);
  return join(host, 'node_modules', '@veedstudio', 'openedit-cli');
}

export interface CliResult { status: number; stdout: string; stderr: string }

// Plain node on the dist entry: what the published bin resolves to, with no .cmd shim games.
export function cli(installedPkg: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): CliResult {
  const r = spawnSync(process.execPath, [join(installedPkg, 'cli', 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, OPENEDIT_REGISTRY: DEAD_REGISTRY, ...opts.env },
    timeout: 300_000,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- host gate ----------

export function ffmpegReady(): boolean {
  // config's own resolution: the Windows preflight puts ffmpeg in app-data, never on PATH.
  const probe = (cmd: string) => spawnSync(cmd, ['-version'], { encoding: 'utf8', shell: process.platform === 'win32' && !cmd.includes('\\') }).status === 0;
  return probe(FFMPEG) && probe(FFPROBE);
}

export const TOOLS_READY = ffmpegReady();
export const TOOLS_SKIP = TOOLS_READY ? undefined : 'ffmpeg/ffprobe not installed — run `openedit install-ffmpeg`, then re-run';
// A CI runner FAILS loudly instead: its preflight step exists to provision exactly this.
if (!TOOLS_READY && process.env.CI) {
  throw new Error(`integration host not provisioned in CI: ${TOOLS_SKIP}`);
}

/** Bare init for a suite's setup; the caller asserts on the returned run. */
export function initWorkspace(installedPkg: string, workspace: string, env: Record<string, string | undefined> = {}): CliResult {
  return cli(installedPkg, ['init', '--workspace', workspace], { cwd: workspace, env });
}

export function execOk(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
