// @ts-nocheck — a faithful port of the skill's preflight.mjs, kept line-for-line where possible;
// its behavior is pinned by tests/init.test.ts, not by types.
//
// Open Edit's single setup entrypoint.
//
//   openedit init                 Apply workspace-local setup; report global installs and updates.
//   openedit init --dry           Report only; never write.
//   openedit init --auto-approve  Apply everything, including global installs and clean updates. The
//                                 orchestrating agent may use this only after explicit user approval.
//
// Project hooks (the SessionStart entries in the workspace's agent configs) are installed here too,
// invoking this package's session-start command — the installed skill is SKILL.md alone.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLatestEngineTag } from '../engine-release.ts';
import {
  engineBinaryName,
  engineInstallDir,
  ffmpegInstallDir,
  findOnPath,
  installHint,
  isCmdShim,
  isEngineRunnable,
  platformKey,
  unsupportedMessage,
} from '../platform.ts';
import { installProjectHooks } from '../project-hooks.ts';

export interface ExecResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}

const DEFAULT_REPOSITORY = 'https://github.com/veedstudio/open-edit.git';
const DEFAULT_REF = 'main';
// Floor, not a pin: any newer pnpm is accepted. Must equal the repository package.json's
// `packageManager`; init runs in a CONSUMER's project, so reading that field at runtime would find
// their package.json, not the repo's. tests/init.test.ts holds the two together instead.
const MIN_PNPM = '10.16.1';
// 0.10.2 is the first release with `--verify=<rules>` (the safe-zone family the skill's SAFE-ZONE CHECK
// runs); the Windows asset arrived in 0.9.0 and the WCAG analyzer in 0.8.0. The floor is checked before
// the release API, so a stale engine is caught even when that API is unreachable or rate-limited.
const MIN_ENGINE = '0.10.2';


const USAGE = `usage: openedit init [--dry|--auto-approve]
                     [--workspace <path>] [--repository <url-or-path>] [--ref <branch>]

Bare init applies only workspace-local first-time setup. --dry never writes.
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
  // prefixes before probing brew, Node, pnpm, FFmpeg or Git — BEHIND the caller's own PATH, never
  // ahead of it. This PATH also carries the nested `npx @veedstudio/openedit-cli` calls below, and an
  // npm whose global directory is not the caller's resolves a published copy of this CLI instead of
  // the one now running: a different version doing the install.
  if (deps.os === 'darwin') {
    const prefix = 'OPEN_EDIT_HOMEBREW_PATH_PREFIX' in env
      ? env.OPEN_EDIT_HOMEBREW_PATH_PREFIX
      : '/opt/homebrew/bin:/usr/local/bin';
    if (prefix) env.PATH = env.PATH ? `${env.PATH}:${prefix}` : prefix;
  }

  const which = deps.which ?? ((cmd) => findOnPath(cmd, env, deps.os));
  const have = (cmd) => Boolean(which(cmd));
  const exec = (cmd, args, opts = {}) => deps.exec(cmd, args, opts);
  // pnpm and npm install as .cmd shims on Windows, which Node refuses to exec directly — the
  // classic win32 port bug. Route those through cmd.exe with every token quoted.
  const execTool = (cmd, args, opts = {}) => {
    const resolved = which(cmd) ?? cmd;
    // A corepack-managed pnpm fetches its version on first use and PROMPTS before doing so. stdio is
    // piped here, so nobody can answer and the probe fails instead of reporting a version.
    const withEnv = { env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }, ...opts };
    if (isCmdShim(resolved)) {
      const line = [resolved, ...args].map((a) => `"${a}"`).join(' ');
      return deps.exec('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...withEnv, windowsVerbatimArguments: true });
    }
    return deps.exec(resolved, args, withEnv);
  };
  const out = (result) => (result.stdout ?? '').toString().trim();
  const ok = (result) => !result.error && result.status === 0;

  // Numeric core only: a prerelease segment (10.17.0-beta.1) made Number() NaN, which reported a
  // NEWER tool as missing and proposed the floor over it. A prerelease of the floor now passes.
  const versionAtLeast = (candidate, floor) => {
    if (!candidate) return false;
    const core = (v) => String(v).trim().replace(/^v/, '').split(/[-+]/)[0].split('.');
    const a = core(candidate);
    const b = core(floor);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = Number(a[i] ?? 0);
      const y = Number(b[i] ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (x !== y) return x > y;
    }
    return true;
  };
  // pnpm >=10 self-switches to a project's pinned `packageManager`, so the binary on PATH is not the
  // one that installs. Ask what this pnpm becomes in a scratch project carrying the same pin.
  const pnpmSelfSwitchesToFloor = () => {
    let dir = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-edit-pnpm-'));
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'open-edit-pnpm-probe', private: true, packageManager: `pnpm@${MIN_PNPM}` }),
      );
      return versionAtLeast(out(execTool('pnpm', ['--version'], { cwd: dir })), MIN_PNPM);
    } catch {
      return false; // offline, or a pnpm that cannot fetch its pin — treat as not satisfied
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch dir */ } }
    }
  };
  const pnpmOk = () => versionAtLeast(out(execTool('pnpm', ['--version'])), MIN_PNPM)
    || pnpmSelfSwitchesToFloor();
  // native expands Windows 8.3 short names (RUNNER~1), so OPEN_EDIT_ROOT is the path a user recognises.
  const resolveDir = (p) => {
    try {
      const real = fs.realpathSync.native(p);
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
    workspace = (ok(top) && resolveDir(out(top))) || fs.realpathSync.native(process.cwd());
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

  // The markers that make a tree an Open Edit runtime. A refusal names the one that was missing:
  // "not a valid checkout" alone leaves whoever hits it — in CI, on a machine they cannot open —
  // with a verdict and no evidence. This package ships three of the four, so the lockfile is what
  // tells an installed copy of the CLI apart from a runtime to reuse in place; it cannot come along
  // by accident, because npm drops a pnpm/yarn lockfile from every pack even when `files` names it
  // outright (measured).
  const CHECKOUT_MARKERS = [
    'package.json',
    'pnpm-lock.yaml',
    path.join('pipeline', 'scripts', 'preflight.sh'),
    path.join('refs', 'tags.json'),
  ];
  const missingCheckoutMarker = (candidate) => {
    try {
      // existsSync answers false for an unreadable directory as readily as for an absent file, so the
      // permissions are checked on their own — otherwise a locked tree is reported as a missing file.
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
      return CHECKOUT_MARKERS.find((marker) => !fs.existsSync(path.join(candidate, marker))) ?? '';
    } catch (error) {
      return `readable contents (${error?.message ?? String(error)})`;
    }
  };
  const isOpenEditCheckout = (candidate) => missingCheckoutMarker(candidate) === '';

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
    const strayMarker = missingCheckoutMarker(managedRoot);
    if (strayMarker) die(`refusing unexpected contents at ${managedRoot} — no ${strayMarker}`);
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

  // SessionStart hooks for the agent harnesses, written into the WORKSPACE's agent configs. Advisory,
  // like setup always treated them: a hook problem must not block a run. Owned here rather than by
  // the skill so an installed skill is SKILL.md alone.
  if (mode === 'dry') {
    say('WOULD APPLY LOCALLY — SessionStart hooks in the workspace agent configs (.claude/.codex/.gemini)');
  } else {
    try {
      installProjectHooks(workspace, (line) => say(line));
    } catch (error) {
      say(`could not install project hooks automatically (${error?.message ?? error}); the agent must preserve existing settings and add them manually`);
    }
  }

  // Say which code is about to run, and warn when a local checkout is being bypassed. WORKSPACE is only
  // reused when it IS an Open Edit checkout; otherwise everything below runs from a clone of
  // DEFAULT_REF, so pointing --workspace at the wrong directory silently runs different code.
  if (rootKind === 'reused') {
    say(`reusing the local checkout at ${root}`);
  } else {
    say(`workspace ${workspace} will use a managed clone at ${managedRoot}`);
    // Pointing --workspace elsewhere while standing in a checkout silently runs DIFFERENT code —
    // the note the skill-bundled setup used to key on its own install location.
    const invokedTop = exec('git', ['rev-parse', '--show-toplevel']);
    const invokedFrom = ok(invokedTop) ? resolveDir(out(invokedTop)) : null;
    if (invokedFrom && isOpenEditCheckout(invokedFrom) && invokedFrom !== workspace) {
      say(`NOTE: this command ran from the checkout ${invokedFrom}, which will NOT be used.`);
      say(`      To run that code instead, pass --workspace ${invokedFrom}`);
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

  // Duplicates config.ts's resolution rather than importing it, so the check runs against the
  // INJECTED env: env override → app-data install → legacy workspace .ffmpeg/ → PATH.
  const localFfmpegOk = () => [path.join(ffmpegInstallDir(deps.os, env), 'bin'), path.join(root, '.ffmpeg', 'bin')]
    .some((bin) => ['ffmpeg', 'ffprobe'].every((n) => fs.existsSync(path.join(bin, isWin ? `${n}.exe` : n))));
  const ffmpegOk = () =>
    (have(env.VEED_ENGINE_FFMPEG || 'ffmpeg') && have(env.VEED_ENGINE_FFPROBE || 'ffprobe')) || localFfmpegOk();
  // A platform question: the no-admin download route exists on Windows only (macOS has brew).
  const ffmpegHasLocalRoute = () => isWin;
  const installFfmpegLocally = () => {
    // stderr is inherited, so the installer's own diagnostics reach the user directly.
    const r = execTool('npx', ['--yes', '@veedstudio/openedit-cli', 'install-ffmpeg'], { stdio: ['ignore', 2, 2] });
    if (!ok(r)) {
      say(`local FFmpeg install failed: ${r.error?.message ?? `exited ${r.status}`}`);
      failed = true;
    }
  };
  const installBrewFormula = (formula) => {
    if (!have('brew')) {
      say(`Homebrew is required to install ${formula}; install Homebrew first`);
      failed = true;
      return;
    }
    if (!ok(execTool('brew', ['install', formula], { stdio: ['ignore', 2, 2] }))) failed = true;
  };

  // Kept at this scope so the post-clone FFmpeg step can clear its entry and retract the approval.
  let globalsMissing = { git: false, node: false, pnpm: false, ffmpeg: false };

  const handleGlobalDependencies = () => {
    const missing = {
      git: !have('git'),
      node: !have('node'),
      pnpm: !pnpmOk(),
      ffmpeg: !ffmpegOk(),
    };
    globalsMissing = missing;
    if (missing.git) needApproval(`install Git globally: ${installHint('git', deps.os)}`);
    if (missing.node) needApproval(`install Node globally: ${installHint('node', deps.os)}`);
    // corepack avoids owning a global package, but resolves its version from the CWD project and
    // writes shims into Node's own bin dir, which a system-wide Node does not allow. Both commands
    // are printed because either can be the one that works on a given machine.
    if (missing.pnpm) {
      needApproval(`install pnpm ${MIN_PNPM} or newer globally: ${have('corepack')
        ? 'corepack enable pnpm (or npm install --global pnpm@latest)'
        : 'npm install --global pnpm@latest'}`);
    }
    if (missing.ffmpeg) {
      needApproval(`install FFmpeg globally: ${installHint('ffmpeg', deps.os)}`);
      if (ffmpegHasLocalRoute()) {
        say('FFmpeg can instead be installed to the app-data dir, which needs no admin rights: npx @veedstudio/openedit-cli install-ffmpeg');
      }
    }

    if (isWin && Object.values(missing).some(Boolean)) {
      // winget needs an interactive first run and its PATH edits never reach an already-running
      // process, so Windows GLOBAL installs stay manual: report, and keep the approval pending even
      // under --auto-approve rather than half-applying it.
      if (!have('winget')) say('no winget on this machine — install from git-scm.com, nodejs.org, and gyan.dev (FFmpeg) instead');
      // FFmpeg is the exception — handleLocalFfmpeg() applies the no-admin route.
      if (missing.git || missing.node || missing.pnpm) {
        say('Windows installs are manual in v1 — run the commands above, then re-run preflight from a NEW terminal (PATH changes need a fresh shell)');
      }
      return;
    }
    if (mode !== 'auto') return;
    needsApproval = false;
    if (missing.git) installBrewFormula('git');
    if (missing.node) installBrewFormula('node');
    if (missing.ffmpeg) installBrewFormula('ffmpeg');
    if (missing.pnpm) {
      // corepack enable only writes shims; which pnpm they resolve to comes from the CWD project's
      // own packageManager, which is the consumer's and may be below the floor or absent. A zero exit
      // is therefore not proof, and treating it as one skipped the npm fallback that would have
      // fixed it — leaving preflight to die a step later with nothing left to try.
      const viaCorepack = have('corepack')
        && ok(execTool('corepack', ['enable', 'pnpm'], { stdio: ['ignore', 2, 2] }))
        && pnpmOk();
      if (!viaCorepack) {
        if (!have('npm')) {
          say('npm is unavailable after installing Node');
          failed = true;
          return;
        }
        if (!ok(execTool('npm', ['install', '--global', 'pnpm@latest'], { stdio: ['ignore', 2, 2] }))) failed = true;
      }
    }
    if (!have('git') || !have('node') || !pnpmOk() || !ffmpegOk()) failed = true;
  };

  handleGlobalDependencies();
  if (failed) die('one or more approved global dependency installs failed');

  // The installer ships in this package, so the no-admin route needs no clone.
  const handleLocalFfmpeg = () => {
    if (!ffmpegHasLocalRoute() || !globalsMissing.ffmpeg || ffmpegOk()) return;
    if (mode === 'dry') {
      say('WOULD APPLY LOCALLY — npx @veedstudio/openedit-cli install-ffmpeg');
      return;
    }
    // Bare init performs this: it is workspace-local and needs no elevation, so only GLOBAL installs
    // wait for approval.
    say('installing FFmpeg into the app-data dir (no admin rights needed)');
    installFfmpegLocally();
    if (!ffmpegOk()) return;
    globalsMissing.ffmpeg = false;
    // Safe because only the global installs approve before here; renderer and runtime come later.
    if (!Object.values(globalsMissing).some(Boolean)) needsApproval = false;
  };

  handleLocalFfmpeg();
  if (failed) die('the local FFmpeg install failed');

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
      // Names the repository and ref, never the staging path: the finally below deletes that before
      // the error surfaces, and a directory the reader cannot open is not evidence.
      const cloneMarker = missingCheckoutMarker(cloned);
      if (cloneMarker) die(`cloned repository is not a valid Open Edit checkout — ${repository} (${ref}) has no ${cloneMarker}`);
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

  // `pnpm list` costs about 850ms, almost all of it pnpm's own boot, and this predicate is asked twice
  // in one init — once to decide whether to install, once again in the readiness summary. The answer
  // cannot change between those two calls unless install ran, which clears the memo itself.
  let depsReady: boolean | undefined;
  const repoDepsReady = () => (depsReady ??= computeRepoDepsReady());

  const computeRepoDepsReady = () => {
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
    depsReady = undefined;   // install changed the answer
    if (!repoDepsReady()) die('repository dependency validation failed after install');
  };

  handleRepoDeps();

  const enginePath = () => env.VEED_ENGINE_BIN || path.join(engineInstallDir(deps.os, env), engineBinaryName(deps.os));
  const latestEngineVersion = async () => {
    // No route answering means no update prompt, never a failed run — the floor check above already
    // catches a stale engine without asking anyone what the newest one is.
    const { tag } = await resolveLatestEngineTag(deps.fetch, 10_000);
    return tag.replace(/^weave-v/, ''); // upstream tag format is weave-v<semver>
  };
  // The binary prints `weave-viewer-cli <semver>`; a run that fails or prints nothing reads as ''.
  const engineVersion = (bin) => {
    const result = exec(bin, ['--version']);
    return result.error ? '' : ((result.stdout ?? '').toString().trim().split(/\s+/)[1] ?? '');
  };
  // The installer lives in the published CLI, not the runtime checkout; execTool routes npx
  // through cmd.exe on Windows (it installs as a .cmd shim there).
  const installEngine = () => ok(execTool('npx', ['--yes', '@veedstudio/openedit-cli', 'install-engine'], { stdio: ['ignore', 2, 2] }));

  // RE-READ and enforce, after any install: one that exits 0 without raising the
  // version (download failed softly, or the published release is still older than
  // the floor) would otherwise be reported as ready, and the run would die inside
  // the WCAG pass on an unknown flag instead.
  const assertEngineFloor = (engine) => {
    const installed = engineVersion(engine);
    if (!versionAtLeast(installed, MIN_ENGINE)) {
      die(`renderer is ${installed || 'unreadable'} after installing, below the required ${MIN_ENGINE} — the safe-zone check and the WCAG pass cannot run`);
    }
    say(`renderer ${installed} — meets the ${MIN_ENGINE} floor`);
  };

  const handleRenderer = async () => {
    if (rootKind === 'missing') return;
    const engine = enginePath();
    if (!isEngineRunnable(engine, deps.os)) {
      if (mode === 'dry') {
        say(`WOULD APPLY LOCALLY — install the renderer in ${engineInstallDir(deps.os, env)}`);
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
        needApproval(`update renderer from ${installed || 'an unreadable version'} to at least ${MIN_ENGINE} (the safe-zone check needs --verify=<rules>, the WCAG pass its bundled analyzer)`);
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

