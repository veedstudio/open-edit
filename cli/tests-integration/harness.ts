// Installs the packed tarball and spawns the INSTALLED cli/dist. Paths and floors come from the
// package's own modules, never re-derived: drift must not silently SKIP suites.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineBinPath, FFMPEG, FFPROBE } from '../src/config.ts';

export const IT_DIR = process.env.OPENEDIT_IT_DIR ?? '';
export const IT_VERSION = process.env.OPENEDIT_IT_VERSION ?? '1.2.3';
export const BASE_TGZ = join(IT_DIR, `cli-${IT_VERSION}.tgz`);
export const NEXT_TGZ = join(IT_DIR, 'cli-1.3.0.tgz');
if (!IT_DIR) throw new Error('run these suites through `npm run test:integration`, which packs the tarballs they install');

// A registry nothing listens on — no test may consult the real registry for this real package name.
export const DEAD_REGISTRY = 'http://127.0.0.1:9/';

const ENGINE_FLOOR: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).openedit.minEngine;

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

// ---------- host gates ----------

const numericAtLeast = (candidate: string, floor: string): boolean => {
  const parts = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const a = parts(candidate);
  const b = parts(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return x > y;
  }
  return true;
};

/** A runnable engine at or above the published floor. */
export function engineReady(): boolean {
  const bin = engineBinPath();
  if (!existsSync(bin)) return false;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  const version = r.status === 0 ? (r.stdout ?? '').trim().split(/\s+/)[1] ?? '' : '';
  return Boolean(version) && numericAtLeast(version, ENGINE_FLOOR);
}

export function ffmpegReady(): boolean {
  // config's own resolution: the Windows preflight puts ffmpeg in app-data, never on PATH.
  const probe = (cmd: string) => spawnSync(cmd, ['-version'], { encoding: 'utf8', shell: process.platform === 'win32' && !cmd.includes('\\') }).status === 0;
  return probe(FFMPEG) && probe(FFPROBE);
}

// Two gates: only a test that RENDERS needs HOST_READY, and one gate skipped every case that
// never starts an engine.
export const TOOLS_READY = ffmpegReady();
export const TOOLS_SKIP = TOOLS_READY ? undefined : 'ffmpeg/ffprobe not installed — run `openedit install-ffmpeg`, then re-run';
export const HOST_READY = engineReady() && TOOLS_READY;
export const SKIP_REASON = HOST_READY ? undefined : `host not provisioned (engine ready: ${engineReady()}, ffmpeg: ${ffmpegReady()}) — install both, then re-run`;
// A CI runner FAILS loudly either way: its preflight step exists to provision exactly this.
if (!HOST_READY && process.env.CI) {
  throw new Error(`integration host not provisioned in CI: ${SKIP_REASON}`);
}

// A newer renderer existing upstream is a fact about the world, not the flow under test.
export function onlyRendererApproval(stderr: string): boolean {
  const approvals = stderr.split('\n').filter((l) => l.includes('APPROVAL REQUIRED'));
  return approvals.length > 0 && approvals.every((l) => /update renderer/.test(l));
}

/** Bare init for a suite's setup; the caller asserts on the returned run. */
export function initWorkspace(installedPkg: string, workspace: string, env: Record<string, string | undefined> = {}): CliResult {
  return cli(installedPkg, ['init', '--workspace', workspace], { cwd: workspace, env });
}

export function execOk(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
