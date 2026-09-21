// The package path of init: scaffold, promotion, auto-update. Same fixture family as init.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { main, type ExecResult } from '../src/commands/init.ts';
import { emulateNpmAdd } from './exec-stubs.ts';

// init resolves paths with realpathSync.native (Windows 8.3 names expand); compare likewise.
const real = (p: string) => realpathSync.native(p);

interface Fixture {
  root: string;
  consumer: string;
  actionLog: string;
  stateDir: string;
  contentDir: string;
  enginePath: string;
  engineInstallVersion: string | null;
  cliVersion: string;
  /** The `latest` manifest the injected fetch answers with; null = network failure (throw). */
  registry: unknown | null;
  registryStatus: number;
  npmAddFails: boolean;
  /** The stubbed install-ffmpeg exits 0 without laying anything down when false. */
  ffmpegInstallWorks: boolean;
  bins: Record<string, string | null>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'openedit-pkg-init-'));
  const consumer = join(root, 'consumer');
  const contentDir = join(root, 'content');
  await mkdir(consumer);
  const skill = join(contentDir, '.claude', 'skills', 'open-edit');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: open-edit\n---\n');
  await writeFile(join(skill, 'scripts', 'preflight.sh'), '#!/bin/sh\n');
  return {
    root,
    consumer,
    actionLog: join(root, 'actions.log'),
    stateDir: join(root, 'state'),
    contentDir,
    enginePath: join(root, 'engine', 'veed-engine-cli'),
    engineInstallVersion: '1.0.0',
    cliVersion: '',
    registry: null,
    registryStatus: 200,
    npmAddFails: false,
    ffmpegInstallWorks: true,
    bins: { git: 'git', node: process.execPath, npm: 'npm', ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
  };
}

const makeExec = (fx: Fixture) => (cmd: string, args: string[], opts: Record<string, unknown> = {}): ExecResult => {
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  if (basename(cmd).startsWith('veed-engine-cli')) {
    if (!existsSync(cmd)) return { status: 1, stdout: '', stderr: '', error: new Error('ENOENT') };
    return { status: 0, stdout: `veed-engine-cli ${readFileSync(cmd, 'utf8').trim()}`, stderr: '' };
  }
  if (cmd === 'npx' && args.includes('install-ffmpeg')) {
    if (fx.ffmpegInstallWorks) {
      const bin = join(fx.stateDir, 'ffmpeg', 'bin');
      mkdirSync(bin, { recursive: true });
      for (const n of ['ffmpeg.exe', 'ffprobe.exe']) writeFileSync(join(bin, n), '');
    }
    appendFileSync(fx.actionLog, 'ffmpeg-local-install\n');
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'yarn' || cmd === 'pnpm') {
    appendFileSync(fx.actionLog, `${cmd}:${args.join(' ')}\n`);
    return { status: 0, stdout: '', stderr: '' };
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
  if (cmd === 'git') {
    return spawnSync('git', args, { encoding: 'utf8', cwd });
  }
  if (cmd === 'npm') {
    return emulateNpmAdd(fx, args, cwd) ?? { status: 1, stdout: '', stderr: '', error: new Error(`unexpected npm ${args.join(' ')}`) };
  }
  return { status: 1, stdout: '', stderr: '', error: new Error(`unexpected command ${cmd}`) };
};

async function runInit(args: string[], fx: Fixture, platform: { os?: string; arch?: string } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  const errLines: string[] = [];
  const outLines: string[] = [];
  const status = await main(args, {
    os: platform.os ?? 'darwin',
    arch: platform.arch ?? 'arm64',
    env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', VEED_ENGINE_BIN: fx.enginePath, OPENEDIT_STATE_DIR: fx.stateDir },
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async (url: string) => {
      if (String(url).includes('api.github.com')) return { ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) };
      if (fx.registry === null) throw new Error('network down');
      return { ok: fx.registryStatus === 200, status: fx.registryStatus, json: async () => fx.registry };
    },
    err: (line: string) => errLines.push(line),
    out: (line: string) => outLines.push(line),
    contentDir: fx.contentDir,
    cliVersion: fx.cliVersion,
  });
  return { status, stderr: errLines.join('\n'), stdout: outLines.join('\n') };
}

const log = (fx: Fixture) => readFileSync(fx.actionLog, 'utf8').trim().split('\n').filter(Boolean);

// ---------- new session: an empty folder becomes a project ----------

test('bare init in an empty folder npm-ifies it: package.json, exact pin, .gitignore, skill — no clone, no pnpm', async () => {
  const fx = await fixture();
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), real(fx.consumer), 'stdout carries the workspace as the root');
  assert.match(r.stderr, /packaged content/);

  const pkg = JSON.parse(await readFile(join(fx.consumer, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.match(log(fx).join('\n'), /npm-add:@veedstudio\/openedit-cli@latest/, 'a dev checkout resolves latest, exact-pinned by the flag');
  assert.ok(pkg.devDependencies['@veedstudio/openedit-cli'], 'the dep landed in package.json');

  const ignore = await readFile(join(fx.consumer, '.gitignore'), 'utf8');
  for (const line of ['node_modules/', 'runs/', '.open-edit/', '.open-edit-prefs.json']) {
    assert.ok(ignore.split('\n').includes(line), `.gitignore carries ${line}`);
  }
  assert.ok(existsSync(join(fx.consumer, '.git')), 'git init ran');
  assert.equal(await readFile(join(fx.consumer, '.claude/skills/open-edit/SKILL.md'), 'utf8'), '---\nname: open-edit\n---\n');
  assert.ok(!existsSync(join(fx.consumer, '.open-edit')), 'no runtime clone anywhere');
  assert.ok(!log(fx).includes('pnpm-install'), 'pnpm never runs on the package path');
});

test('a published install pins its OWN version, so the project runs exactly what init ran', async () => {
  const fx = await fixture();
  fx.cliVersion = '1.2.3';
  fx.registry = { 'dist-tags': { latest: '1.2.3' }, versions: {} };
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  assert.match(log(fx).join('\n'), /npm-add:@veedstudio\/openedit-cli@1\.2\.3/);
});

test('OPENEDIT_PACKAGE_SOURCE overrides the install spec — the tarball seam CI and tests resolve', async () => {
  const fx = await fixture();
  const errLines: string[] = [];
  const status = await main(['--workspace', fx.consumer], {
    os: 'darwin', arch: 'arm64',
    env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', VEED_ENGINE_BIN: fx.enginePath, OPENEDIT_STATE_DIR: fx.stateDir, OPENEDIT_PACKAGE_SOURCE: '/tmp/openedit-cli.tgz' },
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) }),
    err: (line: string) => errLines.push(line),
    out: () => {},
    contentDir: fx.contentDir,
    cliVersion: '',
  });
  assert.equal(status, 0, errLines.join('\n'));
  assert.match(log(fx).join('\n'), /npm-add:\/tmp\/openedit-cli\.tgz/);
});

test('without git the scaffold skips git init silently and still succeeds', async () => {
  const fx = await fixture();
  fx.bins.git = null;
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(fx.consumer, '.git')));
  assert.doesNotMatch(r.stderr, /APPROVAL REQUIRED — install Git/, 'git is not a prerequisite on the package path');
  assert.ok(existsSync(join(fx.consumer, '.gitignore')), 'the ignore rules still travel with the project');
});

test('--dry reports the scaffold and writes nothing', async () => {
  const fx = await fixture();
  const r = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  for (const line of ['create a minimal private package.json', 'git init', '.gitignore entries', 'exact devDependency', 'open-edit skill']) {
    assert.ok(r.stderr.includes(line), `dry names: ${line}`);
  }
  await assert.rejects(access(join(fx.consumer, 'package.json')));
  await assert.rejects(access(join(fx.consumer, '.gitignore')));
  assert.ok(!existsSync(fx.actionLog), 'no action ran');
});

test('a scaffolded project re-inits idempotently: nothing rewritten, nothing re-added', async () => {
  const fx = await fixture();
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  const pkgBefore = await readFile(join(fx.consumer, 'package.json'), 'utf8');
  const ignoreBefore = await readFile(join(fx.consumer, '.gitignore'), 'utf8');
  await writeFile(join(fx.consumer, '.open-edit-prefs.json'), '{"transcription":{"provider":"veed"}}\n');

  const again = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await readFile(join(fx.consumer, 'package.json'), 'utf8'), pkgBefore);
  assert.equal(await readFile(join(fx.consumer, '.gitignore'), 'utf8'), ignoreBefore);
  assert.equal(await readFile(join(fx.consumer, '.open-edit-prefs.json'), 'utf8'), '{"transcription":{"provider":"veed"}}\n');
  assert.equal(log(fx).filter((l) => l.startsWith('npm-add:')).length, 1, 'the pin is added once, ever');
});

// ---------- promotion off the managed clone ----------

async function plantManagedClone(fx: Fixture, prefs?: string): Promise<string> {
  const clone = join(fx.consumer, '.open-edit', 'runtime');
  await mkdir(join(clone, 'pipeline', 'scripts'), { recursive: true });
  await mkdir(join(clone, 'refs'), { recursive: true });
  await writeFile(join(clone, 'package.json'), JSON.stringify({ name: 'open-edit', private: true }));
  await writeFile(join(clone, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await writeFile(join(clone, 'pipeline', 'scripts', 'preflight.sh'), '#!/bin/bash\n');
  await writeFile(join(clone, 'refs', 'tags.json'), JSON.stringify({ version: 3, refs: [] }));
  if (prefs !== undefined) await writeFile(join(clone, '.open-edit-prefs.json'), prefs);
  return clone;
}

test('a managed clone promotes seamlessly: prefs carried, one line, clone untouched, no prompt', async () => {
  const fx = await fixture();
  const clone = await plantManagedClone(fx, '{"transcription":{"provider":"whisperx","model":"medium"}}\n');

  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /promoted to packaged content/);
  assert.doesNotMatch(r.stderr, /APPROVAL REQUIRED — .*promot/i, 'promotion never asks');
  assert.equal(
    await readFile(join(fx.consumer, '.open-edit-prefs.json'), 'utf8'),
    '{"transcription":{"provider":"whisperx","model":"medium"}}\n',
    'the provider choice is not re-asked',
  );
  assert.ok(existsSync(join(clone, '.open-edit-prefs.json')), 'the clone is left as it was');
  assert.equal(r.stdout.trim(), real(fx.consumer), 'the root switches to the workspace');
});

test('promotion never overwrites workspace prefs that already exist', async () => {
  const fx = await fixture();
  await plantManagedClone(fx, '{"transcription":{"provider":"veed"}}\n');
  await writeFile(join(fx.consumer, '.open-edit-prefs.json'), '{"transcription":{"provider":"custom"}}\n');
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  assert.equal(await readFile(join(fx.consumer, '.open-edit-prefs.json'), 'utf8'), '{"transcription":{"provider":"custom"}}\n');
});

test('--repository keeps the clone path: a pinned contributor setup does not promote', async () => {
  const fx = await fixture();
  await plantManagedClone(fx);
  const r = await runInit(['--dry', '--workspace', fx.consumer, '--repository', 'https://example.com/fork.git'], fx);
  assert.doesNotMatch(r.stderr, /promoted to packaged content/);
  assert.doesNotMatch(r.stderr, /packaged content \(self-contained/);
});

// ---------- auto-update ----------

// What the project RUNS, which is what the update step grades — not the copy doing the asking.
function plantInstalled(fx: Fixture, version: string): void {
  const dir = join(fx.consumer, 'node_modules', '@veedstudio', 'openedit-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(version ? { name: '@veedstudio/openedit-cli', version } : { name: '@veedstudio/openedit-cli' }));
}

async function updatableFixture(): Promise<Fixture> {
  const fx = await fixture();
  fx.cliVersion = '1.2.3';
  await writeFile(join(fx.consumer, 'package.json'), JSON.stringify({
    name: 'proj', private: true, devDependencies: { '@veedstudio/openedit-cli': '1.2.3' },
  }));
  plantInstalled(fx, '1.2.3');
  return fx;
}
// The `latest` manifest, which is what init asks for — never the full packument.
const manifest = (latest: string, minEngine?: string) => ({
  name: '@veedstudio/openedit-cli',
  version: latest,
  ...(minEngine === undefined ? {} : { openedit: { minEngine } }),
});

test('a patch/minor whose engine floor is met applies silently in bare init and reports updated x → y', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0', '0.9.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
  assert.match(log(fx).join('\n'), /npm-add:@veedstudio\/openedit-cli@1\.3\.0/);
  const pkg = JSON.parse(await readFile(join(fx.consumer, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@veedstudio/openedit-cli'], '1.3.0', 'the pin moved — a visible lockfile diff');
});

test('a major release reports and waits; --auto-approve applies it', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('2.0.0', '0.9.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — update @veedstudio\/openedit-cli from 1\.2\.3 to 2\.0\.0 — a major release/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')), 'nothing installs without the approval');

  const approved = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 2\.0\.0/);
});

test('a minor that raises the engine floor past the installed engine is treated like a major', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0', '99.0.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — update .* needs engine 99\.0\.0/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')));
});

test('a release that declares no engine floor is treated like a major, not trusted', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /does not declare its engine floor/);
});

test('no update motion: current version, registry BEHIND the install, or a prerelease latest', async () => {
  for (const latest of ['1.2.3', '1.0.0', '1.3.0-rc.1']) {
    const fx = await updatableFixture();
    fx.registry = manifest(latest, '0.9.0');
    const r = await runInit(['--workspace', fx.consumer], fx);
    assert.equal(r.status, 0, `latest=${latest}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /updated @veedstudio/, `latest=${latest}`);
    assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')), `latest=${latest}: no install`);
  }
});

test('every lookup failure is silent and the session starts ready: offline, 4xx/5xx, malformed', async () => {
  const cases: Array<(fx: Fixture) => void> = [
    (fx) => { fx.registry = null; },                                   // connection refused / hung socket (throw)
    (fx) => { fx.registry = {}; fx.registryStatus = 404; },            // not found
    (fx) => { fx.registry = {}; fx.registryStatus = 429; },            // rate-limited
    (fx) => { fx.registry = {}; fx.registryStatus = 500; },            // registry down
    (fx) => { fx.registry = {}; fx.registryStatus = 401; },            // private mirror wants auth
    (fx) => { fx.registry = { unexpected: true }; },                   // malformed: no version
    (fx) => { fx.registry = { version: '' }; },                        // empty version
  ];
  for (const shape of cases) {
    const fx = await updatableFixture();
    shape(fx);
    const r = await runInit(['--workspace', fx.consumer], fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /ready — OPEN_EDIT_ROOT=/);
    assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')));
  }
});

test('an install that fails after a good lookup is reported, non-fatal, and leaves the pin alone', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0', '0.9.0');
  fx.npmAddFails = true;
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, 'a failed update must not fail the session');
  assert.match(r.stderr, /update to 1\.3\.0 failed — staying on 1\.2\.3/);
  const pkg = JSON.parse(await readFile(join(fx.consumer, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@veedstudio/openedit-cli'], '1.2.3', 'pin unchanged');
  assert.ok(!existsSync(join(fx.consumer, 'package-lock.json')), 'lockfile unchanged');
});

test('an unpublished version (dev checkout, 0.0.0-* stamp) never checks the registry', async () => {
  for (const version of ['', '0.0.0-e2e.12345', '0.0.0-dev']) {
    const fx = await updatableFixture();
    plantInstalled(fx, version);
    let registryHit = false;
    const errLines: string[] = [];
    const status = await main(['--workspace', fx.consumer], {
      os: 'darwin', arch: 'arm64',
      env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', VEED_ENGINE_BIN: fx.enginePath, OPENEDIT_STATE_DIR: fx.stateDir },
      which: (cmd: string) => fx.bins[cmd] ?? null,
      exec: makeExec(fx),
      fetch: async (url: string) => {
        if (!String(url).includes('api.github.com')) registryHit = true;
        return { ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) };
      },
      err: (line: string) => errLines.push(line),
      out: () => {},
      contentDir: fx.contentDir,
      cliVersion: version,
    });
    assert.equal(status, 0, errLines.join('\n'));
    assert.equal(registryHit, false, `version ${JSON.stringify(version)} must not consult the registry`);
  }
});

test('a project without the dep is pinned by the scaffold, not raced by the update step', async () => {
  const fx = await fixture();
  fx.cliVersion = '1.2.3';
  await writeFile(join(fx.consumer, '.open-edit-prefs.json'), '{}');
  await writeFile(join(fx.consumer, 'package.json'), JSON.stringify({ name: 'proj', private: true }));
  fx.registry = manifest('1.2.3', '0.9.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  // The scaffold pins first; with the registry on the same version there is nothing to update.
  assert.deepEqual(log(fx).filter((l) => l.startsWith('npm-add:')), ['npm-add:@veedstudio/openedit-cli@1.2.3']);
  assert.doesNotMatch(r.stderr, /updated @veedstudio/);
});

test('a run that dies at the dep install retries cleanly — the folder it half-wrote is its own', async () => {
  // The skill claims the folder before anything else is written, so the retry sees a workspace it
  // already owns rather than a package.json it must ask permission to have created.
  const fx = await fixture();
  fx.npmAddFails = true;
  const first = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(first.status, 1, first.stderr);
  assert.ok(existsSync(join(fx.consumer, 'package.json')), 'the half-finished run left its package.json behind');

  fx.npmAddFails = false;
  const second = await runInit(['--workspace', fx.consumer], fx);
  assert.doesNotMatch(second.stderr, /already holds other files/, 'the retry does not blame the user for init\'s own files');
  assert.equal(second.status, 0, second.stderr);
  assert.ok(JSON.parse(readFileSync(join(fx.consumer, 'package.json'), 'utf8')).devDependencies['@veedstudio/openedit-cli'], 'the pin landed on the retry');
});

test('a folder the consent gate refuses gets NO SessionStart hooks', async () => {
  // Written before the gate, they left a declined workspace spawning session-start every session.
  const fx = await fixture();
  writeFileSync(join(fx.consumer, 'notes.txt'), 'someone else lives here');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED[^\n]*already holds other files/);
  for (const cfg of [join('.claude', 'settings.json'), join('.codex', 'hooks.json'), join('.gemini', 'settings.json')]) {
    assert.ok(!existsSync(join(fx.consumer, cfg)), `${cfg} must not be written into a folder init refused`);
  }
  assert.ok(!existsSync(join(fx.consumer, 'package.json')), 'and nothing else was written either');

  // Approved, the same folder gets both.
  const ok = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(fx.consumer, '.claude', 'settings.json')), 'the hook lands once the folder is claimed');
});

// ---------- pins, migration, PM absence, approvals, dry truth, refresh ----------
async function plantPinnedClone(fx: Fixture, repository: string): Promise<string> {
  const clone = await plantManagedClone(fx);
  execFileSync('git', ['init', '-q'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Pin Test'], { cwd: clone });
  execFileSync('git', ['config', 'user.email', 'pin@example.com'], { cwd: clone });
  execFileSync('git', ['add', '.'], { cwd: clone });
  execFileSync('git', ['commit', '-q', '-m', 'pin'], { cwd: clone });
  execFileSync('git', ['remote', 'add', 'origin', repository], { cwd: clone });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
  const state = join(clone, '.git', 'open-edit-preflight-state');
  for (const [key, value] of [['schema', '1'], ['repository', repository], ['ref', 'my-branch'], ['installedCommit', commit]]) {
    execFileSync('git', ['config', '--file', state, `preflight.${key}`, value]);
  }
  return clone;
}

test('a clone pinned to a non-default source survives bare init: no promotion, the clone stays the root', async () => {
  const fx = await fixture();
  const clone = await plantPinnedClone(fx, 'https://example.com/fork.git');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.doesNotMatch(r.stderr, /promoted to packaged content/);
  assert.match(r.stderr, /managed clone/, 'the pinned clone is announced as the root');
  assert.ok(!existsSync(join(fx.consumer, '.gitignore')), 'no scaffold ran against the pinned setup');
  if (r.status === 0) assert.equal(r.stdout.trim(), real(clone), 'a ready pinned setup reports the clone as the root');
});

test('session-start lets init resolve the workspace (git toplevel), never bare cwd', async () => {
  const { sessionStart } = await import('../src/commands/session-start.ts');
  const calls: string[][] = [];
  await sessionStart(['claude'], async (argv: string[]) => {
    calls.push(argv);
    return { status: 0, output: 'ready — OPEN_EDIT_ROOT=/x' };
  });
  assert.deepEqual(calls, [[]], 'a hook fired in a repo subdirectory must not scaffold that subdirectory');
});

test('prefs recorded at the old app-data default are carried into the workspace, never overwriting', async () => {
  const fx = await fixture();
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(join(fx.stateDir, '.open-edit-prefs.json'), '{"transcription":{"provider":"whisperx"}}\n');
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  assert.equal(
    readFileSync(join(fx.consumer, '.open-edit-prefs.json'), 'utf8'),
    '{"transcription":{"provider":"whisperx"}}\n',
    'a pre-split provider choice is not re-asked',
  );

  const fx2 = await fixture();
  mkdirSync(fx2.stateDir, { recursive: true });
  writeFileSync(join(fx2.stateDir, '.open-edit-prefs.json'), '{"transcription":{"provider":"whisperx"}}\n');
  writeFileSync(join(fx2.consumer, '.open-edit-prefs.json'), '{"transcription":{"provider":"custom"}}\n');
  assert.equal((await runInit(['--workspace', fx2.consumer], fx2)).status, 0);
  assert.equal(readFileSync(join(fx2.consumer, '.open-edit-prefs.json'), 'utf8'), '{"transcription":{"provider":"custom"}}\n');
});

test('a lockfile whose package manager is absent waits at an approval, never a hard death or a swap', async () => {
  const fx = await fixture();
  mkdirSync(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), '# skill');
  writeFileSync(join(fx.consumer, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(fx.consumer, 'yarn.lock'), '');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — [^\n]*yarn/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')), 'no cross-manager install behind the project\'s back');
});

test('an open-edit source tree without .git is reused for its content, never scaffolded over', async () => {
  // A ZIP download: every marker matches, so it is content, and only runtime UPDATES need git.
  const fx = await fixture();
  await mkdir(join(fx.consumer, 'pipeline', 'scripts'), { recursive: true });
  await mkdir(join(fx.consumer, 'refs'), { recursive: true });
  writeFileSync(join(fx.consumer, 'package.json'), '{"name":"open-edit","private":true}');
  writeFileSync(join(fx.consumer, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(fx.consumer, 'pipeline', 'scripts', 'preflight.sh'), '#!/bin/bash\n');
  writeFileSync(join(fx.consumer, 'refs', 'tags.json'), JSON.stringify({ version: 3, refs: [] }));
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.match(r.stderr, /not a Git work tree — using its content/);
  assert.match(r.stderr, /reusing the local checkout/);
  assert.ok(!existsSync(join(fx.consumer, '.gitignore')), 'the source tree was not scaffolded over');
  assert.equal(JSON.parse(readFileSync(join(fx.consumer, 'package.json'), 'utf8')).name, 'open-edit', 'its package.json is untouched');
});

test('an approved-but-unfulfilled FFmpeg install is not erased by an auto-approved update', async () => {
  const fx = await updatableFixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.ffmpegInstallWorks = false;
  fx.registry = manifest('2.0.0', '0.9.0');
  const r = await runInit(['--auto-approve', '--workspace', fx.consumer], fx, { os: 'win32', arch: 'x64' });
  assert.equal(r.status, 10, `the FFmpeg approval is still pending:\n${r.stderr}`);
  assert.match(r.stderr, /FFmpeg/);
});

test('--dry on an un-scaffolded workspace ends "not ready yet", even with the engine installed', async () => {
  const fx = await fixture();
  mkdirSync(join(fx.root, 'engine'), { recursive: true });
  writeFileSync(fx.enginePath, '1.0.0');
  chmodSync(fx.enginePath, 0o755);
  const r = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not ready yet — run bare preflight/);
  assert.doesNotMatch(r.stderr, /ready — OPEN_EDIT_ROOT=/);
});

test('--dry reports a clean minor as WOULD APPLY when the renderer install is also pending', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0', '0.9.0');
  const r = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WOULD APPLY LOCALLY — update @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
  assert.doesNotMatch(r.stderr, /APPROVAL REQUIRED — update @veedstudio/);
});

test('the skill refresh replaces the directory: files dropped upstream do not linger', async () => {
  const fx = await fixture();
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'stale.md'), 'from an older version');
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  assert.ok(!existsSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'stale.md')), 'refresh replaces, never merges');
  assert.ok(existsSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md')));
});

// ---------- scaffold consent ----------

test('a folder holding unrelated files is not silently npm-ified: init asks and proposes a location', async () => {
  const fx = await fixture();
  writeFileSync(join(fx.consumer, 'video.mp4'), 'not really a video');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — [^\n]*holds other files/);
  assert.match(r.stderr, /--workspace/, 'the report proposes choosing a location');
  assert.ok(!existsSync(join(fx.consumer, 'package.json')), 'nothing scaffolded without consent');
  assert.ok(!existsSync(join(fx.consumer, '.gitignore')));

  const approved = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(approved.status, 0, approved.stderr);
  assert.ok(existsSync(join(fx.consumer, 'package.json')), '--auto-approve is the consent');
  assert.equal(readFileSync(join(fx.consumer, 'video.mp4'), 'utf8'), 'not really a video', 'existing content untouched');
});

test('a foreign npm project is not silently pinned: init asks first', async () => {
  const fx = await fixture();
  writeFileSync(join(fx.consumer, 'package.json'), '{"name":"their-app","private":true}');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED —/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')), 'no pin behind the project\'s back');
});

test('openedit markers are consent: a claimed folder scaffolds silently, whatever else it holds', async () => {
  const fx = await fixture();
  mkdirSync(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), '# skill');
  writeFileSync(join(fx.consumer, 'video.mp4'), 'x');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(fx.consumer, 'package.json')), 'a folder that chose openedit keeps working without re-asking');
});
