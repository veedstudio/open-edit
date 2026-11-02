// Install MediaPipe and the full-range BlazeFace model, which the faces command runs. NOT run as a side
// effect of anything: the agent asks the user first, because the environment takes several hundred MB
// (MediaPipe needs OpenCV, NumPy and Matplotlib).
//
// Usage:
//   npx @veedstudio/openedit-cli install-mediapipe            # install (or report an existing install)
//   npx @veedstudio/openedit-cli install-mediapipe 1.1.0      # another version, with the dependencies it declares
//
// Removing it: delete the app-data `mediapipe` folder this prints; nothing else is touched.
//
// MediaPipe is a library with no command of its own, so unlike WhisperX it cannot be a uv/pipx tool: it
// goes into a virtual environment the CLI owns, made by uv when it is there (uv fetches a Python it can use),
// else by `python3 -m venv` when that python3 is one the pinned packages build for. Either way the system
// Python's own packages are never written to.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsage, type Usage } from '../args.ts';
import { mediapipeDir } from '../config.ts';
import { MEDIAPIPE_VERSION, MODEL, modelPath, runDetector, venvDir, venvPython } from '../faces/mediapipe.ts';
import { findOnPath, installHint } from '../platform.ts';

const say = (msg: string) => console.log(`install-mediapipe: ${msg}`);
const warn = (msg: string) => console.error(`install-mediapipe: ${msg}`);

export const usage = {
  summary: 'Install MediaPipe and its face model into an environment of their own, for faces',
  positionals: '[<version>]',
  flags: {},
  notes: [
    `Several hundred MB (MediaPipe brings OpenCV, NumPy and Matplotlib), plus the ${(MODEL.bytes / 1e6).toFixed(1)} MB model, at pinned versions.`,
    `Needs uv, or a python3 of 3.12 or newer on PATH; on Windows on ARM, uv. MediaPipe ${MEDIAPIPE_VERSION} has no Intel Mac build. Remove by deleting the folder it prints.`,
  ].join('\n'),
} satisfies Usage;

/** Bytes under a directory, for the size line: what the install actually costs on this machine. */
export function sizeOf(path: string): number {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

export function verifyModel(bytes: Buffer): string | null {
  const sha = createHash('sha256').update(bytes).digest('hex');
  return sha === MODEL.sha256 ? null : `the model download does not match its pinned checksum (got sha256 ${sha})`;
}

export async function fetchModel(fetchImpl: typeof fetch = fetch, dest = modelPath()): Promise<void> {
  const res = await fetchImpl(MODEL.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`could not download the face model: HTTP ${res.status} from ${MODEL.url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const bad = verifyModel(bytes);
  if (bad) throw new Error(bad);
  // Written aside and renamed, so an interrupted download never leaves a model that looks installed.
  const part = `${dest}.part`;
  writeFileSync(part, bytes);
  renameSync(part, dest);
}

/**
 * Every package the pinned MediaPipe runs on, transitive ones included, at the versions verified together:
 * an image built twice gets the same environment. OpenCV's headless build stands in for the
 * opencv-contrib-python MediaPipe 1.1.1 declares: MediaPipe imports cv2 at start-up but never opens a window,
 * and on linux x86_64 that saves 56 MB of 478, with the same boxes.
 */
export const PINNED = [
  `mediapipe==${MEDIAPIPE_VERSION}`, 'absl-py==2.5.1', 'certifi==2026.10.19', 'cffi==2.1.1', 'contourpy==1.4.0', 'cycler==0.12.1',
  'flatbuffers==25.12.19', 'fonttools==4.67.0', 'kiwisolver==1.5.1', 'matplotlib==3.11.2', 'numpy==2.5.4',
  'opencv-python-headless==5.0.0.93', 'packaging==26.3', 'pillow==13.0.0', 'pycparser==3.11', 'pyparsing==3.3.3',
  'python-dateutil==2.9.0.post0', 'six==1.17.0', 'sounddevice==0.5.6',
];

// The oldest Python the pinned set runs on: numpy 2.5 and contourpy 1.4 need 3.12.
export const MIN_PYTHON = [3, 12] as const;

/** The packages to install: the pinned set as it is, or another MediaPipe with what it declares. */
export function installArgs(version: string): string[] {
  return version === MEDIAPIPE_VERSION ? ['--no-deps', ...PINNED] : [`mediapipe==${version}`];
}

/** Why `version` (such as "3.10") cannot run the pinned set, or null when it can. */
export function pythonProblem(version: string): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2])];
  const below = v[0] < MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] < MIN_PYTHON[1]);
  return below ? `Python ${v.join('.')} is older than the ${MIN_PYTHON.join('.')} the pinned packages of MediaPipe ${MEDIAPIPE_VERSION} need` : null;
}

export interface Machine {
  platform: NodeJS.Platform;
  arch: string;
  /** An x64 process translated by Rosetta on an Apple Silicon Mac. */
  rosetta: boolean;
  /** A Windows machine with an ARM processor, whatever this process was built for. */
  windowsArm: boolean;
  /** What OPEN_EDIT_MEDIAPIPE_PYTHON asks uv for, if set. */
  python?: string;
  /** Whether uv is on PATH: only uv reads OPEN_EDIT_MEDIAPIPE_PYTHON. */
  uv: boolean;
}

export function thisMachine(): Machine {
  // By its full path: a PATH without /usr/sbin would read Rosetta as an Intel Mac.
  const ask = (name: string) => spawnSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8' }).stdout?.trim();
  return {
    platform: process.platform,
    arch: process.arch,
    rosetta: process.platform === 'darwin' && process.arch === 'x64' && ask('sysctl.proc_translated') === '1',
    windowsArm: process.platform === 'win32'
      && (process.arch === 'arm64' || /ARM64/i.test(process.env.PROCESSOR_ARCHITEW6432 ?? '') || /\bARM/i.test(process.env.PROCESSOR_IDENTIFIER ?? '')),
    python: process.env.OPEN_EDIT_MEDIAPIPE_PYTHON,
    uv: findOnPath('uv') !== null,
  };
}

/** Why the pinned MediaPipe cannot be installed for this process as it runs, or null; all but an Intel Mac have a way out. */
export function platformProblem(m: Machine): string | null {
  if (m.platform === 'darwin' && m.arch === 'x64') {
    return m.rosetta
      ? `this Node runs as x86_64 under Rosetta, and MediaPipe ${MEDIAPIPE_VERSION} has no Intel Mac build; this Mac runs its arm64 build: ` +
        'run the CLI with an arm64 Node, then install-mediapipe again'
      : `MediaPipe ${MEDIAPIPE_VERSION} has no Intel Mac build, so it cannot be installed on this machine`;
  }
  if (m.windowsArm && (!m.uv || !/x86_64|amd64|x64/i.test(m.python ?? ''))) {
    return 'opencv-python-headless 5.0.0.93, which it needs, has no Windows on ARM build: install it on an x64 Python, which Windows ' +
      `runs under emulation${m.uv ? ', by setting' : ' and uv fetches: install uv, set'} OPEN_EDIT_MEDIAPIPE_PYTHON=cpython-3.12-windows-x86_64-none, ` +
      'then install-mediapipe again';
  }
  return null;
}

/** What went wrong with a finished step, in words: a missing program, a signal, or an exit status. */
export function stepFailure(step: string, r: { error?: Error; signal?: NodeJS.Signals | null; status: number | null }): string {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const why = code === 'ENOENT' ? 'the program was not found' : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  return `${step} failed (${why})${r.error ? '' : '; its own output is above'}`;
}

export async function installMediapipe(args: string[]): Promise<number> {
  const { positionals: [version = MEDIAPIPE_VERSION] } = parseUsage('install-mediapipe', usage, args);
  const unable = version === MEDIAPIPE_VERSION ? platformProblem(thisMachine()) : null;
  if (unable) {
    warn(unable);
    return 1;
  }
  // Pinned like WhisperX's interpreter: the version this install was verified and measured on.
  const python = 'OPEN_EDIT_MEDIAPIPE_PYTHON' in process.env ? process.env.OPEN_EDIT_MEDIAPIPE_PYTHON! : '3.12';
  const venv = venvDir();
  const py = venvPython(venv);
  mkdirSync(mediapipeDir(), { recursive: true });
  // Run from the install's own folder, so no pyproject or uv.toml of the user's working directory steers it.
  const opts = { cwd: mediapipeDir() };
  const step = (what: string, cmd: string, runArgs: string[]): boolean => {
    const r = spawnSync(cmd, runArgs, { ...opts, stdio: 'inherit' });
    if (r.status === 0) return true;
    warn(stepFailure(what, r));
    return false;
  };
  const versionOf = (bin: string) => {
    const r = spawnSync(bin, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { ...opts, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const installed = spawnSync(py, ['-I', '-c', 'import mediapipe; print(mediapipe.__version__)'], { ...opts, encoding: 'utf8' });
  const current = installed.status === 0 ? installed.stdout.trim() : '';
  const pinned = version === MEDIAPIPE_VERSION;

  if (current !== version) {
    const uv = findOnPath('uv');
    const system = findOnPath(process.platform === 'win32' ? 'python' : 'python3');
    // Every check comes before the old environment is removed: a refusal must leave a working install alone.
    if (uv) {
      const found = spawnSync(uv, ['python', 'find', '--no-config', python], { ...opts, encoding: 'utf8' });
      const asked = pinned ? pythonProblem(python) ?? (found.status === 0 ? pythonProblem(versionOf(found.stdout.trim())) : null) : null;
      if (asked) {
        warn(`OPEN_EDIT_MEDIAPIPE_PYTHON asks uv for ${python}. ${asked}: unset it, or set it to 3.12 or newer.`);
        return 1;
      }
      rmSync(venv, { recursive: true, force: true });
      say(`installing mediapipe==${version} with uv on Python ${python} into ${venv}`);
      if (!step('uv venv', uv, ['venv', '--no-config', '--python', python, venv])) return 1;
      if (!step('uv pip install', uv, ['pip', 'install', '--no-config', '--python', py, ...installArgs(version)])) return 1;
    } else if (system) {
      const have = versionOf(system);
      const old = pinned ? pythonProblem(have) : null;
      if (old) {
        console.error(`install-mediapipe: ${system} is Python ${have}. ${old}. Install uv, which fetches a Python it can use,
then re-run:

  ${installHint('uv')}`);
        return 1;
      }
      rmSync(venv, { recursive: true, force: true });
      say(`installing mediapipe==${version} into a virtual environment of ${system} (Python ${have}) at ${venv}`);
      if (!step('python3 -m venv', system, ['-I', '-m', 'venv', venv])) return 1;
      if (!step('pip install', py, ['-I', '-m', 'pip', 'install', ...installArgs(version)])) return 1;
    } else {
      console.error(`install-mediapipe: neither uv nor a python3 is available. Install uv, then re-run:

  ${installHint('uv')}`);
      return 1;
    }
  } else {
    say(`mediapipe ${current} is already installed in ${venv}`);
  }

  try {
    if (!existsSync(modelPath()) || verifyModel(readFileSync(modelPath()))) {
      say(`downloading the full-range face model (${(MODEL.bytes / 1e6).toFixed(1)} MB)`);
      await fetchModel();
    }
    // An install that exits 0 without a working detector would otherwise be found mid-edit.
    const { readyMs } = runDetector({ confidence: 0.5 });
    say(`the model loads in ${Math.round(readyMs)} ms`);
  } catch (e) {
    warn((e as Error).message);
    return 1;
  }
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
  say(`ready — ${mediapipeDir()} (environment ${mb(sizeOf(venv))}, model ${mb(sizeOf(modelPath()))})`);
  return 0;
}
