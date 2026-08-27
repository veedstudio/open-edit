// Single source of truth for machine-specific paths. Edit here, or set the env vars below; NO user
// paths are hardcoded anywhere else in the repo. The TypeScript scripts import this; the shell scripts
// (pipeline/scripts/*.sh) read the same env vars (VEED_ENGINE_BIN / VEED_ENGINE_FFMPEG).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

// The CLI's app-data layout, mirrored from the package's platform.ts (stateDir + engine/ffmpeg dirs)
// so this repo can FIND what the CLI installed without depending on the package. Keep in step: the
// two must never disagree about where `npx @veedstudio/openedit-cli install-engine|install-ffmpeg` write.
const appDataDir = (): string => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return process.env.OPENEDIT_STATE_DIR
    ?? (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'veed-openedit')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'veed-openedit')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'veed-openedit'));
};
const engineInstallDir = () => path.join(appDataDir(), 'engine');
const ffmpegInstallDir = () => path.join(appDataDir(), 'ffmpeg');
const engineBinaryName = () => (process.platform === 'win32' ? 'veed-engine-cli.exe' : 'veed-engine-cli');

// Preferred over PATH so `npx @veedstudio/openedit-cli install-ffmpeg` — the no-admin route — needs no
// env vars. The workspace-local .ffmpeg/ is honored first as a legacy install; new installs go to app-data.
const localFfmpegTool = (name: string): string | null => {
  const file = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);
  for (const bin of [path.join(REPO_ROOT, '.ffmpeg', 'bin'), path.join(ffmpegInstallDir(), 'bin')]) {
    const candidate = path.join(bin, file(name));
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

// ffmpeg — base-frame extraction + audio mux.
export const FFMPEG = process.env.VEED_ENGINE_FFMPEG ?? localFfmpegTool('ffmpeg') ?? 'ffmpeg';

// ffprobe (source dims + duration → canvas aspect). Defaults next to FFMPEG when that path is set, else PATH.
export const FFPROBE = process.env.VEED_ENGINE_FFPROBE
  ?? (process.env.VEED_ENGINE_FFMPEG
    ? process.env.VEED_ENGINE_FFMPEG.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1')
    : localFfmpegTool('ffprobe') ?? 'ffprobe');

// The engine resolves `ffmpeg` for --record through the OS search path and takes no override of its
// own, so a workspace-local copy is invisible to it unless its directory is on the child's PATH.
export function engineEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!path.isAbsolute(FFMPEG)) return base;
  const dir = path.dirname(FFMPEG);
  const key = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = base[key] ?? '';
  if (current.split(path.delimiter).includes(dir)) return base;
  return { ...base, [key]: current ? `${dir}${path.delimiter}${current}` : dir };
}

// veed-engine-cli render engine (veed-engine-cli.exe on Windows). PREFLIGHT (pipeline/scripts/preflight.mjs)
// checks your binary against the latest veedstudio/weave-renderer-public-releases GitHub release (upstream
// repo name) and offers an install if behind — no version is pinned here. Default: the app-data install
// produced by `npx @veedstudio/openedit-cli install-engine`.
export const VEED_ENGINE_BIN = process.env.VEED_ENGINE_BIN ?? path.join(engineInstallDir(), engineBinaryName());

// WhisperX — the local, free transcription provider (the CLI's transcribe command), installed on request
// by `npx @veedstudio/openedit-cli install-whisperx`. Default: PATH.
export const WHISPERX_BIN = process.env.WHISPERX_BIN ?? 'whisperx';

// Fallback quality tier, used only until the user's choice is recorded in .open-edit-prefs.json.
export const WHISPERX_MODEL = process.env.WHISPERX_MODEL ?? 'small.en';

// WhisperX device/compute. cpu/int8 runs everywhere (CTranslate2 has no GPU path on Apple Silicon);
// a CUDA-capable box can override, e.g. OPEN_EDIT_WHISPERX_DEVICE=cuda OPEN_EDIT_WHISPERX_COMPUTE=float16.
export const WHISPERX_DEVICE = process.env.OPEN_EDIT_WHISPERX_DEVICE ?? 'cpu';
export const WHISPERX_COMPUTE = process.env.OPEN_EDIT_WHISPERX_COMPUTE ?? 'int8';

// The WCAG pass (analyzer + remediation) lives in the CLI: `npx @veedstudio/openedit-cli wcag-pass`.
