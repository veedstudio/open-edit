// The single platform authority: which platforms render, which engine release asset each one pulls,
// and how a missing global dependency is installed there. Dependency-free — preflight imports this
// before node_modules exists. config.ts imports it too, so the installed binary name can never skew
// between the installer and the scripts that spawn the engine.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

export function unsupportedMessage(platform = process.platform, arch = process.arch) {
  return `unsupported platform ${platform}/${arch}; rendering requires macOS arm64 or Windows x64`;
}

// Upstream release assets (weave-v<semver> tags). The Windows asset exists from weave-v0.9.0 onward;
// both archives extract with the system tar (bsdtar on macOS and Windows 10+, which reads zip too).
export const ENGINE_ASSETS = {
  'darwin-arm64': { archive: 'weave-viewer-cli-macos-arm64.tar.gz', upstreamBin: 'weave-viewer-cli' },
  'win32-x64': { archive: 'weave-viewer-cli-windows-x64.zip', upstreamBin: 'weave-viewer-cli.exe' },
};

export function engineBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'veed-engine-cli.exe' : 'veed-engine-cli';
}

// What a user runs to install a missing global dependency. Windows installs are report-only: winget
// needs an interactive first run and its PATH edits don't reach an already-running process.
const HINTS = {
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

export function installHint(dep, platform = process.platform) {
  return HINTS[platform]?.[dep] ?? HINTS.darwin[dep];
}

// `command -v`, portably: walk PATH, honouring PATHEXT on Windows so `ffmpeg` finds ffmpeg.exe and
// `pnpm` finds pnpm.CMD. A cmd carrying a path separator is checked as given, like command -v does.
export function findOnPath(cmd, env = process.env, platform = process.platform) {
  const isWin = platform === 'win32';
  const exts = isWin
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const runnable = (candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      if (!isWin) accessSync(candidate, constants.X_OK); // Windows has no exec bit; the extension decides
      return true;
    } catch {
      return false;
    }
  };
  // On Windows only an extension makes a file spawnable, so a bare name is tried per PATHEXT.
  const candidates = (base) => (isWin ? (path.extname(base) ? [base] : exts.map((e) => base + e)) : [base]);
  if (cmd.includes('/') || (isWin && cmd.includes('\\'))) {
    for (const candidate of candidates(cmd)) if (runnable(candidate)) return candidate;
    return null;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates(path.join(dir, cmd))) if (runnable(candidate)) return candidate;
  }
  return null;
}

// Whether a spawn target needs cmd.exe: Node refuses to exec .cmd/.bat shims directly (the classic
// win32 port bug — pnpm and npm install as shims, not .exe).
export function isCmdShim(resolvedPath) {
  return /\.(cmd|bat)$/i.test(resolvedPath ?? '');
}

export function whisperxSupported(platform = process.platform, arch = process.arch) {
  return platformKey(platform, arch) !== null;
}

export function isEngineRunnable(binPath, platform = process.platform) {
  try {
    if (platform === 'win32') return existsSync(binPath);
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
