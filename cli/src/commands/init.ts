// @ts-nocheck — its behavior is pinned by cli/tests/init.test.ts and init-package.test.ts, not by types.
//
// Open Edit's single setup entrypoint.
//
//   openedit init                 Apply workspace-local setup; report global installs.
//   openedit init --dry           Report only; never write.
//   openedit init --auto-approve  Apply everything, including the global installs init can run here
//                                 (Node and FFmpeg through Homebrew on macOS, pnpm through corepack or
//                                 npm outside Windows; on Windows bare init already fetches FFmpeg into
//                                 app-data; the rest are printed for the user). The orchestrating agent
//                                 may use this only after explicit user approval.
//   openedit init --update <v>    Install exactly that published CLI version in the workspace. Never
//                                 implied by any other mode: a newer CLI is new code, and it runs once
//                                 the user has said yes to that version.
//
// A workspace is scaffolded as an npm project that pins this package; a contributor checkout of this
// package is used in place instead, with its own pnpm dependencies.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ffmpegInstallDir,
  findOnPath,
  installHint,
  isCmdShim,
  isRelease,
  stateDirFor,
  versionAtLeast,
} from '../platform.ts';
import { findProjectHooks, removeProjectHooks } from '../project-hooks.ts';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { PACKAGE_NAME, findWorkspace, hasCheckoutLayout, isOpenEditCheckout, packageRoot, resolveFfmpegPair } from '../config.ts';

export interface ExecResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}

// Floor, not a pin: any newer pnpm is accepted. Must equal the repository package.json's
// `packageManager`; cli/tests/init.test.ts holds the two together.
const MIN_PNPM = '10.16.1';

export const usage = {
  summary: 'Workspace setup: check/install dependencies, scaffold the project, install the skill',
  flags: {
    dry: { type: 'boolean', help: 'Report only; never write' },
    'auto-approve': { type: 'boolean', help: 'Also run the global installs init can run here (Homebrew on macOS, pnpm outside Windows); only after the user approved every action --dry reported' },
    update: { type: 'string', value: '<version>', help: 'Install exactly this published CLI version in the workspace and refresh its skill; only the version an update notice named, after the user said yes' },
    workspace: { type: 'string', value: '<path>', help: 'The workspace to set up (default: the nearest project, else the git toplevel, else cwd)' },
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
    err: (line) => process.stderr.write(`${line}\n`),
    out: (line) => process.stdout.write(`${line}\n`),
    // Seams for tests. A checkout's package.json carries no version — it is stamped at pack time.
    contentDir: packageRoot(),
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
  // Checked before anything is written: a mistyped version must not leave a half set-up folder behind.
  if (values.update !== undefined && !isRelease(values.update)) die(`--update takes the release version an update notice named, such as 1.4.0 — got "${values.update}"`);
  const workspaceArg = values.workspace ?? '';
  // The root is printed as one line on stdout and in the ready line the agent reads.
  if (/[\n\r]/.test(workspaceArg)) die('arguments may not contain newlines');

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

  // A checkout is used in place, ZIP downloads included. It never takes the package path, where the
  // scaffold would mutate the checkout's own files.
  const checkout = isOpenEditCheckout(workspace);
  if (values.update !== undefined && checkout) die('a checkout updates through git, not init --update');
  // A checkout whose package.json does not parse (a conflict mid-rebase) fails the name check, and the
  // scaffold would then treat it as a user's project and replace its tracked skill.
  if (!checkout && hasCheckoutLayout(workspace)) {
    const manifest = path.join(workspace, 'package.json');
    try {
      JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch (error) {
      die(`${manifest} cannot be read as JSON (${error?.message ?? error}), so init cannot tell whether this is an OpenEdit checkout — fix it, then re-run init`);
    }
  }

  // Pointing --workspace at the wrong directory silently runs different code.
  const warnBypassedCheckout = () => {
    const invokedTop = exec('git', ['rev-parse', '--show-toplevel']);
    const invokedFrom = ok(invokedTop) ? resolveDir(out(invokedTop)) : null;
    if (invokedFrom && isOpenEditCheckout(invokedFrom) && invokedFrom !== workspace) {
      say(`NOTE: this command ran from the checkout ${invokedFrom}, which will NOT be used.`);
      say(`      To run that code instead, pass --workspace ${invokedFrom}`);
    }
  };
  if (checkout) {
    say(`reusing the local checkout at ${workspace}`);
  } else {
    say(`workspace ${workspace} uses the packaged content`);
    warnBypassedCheckout();
  }

  // Taking back what an earlier init added needs no approval. It runs before the consent gate and every
  // install, so a workspace that never reaches ready still stops running a hook each session.
  if (mode === 'dry') {
    const stale = findProjectHooks(workspace);
    const editable = stale.filter((hook) => !hook.manual).map((hook) => hook.rel);
    if (editable.length) say(`WOULD APPLY LOCALLY — remove the SessionStart hooks an earlier version installed: ${editable.join(' ')}`);
    for (const hook of stale) if (hook.manual) say(hook.manual);
  } else {
    removeProjectHooks(workspace, say);
  }

  // config.ts's own resolution, run against the INJECTED env and platform, so init checks the pair every
  // command runs. An app-data binary is there by construction; any other must be found.
  const ffmpegPair = () => resolveFfmpegPair(env, (n) => {
    const file = path.join(ffmpegInstallDir(deps.os, env), 'bin', isWin ? `${n}.exe` : n);
    return fs.existsSync(file) ? file : null;
  });
  const ffmpegOk = () => {
    const { ffmpeg, ffprobe } = ffmpegPair();
    return [ffmpeg, ffprobe].every((tool) => tool.from === 'app-data install' || have(tool.bin));
  };
  // A platform question: the no-admin download route exists on Windows only (macOS has brew).
  const ffmpegHasLocalRoute = () => isWin;
  // By name alone, npx runs whatever the registry calls latest while the workspace holds no install yet,
  // so a published CLI names its own version, in what it runs and in what it prints.
  const selfSpec = isRelease(deps.cliVersion ?? '') ? `${PACKAGE_NAME}@${deps.cliVersion}` : PACKAGE_NAME;
  const installFfmpegLocally = () => {
    // stderr is inherited, so the installer's diagnostics reach the user directly. This run already
    // printed any update notice; the nested one would print it twice.
    const r = execTool('npx', ['--yes', selfSpec, 'install-ffmpeg'], { stdio: ['ignore', 2, 2], env: { ...env, NO_UPDATE_NOTIFIER: '1' } });
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

  // Kept at this scope so the local FFmpeg step can clear its entry and retract the approval.
  let globalsMissing = { node: false, pnpm: false, ffmpeg: false };

  const globalApprovals = { node: '', pnpm: '', ffmpeg: '' };
  // Approvals only the user can carry out: --auto-approve runs nothing for them, so the run must not
  // end by sending the agent back to --auto-approve.
  const userRunApprovals = new Set();

  const handleGlobalDependencies = () => {
    // No install can fix a broken override: every command would still run it. Each is named by its own
    // variable, since fixing or unsetting any other one cannot help.
    const pair = ffmpegPair();
    const brokenOverrides = ['OPENEDIT_FFMPEG', 'OPENEDIT_FFPROBE'].flatMap((variable) => {
      const named = [pair.ffmpeg, pair.ffprobe].filter((tool) => tool.from === variable);
      const unrunnable = named.filter((tool) => !have(tool.bin));
      if (!unrunnable.length) return [];
      const beside = unrunnable.includes(pair.ffprobe) && variable === 'OPENEDIT_FFMPEG' ? ', or set OPENEDIT_FFPROBE to an ffprobe elsewhere' : '';
      return [`${variable} is set, so every command runs ${named.map((tool) => tool.bin).join(' and ')}, but no executable file is at ${unrunnable.map((tool) => tool.bin).join(' or ')} — fix or unset it${beside}`];
    });
    if (brokenOverrides.length) die(brokenOverrides.join('; '));
    // Only a checkout installs anything with pnpm: its own dependencies.
    const missing = {
      node: !have('node'),
      pnpm: checkout && !pnpmOk(),
      ffmpeg: !ffmpegOk(),
    };
    globalsMissing = missing;
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
      say('an FFmpeg that is installed but not on PATH is used by setting OPENEDIT_FFMPEG to its path');
      if (ffmpegHasLocalRoute()) {
        say(`FFmpeg can instead be installed to the app-data dir, which needs no admin rights: npx ${selfSpec} install-ffmpeg`);
      }
    }

    // Who carries out each approved install. Only Homebrew puts Node and FFmpeg in a user-owned prefix:
    // winget needs an interactive first run and its PATH edits never reach an already-running process,
    // and any other system's package manager needs root, which init must never hold. pnpm comes from
    // corepack or npm, which need no root under a user-owned Node, so outside Windows init runs that
    // once Node is there. On Windows, FFmpeg takes handleLocalFfmpeg()'s no-admin route instead.
    const initRuns = {
      node: deps.os === 'darwin',
      ffmpeg: deps.os === 'darwin',
      pnpm: !isWin && (deps.os === 'darwin' || !missing.node),
    };
    const userRuns = Object.keys(missing)
      .filter((key) => missing[key] && !initRuns[key] && !(key === 'ffmpeg' && ffmpegHasLocalRoute()));
    for (const key of userRuns) userRunApprovals.add(globalApprovals[key]);
    if (isWin && Object.values(missing).some(Boolean) && !have('winget')) {
      say('no winget on this machine — install from nodejs.org and gyan.dev (FFmpeg) instead');
    }
    if (userRuns.length) {
      say(isWin
        ? 'Windows installs are manual: winget needs an interactive first run, and its PATH changes reach only a NEW terminal'
        : 'Node and FFmpeg installs here need root, so init never runs them');
    }
    if (mode !== 'auto') return;
    const initRunning = Object.keys(missing).filter((key) => missing[key] && initRuns[key]);
    for (const key of initRunning) pendingApprovals.delete(globalApprovals[key]);
    if (initRunning.includes('node')) installBrewFormula('node');
    if (initRunning.includes('ffmpeg')) installBrewFormula('ffmpeg');
    if (initRunning.includes('pnpm')) {
      // corepack enable only writes shims; which pnpm they resolve to comes from the CWD project's
      // own packageManager, which is the consumer's and may be below the floor or absent. A zero exit
      // is therefore not proof, and treating it as one skipped the npm fallback that would have
      // fixed it — leaving init to die a step later with nothing left to try.
      const viaCorepack = have('corepack')
        && ok(execTool('corepack', ['enable', 'pnpm'], { stdio: ['ignore', 2, 2] }))
        && pnpmOk();
      if (!viaCorepack) {
        if (!have('npm')) {
          say('npm is unavailable, so pnpm cannot be installed');
          failed = true;
          return;
        }
        if (!ok(execTool('npm', ['install', '--global', 'pnpm@latest'], { stdio: ['ignore', 2, 2] }))) failed = true;
      }
    }
    // Mirrors the requirements above, for what init installed.
    const stillMissing = { node: () => !have('node'), ffmpeg: () => !ffmpegOk(), pnpm: () => !pnpmOk() };
    if (initRunning.some((key) => stillMissing[key]())) failed = true;
  };

  handleGlobalDependencies();
  if (failed) die('one or more approved global dependency installs failed');

  // The installer ships in this package, so the no-admin route needs nothing else first.
  const handleLocalFfmpeg = () => {
    if (!ffmpegHasLocalRoute() || !globalsMissing.ffmpeg || ffmpegOk()) return;
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — npx ${selfSpec} install-ffmpeg`);
      return;
    }
    // Bare init performs this: it is workspace-local and needs no elevation, so only GLOBAL installs
    // wait for approval.
    say('installing FFmpeg into the app-data dir (no admin rights needed)');
    installFfmpegLocally();
    if (failed) return;
    // A zero exit that leaves nothing usable must still fail loudly, or the approval just sits there.
    if (!ffmpegOk()) {
      say('the local FFmpeg install exited cleanly, but no ffmpeg/ffprobe pair is usable afterwards');
      failed = true;
      return;
    }
    globalsMissing.ffmpeg = false;
    pendingApprovals.delete(globalApprovals.ffmpeg);
  };

  handleLocalFfmpeg();
  if (failed) die('the local FFmpeg install failed');

  // ---------- the package path: the project scaffold ----------

  const packageManagerFor = (dir) => {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    return 'npm';
  };
  // Installs run no lifecycle scripts: a project's postinstall is its own code, not init's to run. Flags as
  // well as the environment, because a project's own package-manager config outranks the environment.
  // npm also stays out of any workspaces root above the folder, whose node_modules it would otherwise use.
  const noScriptsArgs = (pm) => (pm === 'npm' ? ['--ignore-scripts', '--workspaces=false'] : pm === 'pnpm' ? ['--ignore-scripts', '--ignore-pnpmfile'] : ['--mode=skip-build']);
  const noScripts = { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true', YARN_IGNORE_SCRIPTS: 'true', YARN_ENABLE_SCRIPTS: 'false' };
  const pmAddArgs = (pm, spec) => (pm === 'npm'
    ? ['install', '--save-dev', '--save-exact', ...noScriptsArgs(pm), spec]
    : pm === 'yarn'
      ? ['add', '--dev', '--exact', ...noScriptsArgs(pm), spec]
      : ['add', '--save-dev', '--save-exact', ...noScriptsArgs(pm), spec]);
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
  // The scaffold installs the skill this CLI shipped with; an applied update below replaces it with
  // the new version's own.
  const skillSource = () => path.join(deps.contentDir, '.claude', 'skills', 'open-edit');
  // Claude Code reads .claude/skills; Codex and Gemini CLI read .agents/skills.
  const SKILL_DIRS = [path.join('.claude', 'skills', 'open-edit'), path.join('.agents', 'skills', 'open-edit')];

  // A path's real location, resolved through its nearest existing ancestor when it does not exist yet.
  const realLocation = (p) => {
    for (let cur = p; ; cur = path.dirname(cur)) {
      try {
        return path.join(fs.realpathSync.native(cur), path.relative(cur, p));
      } catch {
        if (path.dirname(cur) === cur) return p;
      }
    }
  };

  // A failed refresh fails the run: the agent must not be told ready while it reads a skill older than
  // the CLI it calls.
  const refreshSkillFrom = (skillSrc) => {
    if (!fs.existsSync(skillSrc)) {
      say(`skill refresh incomplete — no skill at ${skillSrc}, so the workspace skill is unchanged`);
      failed = true;
      return;
    }
    // Whether any part of the path below the workspace is a link; walking it, unlike comparing real paths,
    // does not mistake a case variant of a folder name for one.
    const linkOnTheWay = (rel) => {
      let cur = workspace;
      for (const part of rel.split(path.sep)) {
        cur = path.join(cur, part);
        const st = fs.lstatSync(cur, { throwIfNoEntry: false });
        if (!st) return false;
        if (st.isSymbolicLink()) return true;
      }
      return false;
    };
    const refreshed = new Set();
    for (const rel of SKILL_DIRS) {
      const skillDest = path.join(workspace, rel);
      // The recursive delete below must start only where a skill belongs. The one link followed is
      // `npx skills add` pointing one skill dir at the other, since replacing that would leave the agents
      // reading the other path on a copy that never updates; any other link is replaced, never followed.
      let dest = realLocation(skillDest);
      if (linkOnTheWay(rel)) {
        const other = SKILL_DIRS.find((r) => r !== rel && !linkOnTheWay(r));
        if (!other || dest !== realLocation(path.join(workspace, other))) {
          if (linkOnTheWay(path.dirname(rel))) {
            say(`skill refresh incomplete — ${path.dirname(rel)} is a link, so init writes nothing through it`);
            failed = true;
            continue;
          }
          say(`replacing ${rel}, a link to ${dest}, with a copy; what it pointed at is untouched`);
          dest = skillDest;
        }
      }
      if (refreshed.has(dest)) continue;
      refreshed.add(dest);
      try {
        // The link goes on its own first, so the recursive delete can never begin at its target.
        if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dest);
        // Replace, never merge: cpSync alone leaves behind files a newer version dropped.
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(skillSrc, dest, { recursive: true });
        say(`skill refreshed — ${dest === skillDest || !linkOnTheWay(rel) ? rel : dest}`);
      } catch (error) {
        say(`skill refresh incomplete — could not replace ${dest} (${error?.message ?? error}); the skill there may be missing, partial or older than the CLI`);
        failed = true;
      }
    }
  };

  // Two agents in one project can run init at once, and npm takes no cross-process lock. A
  // lease, not a lock: a crashed init must not wedge later runs, so a stale one is broken.
  const LEASE_MS = 10 * 60 * 1000;
  const withInitLease = async (work) => {
    if (mode === 'dry') return await work();
    const key = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 16);
    const lease = path.join(stateDirFor(deps.os, env), 'locks', `init-${key}`);
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
    if (checkout) return;
    const pkgPath = path.join(workspace, 'package.json');
    const ignorePath = path.join(workspace, '.gitignore');
    const skillDest = path.join(workspace, '.claude', 'skills', 'open-edit');
    const skillSrc = skillSource();

    // A folder holding someone's files is never claimed silently.
    const IGNORABLE = new Set(['.DS_Store', '.git', '.gitignore', '.claude', '.codex', '.gemini', '.agents', '.open-edit-prefs.json', 'runs']);
    const claimed = () => fs.existsSync(path.join(workspace, '.open-edit-prefs.json'))
      || fs.existsSync(skillDest)
      || Boolean(workspacePin());
    const emptyEnough = () => {
      try {
        return fs.readdirSync(workspace).every((name) => IGNORABLE.has(name));
      } catch {
        return false;
      }
    };
    const pm = packageManagerFor(workspace);
    const foreignInstall = () => `add ${PACKAGE_NAME} to ${workspace} with ${pm}: this project's own package.json, lockfile and ${pm} config decide what that install fetches and may run`;
    if (mode !== 'auto' && !claimed() && !emptyEnough()) {
      needApproval(`use ${workspace} as the OpenEdit project — it already holds other files; re-run with --auto-approve to use it anyway, or pass --workspace <folder> to pick another location (a fresh subfolder such as ${path.join(workspace, 'openedit')} keeps it separate)`);
      // Named now, so the one --auto-approve that follows was approved for this install too.
      if (fs.existsSync(pkgPath) && !workspacePin() && have(pm)) needApproval(foreignInstall());
      return;
    }

    const needPkg = !fs.existsSync(pkgPath);
    const gitUsable = have('git');
    const inRepo = gitUsable && ok(exec('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']));
    const ignoreLines = (() => {
      const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/) : [];
      // node_modules/ because the pin below installs one where git init just started tracking.
      return ['node_modules/', 'runs/', '.open-edit-prefs.json'].filter((line) => !existing.includes(line));
    })();
    const pinned = needPkg ? '' : workspacePin();
    // A clone, or a deleted node_modules: until the pin is installed, every `npx @veedstudio/openedit-cli`
    // runs whatever the registry calls latest instead of the version the project pins.
    const pinMissing = Boolean(pinned) && !workspaceInstalledVersion();
    if (pinMissing && fs.existsSync(path.join(workspace, '.pnp.cjs'))) {
      die(`this project installs with Yarn Plug'n'Play, and npx runs ${PACKAGE_NAME} only from node_modules — set nodeLinker: node-modules in .yarnrc.yml, then run init again`);
    }
    // Installing into a project init did not create obeys its lockfile, pin, package-manager config and any
    // committed node_modules, which no flag can vet (yarn runs a configured yarnPath before anything else),
    // so that install is the user's call. A folder holding only init's own files, its minimal manifest from
    // an earlier run that stopped short included, is still init's.
    const ownManifest = needPkg || (() => {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return Object.keys(pkg).every((key) => key === 'name' || key === 'private')
          && fs.readdirSync(workspace).every((name) => IGNORABLE.has(name) || name === 'package.json');
      } catch {
        return false;
      }
    })();
    const foreignPin = !pinned && !ownManifest;
    const installApproval = (pinMissing || foreignPin) && have(pm)
      ? needApproval(pinMissing
        ? `${pm} install in ${workspace}: the pinned ${PACKAGE_NAME} (${pinned}) is missing from node_modules, and the install fetches and may run what this project's lockfile and ${pm} config name`
        : foreignInstall())
      : '';

    if (mode === 'dry') {
      if (fs.existsSync(skillSrc)) say(`WOULD APPLY LOCALLY — install/refresh the open-edit skill in ${SKILL_DIRS.join(' and ')}`);
      if (needPkg) say('WOULD APPLY LOCALLY — create a minimal private package.json');
      if (gitUsable && !inRepo) say('WOULD APPLY LOCALLY — git init');
      if (ignoreLines.length) say(`WOULD APPLY LOCALLY — .gitignore entries: ${ignoreLines.join(' ')}`);
      if (!pinned) say(`WOULD APPLY LOCALLY — pin ${PACKAGE_NAME} as an exact devDependency (${packageManagerFor(workspace)})`);
      return;
    }

    // First because `claimed()` reads it back: a run that dies at the pin must not return to a
    // folder it made non-empty itself and demand approval for it.
    refreshSkillFrom(skillSrc);
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
    if (!pinned || pinMissing) {
      if (pm !== 'npm' && !have(pm)) {
        // Installing with a different manager would fork the project's lockfiles; the pin waits. The user
        // runs this one: a global npm install needs root under a system Node, which init must never hold.
        userRunApprovals.add(needApproval(`install ${pm} globally: npm install --global ${pm}@latest — this project's lockfile makes ${pm} its package manager, and installing the CLI waits for it`));
      } else if (!have('npm') && pm === 'npm') {
        say('npm is unavailable — the project cannot be pinned to a CLI version yet');
        failed = true;
        return;
      } else if (pinned && mode === 'auto') {
        pendingApprovals.delete(installApproval);
        say(`installing the pinned ${PACKAGE_NAME} (${pinned}) with ${pm}`);
        if (!ok(execTool(pm, ['install', ...noScriptsArgs(pm)], { cwd: workspace, stdio: ['ignore', 2, 2], env: noScripts }))) {
          say(`could not install the project's dependencies with ${pm} — the pinned CLI is not installed`);
          failed = true;
          return;
        }
        // This copy of init may be another version than the one just installed; the agent must read the
        // skill of the CLI it will call.
        refreshSkillFrom(path.join(workspace, 'node_modules', ...PACKAGE_NAME.split('/'), '.claude', 'skills', 'open-edit'));
      } else if (!pinned && (!foreignPin || mode === 'auto')) {
        pendingApprovals.delete(installApproval);
        // Pins ITS OWN version so the project runs what init ran; OPENEDIT_PACKAGE_SOURCE overrides.
        const spec = env.OPENEDIT_PACKAGE_SOURCE || (ownVersion() ? `${PACKAGE_NAME}@${ownVersion()}` : `${PACKAGE_NAME}@latest`);
        say(`pinning ${spec} as an exact devDependency (${pm})`);
        if (!ok(execTool(pm, pmAddArgs(pm, spec), { cwd: workspace, stdio: ['ignore', 2, 2], env: noScripts }))) {
          say(`could not install ${spec} with ${pm} — the project is not pinned to a CLI version yet`);
          failed = true;
          return;
        }
      }
    }
    // Carried once, never overwritten, so an upgrade cannot re-ask the provider question.
    const legacyPrefs = path.join(stateDirFor(deps.os, env), '.open-edit-prefs.json');
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

  // Read from disk: inferred from the path taken, --dry would call an untouched folder ready.
  const workspaceScaffolded = () =>
    fs.existsSync(path.join(workspace, 'package.json'))
    && Boolean(workspacePin())
    && Boolean(workspaceInstalledVersion())
    && (!fs.existsSync(skillSource())
      || fs.existsSync(path.join(workspace, '.claude', 'skills', 'open-edit', 'SKILL.md')));

  // `pnpm list` costs about 850ms, almost all of it pnpm's own boot, and this predicate is asked twice
  // in one init — once to decide whether to install, once again in the final summary. The answer
  // cannot change between those two calls unless install ran, which clears the memo itself.
  let depsReady: boolean | undefined;
  const repoDepsReady = () => (depsReady ??= computeRepoDepsReady());

  const computeRepoDepsReady = () => {
    const tsx = path.join(workspace, 'node_modules', '.bin', 'tsx');
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
    const modulesYaml = path.join(workspace, 'node_modules', '.modules.yaml');
    if (!fs.existsSync(modulesYaml)) return false;
    const recordedPnpm = fs.readFileSync(modulesYaml, 'utf8').split(/\r?\n/)
      .map((line) => line.match(/^packageManager:\s*pnpm@([^\s"']*)/)?.[1])
      .find(Boolean) ?? '';
    return versionAtLeast(recordedPnpm, MIN_PNPM) && ok(execTool('pnpm', ['list', '--depth', '0'], { cwd: workspace }));
  };

  const handleRepoDeps = () => {
    if (!checkout) return;
    if (repoDepsReady()) {
      say('repository dependencies — ready');
      return;
    }
    if (!have('node') || !pnpmOk()) {
      say('repository dependencies are waiting for approved Node/pnpm installation');
      return;
    }
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — pnpm install --frozen-lockfile in ${workspace}`);
      return;
    }
    say(`installing repository dependencies in ${workspace}`);
    if (!ok(execTool('pnpm', ['install', '--frozen-lockfile'], { cwd: workspace, stdio: ['ignore', 2, 2] }))) die('repository dependency installation failed');
    depsReady = undefined;   // install changed the answer
    if (!repoDepsReady()) die('repository dependency validation failed after install');
  };

  handleRepoDeps();

  // Exactly the version an update notice named and the user said yes to: the registry's latest may have
  // moved since, to a release nobody agreed to.
  const handlePackageUpdate = () => {
    const target = values.update;
    if (!workspacePin()) die(`${PACKAGE_NAME} is not pinned in this workspace yet — run bare init first`);
    // What the project RUNS is its own install, whichever copy is asking.
    const installed = workspaceInstalledVersion();
    // A clone's install waits on its own approval; a yes to a version is not a yes to this project's config.
    if (!installed && mode !== 'auto') die(`the pinned ${PACKAGE_NAME} is not installed yet — approve the install init reports, then run init --update ${target} again`);
    // 0.0.0-* (CI stamps, local packs) is unpublished space no release replaces.
    if (installed.startsWith('0.0.0-')) die(`the workspace runs an unpublished build (${installed}), which no release replaces`);
    if (installed === target) {
      say(`${PACKAGE_NAME} ${target} is already installed`);
      return;
    }
    // On the numeric core, so an installed prerelease of a later version is not taken for an older one.
    const installedCore = installed.split(/[-+]/)[0];
    if (installedCore && installedCore !== target && versionAtLeast(installedCore, target)) die(`${target} is older than the installed ${installed} — init --update never downgrades`);
    const from = installed || workspacePin();
    if (mode === 'dry') {
      say(`WOULD APPLY LOCALLY — update ${PACKAGE_NAME} ${from} → ${target}`);
      return;
    }
    const pm = packageManagerFor(workspace);
    if (pm !== 'npm' && !have(pm)) die(`the update to ${target} needs ${pm} (this project's package manager) — staying on ${from}`);
    if (!ok(execTool(pm, pmAddArgs(pm, `${PACKAGE_NAME}@${target}`), { cwd: workspace, stdio: ['ignore', 2, 2], env: noScripts }))) {
      die(`update to ${target} failed — staying on ${from}`);
    }
    say(`updated ${PACKAGE_NAME} ${from} → ${target}`);
    // The scaffold refreshed the skill from the copy running now, the version just replaced; the
    // agent must read the skill that matches the CLI it will call.
    refreshSkillFrom(path.join(workspace, 'node_modules', ...PACKAGE_NAME.split('/'), '.claude', 'skills', 'open-edit'));
    if (failed) die(`updated to ${target}, but the skill refresh failed — run bare init in the workspace to finish`);
  };

  // The lease skips its work while another init holds it, which for an asked-for update is a failure.
  if (values.update !== undefined && (await withInitLease(async () => { handlePackageUpdate(); return true; })) !== true) {
    die('another setup is running in this workspace — run init --update again once it finishes');
  }

  if (checkout ? repoDepsReady() : workspaceScaffolded()) {
    say(`ready — OPEN_EDIT_ROOT=${workspace}`);
  } else if (pendingApprovals.size > 0) {
    say('local setup is incomplete because an approved prerequisite is missing');
  } else {
    // Nothing is awaiting approval: the outstanding work is the WOULD APPLY LOCALLY list above, which
    // bare init performs itself. Saying "approval" here sent agents looking for a user to ask.
    say('not ready yet — run bare init (no --dry) to apply the local setup listed above');
  }

  if (pendingApprovals.size > 0) {
    const pending = [...pendingApprovals];
    if (pending.some((approval) => userRunApprovals.has(approval))) {
      say(`the user runs the install commands init cannot run here, then re-runs init${isWin ? ' from a NEW terminal' : ''}`);
    }
    if (pending.some((approval) => !userRunApprovals.has(approval))) {
      say('run with --auto-approve only after the user approves every action above');
    }
    return 10;
  }
  if (failed) return 1;
  deps.out(workspace);
  return 0;
}

