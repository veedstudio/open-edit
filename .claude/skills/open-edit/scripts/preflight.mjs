#!/usr/bin/env node
// Open Edit's single setup entrypoint.
//
//   preflight                 Apply workspace-local setup; report global installs and updates.
//   preflight --dry           Report only; never write.
//   preflight --auto-approve  Apply everything, including global installs and clean updates. The
//                             orchestrating agent may use this only after explicit user approval.
//
// Runs on Node builtins only: preflight is what installs the repository dependencies, so nothing
// from node_modules can be imported here. preflight.sh is the macOS shim that bootstraps Node itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  engineBinaryName,
  findOnPath,
  installHint,
  isCmdShim,
  isEngineRunnable,
  platformKey,
  unsupportedMessage,
} from './platform.mjs';

const DEFAULT_REPOSITORY = 'https://github.com/veedstudio/open-edit.git';
const DEFAULT_REF = 'main';
const MIN_PNPM = '10.16.1'; // floor, not a pin: any newer pnpm is accepted
const MIN_ENGINE = '0.9.0'; // first release with a Windows asset; the WCAG analyzer has shipped in-engine since 0.8.0
const ENGINE_RELEASES = 'veedstudio/weave-renderer-public-releases'; // upstream repo name, not renamed

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: preflight.mjs [--dry|--auto-approve]
                     [--workspace <path>] [--repository <url-or-path>] [--ref <branch>]

Bare preflight applies only workspace-local first-time setup. --dry never writes.
--auto-approve installs missing machine dependencies and applies all clean updates; use it only
after the user has explicitly approved every action reported by --dry.`;

class PreflightError extends Error {}

export function defaultDeps() {
  return {
    os: process.platform,
    arch: process.arch,
    env: process.env,
    exec: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts }),
    fetch: (...args) => fetch(...args),
    err: (line) => process.stderr.write(`${line}\n`),
    out: (line) => process.stdout.write(`${line}\n`),
  };
}

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  try {
    return await run(argv, deps);
  } catch (error) {
    if (error instanceof PreflightError) {
      deps.err(`preflight: ERROR — ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function run(argv, deps) {
  const { env } = deps;
  const isWin = deps.os === 'win32';
  const say = (msg) => deps.err(`preflight: ${msg}`);
  const die = (msg) => {
    throw new PreflightError(msg);
  };
  let needsApproval = false;
  let failed = false;
  const needApproval = (msg) => {
    needsApproval = true;
    say(`APPROVAL REQUIRED — ${msg}`);
  };

  // GUI-launched agents inherit a minimal PATH that commonly omits Homebrew. Add both standard
  // prefixes before probing brew, Node, pnpm, FFmpeg, or Git; preserve the caller's remaining PATH.
  if (deps.os === 'darwin') {
    const prefix = 'OPEN_EDIT_HOMEBREW_PATH_PREFIX' in env
      ? env.OPEN_EDIT_HOMEBREW_PATH_PREFIX
      : '/opt/homebrew/bin:/usr/local/bin';
    if (prefix) env.PATH = `${prefix}:${env.PATH ?? ''}`;
  }

  const which = deps.which ?? ((cmd) => findOnPath(cmd, env, deps.os));
  const have = (cmd) => Boolean(which(cmd));
  const exec = (cmd, args, opts = {}) => deps.exec(cmd, args, opts);
  // pnpm and npm install as .cmd shims on Windows, which Node refuses to exec directly — the
  // classic win32 port bug. Route those through cmd.exe with every token quoted.
  const execTool = (cmd, args, opts = {}) => {
    const resolved = which(cmd) ?? cmd;
    if (isCmdShim(resolved)) {
      const line = [resolved, ...args].map((a) => `"${a}"`).join(' ');
      return deps.exec('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
    }
    return deps.exec(resolved, args, opts);
  };
  const out = (result) => (result.stdout ?? '').toString().trim();
  const ok = (result) => !result.error && result.status === 0;

  const versionAtLeast = (candidate, floor) => {
    if (!candidate) return false;
    const a = candidate.trim().split('.');
    const b = floor.split('.');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = Number(a[i] ?? 0);
      const y = Number(b[i] ?? 0);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      if (x !== y) return x > y;
    }
    return true;
  };
  const pnpmOk = () => versionAtLeast(out(execTool('pnpm', ['--version'])), MIN_PNPM);
  const resolveDir = (p) => {
    try {
      const real = fs.realpathSync(p);
      return fs.statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  };

  let mode = 'apply';
  let workspaceArg = '';
  let repositoryArg = '';
  let refArg = '';
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--dry': mode = 'dry'; break;
      case '--auto-approve': mode = 'auto'; break;
      case '--workspace':
        if (args.length === 0) die('--workspace requires a path');
        workspaceArg = args.shift();
        break;
      case '--repository':
        if (args.length === 0) die('--repository requires a URL or local path');
        repositoryArg = args.shift();
        break;
      case '--ref':
        if (args.length === 0) die('--ref requires a branch');
        refArg = args.shift();
        break;
      case '-h':
      case '--help':
        deps.err(USAGE);
        return 0;
      default:
        deps.err(USAGE);
        die(`unknown argument: ${arg}`);
    }
  }
  for (const value of [workspaceArg, repositoryArg, refArg]) {
    if (/[\n\r]/.test(value)) die('arguments may not contain newlines');
  }

  let workspace;
  if (workspaceArg) {
    workspace = resolveDir(workspaceArg) ?? die(`workspace does not exist: ${workspaceArg}`);
  } else {
    const top = exec('git', ['rev-parse', '--show-toplevel']);
    workspace = ok(top) ? out(top) : fs.realpathSync(process.cwd());
  }
  if (repositoryArg && fs.existsSync(repositoryArg) && fs.statSync(repositoryArg).isDirectory()) {
    repositoryArg = resolveDir(repositoryArg) ?? die('repository path does not exist');
  }

  if (!platformKey(deps.os, deps.arch)) die(unsupportedMessage(deps.os, deps.arch));

  const container = path.join(workspace, '.open-edit');
  const managedRoot = path.join(container, 'runtime');
  let root = managedRoot;
  let rootKind = 'missing';
  let recorded = { repository: '', ref: '', commit: '' };

  const isOpenEditCheckout = (candidate) => {
    try {
      if (!fs.existsSync(path.join(candidate, 'package.json'))) return false;
      if (!fs.existsSync(path.join(candidate, 'pnpm-lock.yaml'))) return false;
      if (!fs.existsSync(path.join(candidate, 'pipeline', 'scripts', 'preflight.sh'))) return false;
      return /"name"\s*:\s*"open-edit"/.test(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
    } catch {
      return false;
    }
  };

  const statePathFor = (dir) => {
    const result = exec('git', ['-C', dir, 'rev-parse', '--absolute-git-dir']);
    return ok(result) ? path.join(out(result), 'open-edit-preflight-state') : null;
  };
  const stateGet = (file, key) => {
    const result = exec('git', ['config', '--file', file, '--get', `preflight.${key}`]);
    return ok(result) ? out(result) : '';
  };
  const writeState = (dir, source, branch, commit) => {
    const file = statePathFor(dir) ?? die(`cannot locate Git metadata for ${dir}`);
    for (const [key, value] of [['schema', '1'], ['repository', source], ['ref', branch], ['installedCommit', commit]]) {
      exec('git', ['config', '--file', file, `preflight.${key}`, value]);
    }
  };

  const discoverRuntime = () => {
    if (isOpenEditCheckout(workspace) && ok(exec('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']))) {
      root = workspace;
      rootKind = 'reused';
      return;
    }
    if (!fs.existsSync(managedRoot)) return;
    if (!fs.statSync(managedRoot).isDirectory()) die(`managed runtime path is not a directory: ${managedRoot}`);
    if (!isOpenEditCheckout(managedRoot)) die(`refusing unexpected contents at ${managedRoot}`);
    const statePath = statePathFor(managedRoot) ?? die('managed runtime is not a Git checkout');
    if (!fs.existsSync(statePath)) die('managed runtime has no completed-clone receipt');
    if (stateGet(statePath, 'schema') !== '1') die('managed runtime has an unsupported receipt');
    recorded = {
      repository: stateGet(statePath, 'repository'),
      ref: stateGet(statePath, 'ref'),
      commit: stateGet(statePath, 'installedCommit'),
    };
    if (!recorded.repository || !recorded.ref || !recorded.commit) die('managed runtime receipt is incomplete');
    const origin = out(exec('git', ['-C', managedRoot, 'remote', 'get-url', 'origin']));
    const head = out(exec('git', ['-C', managedRoot, 'rev-parse', 'HEAD']));
    if (origin !== recorded.repository) die('runtime origin differs from its receipt');
    if (head !== recorded.commit) die('runtime HEAD differs from its managed revision; inspect it before continuing');
    if (repositoryArg && repositoryArg !== recorded.repository) die('--repository conflicts with the managed runtime');
    if (refArg && refArg !== recorded.ref) die('--ref conflicts with the managed runtime');
    root = managedRoot;
    rootKind = 'managed';
  };

  discoverRuntime();

  // Say which code is about to run, and warn when a local checkout is being bypassed. WORKSPACE is only
  // reused when it IS an Open Edit checkout; otherwise everything below runs from a clone of
  // DEFAULT_REF, so pointing --workspace at the wrong directory silently runs different code.
  const bundledCheckout = resolveDir(path.join(SCRIPT_ROOT, '..', '..', '..'));
  if (rootKind === 'reused') {
    say(`reusing the local checkout at ${root}`);
  } else {
    say(`workspace ${workspace} will use a managed clone at ${managedRoot}`);
    if (bundledCheckout && isOpenEditCheckout(bundledCheckout) && bundledCheckout !== workspace) {
      say(`NOTE: this skill lives in the checkout ${bundledCheckout}, which will NOT be used.`);
      say(`      To run that code instead, pass --workspace ${bundledCheckout}`);
    }
  }

  let repository;
  let ref;
  if (rootKind === 'managed') {
    repository = recorded.repository;
    ref = recorded.ref;
  } else {
    repository = repositoryArg || DEFAULT_REPOSITORY;
    ref = refArg || DEFAULT_REF;
  }

  const ffmpegOk = () => have(env.VEED_ENGINE_FFMPEG || 'ffmpeg') && have(env.VEED_ENGINE_FFPROBE || 'ffprobe');
  const installBrewFormula = (formula) => {
    if (!have('brew')) {
      say(`Homebrew is required to install ${formula}; install Homebrew first`);
      failed = true;
      return;
    }
    if (!ok(execTool('brew', ['install', formula], { stdio: ['ignore', 2, 2] }))) failed = true;
  };

  const handleGlobalDependencies = () => {
    const missing = {
      git: !have('git'),
      node: !have('node'),
      pnpm: !pnpmOk(),
      ffmpeg: !ffmpegOk(),
    };
    if (missing.git) needApproval(`install Git globally: ${installHint('git', deps.os)}`);
    if (missing.node) needApproval(`install Node globally: ${installHint('node', deps.os)}`);
    if (missing.pnpm) needApproval(`install pnpm ${MIN_PNPM} or newer globally: npm install --global pnpm@${MIN_PNPM}`);
    if (missing.ffmpeg) needApproval(`install FFmpeg globally: ${installHint('ffmpeg', deps.os)}`);

    if (isWin && Object.values(missing).some(Boolean)) {
      // winget needs an interactive first run and its PATH edits never reach an already-running
      // process, so Windows installs stay manual: report, and keep the approval pending even
      // under --auto-approve rather than half-applying it.
      if (!have('winget')) say('no winget on this machine — install from git-scm.com, nodejs.org, and gyan.dev (FFmpeg) instead');
      say('Windows installs are manual in v1 — run the commands above, then re-run preflight from a NEW terminal (PATH changes need a fresh shell)');
      return;
    }
    if (mode !== 'auto') return;
    needsApproval = false;
    if (missing.git) installBrewFormula('git');
    if (missing.node) installBrewFormula('node');
    if (missing.ffmpeg) installBrewFormula('ffmpeg');
    if (missing.pnpm) {
      if (!have('npm')) {
        say('npm is unavailable after installing Node');
        failed = true;
        return;
      }
      if (!ok(execTool('npm', ['install', '--global', `pnpm@${MIN_PNPM}`], { stdio: ['ignore', 2, 2] }))) failed = true;
    }
    if (!have('git') || !have('node') || !pnpmOk() || !ffmpegOk()) failed = true;
  };

  handleGlobalDependencies();
  if (failed) die('one or more approved global dependency installs failed');

  if (mode !== 'dry' && have('node')) {
    const hooks = exec(process.execPath, [path.join(SCRIPT_ROOT, 'hooks', 'install-project-hooks.mjs'), workspace, SCRIPT_ROOT], { stdio: ['ignore', 2, 2] });
    if (!ok(hooks)) say('could not install project hooks automatically; the agent must preserve existing settings and add them manually');
  }

  const cloneRuntime = () => {
    if (rootKind !== 'missing') return;
    if (!have('git')) {
      say('runtime clone is waiting for Git');
      return;
    }
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — full clone ${repository} (${ref}) to ${managedRoot}`);
      return;
    }
    fs.mkdirSync(container, { recursive: true });
    let staging;
    try {
      staging = fs.mkdtempSync(path.join(container, '.preflight.'));
    } catch {
      die('cannot create clone staging directory');
    }
    try {
      say(`cloning ${repository} (${ref}) to ${managedRoot}`);
      const cloned = path.join(staging, 'runtime');
      if (!ok(exec('git', ['clone', '--single-branch', '--branch', ref, '--', repository, cloned], { stdio: ['ignore', 2, 2] }))) die('clone failed');
      if (!isOpenEditCheckout(cloned)) die('cloned repository is not a valid Open Edit checkout');
      const commitR = exec('git', ['-C', cloned, 'rev-parse', 'HEAD']);
      if (!ok(commitR)) die('cannot resolve cloned revision');
      const originR = exec('git', ['-C', cloned, 'remote', 'get-url', 'origin']);
      if (!ok(originR)) die('cannot resolve cloned origin');
      const commit = out(commitR);
      const origin = out(originR);
      writeState(cloned, origin, ref, commit);
      if (fs.existsSync(managedRoot)) die('runtime appeared while cloning; refusing to overwrite it');
      fs.renameSync(cloned, managedRoot);
      if (ok(exec('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']))) {
        let exclude = out(exec('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude']));
        if (!path.isAbsolute(exclude)) exclude = path.join(workspace, exclude);
        const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        if (!existing.split(/\r?\n/).includes('.open-edit/')) fs.appendFileSync(exclude, '\n.open-edit/\n');
      }
      root = managedRoot;
      rootKind = 'managed';
      recorded = { repository: origin, ref, commit };
      say(`runtime cloned at ${commit}`);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  };

  cloneRuntime();

  const repoDepsReady = () => {
    const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
    if (isWin) {
      // pnpm writes .CMD shims on Windows, and there is no exec bit to test
      if (!fs.existsSync(`${tsx}.CMD`) && !fs.existsSync(`${tsx}.cmd`)) return false;
    } else {
      try {
        fs.accessSync(tsx, fs.constants.X_OK);
      } catch {
        return false;
      }
    }
    const modulesYaml = path.join(root, 'node_modules', '.modules.yaml');
    if (!fs.existsSync(modulesYaml)) return false;
    const recordedPnpm = fs.readFileSync(modulesYaml, 'utf8').split(/\r?\n/)
      .map((line) => line.match(/^packageManager:\s*pnpm@([^\s"']*)/)?.[1])
      .find(Boolean) ?? '';
    return versionAtLeast(recordedPnpm, MIN_PNPM) && ok(execTool('pnpm', ['list', '--depth', '0'], { cwd: root }));
  };

  const handleRepoDeps = () => {
    if (rootKind === 'missing') return;
    if (repoDepsReady()) {
      say('repository dependencies — ready');
      return;
    }
    if (!have('node') || !pnpmOk()) {
      say('repository dependencies are waiting for approved Node/pnpm installation');
      return;
    }
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — pnpm install --frozen-lockfile in ${root}`);
      return;
    }
    say(`installing repository dependencies in ${root}`);
    if (!ok(execTool('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: ['ignore', 2, 2] }))) die('repository dependency installation failed');
    if (!repoDepsReady()) die('repository dependency validation failed after install');
  };

  handleRepoDeps();

  const enginePath = () => env.VEED_ENGINE_BIN || path.join(root, '.veed-engine', engineBinaryName(deps.os));
  const latestEngineVersion = async () => {
    try {
      const res = await deps.fetch(`https://api.github.com/repos/${ENGINE_RELEASES}/releases/latest`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return '';
      const tag = (await res.json()).tag_name ?? '';
      return tag.replace(/^weave-v/, ''); // upstream tag format is weave-v<semver>
    } catch {
      return '';
    }
  };
  // The binary prints `weave-viewer-cli <semver>`; a run that fails or prints nothing reads as ''.
  const engineVersion = (bin) => {
    const result = exec(bin, ['--version']);
    return result.error ? '' : ((result.stdout ?? '').toString().trim().split(/\s+/)[1] ?? '');
  };
  const installEngine = () => ok(exec(process.execPath, [path.join(root, 'pipeline', 'scripts', 'install-veed-engine.mjs')], { stdio: ['ignore', 2, 2] }));

  // RE-READ and enforce, after any install: one that exits 0 without raising the
  // version (download failed softly, or the published release is still older than
  // the floor) would otherwise be reported as ready, and the run would die inside
  // the WCAG pass on an unknown flag instead.
  const assertEngineFloor = (engine) => {
    const installed = engineVersion(engine);
    if (!versionAtLeast(installed, MIN_ENGINE)) {
      die(`renderer is ${installed || 'unreadable'} after installing, below the required ${MIN_ENGINE} — the WCAG pass cannot run`);
    }
    say(`renderer ${installed} — meets the ${MIN_ENGINE} floor`);
  };

  const handleRenderer = async () => {
    if (rootKind === 'missing') return;
    const engine = enginePath();
    if (!isEngineRunnable(engine, deps.os)) {
      if (mode === 'dry') {
        say(`WOULD APPLY LOCALLY — install the renderer in ${path.join(root, '.veed-engine')}`);
        return;
      }
      say('installing the renderer locally');
      if (!installEngine()) die('renderer installation failed');
      // A FIRST install answers to the same floor as an update: nothing downstream
      // re-checks it, so an engine laid down below the floor would be reported ready.
      assertEngineFloor(engine);
      return;
    }
    const installed = engineVersion(engine);
    // The FLOOR is checked before freshness: an engine below it cannot run the WCAG
    // pass at all, and that must be said even when the release API is unreachable.
    // An UNREADABLE version counts as below it — nothing downstream can tell the two
    // apart, so treating it as "unknown, carry on" only defers the failure.
    if (!versionAtLeast(installed, MIN_ENGINE)) {
      if (mode !== 'auto') {
        needApproval(`update renderer from ${installed || 'an unreadable version'} to at least ${MIN_ENGINE} (the WCAG pass needs its bundled analyzer)`);
        return;
      }
      if (!installEngine()) die('approved renderer update failed');
      assertEngineFloor(engine);
      needsApproval = false;
      return;
    }
    const latest = await latestEngineVersion();
    if (!installed || !latest) {
      say('renderer freshness — offline or indeterminate');
      return;
    }
    if (installed === latest) {
      say(`renderer ${installed} — current`);
      return;
    }
    if (!versionAtLeast(latest, installed)) {
      say(`renderer ${installed} is newer than published ${latest}`);
      return;
    }
    needApproval(`update renderer from ${installed} to ${latest}`);
    if (mode === 'auto') {
      needsApproval = false;
      if (!installEngine()) die('approved renderer update failed');
    }
  };

  await handleRenderer();

  const handleRuntimeUpdate = () => {
    if (rootKind !== 'managed') return;
    const remote = exec('git', ['ls-remote', '--exit-code', repository, `refs/heads/${ref}`]);
    const remoteCommit = ok(remote) ? (out(remote).split(/\s+/)[0] ?? '') : '';
    if (!remoteCommit) {
      say('runtime freshness — offline or indeterminate');
      return;
    }
    const localCommit = out(exec('git', ['-C', root, 'rev-parse', 'HEAD']));
    if (localCommit === remoteCommit) {
      say(`runtime ${localCommit} — current`);
      return;
    }
    if (out(exec('git', ['-C', root, 'status', '--porcelain']))) {
      say('UPDATE AVAILABLE — runtime has local changes; leaving it untouched');
      return;
    }
    needApproval(`fast-forward runtime from ${localCommit} to ${remoteCommit} (${repository} ${ref})`);
    if (mode === 'auto') {
      needsApproval = false;
      if (!ok(exec('git', ['-C', root, 'fetch', 'origin', `refs/heads/${ref}:refs/remotes/origin/${ref}`], { stdio: ['ignore', 2, 2] }))) die('approved runtime fetch failed');
      if (!ok(exec('git', ['-C', root, 'merge-base', '--is-ancestor', localCommit, remoteCommit]))) die('remote update is not a fast-forward');
      if (!ok(exec('git', ['-C', root, 'merge', '--ff-only', remoteCommit], { stdio: ['ignore', 2, 2] }))) die('approved runtime update failed');
      writeState(root, repository, ref, remoteCommit);
    }
  };

  handleRuntimeUpdate();

  if (rootKind === 'missing') {
    say('runtime is not ready');
  } else if (repoDepsReady() && isEngineRunnable(enginePath(), deps.os)) {
    say(`ready — OPEN_EDIT_ROOT=${root}`);
  } else if (needsApproval) {
    say('local setup is incomplete because an approved prerequisite is missing');
  } else {
    // Nothing is awaiting approval: the outstanding work is the WOULD APPLY LOCALLY list above, which
    // bare preflight performs itself. Saying "approval" here sent agents looking for a user to ask.
    say('not ready yet — run bare preflight (no --dry) to apply the local setup listed above');
  }

  if (needsApproval) {
    say('run with --auto-approve only after the user approves every action above');
    return 10;
  }
  if (failed) return 1;
  deps.out(root);
  return 0;
}

const directRun = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (directRun) {
  process.exit(await main(process.argv.slice(2)));
}
