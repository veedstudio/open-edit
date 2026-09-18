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
// invoking this package's session-start command — the skill itself implements no setup.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { contentRoot, findWorkspace, packageRoot } from '../config.ts';

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
const PACKAGE_NAME = '@veedstudio/openedit-cli';
const REGISTRY_DEFAULT = 'https://registry.npmjs.org';


export const usage = {
  summary: 'Workspace setup: check/install dependencies, clone the runtime, verify the engine',
  flags: {
    dry: { type: 'boolean', help: 'Report only; never write' },
    'auto-approve': { type: 'boolean', help: 'Also install machine-global dependencies and apply clean updates; only after the user approved every action --dry reported' },
    workspace: { type: 'string', value: '<path>', help: 'The workspace to set up (default: the nearest project, else the git toplevel, else cwd)' },
    repository: { type: 'string', value: '<url-or-path>', help: 'Where the runtime is cloned from' },
    ref: { type: 'string', value: '<branch>', help: 'The runtime branch to clone' },
  },
  notes: 'Bare init applies only workspace-local first-time setup.',
} satisfies Usage;

const USAGE = `${usageLine('init', usage)}\n\n${usage.notes}`;

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
    // Seams for tests. A checkout's package.json carries no version — it is stamped at pack time.
    contentDir: contentRoot(),
    cliVersion: readOwnVersion(),
  };
}

function readOwnVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
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
  // One entry per approval: a shared boolean let one handler's auto-approval erase another's.
  const pendingApprovals = new Set();
  let failed = false;
  const needApproval = (msg) => {
    pendingApprovals.add(msg);
    say(`APPROVAL REQUIRED — ${msg}`);
    return msg;
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

  let values;
  try {
    ({ values } = parseUsage('init', usage, argv));
  } catch (error) {
    deps.err(USAGE);
    die(error.message);
  }
  const mode = values['auto-approve'] ? 'auto' : values.dry ? 'dry' : 'apply';
  const workspaceArg = values.workspace ?? '';
  let repositoryArg = values.repository ?? '';
  const refArg = values.ref ?? '';
  for (const value of [workspaceArg, repositoryArg, refArg]) {
    if (/[\n\r]/.test(value)) die('arguments may not contain newlines');
  }

  let workspace;
  if (workspaceArg) {
    workspace = resolveDir(workspaceArg) ?? die(`workspace does not exist: ${workspaceArg}`);
  } else {
    // An existing project outranks the git toplevel, or a session opened in runs/<key> would
    // scaffold a second project around the first.
    const found = findWorkspace(process.cwd());
    const top = found ? null : exec('git', ['rev-parse', '--show-toplevel']);
    workspace = (found && resolveDir(found))
      || (top && ok(top) && resolveDir(out(top)))
      || fs.realpathSync.native(process.cwd());
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

  // Set when a managed clone should promote to packaged content (deleting it is the user's call).
  let promoteFrom = '';

  const discoverRuntime = () => {
    if (isOpenEditCheckout(workspace)) {
      // The content is all this needs, and a ZIP download still has it. Never falls through to the
      // package path, where the scaffold would mutate the checkout's own files.
      root = workspace;
      rootKind = 'reused';
      if (!ok(exec('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']))) {
        say(`${workspace} is an Open Edit source tree but not a Git work tree — using its content; runtime updates are unavailable`);
      }
      return;
    }
    // Only an explicit --repository/--ref pin keeps the clone path, and that clone must validate.
    if (!repositoryArg && !refArg) {
      if (isOpenEditCheckout(managedRoot)) {
        // A non-default receipt is a deliberate pin; only DEFAULT-path clones promote.
        const statePath = statePathFor(managedRoot);
        const pinned = statePath && fs.existsSync(statePath)
          && (stateGet(statePath, 'repository') !== DEFAULT_REPOSITORY || stateGet(statePath, 'ref') !== DEFAULT_REF);
        // Promotion would leave the user's own edits in a directory nothing reads again.
        const dirty = Boolean(out(exec('git', ['-C', managedRoot, 'status', '--porcelain'])));
        const moved = Boolean(statePath && fs.existsSync(statePath)
          && out(exec('git', ['-C', managedRoot, 'rev-parse', 'HEAD'])) !== stateGet(statePath, 'installedCommit'));
        if (!pinned && (dirty || moved)) {
          say(`the managed clone at ${managedRoot} has ${dirty ? 'local changes' : 'moved off its recorded revision'} — keeping it rather than promoting to packaged content`);
        }
        if (!pinned && !dirty && !moved) {
          promoteFrom = managedRoot;
          root = workspace;
          rootKind = 'package';
          return;
        }
      } else {
        root = workspace;
        rootKind = 'package';
        return;
      }
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

  // Pointing --workspace at the wrong directory silently runs different code.
  const warnBypassedCheckout = () => {
    const invokedTop = exec('git', ['rev-parse', '--show-toplevel']);
    const invokedFrom = ok(invokedTop) ? resolveDir(out(invokedTop)) : null;
    if (invokedFrom && isOpenEditCheckout(invokedFrom) && invokedFrom !== workspace) {
      say(`NOTE: this command ran from the checkout ${invokedFrom}, which will NOT be used.`);
      say(`      To run that code instead, pass --workspace ${invokedFrom}`);
    }
  };
  if (rootKind === 'reused') {
    say(`reusing the local checkout at ${root}`);
  } else if (rootKind === 'package') {
    say(`workspace ${workspace} uses the packaged content (self-contained; no clone)`);
    warnBypassedCheckout();
  } else {
    say(`workspace ${workspace} will use a managed clone at ${managedRoot}`);
    warnBypassedCheckout();
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

  const globalApprovals = { git: '', node: '', pnpm: '', ffmpeg: '' };

  const handleGlobalDependencies = () => {
    // The package path needs neither: the scaffold skips git init silently, and nothing is
    // pnpm-installed.
    const missing = {
      git: rootKind !== 'package' && !have('git'),
      node: !have('node'),
      pnpm: rootKind !== 'package' && !pnpmOk(),
      ffmpeg: !ffmpegOk(),
    };
    globalsMissing = missing;
    if (missing.git) globalApprovals.git = needApproval(`install Git globally: ${installHint('git', deps.os)}`);
    if (missing.node) globalApprovals.node = needApproval(`install Node globally: ${installHint('node', deps.os)}`);
    // corepack avoids owning a global package, but resolves its version from the CWD project and
    // writes shims into Node's own bin dir, which a system-wide Node does not allow. Both commands
    // are printed because either can be the one that works on a given machine.
    if (missing.pnpm) {
      globalApprovals.pnpm = needApproval(`install pnpm ${MIN_PNPM} or newer globally: ${have('corepack')
        ? 'corepack enable pnpm (or npm install --global pnpm@latest)'
        : 'npm install --global pnpm@latest'}`);
    }
    if (missing.ffmpeg) {
      globalApprovals.ffmpeg = needApproval(`install FFmpeg globally: ${installHint('ffmpeg', deps.os)}`);
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
    for (const key of Object.keys(globalApprovals)) pendingApprovals.delete(globalApprovals[key]);
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
    // Mirrors the requirements above: the package path never demanded Git or pnpm.
    if (!have('node') || !ffmpegOk() || (rootKind !== 'package' && (!have('git') || !pnpmOk()))) failed = true;
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
    pendingApprovals.delete(globalApprovals.ffmpeg);
  };

  handleLocalFfmpeg();
  if (failed) die('the local FFmpeg install failed');

  // ---------- the package path: promotion off the managed clone + project scaffold ----------

  const packageManagerFor = (dir) => {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    return 'npm';
  };
  const pmAddArgs = (pm, spec) => (pm === 'npm'
    ? ['install', '--save-dev', '--save-exact', spec]
    : pm === 'yarn'
      ? ['add', '--dev', '--exact', spec]
      : ['add', '--save-dev', '--save-exact', spec]);
  const ownVersion = () => deps.cliVersion ?? '';
  const workspacePin = () => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
      return pkg.devDependencies?.[PACKAGE_NAME] ?? pkg.dependencies?.[PACKAGE_NAME] ?? '';
    } catch {
      return '';
    }
  };
  // What the PROJECT runs: the pin can be a tarball or a range, and this CLI is usually an npx copy.
  const workspaceInstalledVersion = () => {
    try {
      const file = path.join(workspace, 'node_modules', PACKAGE_NAME, 'package.json');
      return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? '';
    } catch {
      return '';
    }
  };
  // The skill travels with the content, so a pinned checkout installs ITS skill beside its recipes.
  const skillSource = () => path.join(deps.contentDir, '.claude', 'skills', 'open-edit');

  // Prefs move so the provider question is not re-asked; the clone is left untouched.
  const handlePromotion = () => {
    if (rootKind !== 'package' || !promoteFrom) return;
    const from = path.join(promoteFrom, '.open-edit-prefs.json');
    const to = path.join(workspace, '.open-edit-prefs.json');
    const carry = fs.existsSync(from) && !fs.existsSync(to);
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — promote off the managed clone${carry ? ' (carrying .open-edit-prefs.json to the workspace)' : ''}`);
      return;
    }
    if (carry) {
      try {
        fs.copyFileSync(from, to);
      } catch (error) {
        say(`could not carry .open-edit-prefs.json from the old runtime (${error?.message ?? error}); the provider question will be asked again`);
      }
    }
    say(`promoted to packaged content — the managed clone at ${promoteFrom} is no longer used and can be deleted`);
  };

  handlePromotion();

  // Set once the consent gate has passed: this workspace is an OpenEdit project, or is becoming one.
  let workspaceUsable = false;

  // Two agents in one project both fire session-start, and npm takes no cross-process lock. A
  // lease, not a lock: a crashed init must not wedge later sessions, so a stale one is broken.
  const LEASE_MS = 10 * 60 * 1000;
  const withInitLease = async (work) => {
    if (mode === 'dry') return await work();
    const key = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 16);
    const lease = path.join(path.dirname(engineInstallDir(deps.os, env)), 'locks', `init-${key}`);
    let held = false;
    try {
      fs.mkdirSync(path.dirname(lease), { recursive: true });
      try {
        fs.mkdirSync(lease);
        held = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (Date.now() - fs.statSync(lease).mtimeMs < LEASE_MS) {
          say('another setup is already running in this workspace — leaving it to finish');
          return undefined;
        }
        fs.rmSync(lease, { recursive: true, force: true });
        fs.mkdirSync(lease);
        held = true;
      }
    } catch {
      // An unwritable app-data dir is not a reason to refuse setup.
      return await work();
    }
    try {
      return await work();
    } finally {
      if (held) {
        try {
          fs.rmSync(lease, { recursive: true, force: true });
        } catch { /* the next run breaks it by age */ }
      }
    }
  };

  // Workspace-local (bare-init tier) and idempotent: present means untouched.
  const handleProjectScaffold = () => {
    if (rootKind !== 'package') return;
    const pkgPath = path.join(workspace, 'package.json');
    const ignorePath = path.join(workspace, '.gitignore');
    const skillDest = path.join(workspace, '.claude', 'skills', 'open-edit');
    const skillSrc = skillSource();

    // A folder holding someone's files is never claimed silently.
    const IGNORABLE = new Set(['.DS_Store', '.git', '.gitignore', '.claude', '.codex', '.gemini', '.agents', '.open-edit', '.open-edit-prefs.json', 'runs']);
    const claimed = () => Boolean(promoteFrom)
      || fs.existsSync(path.join(workspace, '.open-edit-prefs.json'))
      || fs.existsSync(skillDest)
      || Boolean(workspacePin());
    const emptyEnough = () => {
      try {
        return fs.readdirSync(workspace).every((name) => IGNORABLE.has(name));
      } catch {
        return false;
      }
    };
    if (mode !== 'auto' && !claimed() && !emptyEnough()) {
      needApproval(`use ${workspace} as the OpenEdit project — it already holds other files; re-run with --auto-approve to use it anyway, or pass --workspace <folder> to pick another location (a fresh subfolder such as ${path.join(workspace, 'openedit')} keeps it separate)`);
      return;
    }

    workspaceUsable = true;

    const needPkg = !fs.existsSync(pkgPath);
    const gitUsable = have('git');
    const inRepo = gitUsable && ok(exec('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']));
    const ignoreLines = (() => {
      const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/) : [];
      // node_modules/ because the pin below installs one where git init just started tracking.
      return ['node_modules/', 'runs/', '.open-edit/', '.open-edit-prefs.json'].filter((line) => !existing.includes(line));
    })();
    const pinned = needPkg ? '' : workspacePin();

    // First because `claimed()` reads it back: a run that dies at the pin must not return to a
    // folder it made non-empty itself and demand approval for it.
    const refreshSkill = () => {
      if (!fs.existsSync(skillSrc)) {
        say(`skill refresh skipped — no skill at ${skillSrc}`);
        return;
      }
      // `npx skills add` symlinks this at .agents/skills/open-edit; replacing the LINK would leave
      // every other agent on a copy that never updates again.
      let dest = skillDest;
      try {
        if (fs.lstatSync(skillDest).isSymbolicLink()) dest = fs.realpathSync(skillDest);
      } catch { /* absent, or a broken link: the plain path is the destination */ }
      try {
        // Replace, never merge: cpSync alone leaves behind files a newer version dropped.
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(skillSrc, dest, { recursive: true });
        say(`skill refreshed — ${dest === skillDest ? path.join('.claude', 'skills', 'open-edit') : dest}`);
      } catch (error) {
        // An editor or another agent holding a file here must not abort every session on the machine.
        say(`could not refresh the open-edit skill at ${dest} (${error?.message ?? error}); the agent may be reading an older copy`);
      }
    };

    if (mode === 'dry') {
      if (fs.existsSync(skillSrc)) say('WOULD APPLY LOCALLY — install/refresh the open-edit skill in .claude/skills/open-edit');
      if (needPkg) say('WOULD APPLY LOCALLY — create a minimal private package.json');
      if (gitUsable && !inRepo) say('WOULD APPLY LOCALLY — git init');
      if (ignoreLines.length) say(`WOULD APPLY LOCALLY — .gitignore entries: ${ignoreLines.join(' ')}`);
      if (!pinned) say(`WOULD APPLY LOCALLY — pin ${PACKAGE_NAME} as an exact devDependency (${packageManagerFor(workspace)})`);
      return;
    }

    refreshSkill();
    if (needPkg) {
      // npm-safe name from the folder; the project is private, so the name only has to be valid.
      const name = path.basename(workspace).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '') || 'openedit-project';
      fs.writeFileSync(pkgPath, `${JSON.stringify({ name, private: true }, null, 2)}\n`);
      say('created a minimal private package.json');
    }
    if (gitUsable && !inRepo) {
      if (ok(exec('git', ['init', '--quiet'], { cwd: workspace }))) say('initialized a git repository');
      else say('git init failed; continuing without one');
    }
    if (ignoreLines.length) {
      const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
      const glue = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(ignorePath, `${glue}${ignoreLines.join('\n')}\n`);
      say(`ignored in git: ${ignoreLines.join(' ')}`);
    }
    if (!pinned) {
      // Pins ITS OWN version so the project runs what init ran; OPENEDIT_PACKAGE_SOURCE overrides.
      const spec = env.OPENEDIT_PACKAGE_SOURCE || (ownVersion() ? `${PACKAGE_NAME}@${ownVersion()}` : `${PACKAGE_NAME}@latest`);
      const pm = packageManagerFor(workspace);
      if (pm !== 'npm' && !have(pm)) {
        // Installing with a different manager would fork the project's lockfiles; the pin waits.
        needApproval(`install ${pm} globally: npm install --global ${pm}@latest — this project's lockfile makes ${pm} its package manager, and the CLI pin waits for it`);
      } else if (!have('npm') && pm === 'npm') {
        say('npm is unavailable — the project cannot be pinned to a CLI version yet');
        failed = true;
        return;
      } else {
        say(`pinning ${spec} as an exact devDependency (${pm})`);
        if (!ok(execTool(pm, pmAddArgs(pm, spec), { cwd: workspace, stdio: ['ignore', 2, 2] }))) {
          say(`could not install ${spec} with ${pm} — the project is not pinned to a CLI version yet`);
          failed = true;
          return;
        }
      }
    }
    // Carried once, never overwritten, so an upgrade cannot re-ask the provider question.
    const legacyPrefs = path.join(path.dirname(engineInstallDir(deps.os, env)), '.open-edit-prefs.json');
    const prefsDest = path.join(workspace, '.open-edit-prefs.json');
    if (!fs.existsSync(prefsDest) && fs.existsSync(legacyPrefs)) {
      try {
        fs.copyFileSync(legacyPrefs, prefsDest);
        say('carried .open-edit-prefs.json from the app-data dir — the provider choice travels with the upgrade');
      } catch (error) {
        say(`could not carry .open-edit-prefs.json from the app-data dir (${error?.message ?? error})`);
      }
    }
  };

  await withInitLease(handleProjectScaffold);
  if (failed) die('project setup failed');

  // Advisory: a hook problem must not block a run. Never written into a workspace the consent gate
  // declined, or a refused folder would keep spawning session-start every session.
  if (rootKind !== 'package' || workspaceUsable) {
    if (mode === 'dry') {
      say('WOULD APPLY LOCALLY — SessionStart hooks in the workspace agent configs (.claude/.codex/.gemini)');
    } else {
      try {
        installProjectHooks(workspace, (line) => say(line));
      } catch (error) {
        say(`could not install project hooks automatically (${error?.message ?? error}); the agent must preserve existing settings and add them manually`);
      }
    }
  }

  // Read from disk: inferring them from the root kind made --dry call an untouched folder ready.
  const workspaceScaffolded = () =>
    fs.existsSync(path.join(workspace, 'package.json'))
    && Boolean(workspacePin())
    && (!fs.existsSync(skillSource())
      || fs.existsSync(path.join(workspace, '.claude', 'skills', 'open-edit', 'SKILL.md')));

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
    if (rootKind === 'missing' || rootKind === 'package') return;
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
    const approval = needApproval(`update renderer from ${installed} to ${latest}`);
    if (mode === 'auto') {
      pendingApprovals.delete(approval);
      if (!installEngine()) die('approved renderer update failed');
    }
  };

  await handleRenderer();

  // A patch or minor whose declared engine floor is met applies silently; anything else waits.
  // Every lookup failure is silent: an offline session must still start clean.
  const handlePackageUpdate = async () => {
    if (rootKind !== 'package') return;
    if (!workspacePin()) return; // the scaffold owns adding the dep; nothing to update without it
    // Never ownVersion(): this CLI is usually an npx copy, and grading that either froze the pin or
    // reinstalled it every session.
    const installed = workspaceInstalledVersion();
    // No readable install (a checkout) and 0.0.0-* (CI stamps, local packs) are unpublished space.
    if (!installed || installed.startsWith('0.0.0-')) return;
    const registry = (env.OPENEDIT_REGISTRY || REGISTRY_DEFAULT).replace(/\/+$/, '');
    let doc;
    try {
      // The `latest` manifest, not the packument: that grows with every release, and this runs on
      // every session start for two fields.
      const res = await deps.fetch(`${registry}/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      doc = await res.json();
    } catch {
      return;
    }
    const latest = doc?.version;
    if (typeof latest !== 'string' || !latest) return;
    if (latest.includes('-')) return; // a prerelease latest is never auto-installed
    if (versionAtLeast(installed, latest)) return; // current, or the registry moved BACK — never downgrade
    const majorBump = Number(latest.split('.')[0]) > Number(installed.split('.')[0]);
    const minEngine = doc?.openedit?.minEngine;
    const engineNow = engineVersion(enginePath());
    const floorSatisfied = typeof minEngine === 'string' && versionAtLeast(engineNow, minEngine);
    // In --dry the renderer does not exist yet, so a declared floor cannot be graded.
    if (mode === 'dry' && !majorBump && typeof minEngine === 'string' && !floorSatisfied
      && !isEngineRunnable(enginePath(), deps.os)) {
      say(`WOULD APPLY LOCALLY — update ${PACKAGE_NAME} ${installed} → ${latest} (engine floor ${minEngine} is checked after the renderer install)`);
      return;
    }
    if (majorBump || !floorSatisfied) {
      const why = majorBump
        ? 'a major release'
        : typeof minEngine !== 'string'
          ? 'it does not declare its engine floor'
          : `it needs engine ${minEngine} and ${engineNow || 'no readable engine'} is installed`;
      const approval = needApproval(`update ${PACKAGE_NAME} from ${installed} to ${latest} — ${why}`);
      if (mode !== 'auto') return;
      pendingApprovals.delete(approval);
    }
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — update ${PACKAGE_NAME} ${installed} → ${latest}`);
      return;
    }
    const pm = packageManagerFor(workspace);
    if (pm !== 'npm' && !have(pm)) {
      say(`update to ${latest} is waiting for ${pm} (this project's package manager) — staying on ${installed}`);
      return;
    }
    if (ok(execTool(pm, pmAddArgs(pm, `${PACKAGE_NAME}@${latest}`), { cwd: workspace, stdio: ['ignore', 2, 2] }))) {
      say(`updated ${PACKAGE_NAME} ${installed} → ${latest}`);
    } else {
      // Non-fatal: the pin and the lockfile are untouched, and the next session retries.
      say(`update to ${latest} failed — staying on ${installed}; the next session will retry`);
    }
  };

  await withInitLease(handlePackageUpdate);

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
    const approval = needApproval(`fast-forward runtime from ${localCommit} to ${remoteCommit} (${repository} ${ref})`);
    if (mode === 'auto') {
      pendingApprovals.delete(approval);
      if (!ok(exec('git', ['-C', root, 'fetch', 'origin', `refs/heads/${ref}:refs/remotes/origin/${ref}`], { stdio: ['ignore', 2, 2] }))) die('approved runtime fetch failed');
      if (!ok(exec('git', ['-C', root, 'merge-base', '--is-ancestor', localCommit, remoteCommit]))) die('remote update is not a fast-forward');
      if (!ok(exec('git', ['-C', root, 'merge', '--ff-only', remoteCommit], { stdio: ['ignore', 2, 2] }))) die('approved runtime update failed');
      writeState(root, repository, ref, remoteCommit);
    }
  };

  handleRuntimeUpdate();

  if (rootKind === 'missing') {
    say('runtime is not ready');
  } else if ((rootKind === 'package' ? workspaceScaffolded() : repoDepsReady()) && isEngineRunnable(enginePath(), deps.os)) {
    say(`ready — OPEN_EDIT_ROOT=${root}`);
  } else if (pendingApprovals.size > 0) {
    say('local setup is incomplete because an approved prerequisite is missing');
  } else {
    // Nothing is awaiting approval: the outstanding work is the WOULD APPLY LOCALLY list above, which
    // bare preflight performs itself. Saying "approval" here sent agents looking for a user to ask.
    say('not ready yet — run bare preflight (no --dry) to apply the local setup listed above');
  }

  if (pendingApprovals.size > 0) {
    say('run with --auto-approve only after the user approves every action above');
    return 10;
  }
  if (failed) return 1;
  deps.out(root);
  return 0;
}

