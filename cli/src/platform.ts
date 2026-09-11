// The platform authority for the render engine: which platforms render, which release
// asset each one pulls, and what the installed binary is called. Mirrors the repository's
// platform.mjs, which remains the authority for the not-yet-migrated preflight.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

export function platformKey(platform = process.platform, arch = process.arch): 'darwin-arm64' | 'win32-x64' | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

export function unsupportedMessage(platform = process.platform, arch = process.arch): string {
  return `unsupported platform ${platform}/${arch}; rendering requires macOS arm64 or Windows x64`;
}

// WhisperX shares the engine's platform envelope: CTranslate2 runs CPU-only on both.
export function whisperxSupported(platform = process.platform, arch = process.arch): boolean {
  return platformKey(platform, arch) !== null;
}

// Upstream release assets (weave-v<semver> tags). The Windows asset exists from weave-v0.9.0 onward;
// both archives extract with the system tar (bsdtar on macOS and Windows 10+, which reads zip too).
export const ENGINE_ASSETS = {
  'darwin-arm64': { archive: 'weave-viewer-cli-macos-arm64.tar.gz', upstreamBin: 'weave-viewer-cli' },
  'win32-x64': { archive: 'weave-viewer-cli-windows-x64.zip', upstreamBin: 'weave-viewer-cli.exe' },
} as const;

export function engineBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'veed-engine-cli.exe' : 'veed-engine-cli';
}

export function isEngineRunnable(binPath: string, platform = process.platform): boolean {
  try {
    if (platform === 'win32') return existsSync(binPath);
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The app-data state dir, computable against an INJECTED env (init's tests inject one);
// config.stateDir() is the process-env convenience over the same rule.
function stateDirFor(platform: string, env: Record<string, string | undefined>): string {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  return env.OPENEDIT_STATE_DIR
    ?? (platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'veed-openedit')
      : platform === 'win32'
        ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'veed-openedit')
        : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'veed-openedit'));
}

// Where install-engine puts the engine.
export function engineInstallDir(platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  return join(stateDirFor(platform, env), 'engine');
}

// Where install-ffmpeg puts its no-admin copy (binaries under bin/).
export function ffmpegInstallDir(platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  return join(stateDirFor(platform, env), 'ffmpeg');
}

// What a user runs to install a missing global dependency. Windows installs are report-only: winget
// needs an interactive first run and its PATH edits don't reach an already-running process.
const HINTS: Record<string, Record<string, string>> = {
  darwin: {
    git: 'brew install git',
    node: 'brew install node',
    ffmpeg: 'brew install ffmpeg',
    uv: 'brew install uv',
    pipx: 'brew install pipx',
  },
  win32: {
    git: 'winget install --id Git.Git',
    node: 'winget install --id OpenJS.NodeJS.LTS',
    ffmpeg: 'winget install --id Gyan.FFmpeg',
    uv: 'winget install --id astral-sh.uv',
    pipx: 'python -m pip install --user pipx',
  },
};

export function installHint(dep: string, platform = process.platform): string {
  return HINTS[platform]?.[dep] ?? HINTS.darwin[dep];
}

// `command -v`, portably: walk PATH, honouring PATHEXT on Windows so `ffmpeg` finds ffmpeg.exe and
// `pnpm` finds pnpm.CMD. A cmd carrying a path separator is checked as given, like command -v does.
export function findOnPath(cmd: string, env: Record<string, string | undefined> = process.env, platform = process.platform): string | null {
  const isWin = platform === 'win32';
  const exts = isWin
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const runnable = (candidate: string): boolean => {
    try {
      if (!statSync(candidate).isFile()) return false;
      if (!isWin) accessSync(candidate, constants.X_OK); // Windows has no exec bit; the extension decides
      return true;
    } catch {
      return false;
    }
  };
  // On Windows only an extension makes a file spawnable, so a bare name is tried per PATHEXT.
  const candidates = (base: string): string[] => (isWin ? (extname(base) ? [base] : exts.map((e) => base + e)) : [base]);
  if (cmd.includes('/') || (isWin && cmd.includes('\\'))) {
    for (const candidate of candidates(cmd)) if (runnable(candidate)) return candidate;
    return null;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates(join(dir, cmd))) if (runnable(candidate)) return candidate;
  }
  return null;
}

// Whether a spawn target needs cmd.exe: Node refuses to exec .cmd/.bat shims directly (the classic
// win32 port bug — pnpm and npm install as shims, not .exe).
export function isCmdShim(resolvedPath: string | null | undefined): boolean {
  return /\.(cmd|bat)$/i.test(resolvedPath ?? '');
}

// Whether a binary starts, and what it says of itself. One that will not start says nothing on
// stderr, so the status code is the whole diagnosis; the one seen in practice is decoded.
const STATUS_DLL_NOT_FOUND = 3221225781;
export function probeVersion(
  bin: string,
  opts: { args?: string[]; missingDll?: string } = {},
): { banner: string; failure: string } {
  const probe = spawnSync(bin, opts.args ?? ['--version'], { encoding: 'utf8' });
  const banner = probe.status === 0 ? (probe.stdout ?? '').split('\n')[0].trim() : '';
  if (banner) return { banner, failure: '' };
  const detail = probe.error?.message
    ?? (probe.signal ? `killed by ${probe.signal}`
      : probe.status === STATUS_DLL_NOT_FOUND ? `exit status ${probe.status} — a system DLL it needs is missing${opts.missingDll ? ` (${opts.missingDll})` : ''}`
        : probe.status === 0 ? 'exited 0 but printed no version'
          : `exit status ${probe.status}`);
  const stderr = (probe.stderr ?? '').trim().split('\n')[0];
  return { banner: '', failure: stderr ? `${detail} — ${stderr}` : detail };
}

// Gyan's FFmpeg links Video for Windows, which a trimmed Server edition lacks — shared by
// install-ffmpeg and readiness so both decode the same failure.
export const FFMPEG_PROBE = { args: ['-version'], missingDll: 'Video for Windows is absent on some Server editions' };
