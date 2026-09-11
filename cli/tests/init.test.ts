import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { main, type ExecResult } from '../src/commands/init.ts';

// The fixture's engine "binary" is a plain file whose CONTENT is its version; the exec seam answers
// `--version` by reading it, so no platform-specific stub scripts or shebangs are needed. The
// installer is the published CLI (`npx … install-engine`), stubbed in the exec seam: it writes
// fx.engineInstallVersion to fx.enginePath — or nothing when null, the download-failed-softly case.

interface Fixture {
  root: string;
  source: string;
  consumer: string;
  actionLog: string;
  /** The injected OPENEDIT_STATE_DIR — where the stubbed `npx … install-ffmpeg` writes. */
  stateDir: string;
  pnpmVersion: string;
  installedPnpm: string;
  // What `corepack enable pnpm` leaves `pnpm --version` reporting. Not always the floor: the shim
  // resolves from the CWD project, which is the consumer's.
  corepackYields: string;
  enginePath: string;
  /** What the stubbed `npx … install-engine` lays down; null = exits 0 without writing anything. */
  engineInstallVersion: string | null;
  bins: Record<string, string | null>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-preflight-'));
  const source = join(root, 'source');
  const consumer = join(root, 'consumer');
  const actionLog = join(root, 'actions.log');
  await mkdir(join(source, '.claude/skills/open-edit/scripts'), { recursive: true });
  await mkdir(join(source, 'pipeline/scripts'), { recursive: true });
  await mkdir(join(source, 'refs'), { recursive: true });
  await mkdir(consumer);

  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@veedstudio/openedit-cli', packageManager: 'pnpm@10.16.1' }));
  // checkout detection reads the runtime index, so a fixture that means to be one carries it
  await writeFile(join(source, 'refs/tags.json'), JSON.stringify({ version: 3, refs: [] }));
  await writeFile(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await writeFile(join(source, '.gitignore'), '.veed-engine/\nnode_modules/\n');
  await writeFile(join(source, '.claude/skills/open-edit/SKILL.md'), '---\nname: open-edit\ndescription: test\n---\n');
  // checkout detection keys on this file existing; it is the POSIX shim, never executed by the tests
  await writeFile(join(source, 'pipeline/scripts/preflight.sh'), '#!/bin/bash\nexit 0\n');

  execFileSync('git', ['init', '-b', 'feature'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Preflight Test'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'preflight@example.com'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: source });
  execFileSync('git', ['init'], { cwd: consumer });

  return {
    root,
    source,
    consumer,
    actionLog,
    stateDir: join(root, 'state'),
    pnpmVersion: '10.20.0',
    installedPnpm: '10.20.0',
    corepackYields: '10.16.1',
    enginePath: join(root, 'engine', 'veed-engine-cli'),
    engineInstallVersion: '1.0.0',
    bins: {
      git: 'git',
      node: process.execPath,
      pnpm: 'pnpm',
      npm: 'npm',
      ffmpeg: '/fake/ffmpeg',
      ffprobe: '/fake/ffprobe',
    },
  };
}

// What `pnpm --version` prints in a given directory: pnpm >=10 reports a project's pinned
// `packageManager` version, so a one-constant stub cannot express cwd sensitivity. Only an EXPLICIT
// cwd is honoured — this package.json pins one too, so process.cwd() would answer every probe with it.
function pnpmVersionAt(fx: Fixture, explicitCwd: string | null): string {
  if (explicitCwd === null) return fx.pnpmVersion;
  if (Number(fx.pnpmVersion.split('.')[0]) < 10) return fx.pnpmVersion; // pre-self-management
  try {
    const pkg = JSON.parse(readFileSync(join(explicitCwd, 'package.json'), 'utf8')) as { packageManager?: string };
    return /^pnpm@(\d[^+\s]*)/.exec(pkg.packageManager ?? '')?.[1] ?? fx.pnpmVersion;
  } catch {
    return fx.pnpmVersion;
  }
}

// The exec seam: git and node run for real (quietly), pnpm/npm/brew are emulated, and anything
// named like the engine answers --version from its own file content.
const makeExec = (fx: Fixture) => (cmd: string, args: string[], opts: Record<string, unknown> = {}): ExecResult => {
  const explicitCwd = typeof opts.cwd === 'string' ? opts.cwd : null;
  const cwd = explicitCwd ?? process.cwd();
  if (basename(cmd).startsWith('veed-engine-cli')) {
    if (!existsSync(cmd)) return { status: 1, stdout: '', stderr: '', error: new Error('ENOENT') };
    const version = readFileSync(cmd, 'utf8').trim();
    return { status: 0, stdout: version ? `veed-engine-cli ${version}` : '', stderr: '' };
  }
  if (cmd === 'npx' && args.includes('install-engine')) {
    if (fx.engineInstallVersion !== null) {
      mkdirSync(join(fx.root, 'engine'), { recursive: true });
      writeFileSync(fx.enginePath, fx.engineInstallVersion);
      chmodSync(fx.enginePath, 0o755);
    }
    appendFileSync(fx.actionLog, 'renderer-install\n');
    return { status: 0, stdout: '', stderr: '' };
  }
  // Stands in for the real Windows-only downloader: writes the two binaries preflight probes for
  // into the injected state dir, where the real installer's app-data copy goes.
  if (cmd === 'npx' && args.includes('install-ffmpeg')) {
    const bin = join(fx.stateDir, 'ffmpeg', 'bin');
    mkdirSync(bin, { recursive: true });
    for (const n of ['ffmpeg.exe', 'ffprobe.exe']) writeFileSync(join(bin, n), '');
    appendFileSync(fx.actionLog, 'ffmpeg-local-install\n');
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'git' || cmd === process.execPath) {
    return spawnSync(cmd, args, {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, FAKE_ACTION_LOG: fx.actionLog },
    });
  }
  if (cmd === 'pnpm') {
    const sub = args[0];
    if (sub === '--version') return { status: 0, stdout: pnpmVersionAt(fx, explicitCwd), stderr: '' };
    if (sub === 'list') return { status: 0, stdout: '', stderr: '' };
    if (sub === 'install') {
      appendFileSync(fx.actionLog, 'pnpm-install\n');
      mkdirSync(join(cwd, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules/.modules.yaml'), `packageManager: pnpm@${fx.installedPnpm}\n`);
      for (const shim of ['tsx', 'tsx.CMD']) writeFileSync(join(cwd, 'node_modules/.bin', shim), '');
      chmodSync(join(cwd, 'node_modules/.bin/tsx'), 0o755);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  }
  if (cmd === 'corepack') {
    // `corepack enable` exits 0 whatever version its shim will go on to resolve.
    appendFileSync(fx.actionLog, 'corepack-enable\n');
    fx.pnpmVersion = fx.corepackYields;
    fx.installedPnpm = fx.corepackYields;
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'npm') {
    appendFileSync(fx.actionLog, 'npm-global-pnpm\n');
    fx.pnpmVersion = '10.16.1';
    fx.installedPnpm = '10.16.1';
    return { status: 0, stdout: '', stderr: '' };
  }
  return { status: 1, stdout: '', stderr: '', error: new Error(`unexpected command ${cmd}`) };
};

async function runPreflight(
  args: string[],
  fx: Fixture,
  platform: { os?: string; arch?: string } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const errLines: string[] = [];
  const outLines: string[] = [];
  const status = await main(args, {
    os: platform.os ?? 'darwin',
    arch: platform.arch ?? 'arm64',
    env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', VEED_ENGINE_BIN: fx.enginePath, OPENEDIT_STATE_DIR: fx.stateDir },
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) }),
    err: (line: string) => errLines.push(line),
    out: (line: string) => outLines.push(line),
  });
  return { status, stderr: errLines.join('\n'), stdout: outLines.join('\n') };
}

test('preflight.mjs adds the Homebrew prefixes BEHIND the caller PATH on darwin, honouring the override', async () => {
  const fx = await fixture();
  const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
  const status = await main(['--dry', '--workspace', fx.consumer], {
    os: 'darwin',
    arch: 'arm64',
    env,
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) }),
    err: () => {},
    out: () => {},
  });
  assert.equal(status, 0);
  // Behind, not ahead: init spawns `npx @veedstudio/openedit-cli install-engine` and install-ffmpeg
  // through this PATH, and an npm whose global directory differs from the caller's resolves a
  // published copy of the CLI rather than the one the caller is running.
  assert.equal(env.PATH, '/usr/bin:/opt/homebrew/bin:/usr/local/bin');

  const untouched: Record<string, string | undefined> = { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '' };
  await main(['--dry', '--workspace', fx.consumer], {
    os: 'darwin',
    arch: 'arm64',
    env: untouched,
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) }),
    err: () => {},
    out: () => {},
  });
  assert.equal(untouched.PATH, '/usr/bin');
});

test('dry is immutable; bare preflight performs local setup once', async () => {
  const fx = await fixture();
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];

  const dry = await runPreflight(['--dry', ...common], fx);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /WOULD APPLY LOCALLY — full clone/);
  await assert.rejects(access(join(fx.consumer, '.open-edit')));

  const first = await runPreflight(common, fx);
  assert.equal(first.status, 0, first.stderr);
  const runtime = join(await realpath(fx.consumer), '.open-edit/runtime');
  assert.equal(first.stdout.trim(), runtime);
  const expectedCommit = execFileSync('git', ['rev-parse', 'feature'], { cwd: fx.source, encoding: 'utf8' }).trim();
  const state = join(runtime, '.git/open-edit-preflight-state');
  assert.equal(execFileSync('git', ['config', '--file', state, '--get', 'preflight.installedCommit'], { encoding: 'utf8' }).trim(), expectedCommit);
  assert.match(await readFile(join(fx.consumer, '.git/info/exclude'), 'utf8'), /^\.open-edit\/$/m);
  assert.deepEqual((await readFile(fx.actionLog, 'utf8')).trim().split('\n').sort(), ['pnpm-install', 'renderer-install']);

  const second = await runPreflight(['--workspace', fx.consumer], fx);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await readFile(fx.actionLog, 'utf8')).trim().split('\n').length, 2);
});

// The safe-zone check needs `--verify=<rules>` and the WCAG pass the analyzer bundled into the
// engine, so an engine below the floor cannot run them at all. Reporting `ready` and letting the run reach the
// pass is the mid-pipeline failure the floor exists to prevent — and an install
// that silently does not raise the version must not be mistaken for success.
test('an engine below the floor fails preflight even after an approved install', async () => {
  const fx = await fixture();
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];
  assert.equal((await runPreflight(common, fx)).status, 0);

  // An engine that predates the floor...
  writeFileSync(fx.enginePath, '0.7.3');
  // ...and an install that does not raise it (download failed non-fatally, or the
  // published release is still older than the floor).
  fx.engineInstallVersion = null;

  const auto = await runPreflight(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.notEqual(auto.status, 0, `expected failure, got:\n${auto.stderr}`);
  assert.match(auto.stderr, /0\.10\.2/);
  assert.doesNotMatch(auto.stdout, /\.open-edit\/runtime/, 'must not report a ready root');
});

// A FIRST install is subject to the same floor as an update. Nothing downstream
// re-checks it, so an engine laid down below the floor is reported ready and the
// run reaches the WCAG pass before failing — the mid-pipeline failure the floor
// exists to prevent.
test('a FRESH engine install below the floor fails preflight', async () => {
  const fx = await fixture();
  fx.engineInstallVersion = '0.7.3';

  const r = await runPreflight(['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'], fx);
  assert.notEqual(r.status, 0, `expected failure, got:\n${r.stderr}`);
  assert.match(r.stderr, /0\.10\.2/);
  assert.doesNotMatch(r.stdout, /\.open-edit\/runtime/, 'must not report a ready root');
});

// An UNREADABLE version is not "unknown, carry on": nothing downstream can tell
// it apart from a current engine, so passing it on defers the failure into the
// run exactly as a below-floor engine would.
test('an engine whose version cannot be read is treated as below the floor', async () => {
  const fx = await fixture();
  assert.equal((await runPreflight(['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'], fx)).status, 0);
  writeFileSync(fx.enginePath, '');

  const r = await runPreflight(['--workspace', fx.consumer], fx);
  assert.notEqual(r.status, 0, `expected a non-ready exit, got:\n${r.stderr}`);
  assert.match(r.stderr, /0\.10\.2/);
  assert.doesNotMatch(r.stdout, /\.open-edit\/runtime/, 'must not report a ready root');
});

test('clean runtime update requires approval and dirty runtime is only reported', async () => {
  const fx = await fixture();
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];
  assert.equal((await runPreflight(common, fx)).status, 0);
  const runtime = join(await realpath(fx.consumer), '.open-edit/runtime');
  const oldCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtime, encoding: 'utf8' }).trim();

  await writeFile(join(fx.source, 'revision.txt'), 'second\n');
  execFileSync('git', ['add', 'revision.txt'], { cwd: fx.source });
  execFileSync('git', ['commit', '-m', 'second'], { cwd: fx.source });
  const newCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.source, encoding: 'utf8' }).trim();

  const proposed = await runPreflight(['--dry', '--workspace', fx.consumer], fx);
  assert.equal(proposed.status, 10, proposed.stderr);
  assert.match(proposed.stderr, /APPROVAL REQUIRED — fast-forward runtime/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtime, encoding: 'utf8' }).trim(), oldCommit);

  const approved = await runPreflight(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtime, encoding: 'utf8' }).trim(), newCommit);

  await writeFile(join(runtime, 'local.txt'), 'local\n');
  await writeFile(join(fx.source, 'third.txt'), 'third\n');
  execFileSync('git', ['add', 'third.txt'], { cwd: fx.source });
  execFileSync('git', ['commit', '-m', 'third'], { cwd: fx.source });
  const dirty = await runPreflight(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.match(dirty.stderr, /has local changes; leaving it untouched/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtime, encoding: 'utf8' }).trim(), newCommit);
});

test('pnpm newer than the floor satisfies preflight without reinstalling', async () => {
  const fx = await fixture();
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];

  assert.equal((await runPreflight(common, fx)).status, 0);
  const second = await runPreflight(['--workspace', fx.consumer], fx);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /repository dependencies — ready/);
  assert.equal((await readFile(fx.actionLog, 'utf8')).match(/pnpm-install/g)?.length, 1);
});

test('global dependencies are reported but never installed without auto-approve', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '9.0.0';
  fx.installedPnpm = '10.16.1';
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];

  const bare = await runPreflight(common, fx);
  assert.equal(bare.status, 10, bare.stderr);
  assert.match(bare.stderr, /APPROVAL REQUIRED — install pnpm 10\.16\.1 or newer globally/);
  assert.doesNotMatch(await readFile(fx.actionLog, 'utf8').catch(() => ''), /npm-global-pnpm/);

  const approved = await runPreflight(['--auto-approve', ...common], fx);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(await readFile(fx.actionLog, 'utf8'), /npm-global-pnpm/);
});

test('managed runtime rejects conflicting developer overrides', async () => {
  const fx = await fixture();
  assert.equal((await runPreflight(['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'], fx)).status, 0);
  const conflict = await runPreflight(['--dry', '--workspace', fx.consumer, '--repository', join(fx.root, 'other')], fx);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicts with the managed runtime/);
});

// Windows global-dep installs are report-only: winget needs an interactive first run and its PATH
// edits never reach an already-running process, so --auto-approve must NOT claim to have installed.
// Git has no workspace-local route, so it is the honest subject for "stays manual" now that FFmpeg
// has one.
test('on Windows a missing dependency reports a winget hint and stays pending under --auto-approve', async () => {
  const fx = await fixture();
  fx.bins.git = null;
  fx.bins.winget = 'winget';
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];

  const auto = await runPreflight(['--auto-approve', ...common], fx, { os: 'win32', arch: 'x64' });
  assert.equal(auto.status, 10, auto.stderr);
  assert.ok(auto.stderr.includes('APPROVAL REQUIRED — install Git globally: winget install --id Git.Git'), auto.stderr);
  assert.match(auto.stderr, /Windows installs are manual in v1/);
  assert.doesNotMatch(auto.stderr, /brew install/);
});

test('a machine without winget is pointed at the direct download sources', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const r = await runPreflight(['--dry', '--workspace', fx.consumer], fx, { os: 'win32', arch: 'x64' });
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /no winget on this machine — install from git-scm\.com, nodejs\.org, and gyan\.dev/);
});

test('an unsupported platform dies naming the supported ones', async () => {
  const fx = await fixture();
  const r = await runPreflight(['--dry', '--workspace', fx.consumer], fx, { os: 'linux', arch: 'x64' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rendering requires macOS arm64 or Windows x64/);
});

// The next tests spawn the REAL init against the REAL host, which init supports on macOS and
// Windows only — on any other platform it refuses before reaching the behavior under test.
const HOST_UNSUPPORTED = process.platform !== 'darwin' && process.platform !== 'win32'
  && `init refuses ${process.platform} hosts, so the real-host spawn cannot reach the asserted behavior`;
// Resolved to an absolute specifier so the spawn works from ANY cwd — 'tsx' bare would resolve
// from the child's cwd, which need not hold a node_modules (CI installs only in this package).
const TSX = import.meta.resolve('tsx');

// One subprocess run proves the CLI wiring (arg parsing, exit-code mapping, stdout contract) on the
// real host, with no seams. 10 is acceptable: it only means something on this machine needs approval.
test('the CLI entrypoint runs against this checkout', { skip: HOST_UNSUPPORTED }, async () => {
  const repo = resolve(import.meta.dirname, '..', '..');
  const cliPath = resolve(import.meta.dirname, '../src/cli.ts');
  const r = spawnSync(process.execPath, ['--import', TSX, cliPath, 'init', '--dry', '--workspace', repo], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 10, `init exited ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /reusing the local checkout/);
  if (r.status === 0) {
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[lines.length - 1], repo);
  }
});

// A prerelease used to make Number('0-beta') NaN, which reported a NEWER pnpm as missing and then
// proposed installing the floor over it — a silent downgrade.
test('a prerelease pnpm above the floor is accepted, not downgraded', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '10.17.0-beta.1';
  fx.installedPnpm = '10.17.0-beta.1';
  const r = await runPreflight(['--auto-approve', '--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /install pnpm/);
  const log = await readFile(fx.actionLog, 'utf8').catch(() => '');
  assert.doesNotMatch(log, /npm-global-pnpm/);
  assert.doesNotMatch(log, /corepack-enable/);
});

// Nothing at runtime reconciles MIN_PNPM with the repository's package.json — init runs in a
// consumer's project, not this repo — so the drift is caught here instead.
test('the pnpm floor matches package.json packageManager', async () => {
  const pkg = JSON.parse(await readFile(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { packageManager?: string };
  const pinned = /^pnpm@(\d[^+\s]*)/.exec(pkg.packageManager ?? '')?.[1];
  assert.ok(pinned, 'package.json must pin packageManager to a pnpm version');
  const source = await readFile(resolve(import.meta.dirname, '../src/commands/init.ts'), 'utf8');
  const floor = /^const MIN_PNPM = '([^']+)'/m.exec(source)?.[1];
  assert.equal(floor, pinned, 'preflight MIN_PNPM must match package.json packageManager');
});

// corepack ships inside Node and installs exactly what packageManager pins, so it is preferred over
// owning a global package; npm remains the fallback for a Node built without it.
test('corepack is preferred over a global npm install when it is available', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '9.0.0';
  fx.bins.corepack = 'corepack';
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];

  const bare = await runPreflight(['--dry', ...common], fx);
  assert.match(bare.stderr, /install pnpm .* or newer globally: corepack enable pnpm/);

  const approved = await runPreflight(['--auto-approve', ...common], fx);
  assert.equal(approved.status, 0, approved.stderr);
  const log = await readFile(fx.actionLog, 'utf8');
  assert.match(log, /corepack-enable/);
  assert.doesNotMatch(log, /npm-global-pnpm/);
});

// corepack enable exits 0 even when the pnpm its shim resolves is below the floor — the CWD project
// decides that, and preflight runs in the consumer's. Skipping the npm fallback on that exit code
// alone left the run to die a step later with nothing else to try.
test('corepack that resolves a pnpm below the floor still falls back to npm', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '9.0.0';
  fx.corepackYields = '9.0.0';
  fx.bins.corepack = 'corepack';
  const r = await runPreflight(['--auto-approve', '--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'], fx);
  assert.equal(r.status, 0, r.stderr);
  const log = await readFile(fx.actionLog, 'utf8');
  assert.match(log, /corepack-enable/);
  assert.match(log, /npm-global-pnpm/);
});

// The installer ships in the CLI itself, so a COLD workspace gets FFmpeg on the first run — no
// clone has to exist first, and nothing is written into the workspace.
test('on Windows a cold workspace installs FFmpeg locally on the FIRST run, without elevation', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const common = ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];

  const dry = await runPreflight(['--dry', ...common], fx, { os: 'win32', arch: 'x64' });
  assert.equal(dry.status, 10, dry.stderr);
  assert.ok(dry.stderr.includes('needs no admin rights: npx @veedstudio/openedit-cli install-ffmpeg'), dry.stderr);
  // FFmpeg alone is outstanding and it has a local route, so nothing here is actually manual.
  assert.ok(!dry.stderr.includes('Windows installs are manual in v1'), dry.stderr);

  const auto = await runPreflight(['--auto-approve', ...common], fx, { os: 'win32', arch: 'x64' });
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(await readFile(fx.actionLog, 'utf8'), /ffmpeg-local-install/);
  assert.ok(existsSync(join(fx.stateDir, 'ffmpeg/bin/ffmpeg.exe')));
});

// WORKSPACE resolution: init reuses the workspace only when the workspace IS an Open Edit checkout,
// otherwise it clones veedstudio/open-edit@main into <workspace>/.open-edit/runtime and every later
// step runs there. Pointing it at the wrong directory therefore runs the whole job against different
// code, and nothing said so. These two spawn the real CLI so the host git answers "where was this run from".
const repoCheckout = resolve(import.meta.dirname, '..', '..');
const cliEntry = resolve(import.meta.dirname, '../src/cli.ts');
const spawnInit = (args: string[], cwd: string) =>
  spawnSync(process.execPath, ['--import', TSX, cliEntry, 'init', ...args], {
    encoding: 'utf8',
    cwd,
    // a missing engine skips the freshness check — the host's install vs the live release API must not decide these tests
    env: { ...process.env, VEED_ENGINE_BIN: join(tmpdir(), 'open-edit-absent', 'veed-engine-cli') },
  });

test('init says which runtime it will use, and warns when the invoking checkout is bypassed', { skip: HOST_UNSUPPORTED }, async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'open-edit-elsewhere-'));

  const bypassed = spawnInit(['--dry', '--workspace', elsewhere], repoCheckout);
  assert.ok(bypassed.status === 0 || bypassed.status === 10, `init exited ${bypassed.status}: ${bypassed.stderr}`);
  assert.match(bypassed.stderr, /this command ran from the checkout/i,
    'no warning that the checkout this ran from is being bypassed');
  assert.ok(bypassed.stderr.includes(repoCheckout), 'the warning does not name the checkout that would be skipped');
  assert.match(bypassed.stderr, /managed clone/i, 'did not say a managed clone would be used');

  const reused = spawnInit(['--dry', '--workspace', repoCheckout], repoCheckout);
  // 10 is "something needs your approval", which a --dry run reports whenever a newer renderer
  // release exists upstream — a fact about the world, not about this checkout.
  assert.ok(reused.status === 0 || reused.status === 10, `init exited ${reused.status}: ${reused.stderr}`);
  assert.match(reused.stderr, /reusing the local checkout/i, 'did not report reusing the local checkout');
  assert.doesNotMatch(reused.stderr, /this command ran from the checkout/i, 'warned even though the checkout was used');
});

// A --dry run with nothing awaiting approval used to end on "local setup is incomplete because an
// approved prerequisite is missing" — three agents read that as "a human must approve something" and
// treated the run as blocked. Nothing is pending approval on that branch; the outstanding work is the
// WOULD APPLY LOCALLY list, which bare init performs itself.
test('an incomplete-but-unblocked dry run says to run bare init, not to seek approval', { skip: HOST_UNSUPPORTED }, async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'open-edit-incomplete-'));
  execFileSync('git', ['init', '-q', fixtureDir]);
  await mkdir(join(fixtureDir, 'pipeline/scripts'), { recursive: true });
  await mkdir(join(fixtureDir, 'refs'), { recursive: true });
  await writeFile(join(fixtureDir, 'pipeline/scripts/preflight.sh'), '#!/bin/bash\n');
  await writeFile(join(fixtureDir, 'refs/tags.json'), JSON.stringify({ version: 3, refs: [] }) + '\n');
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ name: '@veedstudio/openedit-cli' }) + '\n');
  await writeFile(join(fixtureDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

  const dry = spawnInit(['--dry', '--workspace', fixtureDir], repoCheckout);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /reusing the local checkout/, 'fixture was not recognised as a checkout');
  assert.doesNotMatch(dry.stderr, /APPROVAL REQUIRED/, 'precondition: nothing should need approval here');
  assert.doesNotMatch(dry.stderr, /approved prerequisite is missing/,
    'claims approval is pending when nothing is');
  assert.match(dry.stderr, /run bare preflight/, 'does not name the remedy');
});

// WOULD APPLY LOCALLY is a promise bare init keeps; only GLOBAL installs wait for approval. These
// assert the action — action log, filesystem, exit code — never the printed prose, which was correct
// while nothing happened.

const winWorkspace = (fx: Fixture) => ['--workspace', fx.consumer, '--repository', fx.source, '--ref', 'feature'];
const WIN = { os: 'win32', arch: 'x64' };

test('bare init performs the local FFmpeg install it advertised under --dry', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const common = winWorkspace(fx);

  const dry = await runPreflight(['--dry', ...common], fx, WIN);
  assert.ok(dry.stderr.includes('WOULD APPLY LOCALLY — npx @veedstudio/openedit-cli install-ffmpeg'), dry.stderr);

  // The mode a user actually runs; earlier coverage jumped from --dry straight to --auto-approve.
  const bare = await runPreflight(common, fx, WIN);
  assert.match(await readFile(fx.actionLog, 'utf8'), /ffmpeg-local-install/,
    'bare init advertised the local FFmpeg install and then did not run it');
  assert.ok(existsSync(join(fx.stateDir, 'ffmpeg/bin/ffmpeg.exe')), 'no FFmpeg on disk after a bare init');
  assert.equal(bare.status, 0,
    'exited 10 asking for approval although the only outstanding item was satisfied locally');
});

// Class-level: any local action added later is covered without being named here.
test('after a bare init, a fresh dry run has no local work left to advertise', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const common = winWorkspace(fx);

  const bare = await runPreflight(common, fx, WIN);
  assert.equal(bare.status, 0, bare.stderr);

  const after = await runPreflight(['--dry', ...common], fx, WIN);
  const outstanding = (after.stderr.match(/WOULD APPLY LOCALLY[^\r\n]*/g) ?? [])
    // Advisory and re-printed unconditionally, so it says nothing about work remaining; making it
    // conditional needs a "would this change anything" query installProjectHooks does not expose.
    .filter((line) => !line.includes('SessionStart hooks'));
  assert.deepEqual(outstanding, [], 'bare init left work it had advertised as local');
});

// The floor belongs to the pnpm that performs the install, not the binary on PATH.
test('a global pnpm below the floor that self-switches to the pin is not asked to upgrade', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '10.6.2'; // below MIN_PNPM, and what a directory with no pin reports
  const dry = await runPreflight(['--dry', ...winWorkspace(fx)], fx, WIN);
  assert.doesNotMatch(dry.stderr, /APPROVAL REQUIRED — install pnpm/,
    'demanded a global upgrade although this pnpm becomes the pinned version where the install runs');
});

// The inverse, so the fix cannot decay into never checking: pre-v10 pnpm cannot reach the pin.
test('a pnpm too old to self-manage versions is still refused', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '8.15.0';
  const dry = await runPreflight(['--dry', ...winWorkspace(fx)], fx, WIN);
  assert.match(dry.stderr, /APPROVAL REQUIRED — install pnpm/,
    'accepted a pnpm that cannot reach the pinned version by any route');
});
