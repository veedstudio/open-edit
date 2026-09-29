import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { main, type ExecResult } from '../src/commands/init.ts';
import { emulateNpmAdd } from './exec-stubs.ts';

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
  /** The scaffold/update dep-add (`npm install --save-dev …`) exits non-zero when true. */
  npmAddFails: boolean;
  bins: Record<string, string | null>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-preflight-'));
  const source = join(root, 'source');
  const consumer = join(root, 'consumer');
  const actionLog = join(root, 'actions.log');
  await mkdir(join(source, '.claude/skills/open-edit'), { recursive: true });
  await mkdir(join(source, 'cli/src'), { recursive: true });
  await mkdir(consumer);

  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@veedstudio/openedit-cli', packageManager: 'pnpm@10.16.1' }));
  await writeFile(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await writeFile(join(source, '.gitignore'), 'node_modules/\n');
  await writeFile(join(source, '.claude/skills/open-edit/SKILL.md'), '---\nname: open-edit\ndescription: test\n---\n');
  // checkout detection keys on this file existing; it is never executed by the tests
  await writeFile(join(source, 'cli/src/cli.ts'), '');

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
    npmAddFails: false,
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

// The exec seam: git and node run for real (quietly), and pnpm/npm/brew are emulated.
const makeExec = (fx: Fixture) => (cmd: string, args: string[], opts: Record<string, unknown> = {}): ExecResult => {
  const explicitCwd = typeof opts.cwd === 'string' ? opts.cwd : null;
  const cwd = explicitCwd ?? process.cwd();
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
  if (cmd === 'brew') {
    // What a formula puts on PATH once it lands.
    appendFileSync(fx.actionLog, `brew:${args.join(' ')}\n`);
    for (const bin of args[1] === 'ffmpeg' ? ['ffmpeg', 'ffprobe'] : [args[1]]) fx.bins[bin] = `/opt/homebrew/bin/${bin}`;
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'corepack') {
    // `corepack enable` exits 0 whatever version its shim will go on to resolve.
    appendFileSync(fx.actionLog, 'corepack-enable\n');
    fx.pnpmVersion = fx.corepackYields;
    fx.installedPnpm = fx.corepackYields;
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'npm') {
    // The scaffold/update dep-add is emulated by the shared stub; anything else npm does here is
    // the global pnpm fallback.
    const added = emulateNpmAdd(fx, args, cwd);
    if (added) return added;
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
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const errLines: string[] = [];
  const outLines: string[] = [];
  const status = await main(args, {
    os: platform.os ?? 'darwin',
    arch: platform.arch ?? 'arm64',
    env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', OPENEDIT_STATE_DIR: fx.stateDir, ...extraEnv },
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => { throw new Error('offline'); },
    err: (line: string) => errLines.push(line),
    out: (line: string) => outLines.push(line),
  });
  return { status, stderr: errLines.join('\n'), stdout: outLines.join('\n') };
}

test('init adds the Homebrew prefixes BEHIND the caller PATH on darwin, honouring the override', async () => {
  const fx = await fixture();
  const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
  const status = await main(['--dry', '--workspace', fx.consumer], {
    os: 'darwin',
    arch: 'arm64',
    env,
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => { throw new Error('offline'); },
    err: () => {},
    out: () => {},
  });
  assert.equal(status, 0);
  // Behind, not ahead: init spawns `npx @veedstudio/openedit-cli install-ffmpeg` through this PATH, and an npm whose global directory differs from the caller's resolves a
  // published copy of the CLI rather than the one the caller is running.
  assert.equal(env.PATH, '/usr/bin:/opt/homebrew/bin:/usr/local/bin');

  const untouched: Record<string, string | undefined> = { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '' };
  await main(['--dry', '--workspace', fx.consumer], {
    os: 'darwin',
    arch: 'arm64',
    env: untouched,
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => { throw new Error('offline'); },
    err: () => {},
    out: () => {},
  });
  assert.equal(untouched.PATH, '/usr/bin');
});

const lastLine = (stderr: string) => stderr.trim().split('\n').at(-1) ?? '';

// A contributor checkout is the one path that installs dependencies with pnpm, so it carries the
// pnpm handling below.
const inCheckout = (fx: Fixture) => ['--workspace', fx.source];

test('dry is immutable; bare init installs a checkout\'s dependencies once', async () => {
  const fx = await fixture();
  const common = inCheckout(fx);

  const dry = await runPreflight(['--dry', ...common], fx);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /WOULD APPLY LOCALLY — pnpm install --frozen-lockfile/);
  assert.ok(!existsSync(join(fx.source, 'node_modules')), '--dry installed something');

  const first = await runPreflight(common, fx);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), await realpath(fx.source));
  assert.deepEqual((await readFile(fx.actionLog, 'utf8')).trim().split('\n').sort(), ['pnpm-install']);

  const second = await runPreflight(common, fx);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await readFile(fx.actionLog, 'utf8')).trim().split('\n').length, 1);
});

test('a checkout whose package.json does not parse is refused, never scaffolded over', async () => {
  const fx = await fixture();
  writeFileSync(join(fx.source, 'package.json'), '<<<<<<< HEAD\n{ "name": "@veedstudio/openedit-cli" }\n');
  const skill = join(fx.source, '.claude/skills/open-edit/SKILL.md');
  const [skillBefore, ignoreBefore] = [readFileSync(skill, 'utf8'), readFileSync(join(fx.source, '.gitignore'), 'utf8')];
  const r = await runPreflight(inCheckout(fx), fx);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR — \S+package\.json cannot be read as JSON .*cannot tell whether this is an OpenEdit checkout/);
  assert.equal(readFileSync(skill, 'utf8'), skillBefore, 'replaced the checkout\'s tracked skill');
  assert.equal(readFileSync(join(fx.source, '.gitignore'), 'utf8'), ignoreBefore);
});

test('pnpm newer than the floor satisfies preflight without reinstalling', async () => {
  const fx = await fixture();
  const common = inCheckout(fx);

  assert.equal((await runPreflight(common, fx)).status, 0);
  const second = await runPreflight(common, fx);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /repository dependencies — ready/);
  assert.equal((await readFile(fx.actionLog, 'utf8')).match(/pnpm-install/g)?.length, 1);
});

test('global dependencies are reported but never installed without auto-approve', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '9.0.0';
  fx.installedPnpm = '10.16.1';
  const common = inCheckout(fx);

  const bare = await runPreflight(common, fx);
  assert.equal(bare.status, 10, bare.stderr);
  assert.match(bare.stderr, /APPROVAL REQUIRED — install pnpm 10\.16\.1 or newer globally/);
  assert.doesNotMatch(await readFile(fx.actionLog, 'utf8').catch(() => ''), /npm-global-pnpm/);

  const approved = await runPreflight(['--auto-approve', ...common], fx);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(await readFile(fx.actionLog, 'utf8'), /npm-global-pnpm/);
});

// Windows global-dep installs are report-only: winget needs an interactive first run and its PATH
// edits never reach an already-running process, so --auto-approve must NOT claim to have installed.
// Node has no workspace-local route, so it is the honest subject for "stays manual" now that FFmpeg
// has one.
test('on Windows a missing dependency reports a winget hint and stays pending under --auto-approve', async () => {
  const fx = await fixture();
  fx.bins.node = null;
  fx.bins.winget = 'winget';
  const common = inCheckout(fx);

  const auto = await runPreflight(['--auto-approve', ...common], fx, { os: 'win32', arch: 'x64' });
  assert.equal(auto.status, 10, auto.stderr);
  assert.ok(auto.stderr.includes('APPROVAL REQUIRED — install Node globally: winget install --id OpenJS.NodeJS.LTS'), auto.stderr);
  assert.match(auto.stderr, /Windows installs are manual/);
  assert.doesNotMatch(auto.stderr, /brew install/);
  assert.match(lastLine(auto.stderr), /the user runs the install commands init cannot run here, then re-runs init from a NEW terminal/);
});

// The approval a user gives names a command; --auto-approve must run that command or nothing. On
// Linux it names apt, which needs root, so nothing runs — not even a Homebrew that happens to exist.
test('on Linux a missing dependency reports the apt/nodejs command and stays pending under --auto-approve', async () => {
  const fx = await fixture();
  fx.bins.node = null;
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.bins.brew = 'brew';
  const LINUX = { os: 'linux', arch: 'x64' };

  const bare = await runPreflight(inCheckout(fx), fx, LINUX);
  assert.equal(bare.status, 10, bare.stderr);
  assert.ok(bare.stderr.includes('APPROVAL REQUIRED — install FFmpeg globally: sudo apt install ffmpeg'), bare.stderr);
  assert.ok(bare.stderr.includes('APPROVAL REQUIRED — install Node globally: install Node 20.18.1+ from nodejs.org'), bare.stderr);

  const auto = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx, LINUX);
  assert.equal(auto.status, 10, auto.stderr);
  assert.match(auto.stderr, /need root, so init never runs them/);
  assert.doesNotMatch(auto.stderr, /Homebrew/);
  assert.doesNotMatch(await readFile(fx.actionLog, 'utf8').catch(() => ''), /brew:/, 'ran an install nobody approved');
  // The skill acts on the final line; pointing it back at --auto-approve here was a loop.
  assert.match(lastLine(auto.stderr), /the user runs the install commands init cannot run here, then re-runs init$/);
  assert.doesNotMatch(auto.stderr, /run with --auto-approve/);
});

// pnpm is corepack or npm under the user's own Node, not a package-manager install, so the root rule
// that keeps Node and FFmpeg manual on Linux does not reach it.
test('on Linux --auto-approve still installs the pnpm it asked approval for', async () => {
  const fx = await fixture();
  fx.pnpmVersion = '9.0.0';
  fx.installedPnpm = '10.16.1';
  const auto = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx, { os: 'linux', arch: 'x64' });
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(await readFile(fx.actionLog, 'utf8'), /npm-global-pnpm/);
  assert.doesNotMatch(auto.stderr, /need root/);
});

// The inverse: on macOS the approved command is the Homebrew one, and --auto-approve runs exactly it.
test('on macOS --auto-approve runs the Homebrew install it asked approval for', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.bins.brew = 'brew';

  const bare = await runPreflight(inCheckout(fx), fx);
  assert.ok(bare.stderr.includes('APPROVAL REQUIRED — install FFmpeg globally: brew install ffmpeg'), bare.stderr);

  const auto = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx);
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(await readFile(fx.actionLog, 'utf8'), /^brew:install ffmpeg$/m);
});

// The advice a missing FFmpeg prints: every command takes ffprobe from beside OPENEDIT_FFMPEG, so
// init must too, or following the advice leaves the global-install approval pending for good.
test('an FFmpeg named by OPENEDIT_FFMPEG alone, its ffprobe beside it off PATH, satisfies init', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.bins.brew = 'brew';
  fx.bins['/opt/ff/ffmpeg'] = '/opt/ff/ffmpeg';
  fx.bins['/opt/ff/ffprobe'] = '/opt/ff/ffprobe';
  const override = { OPENEDIT_FFMPEG: '/opt/ff/ffmpeg' };

  const linux = await runPreflight(inCheckout(fx), fx, { os: 'linux', arch: 'x64' }, override);
  assert.equal(linux.status, 0, linux.stderr);
  assert.doesNotMatch(linux.stderr, /install FFmpeg globally/);

  const mac = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx, {}, override);
  assert.equal(mac.status, 0, mac.stderr);
  assert.doesNotMatch(await readFile(fx.actionLog, 'utf8'), /brew:install ffmpeg/, 'installed an FFmpeg nothing would run');
});

// config.ts runs the override whatever else exists, so neither a PATH ffprobe nor an app-data copy may
// pass for it, and no global install is proposed that would change nothing.
test('a set OPENEDIT_FFMPEG that is not there is named, never excused or answered with an install', async () => {
  const fx = await fixture();
  fx.bins['/opt/ff/ffmpeg'] = '/opt/ff/ffmpeg';
  const besideMissing = await runPreflight(inCheckout(fx), fx, {}, { OPENEDIT_FFMPEG: '/opt/ff/ffmpeg' });
  assert.equal(besideMissing.status, 1, besideMissing.stderr);
  assert.match(besideMissing.stderr, /ERROR — OPENEDIT_FFMPEG is set, .*no executable file is at \/opt\/ff\/ffprobe — fix or unset it, or set OPENEDIT_FFPROBE to an ffprobe elsewhere$/m);

  const local = join(fx.stateDir, 'ffmpeg', 'bin');
  mkdirSync(local, { recursive: true });
  for (const n of ['ffmpeg', 'ffprobe']) writeFileSync(join(local, n), '');
  const gone = await runPreflight(inCheckout(fx), fx, {}, { OPENEDIT_FFMPEG: '/gone/ffmpeg' });
  assert.equal(gone.status, 1, gone.stderr);
  assert.match(gone.stderr, /no executable file is at \/gone\/ffmpeg or \/gone\/ffprobe/);
  assert.doesNotMatch(gone.stderr, /APPROVAL REQUIRED/);
});

// config.ts takes OPENEDIT_FFPROBE ahead of app-data and PATH whether or not OPENEDIT_FFMPEG is set, so
// init must hold it to the same bar, and name it, not OPENEDIT_FFMPEG, when it is the one missing.
test('a set OPENEDIT_FFPROBE is checked on its own and named when it is not there', async () => {
  const fx = await fixture();
  fx.bins.brew = 'brew';
  const onPath = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx, {}, { OPENEDIT_FFPROBE: '/gone/ffprobe' });
  assert.equal(onPath.status, 1, onPath.stderr);
  assert.match(onPath.stderr, /ERROR — OPENEDIT_FFPROBE is set, so every command runs \/gone\/ffprobe, but no executable file is at \/gone\/ffprobe — fix or unset it$/m);
  assert.doesNotMatch(onPath.stderr, /APPROVAL REQUIRED/);
  assert.doesNotMatch(await readFile(fx.actionLog, 'utf8').catch(() => ''), /brew:install ffmpeg/, 'installed an FFmpeg that cannot help');

  // An app-data pair must not excuse it either.
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const local = join(fx.stateDir, 'ffmpeg', 'bin');
  mkdirSync(local, { recursive: true });
  for (const n of ['ffmpeg.exe', 'ffprobe.exe']) writeFileSync(join(local, n), '');
  const appData = await runPreflight(inCheckout(fx), fx, { os: 'win32', arch: 'x64' }, { OPENEDIT_FFPROBE: '/gone/ffprobe' });
  assert.equal(appData.status, 1, appData.stderr);
  assert.match(appData.stderr, /ERROR — OPENEDIT_FFPROBE is set/);

  fx.bins['/opt/ff/ffmpeg'] = '/opt/ff/ffmpeg';
  const both = await runPreflight(inCheckout(fx), fx, {}, { OPENEDIT_FFMPEG: '/opt/ff/ffmpeg', OPENEDIT_FFPROBE: '/gone/ffprobe' });
  assert.equal(both.status, 1, both.stderr);
  assert.match(both.stderr, /ERROR — OPENEDIT_FFPROBE is set, so every command runs \/gone\/ffprobe/);
  assert.doesNotMatch(both.stderr, /OPENEDIT_FFMPEG is set/, 'blamed a variable whose removal cannot help');
});

// The inverse: a working OPENEDIT_FFPROBE completes a pair whose ffmpeg is the app-data one.
test('an app-data ffmpeg with a working OPENEDIT_FFPROBE satisfies init', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.bins['/opt/ff/ffprobe'] = '/opt/ff/ffprobe';
  const local = join(fx.stateDir, 'ffmpeg', 'bin');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'ffmpeg.exe'), '');
  const r = await runPreflight(inCheckout(fx), fx, { os: 'win32', arch: 'x64' }, { OPENEDIT_FFPROBE: '/opt/ff/ffprobe' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(await readFile(fx.actionLog, 'utf8').catch(() => ''), /ffmpeg-local-install/);
});

test('a machine without winget is pointed at the direct download sources', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const r = await runPreflight(['--dry', '--workspace', fx.consumer], fx, { os: 'win32', arch: 'x64' });
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /no winget on this machine — install from nodejs\.org and gyan\.dev/);
});

// Resolved to an absolute specifier so the spawn works from ANY cwd — 'tsx' bare would resolve
// from the child's cwd, which need not hold a node_modules (CI installs only in this package).
const TSX = import.meta.resolve('tsx');

// One subprocess run proves the CLI wiring (arg parsing, exit-code mapping, stdout contract) on the
// real host, with no seams. 10 is acceptable: it only means something on this machine needs approval.
test('the CLI entrypoint runs against this checkout', async () => {
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
  const r = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx);
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
  const common = inCheckout(fx);

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
  const r = await runPreflight(['--auto-approve', ...inCheckout(fx)], fx);
  assert.equal(r.status, 0, r.stderr);
  const log = await readFile(fx.actionLog, 'utf8');
  assert.match(log, /corepack-enable/);
  assert.match(log, /npm-global-pnpm/);
});

// The installer ships in the CLI itself, so a COLD workspace gets FFmpeg on the first run, and
// nothing is written into the workspace.
test('on Windows a cold workspace installs FFmpeg locally on the FIRST run, without elevation', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const common = inCheckout(fx);

  const dry = await runPreflight(['--dry', ...common], fx, { os: 'win32', arch: 'x64' });
  assert.equal(dry.status, 10, dry.stderr);
  assert.ok(dry.stderr.includes('needs no admin rights: npx @veedstudio/openedit-cli install-ffmpeg'), dry.stderr);
  // FFmpeg alone is outstanding and it has a local route, so nothing here is actually manual.
  assert.ok(!dry.stderr.includes('Windows installs are manual'), dry.stderr);

  const auto = await runPreflight(['--auto-approve', ...common], fx, { os: 'win32', arch: 'x64' });
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(await readFile(fx.actionLog, 'utf8'), /ffmpeg-local-install/);
  assert.ok(existsSync(join(fx.stateDir, 'ffmpeg/bin/ffmpeg.exe')));
});

// WORKSPACE resolution: init reuses the workspace only when the workspace IS an Open Edit checkout,
// otherwise it scaffolds the workspace around the packaged content. Pointing it at the wrong directory
// therefore runs the whole job against different code, and nothing said so. These two spawn the real
// CLI so the host git answers "where was this run from".
const repoCheckout = resolve(import.meta.dirname, '..', '..');
const cliEntry = resolve(import.meta.dirname, '../src/cli.ts');
const spawnInit = (args: string[], cwd: string) =>
  spawnSync(process.execPath, ['--import', TSX, cliEntry, 'init', ...args], { encoding: 'utf8', cwd });

test('init says which runtime it will use, and warns when the invoking checkout is bypassed', async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'open-edit-elsewhere-'));

  const bypassed = spawnInit(['--dry', '--workspace', elsewhere], repoCheckout);
  assert.ok(bypassed.status === 0 || bypassed.status === 10, `init exited ${bypassed.status}: ${bypassed.stderr}`);
  assert.match(bypassed.stderr, /this command ran from the checkout/i,
    'no warning that the checkout this ran from is being bypassed');
  assert.ok(bypassed.stderr.includes(repoCheckout), 'the warning does not name the checkout that would be skipped');
  assert.match(bypassed.stderr, /packaged content/i, 'did not say the packaged content would be used');

  const reused = spawnInit(['--dry', '--workspace', repoCheckout], repoCheckout);
  // 10 is "something needs your approval", which depends on this host's global tools, not on this
  // checkout.
  assert.ok(reused.status === 0 || reused.status === 10, `init exited ${reused.status}: ${reused.stderr}`);
  assert.match(reused.stderr, /reusing the local checkout/i, 'did not report reusing the local checkout');
  assert.doesNotMatch(reused.stderr, /this command ran from the checkout/i, 'warned even though the checkout was used');
});

// A --dry run with nothing awaiting approval used to end on "local setup is incomplete because an
// approved prerequisite is missing" — three agents read that as "a human must approve something" and
// treated the run as blocked. Nothing is pending approval on that branch; the outstanding work is the
// WOULD APPLY LOCALLY list, which bare init performs itself.
test('an incomplete-but-unblocked dry run says to run bare init, not to seek approval', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'open-edit-incomplete-'));
  execFileSync('git', ['init', '-q', fixtureDir]);
  await mkdir(join(fixtureDir, 'cli/src'), { recursive: true });
  await writeFile(join(fixtureDir, 'cli/src/cli.ts'), '');
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ name: '@veedstudio/openedit-cli' }) + '\n');
  await writeFile(join(fixtureDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

  const dry = spawnInit(['--dry', '--workspace', fixtureDir], repoCheckout);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /reusing the local checkout/, 'fixture was not recognised as a checkout');
  assert.doesNotMatch(dry.stderr, /APPROVAL REQUIRED/, 'precondition: nothing should need approval here');
  assert.doesNotMatch(dry.stderr, /approved prerequisite is missing/,
    'claims approval is pending when nothing is');
  assert.match(dry.stderr, /run bare init \(no --dry\)/, 'does not name the remedy');
});

// WOULD APPLY LOCALLY is a promise bare init keeps; only GLOBAL installs wait for approval. These
// assert the action — action log, filesystem, exit code — never the printed prose, which was correct
// while nothing happened.

const winWorkspace = inCheckout;
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
