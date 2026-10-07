// The package path of init: scaffold, update, and removing the hooks earlier versions wrote. Same
// fixture family as init.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, type ExecResult } from '../src/commands/init.ts';
import { findProjectHooks } from '../src/project-hooks.ts';
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
  npmAddFails: boolean;
  /** For each npm call: whether it ran with lifecycle scripts off. */
  npmScriptsOff: boolean[];
  /** What init asked npx to run: the spec, and whether the nested run's update notice was off. */
  npxCalls: Array<{ spec: string; notifierOff: boolean }>;
  /** False: the stubbed npm installs the CLI without the skill a real package carries. */
  shipsSkill: boolean;
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
    npmAddFails: false,
    npxCalls: [],
    npmScriptsOff: [],
    shipsSkill: true,
    ffmpegInstallWorks: true,
    bins: { git: 'git', node: process.execPath, npm: 'npm', ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
  };
}

const makeExec = (fx: Fixture) => (cmd: string, args: string[], opts: Record<string, unknown> = {}): ExecResult => {
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  if (cmd === 'npx' && args.includes('install-ffmpeg')) {
    const env = (opts.env ?? {}) as Record<string, string | undefined>;
    fx.npxCalls.push({ spec: args[args.indexOf('install-ffmpeg') - 1], notifierOff: Boolean(env.NO_UPDATE_NOTIFIER) });
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
    fx.npmScriptsOff.push(args.includes('--ignore-scripts') && args.includes('--workspaces=false'));
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
  assert.deepEqual(fx.npmScriptsOff, [true], 'the pin ran lifecycle scripts');
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

// ---------- update: only the version asked for ----------

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

test('bare init installs nothing new, in any mode', async () => {
  for (const mode of [[], ['--auto-approve'], ['--dry']]) {
    const fx = await updatableFixture();
    const r = await runInit([...mode, '--workspace', fx.consumer], fx);
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.deepEqual(log(fx), [], `${mode}: something was installed`);
  }
});

test('--update <version> installs exactly that version and reports updated x → y', async () => {
  const fx = await updatableFixture();
  const r = await runInit(['--update', '1.3.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
  assert.deepEqual(log(fx), ['npm-add:@veedstudio/openedit-cli@1.3.0']);
  assert.deepEqual(fx.npmScriptsOff, [true], 'the update ran a package\'s lifecycle scripts');
  const pkg = JSON.parse(await readFile(join(fx.consumer, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@veedstudio/openedit-cli'], '1.3.0', 'the pin moved — a visible lockfile diff');
});

// The yes was to the version the notice named, a major included.
test('--update applies a major release without a second approval', async () => {
  const fx = await updatableFixture();
  const r = await runInit(['--update', '2.0.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 2\.0\.0/);
  assert.doesNotMatch(r.stderr, /APPROVAL REQUIRED/);
});

test('an applied update leaves both skill copies on the skill of the version it installed', async () => {
  const fx = await updatableFixture();
  const r = await runInit(['--update', '1.3.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  for (const dir of ['.claude', '.agents']) {
    assert.equal(await readFile(join(fx.consumer, dir, 'skills', 'open-edit', 'SKILL.md'), 'utf8'), 'skill of 1.3.0\n', dir);
  }
});

// Ready over a skill older than the CLI would send the agent on with the wrong instructions.
test('an update whose skill could not be refreshed fails and says how to finish', async () => {
  const fx = await updatableFixture();
  fx.shipsSkill = false;
  const r = await runInit(['--update', '1.3.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /skill refresh incomplete — no skill at \S+node_modules/);
  assert.match(r.stderr, /ERROR — updated to 1\.3\.0, but the skill refresh failed — run bare init in the workspace to finish/);
  assert.doesNotMatch(r.stderr, /ready — OPEN_EDIT_ROOT=/);
});

test('--update to the installed version installs nothing and succeeds', async () => {
  const fx = await updatableFixture();
  const r = await runInit(['--update', '1.2.3', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /@veedstudio\/openedit-cli 1\.2\.3 is already installed/);
  assert.deepEqual(log(fx), []);
});

// Asked for explicitly, an update that cannot happen must say so: silence would read as done.
test('every --update that cannot run fails loudly and installs nothing', async () => {
  const cases: Array<[string, string[], (fx: Fixture) => Promise<void> | void, RegExp]> = [
    ['not a release', ['--update', 'latest'], () => {}, /--update takes the release version an update notice named, such as 1\.4\.0 — got "latest"/],
    ['a prerelease', ['--update', '1.3.0-rc.1'], () => {}, /--update takes the release version/],
    ['a shell-shaped value', ['--update', '1.3.0 && rm -rf ~'], () => {}, /--update takes the release version/],
    ['a downgrade', ['--update', '1.0.0'], () => {}, /1\.0\.0 is older than the installed 1\.2\.3 — init --update never downgrades/],
    ['an unpublished install', ['--update', '1.3.0'], (fx) => plantInstalled(fx, '0.0.0-e2e.12345'), /unpublished build \(0\.0\.0-e2e\.12345\)/],
    ['a missing package manager', ['--update', '1.3.0'], (fx) => { writeFileSync(join(fx.consumer, 'yarn.lock'), ''); fx.bins.yarn = null; },
      /the update to 1\.3\.0 needs yarn \(this project's package manager\) — staying on 1\.2\.3/],
    ['a failing install', ['--update', '1.3.0'], (fx) => { fx.npmAddFails = true; }, /update to 1\.3\.0 failed — staying on 1\.2\.3/],
  ];
  for (const [name, args, shape, message] of cases) {
    const fx = await updatableFixture();
    await shape(fx);
    const r = await runInit([...args, '--workspace', fx.consumer], fx);
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, message, name);
    const pkg = JSON.parse(await readFile(join(fx.consumer, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies['@veedstudio/openedit-cli'], '1.2.3', `${name}: pin unchanged`);
  }
});

test('--update outside a pinned project is refused: a checkout, or a folder never set up', async () => {
  const checkout = await fixture();
  await plantSourceTree(checkout.consumer, '@veedstudio/openedit-cli');
  const r = await runInit(['--update', '1.3.0', '--workspace', checkout.consumer], checkout);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /a checkout updates through git, not init --update/);

  const refused = await fixture();
  writeFileSync(join(refused.consumer, 'notes.txt'), 'someone else lives here');
  const r2 = await runInit(['--update', '1.3.0', '--workspace', refused.consumer], refused);
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(r2.stderr, /@veedstudio\/openedit-cli is not pinned in this workspace yet — run bare init first/);
});

test('--update while another init holds the workspace lease fails instead of skipping', async () => {
  const fx = await updatableFixture();
  const key = createHash('sha1').update(real(fx.consumer)).digest('hex').slice(0, 16);
  mkdirSync(join(fx.stateDir, 'locks', `init-${key}`), { recursive: true });
  const r = await runInit(['--update', '1.3.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /another setup is running in this workspace — run init --update again once it finishes/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')));
});

// A clone, or a deleted node_modules: without the install, every npx call runs the registry's latest.
// A clone's install runs what its lockfile, pin and package-manager config name: the user's call, not init's.
test('a pinned project whose node_modules lacks the CLI waits for approval to install it, and only then reads ready', async () => {
  const fx = await updatableFixture();
  rmSync(join(fx.consumer, 'node_modules'), { recursive: true, force: true });
  // A full skill, so the missing install is the only thing between this workspace and ready.
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), '# skill');
  const approval = /APPROVAL REQUIRED — npm install in \S+: the pinned @veedstudio\/openedit-cli \(1\.2\.3\) is missing from node_modules/;

  for (const mode of [['--dry'], []]) {
    const r = await runInit([...mode, '--workspace', fx.consumer], fx);
    assert.equal(r.status, 10, `${mode}: ${r.stderr}`);
    assert.match(r.stderr, approval, `${mode}`);
    assert.doesNotMatch(r.stderr, /ready — OPEN_EDIT_ROOT=/, `${mode}: ready while npx would still fetch`);
  }
  assert.deepEqual(log(fx), [], 'installed without the approval');

  fx.npmAddFails = true;
  const failed = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /could not install the project's dependencies with npm — the pinned CLI is not installed/);

  fx.npmAddFails = false;
  const r = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(log(fx), ['npm-install', 'npm-install']);
  assert.deepEqual(fx.npmScriptsOff, [true, true], 'the install ran lifecycle scripts');
  assert.match(r.stderr, /ready — OPEN_EDIT_ROOT=/);
  // This init may be another version than the pin it installed; the agent reads the pin's skill.
  for (const dir of ['.claude', '.agents']) {
    assert.equal(readFileSync(join(fx.consumer, dir, 'skills', 'open-edit', 'SKILL.md'), 'utf8'), 'skill of 1.2.3\n', dir);
  }
});

test('a Yarn Plug\'n\'Play project is told what to change instead of looping on an install', async () => {
  const fx = await updatableFixture();
  rmSync(join(fx.consumer, 'node_modules'), { recursive: true, force: true });
  writeFileSync(join(fx.consumer, '.pnp.cjs'), '');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Yarn Plug'n'Play, and npx runs @veedstudio\/openedit-cli only from node_modules — set nodeLinker: node-modules/);
  assert.deepEqual(log(fx), []);
});

test('an installed prerelease of a later version is not downgraded, and moves up to its release', async () => {
  const fx = await updatableFixture();
  plantInstalled(fx, '1.5.0-rc.1');
  const down = await runInit(['--update', '1.4.0', '--workspace', fx.consumer], fx);
  assert.equal(down.status, 1, down.stderr);
  assert.match(down.stderr, /1\.4\.0 is older than the installed 1\.5\.0-rc\.1 — init --update never downgrades/);
  const up = await runInit(['--update', '1.5.0', '--workspace', fx.consumer], fx);
  assert.equal(up.status, 0, up.stderr);
  assert.match(up.stderr, /updated @veedstudio\/openedit-cli 1\.5\.0-rc\.1 → 1\.5\.0/);
});

test('a mistyped --update writes nothing at all', async () => {
  const fx = await fixture();
  const r = await runInit(['--update', 'latest', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(readdirSync(fx.consumer), [], 'the folder was set up before the argument was refused');
});

// By name alone, npx would run the registry's latest; nested, it would print the update notice again.
test('the nested install-ffmpeg runs the same published version, with the notice off', async () => {
  for (const [cliVersion, spec] of [['1.2.3', '@veedstudio/openedit-cli@1.2.3'], ['', '@veedstudio/openedit-cli'], ['0.0.0-e2e.1', '@veedstudio/openedit-cli']]) {
    const fx = await fixture();
    fx.cliVersion = cliVersion;
    fx.bins.ffmpeg = null;
    fx.bins.ffprobe = null;
    const dry = await runInit(['--dry', '--workspace', fx.consumer], fx, { os: 'win32', arch: 'x64' });
    assert.match(dry.stderr, new RegExp(`WOULD APPLY LOCALLY — npx ${spec.replace(/[.]/g, '\\.')} install-ffmpeg`), cliVersion);
    assert.match(dry.stderr, new RegExp(`no admin rights: npx ${spec.replace(/[.]/g, '\\.')} install-ffmpeg`), cliVersion);
    await runInit(['--workspace', fx.consumer], fx, { os: 'win32', arch: 'x64' });
    assert.deepEqual(fx.npxCalls, [{ spec, notifierOff: true }], cliVersion);
  }
});

test('a project without the dep is pinned by the scaffold with the running version', async () => {
  const fx = await fixture();
  fx.cliVersion = '1.2.3';
  await writeFile(join(fx.consumer, '.open-edit-prefs.json'), '{}');
  await writeFile(join(fx.consumer, 'package.json'), JSON.stringify({ name: 'proj', private: true }));
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
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

// ---------- skill placement and the hooks earlier versions wrote ----------

test('the skill lands where every agent reads it: .claude/skills and .agents/skills', async () => {
  const fx = await fixture();
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  for (const dir of ['.claude', '.agents']) {
    assert.equal(await readFile(join(fx.consumer, dir, 'skills', 'open-edit', 'SKILL.md'), 'utf8'), '---\nname: open-edit\n---\n', dir);
  }
  for (const cfg of [join('.claude', 'settings.json'), join('.codex', 'hooks.json'), join('.gemini', 'settings.json')]) {
    assert.ok(!existsSync(join(fx.consumer, cfg)), `${cfg}: init writes no agent config`);
  }
});

const SYMLINKS = process.platform === 'win32' && 'symlinks need privileges on Windows';

// `npx skills add` keeps one real copy and links the other path to it, in either direction.
test('a skill path that links to the other inside the workspace is refreshed once, through the link', { skip: SYMLINKS }, async () => {
  for (const [real, linked] of [['.agents', '.claude'], ['.claude', '.agents']]) {
    const fx = await fixture();
    const canonical = join(fx.consumer, real, 'skills', 'open-edit');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'SKILL.md'), 'old\n');
    mkdirSync(join(fx.consumer, linked, 'skills'), { recursive: true });
    symlinkSync(join('..', '..', real, 'skills', 'open-edit'), join(fx.consumer, linked, 'skills', 'open-edit'));
    const r = await runInit(['--workspace', fx.consumer], fx);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(lstatSync(join(fx.consumer, linked, 'skills', 'open-edit')).isSymbolicLink(), `${linked}: the link was replaced by a copy`);
    assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), '---\nname: open-edit\n---\n');
    assert.equal((r.stderr.match(/skill refreshed/g) ?? []).length, 1, r.stderr);
  }
});

// A case-insensitive volume answers .claude for .Claude; that is the same folder, not a link.
test('a skill folder spelled in another case is refreshed in place', { skip: process.platform !== 'darwin' && 'case-insensitive volumes are the macOS default' }, async () => {
  const fx = await fixture();
  writeFileSync(join(fx.consumer, '.open-edit-prefs.json'), '{}');
  mkdirSync(join(fx.consumer, '.Claude', 'skills', 'open-edit'), { recursive: true });
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(fx.consumer, '.Claude', 'skills', 'open-edit', 'SKILL.md'), 'utf8'), '---\nname: open-edit\n---\n');
});

// A cloned project could aim the refresh's delete at the user's own files through a planted link.
test('a skill link that leads out of the workspace is replaced, and what it pointed at is untouched', { skip: SYMLINKS }, async () => {
  const fx = await fixture();
  const victim = join(fx.root, 'victim');
  mkdirSync(victim);
  writeFileSync(join(victim, 'important.txt'), 'keep me');
  writeFileSync(join(fx.consumer, '.open-edit-prefs.json'), '{}');
  mkdirSync(join(fx.consumer, '.agents', 'skills'), { recursive: true });
  symlinkSync(victim, join(fx.consumer, '.agents', 'skills', 'open-edit'));
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(victim, 'important.txt'), 'utf8'), 'keep me');
  assert.ok(!existsSync(join(victim, 'SKILL.md')), 'the skill was written through the link');
  assert.ok(!lstatSync(join(fx.consumer, '.agents', 'skills', 'open-edit')).isSymbolicLink());
  assert.match(r.stderr, /replacing \.agents\S+open-edit, a link to \S+, with a copy; what it pointed at is untouched/);
});

// Inside the workspace too: a link to runs/ would take the user's renders with it.
test('a skill link to another folder of the workspace is replaced, never followed', { skip: SYMLINKS }, async () => {
  const fx = await fixture();
  writeFileSync(join(fx.consumer, '.open-edit-prefs.json'), '{}');
  mkdirSync(join(fx.consumer, 'runs', 'job1'), { recursive: true });
  writeFileSync(join(fx.consumer, 'runs', 'job1', 'footage.mp4'), 'precious');
  mkdirSync(join(fx.consumer, '.claude', 'skills'), { recursive: true });
  symlinkSync(join('..', '..', 'runs'), join(fx.consumer, '.claude', 'skills', 'open-edit'));
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(fx.consumer, 'runs', 'job1', 'footage.mp4'), 'utf8'), 'precious');
  assert.ok(!existsSync(join(fx.consumer, 'runs', 'SKILL.md')));
  assert.ok(!lstatSync(join(fx.consumer, '.claude', 'skills', 'open-edit')).isSymbolicLink());
});

test('a skills folder that leads out of the workspace is refused, and the run does not read ready', { skip: SYMLINKS }, async () => {
  const fx = await fixture();
  const elsewhere = join(fx.root, 'elsewhere');
  mkdirSync(join(elsewhere, 'open-edit'), { recursive: true });
  writeFileSync(join(elsewhere, 'open-edit', 'mine.txt'), 'keep me');
  writeFileSync(join(fx.consumer, '.open-edit-prefs.json'), '{}');
  mkdirSync(join(fx.consumer, '.agents'));
  symlinkSync(elsewhere, join(fx.consumer, '.agents', 'skills'));
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /skill refresh incomplete — \.agents\S+skills is a link, so init writes nothing through it/);
  assert.equal(readFileSync(join(elsewhere, 'open-edit', 'mine.txt'), 'utf8'), 'keep me');
});

const ourHook = (agent: string) => ({ type: 'command', command: `npx --yes @veedstudio/openedit-cli session-start ${agent}` });
const legacyHooks = {
  '.claude/settings.json': { permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [
    { hooks: [ourHook('claude')] },
    { hooks: [{ type: 'command', command: 'echo mine' }] },
  ] } },
  '.codex/hooks.json': { hooks: { SessionStart: [
    { matcher: 'startup|resume|clear|compact', hooks: [ourHook('codex')] },
  ] } },
  '.gemini/settings.json': { hooks: { SessionStart: [
    { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: 'node ".claude/skills/open-edit/hooks/session-start.mjs" gemini' }] },
  ] } },
};
const plantConfigs = (dir: string, configs: Record<string, unknown>) => {
  for (const [rel, doc] of Object.entries(configs)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  }
};
const readConfig = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

test('init removes the SessionStart hooks earlier versions wrote, and nothing of anyone else', async () => {
  const fx = await fixture();
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  plantConfigs(fx.consumer, legacyHooks);

  const dry = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.match(dry.stderr, /WOULD APPLY LOCALLY — remove the SessionStart hooks an earlier version installed: \S*\.claude\S*settings\.json \S*\.codex\S*hooks\.json \S*\.gemini\S*settings\.json/);
  assert.ok(existsSync(join(fx.consumer, '.codex', 'hooks.json')), '--dry wrote');

  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  for (const rel of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json']) {
    assert.ok(r.stderr.includes(`removed the Open Edit SessionStart hook from ${rel}`), rel);
  }
  assert.deepEqual(readConfig(fx.consumer, '.claude/settings.json'), { permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  assert.ok(!existsSync(join(fx.consumer, '.codex')), 'a config and folder that held only our hook are gone');
  assert.ok(!existsSync(join(fx.consumer, '.gemini')), 'the legacy skill-adapter entry is ours too');

  const again = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.doesNotMatch(again.stderr, /SessionStart/);
});

// The shape of this repository's own settings before this change: a sandbox block beside our hook.
test('a config keeps every other key, other hook events, other hooks in our group, and its folder', async () => {
  const fx = await fixture();
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  plantConfigs(fx.consumer, {
    '.claude/settings.json': { sandbox: { network: { allowedDomains: ['*.veed.io'] } }, hooks: { SessionStart: [{ hooks: [ourHook('claude')] }] } },
    '.codex/hooks.json': { hooks: { SessionStart: [{ hooks: [ourHook('codex'), { type: 'command', command: 'echo appended' }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }] } },
    '.codex/config.toml': 'model = "x"\n',
    // Legacy forms: the .sh adapter, a Windows path, and a duplicate the old installer accumulated.
    '.gemini/settings.json': { hooks: { SessionStart: [
      { hooks: [{ type: 'command', command: 'bash .claude/skills/open-edit/hooks/session-start.sh gemini' }] },
      { hooks: [{ type: 'command', command: 'node .claude\\skills\\open-edit\\hooks\\session-start.mjs gemini' }] },
      { hooks: [ourHook('gemini')] },
    ] }, theme: 'dark' },
  });
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readConfig(fx.consumer, '.claude/settings.json'), { sandbox: { network: { allowedDomains: ['*.veed.io'] } } });
  assert.deepEqual(readConfig(fx.consumer, '.codex/hooks.json'), { hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo appended' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }],
  } });
  assert.equal(readFileSync(join(fx.consumer, '.codex', 'config.toml'), 'utf8'), 'model = "x"\n');
  assert.deepEqual(readConfig(fx.consumer, '.gemini/settings.json'), { theme: 'dark' });
});

test('a private settings file stays private after the hook comes out', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const fx = await fixture();
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  plantConfigs(fx.consumer, { '.claude/settings.json': { env: { TOKEN: 'secret' }, hooks: { SessionStart: [{ hooks: [ourHook('claude')] }] } } });
  chmodSync(join(fx.consumer, '.claude', 'settings.json'), 0o600);
  assert.equal((await runInit(['--workspace', fx.consumer], fx)).status, 0);
  assert.equal(statSync(join(fx.consumer, '.claude', 'settings.json')).mode & 0o777, 0o600);
  assert.deepEqual(readConfig(fx.consumer, '.claude/settings.json'), { env: { TOKEN: 'secret' } });
});

// A workspace that never reaches ready must still stop running a hook every session.
test('a folder the consent gate refuses still loses our hooks, and gains nothing else', async () => {
  const fx = await fixture();
  writeFileSync(join(fx.consumer, 'notes.txt'), 'someone else lives here');
  plantConfigs(fx.consumer, legacyHooks);
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED[^\n]*already holds other files/);
  assert.ok(!existsSync(join(fx.consumer, '.codex')));
  for (const path of ['package.json', '.agents', join('.claude', 'skills'), '.gitignore']) {
    assert.ok(!existsSync(join(fx.consumer, path)), `${path} was written into a folder init refused`);
  }
});

test('a config init cannot edit is left as it is and reported when it holds our hook', async () => {
  const fx = await fixture();
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  const commented = '{ // mine\n  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx --yes @veedstudio/openedit-cli session-start gemini" }] }] } }';
  plantConfigs(fx.consumer, { '.gemini/settings.json': commented, '.codex/hooks.json': '{ not json, and not ours' });
  const dry = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.doesNotMatch(dry.stderr, /WOULD APPLY LOCALLY — remove the SessionStart hooks/, 'dry promised a removal init will not do');
  assert.match(dry.stderr, /found an Open Edit SessionStart hook in \.gemini\/settings\.json that init cannot edit/);
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(fx.consumer, '.gemini', 'settings.json'), 'utf8'), commented);
  assert.equal(readFileSync(join(fx.consumer, '.codex', 'hooks.json'), 'utf8'), '{ not json, and not ours');
  assert.match(r.stderr, /found an Open Edit SessionStart hook in \.gemini\/settings\.json that init cannot edit \(it is not plain JSON\); remove its openedit-cli session-start entry by hand/);
  assert.doesNotMatch(r.stderr, /\.codex/);
});

test('a linked config is never rewritten through its link', { skip: SYMLINKS }, async () => {
  const fx = await fixture();
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  const dotfile = join(fx.root, 'dotfiles-settings.json');
  writeFileSync(dotfile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [ourHook('claude')] }] } }));
  symlinkSync(dotfile, join(fx.consumer, '.claude', 'settings.json'));
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /found an Open Edit SessionStart hook in \.claude\/settings\.json that init cannot edit \(it is a symbolic link\)/);
  assert.ok(lstatSync(join(fx.consumer, '.claude', 'settings.json')).isSymbolicLink());
  assert.match(readFileSync(dotfile, 'utf8'), /session-start claude/);
});

test('a hook init cannot delete is reported by name, and setup still completes', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as a non-root user' }, async () => {
  const fx = await fixture();
  await mkdir(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  plantConfigs(fx.consumer, { '.codex/hooks.json': legacyHooks['.codex/hooks.json'] });
  chmodSync(join(fx.consumer, '.codex'), 0o555);
  try {
    const r = await runInit(['--workspace', fx.consumer], fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not remove the Open Edit SessionStart hook from \.codex\/hooks\.json \(.+\); remove its openedit-cli session-start entry by hand/);
    assert.match(r.stderr, /ready — OPEN_EDIT_ROOT=/);
  } finally {
    chmodSync(join(fx.consumer, '.codex'), 0o755);
  }
});

// ---------- migration, PM absence, approvals, dry truth, refresh ----------
// What the hooks of earlier versions still call after the project updates past them.
test('session-start removes the old hooks and points Codex at the skill copy once', async () => {
  const { sessionStart } = await import('../src/commands/session-start.ts');
  const fx = await fixture();
  await writeFile(join(fx.consumer, 'package.json'), JSON.stringify({ devDependencies: { '@veedstudio/openedit-cli': '1.2.3' } }));
  mkdirSync(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), 'the skill\n');
  plantConfigs(fx.consumer, legacyHooks);
  const sub = join(fx.consumer, 'runs', 'piece');
  mkdirSync(sub, { recursive: true });

  const out: string[] = [];
  const err: string[] = [];
  const { log: realLog, error: realError } = console;
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  console.error = (...a: unknown[]) => err.push(a.join(' '));
  try {
    assert.equal(await sessionStart(['codex'], sub), 0, 'a hook fired below the project still finds it');
    assert.equal(await sessionStart(['codex'], sub), 0);
    assert.equal(await sessionStart(['gemini'], join(fx.root, 'no-such-dir')), 0, 'never fails a session');
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.deepEqual(out, [`For video work, the open-edit skill is ${join(fx.consumer, '.agents', 'skills', 'open-edit', 'SKILL.md')}.`]);
  assert.deepEqual(err, []);
  assert.deepEqual(findProjectHooks(fx.consumer), []);
  assert.equal(readFileSync(join(fx.consumer, '.agents', 'skills', 'open-edit', 'SKILL.md'), 'utf8'), 'the skill\n');
});

const sessionFixture = async () => {
  const fx = await fixture();
  await writeFile(join(fx.consumer, 'package.json'), JSON.stringify({ devDependencies: { '@veedstudio/openedit-cli': '1.2.3' } }));
  mkdirSync(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), 'the skill\n');
  plantConfigs(fx.consumer, { '.gemini/settings.json': legacyHooks['.gemini/settings.json'] });
  return fx;
};

test('session-start never copies the skill through a link', { skip: SYMLINKS }, async () => {
  const { sessionStart } = await import('../src/commands/session-start.ts');
  const fx = await fixture();
  await writeFile(join(fx.consumer, 'package.json'), JSON.stringify({ devDependencies: { '@veedstudio/openedit-cli': '1.2.3' } }));
  mkdirSync(join(fx.consumer, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(fx.consumer, '.claude', 'skills', 'open-edit', 'SKILL.md'), 'the skill\n');
  const outside = join(fx.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(fx.consumer, '.agents'));
  const err: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => err.push(a.join(' '));
  try {
    assert.equal(await sessionStart(['claude'], fx.consumer), 0);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(readdirSync(outside), []);
  assert.match(err.join('\n'), /did not copy the open-edit skill to \S+: a link is on the way/);
});

test('session-start gives Gemini its pointer as SessionStart JSON', async () => {
  const { sessionStart } = await import('../src/commands/session-start.ts');
  const fx = await sessionFixture();
  const out: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  try {
    assert.equal(await sessionStart(['gemini'], fx.consumer), 0);
  } finally {
    console.log = realLog;
  }
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, `For video work, the open-edit skill is ${join(fx.consumer, '.agents', 'skills', 'open-edit', 'SKILL.md')}.`);
});

// A partial copy left in place would read as done to every later run, and the hooks that retried are gone.
test('a copy that fails leaves nothing behind, says so on stderr, and still exits 0', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as a non-root user' }, async () => {
  const { sessionStart } = await import('../src/commands/session-start.ts');
  const fx = await sessionFixture();
  const unreadable = join(fx.consumer, '.claude', 'skills', 'open-edit', 'locked.md');
  writeFileSync(unreadable, 'x');
  chmodSync(unreadable, 0o000);
  const out: string[] = [];
  const err: string[] = [];
  const { log: realLog, error: realError } = console;
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  console.error = (...a: unknown[]) => err.push(a.join(' '));
  try {
    assert.equal(await sessionStart(['gemini'], fx.consumer), 0);
  } finally {
    console.log = realLog;
    console.error = realError;
    chmodSync(unreadable, 0o644);
  }
  assert.deepEqual(out, [], 'a pointer to a copy that is not there');
  assert.match(err.join('\n'), /could not copy the open-edit skill to \S+ \(.+\); bare init lays it there/);
  assert.ok(!existsSync(join(fx.consumer, '.agents', 'skills', 'open-edit')), 'a partial copy was left in place');
  assert.deepEqual(readdirSync(join(fx.consumer, '.agents')).filter((n) => n.endsWith('.tmp')), [], 'the staging copy was left behind');
  assert.deepEqual(findProjectHooks(fx.consumer), [], 'the hook went even though the copy failed');
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

// A checkout skips the consent gate and gets pnpm install without asking, so a user's own
// pnpm project that merely has a cli/src/cli.ts must never pass for one.
test('a lookalike pnpm project is not taken for a checkout: the consent gate still asks', async () => {
  const fx = await fixture();
  await plantSourceTree(fx.consumer, 'their-tool');
  const r = await runInit(['--workspace', fx.consumer], fx);
  assert.doesNotMatch(r.stderr, /reusing the local checkout/);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — [^\n]*already holds other files/);
  assert.ok(!log(fx).some((l) => l.startsWith('pnpm:')), 'installed into a project nobody offered');
  assert.ok(!existsSync(join(fx.consumer, '.claude')), 'wrote into a project nobody offered');
});

// Linux, because there the FFmpeg approval is one --auto-approve never carries out.
test('an approved-but-unfulfilled FFmpeg install is not erased by an update in the same run', async () => {
  const fx = await updatableFixture();
  fx.bins.ffmpeg = null;
  fx.bins.ffprobe = null;
  const r = await runInit(['--auto-approve', '--update', '2.0.0', '--workspace', fx.consumer], fx, { os: 'linux', arch: 'x64' });
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

test('--dry --update reports the update as WOULD APPLY and installs nothing', async () => {
  const fx = await updatableFixture();
  const r = await runInit(['--dry', '--update', '1.3.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WOULD APPLY LOCALLY — update @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')));
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

test('a foreign npm project is not silently pinned: init asks first, for the folder and for the install', async () => {
  const fx = await fixture();
  writeFileSync(join(fx.consumer, 'package.json'), '{"name":"their-app","private":true}');
  const r = await runInit(['--dry', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /APPROVAL REQUIRED — use \S+ as the OpenEdit project/);
  assert.match(r.stderr, /APPROVAL REQUIRED — add @veedstudio\/openedit-cli to \S+ with npm: this project's own package\.json/);
  assert.ok(!log(fx).some((l) => l.startsWith('npm-add:')), 'no pin behind the project\'s back');
});

// A claimed folder's own package.json, lockfile and package-manager config decide what an install runs.
test('a claimed folder whose package.json init did not write waits for approval before the pin', async () => {
  for (const [name, plant] of [
    ['a foreign manifest', (dir: string) => writeFileSync(join(dir, 'package.json'), '{"name":"their-app","private":true,"dependencies":{"x":"1.0.0"}}')],
    ['package-manager config', (dir: string) => { writeFileSync(join(dir, 'package.json'), '{"name":"app","private":true}'); writeFileSync(join(dir, '.yarnrc.yml'), 'yarnPath: evil.js\n'); writeFileSync(join(dir, 'yarn.lock'), ''); }],
    ['a committed node_modules', (dir: string) => { writeFileSync(join(dir, 'package.json'), '{"name":"app","private":true}'); mkdirSync(join(dir, 'node_modules', 'undici'), { recursive: true }); }],
    ['a shrinkwrap', (dir: string) => { writeFileSync(join(dir, 'package.json'), '{"name":"app","private":true}'); writeFileSync(join(dir, 'npm-shrinkwrap.json'), '{}'); }],
  ] as const) {
    const fx = await fixture();
    fx.bins.yarn = 'yarn';
    writeFileSync(join(fx.consumer, '.open-edit-prefs.json'), '{}');
    plant(fx.consumer);
    const r = await runInit(['--workspace', fx.consumer], fx);
    assert.equal(r.status, 10, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /APPROVAL REQUIRED — add @veedstudio\/openedit-cli to \S+ with (npm|yarn): this project's own package\.json/, name);
    assert.deepEqual(log(fx), [], `${name}: installed without the approval`);
    const ok = await runInit(['--auto-approve', '--workspace', fx.consumer], fx);
    assert.equal(ok.status, 0, `${name}: ${ok.stderr}`);
    assert.equal(log(fx).length, 1, `${name}: the approved install did not run`);
  }
});

test('--update on a clone whose pin is not installed waits for that install\'s own approval', async () => {
  const fx = await updatableFixture();
  rmSync(join(fx.consumer, 'node_modules'), { recursive: true, force: true });
  const r = await runInit(['--update', '1.3.0', '--workspace', fx.consumer], fx);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the pinned @veedstudio\/openedit-cli is not installed yet — approve the install init reports, then run init --update 1\.3\.0 again/);
  assert.deepEqual(log(fx), []);
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

// SKILL.md completes Setup on the line init prints, so the two cannot drift apart.
test('SKILL.md counts an init run ending ready as done setup', async () => {
  const skill = await readFile(join(import.meta.dirname, '../../.claude/skills/open-edit/SKILL.md'), 'utf8');
  const line = /`([^`]+)…` means go/.exec(skill)?.[1];
  assert.ok(line, 'SKILL.md no longer says which init line completes setup');
  const init = await readFile(join(import.meta.dirname, '../src/commands/init.ts'), 'utf8');
  // Any variable may carry the root; what must hold is that init prints this exact prefix before it.
  assert.ok(init.includes(`say(\`${line}\${`), `init no longer prints ${line}`);
});
