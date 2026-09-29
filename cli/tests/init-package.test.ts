// The package path of init: scaffold and auto-update. Same fixture family as init.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: open-edit\n---\n');
  return {
    root,
    consumer,
    actionLog: join(root, 'actions.log'),
    stateDir: join(root, 'state'),
    contentDir,
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
    env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', OPENEDIT_STATE_DIR: fx.stateDir },
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => {
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

// No action at all leaves no log behind.
const log = (fx: Fixture) => (existsSync(fx.actionLog) ? readFileSync(fx.actionLog, 'utf8').trim().split('\n').filter(Boolean) : []);

// ---------- new session: an empty folder becomes a project ----------

test('bare init in an empty folder npm-ifies it: package.json, exact pin, .gitignore, skill — no pnpm', async () => {
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
  for (const line of ['node_modules/', 'runs/', '.open-edit-prefs.json']) {
    assert.ok(ignore.split('\n').includes(line), `.gitignore carries ${line}`);
  }
  assert.ok(existsSync(join(fx.consumer, '.git')), 'git init ran');
  assert.equal(await readFile(join(fx.consumer, '.claude/skills/open-edit/SKILL.md'), 'utf8'), '---\nname: open-edit\n---\n');
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
    env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', OPENEDIT_STATE_DIR: fx.stateDir, OPENEDIT_PACKAGE_SOURCE: '/tmp/openedit-cli.tgz' },
    which: (cmd: string) => fx.bins[cmd] ?? null,
    exec: makeExec(fx),
    fetch: async () => { throw new Error('offline'); },
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
const manifest = (latest: string) => ({
  name: '@veedstudio/openedit-cli',
  version: latest,
});

test('a patch/minor applies silently in bare init and reports updated x → y', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
  assert.match(log(fx).join('\n'), /npm-add:@veedstudio\/openedit-cli@1\.3\.0/);
  const pkg = JSON.parse(await readFile(join(fx.consumer, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@veedstudio/openedit-cli'], '1.3.0', 'the pin moved — a visible lockfile diff');
});

test('an applied update leaves the workspace on the skill of the version it installed', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0');
  // What the package manager unpacked: the new version's own skill beside its package.json.
  const shipped = join(fx.consumer, 'node_modules', '@veedstudio', 'openedit-cli', '.claude', 'skills', 'open-edit');
  mkdirSync(shipped, { recursive: true });
  writeFileSync(join(shipped, 'SKILL.md'), 'skill of 1.3.0\n');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
  assert.equal(await readFile(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), 'utf8'), 'skill of 1.3.0\n');
});

// The session note drops every line of a run that exits 0 unless it reads as unfinished, so a
// refresh that failed after an update would leave the agent on a skill older than its CLI, told
// to proceed.
test('an update whose skill could not be refreshed does not read as ready to the session', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skill refresh incomplete — no skill at \S+node_modules/);
  const { composeContext } = await import('../src/commands/session-start.ts');
  assert.doesNotMatch(composeContext(r.status, `${r.stderr}\n${r.stdout}`), /proceed silently/);
});

test('a major release reports and waits; --auto-approve applies it', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('2.0.0');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — update @veedstudio\/openedit-cli from 1\.2\.3 to 2\.0\.0 — a major release/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')), 'nothing installs without the approval');

  const approved = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 2\.0\.0/);
});

test('no update motion: current version, registry BEHIND the install, or a prerelease latest', async () => {
  for (const latest of ['1.2.3', '1.0.0', '1.3.0-rc.1']) {
    const fx = await updatableFixture();
    fx.registry = manifest(latest);
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
  fx.registry = manifest('1.3.0');
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
      env: { PATH: '/usr/bin', OPEN_EDIT_HOMEBREW_PATH_PREFIX: '', OPENEDIT_STATE_DIR: fx.stateDir },
      which: (cmd: string) => fx.bins[cmd] ?? null,
      exec: makeExec(fx),
      fetch: async () => {
        registryHit = true;
        return { ok: true, json: async () => manifest('9.9.9') };
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
  fx.registry = manifest('1.2.3');
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

// ---------- migration, PM absence, approvals, dry truth, refresh ----------
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

  // --auto-approve never runs that install, so sending the agent back to it after a yes was a loop.
  const auto = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(auto.status, 10, auto.stderr);
  assert.match(auto.stderr.trim().split('\n').at(-1) ?? '', /the user runs the install commands init cannot run here, then re-runs init$/);
  assert.doesNotMatch(auto.stderr, /run with --auto-approve/);
});

const plantSourceTree = async (dir: string, name: string) => {
  await mkdir(join(dir, 'cli', 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, 'cli', 'src', 'cli.ts'), '');
};

test('an open-edit source tree without .git is reused in place, never scaffolded over', async () => {
  // A ZIP download: every marker matches, so it is a checkout even with no repository around it.
  const fx = await fixture();
  await plantSourceTree(fx.consumer, '@veedstudio/openedit-cli');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.match(r.stderr, /reusing the local checkout/);
  assert.ok(!existsSync(join(fx.consumer, '.gitignore')), 'the source tree was not scaffolded over');
  assert.equal(JSON.parse(readFileSync(join(fx.consumer, 'package.json'), 'utf8')).name, '@veedstudio/openedit-cli', 'its package.json is untouched');
});

// A checkout skips the consent gate and gets pnpm install and hooks without asking, so a user's own
// pnpm project that merely has a cli/src/cli.ts must never pass for one.
test('a lookalike pnpm project is not taken for a checkout: the consent gate still asks', async () => {
  const fx = await fixture();
  await plantSourceTree(fx.consumer, 'their-tool');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.doesNotMatch(r.stderr, /reusing the local checkout/);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — [^\n]*already holds other files/);
  assert.ok(!log(fx).some((l) => l.startsWith('pnpm:')), 'installed into a project nobody offered');
  assert.ok(!existsSync(join(fx.consumer, '.claude', 'settings.json')), 'hooked a project nobody offered');
});

// Linux, because there the FFmpeg approval is one --auto-approve never carries out.
test('an approved-but-unfulfilled FFmpeg install is not erased by an auto-approved update', async () => {
  const fx = await updatableFixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.registry = manifest('2.0.0');
  const r = await runInit(['--auto-approve', '--workspace', fx.consumer], fx, { os: 'linux', arch: 'x64' });
  assert.equal(r.status, 10, `the FFmpeg approval is still pending:\n${r.stderr}`);
  assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 2\.0\.0/);
  assert.match(r.stderr, /APPROVAL REQUIRED — install FFmpeg globally/);
});

test('a local FFmpeg install that exits 0 but leaves nothing usable fails instead of waiting silently', async () => {
  const fx = await fixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  fx.ffmpegInstallWorks = false;
  const r = await runInit(['--workspace', fx.consumer], fx, { os: 'win32', arch: 'x64' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the local FFmpeg install exited cleanly, but no ffmpeg\/ffprobe pair is usable afterwards/);
  assert.match(r.stderr, /ERROR — the local FFmpeg install failed/);
});

test('--dry on an un-scaffolded workspace ends "not ready yet"', async () => {
  const fx = await fixture();
  const r = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not ready yet — run bare init/);
  assert.doesNotMatch(r.stderr, /ready — OPEN_EDIT_ROOT=/);
});

test('--dry reports a clean minor as WOULD APPLY, not as an approval', async () => {
  const fx = await updatableFixture();
  fx.registry = manifest('1.3.0');
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
