// Single source of truth for machine-specific paths. Edit here, or set the env vars below; NO user
// paths are hardcoded anywhere else in the repo. The TypeScript scripts import this; the shell scripts
// (pipeline/scripts/*.sh) read the same env vars (VEED_ENGINE_BIN / VEED_ENGINE_FFMPEG).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineBinaryName } from './.claude/skills/open-edit/scripts/platform.mjs';

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

// ffmpeg — base-frame extraction + audio mux. Default: PATH.
export const FFMPEG = process.env.VEED_ENGINE_FFMPEG ?? 'ffmpeg';

// ffprobe (source dims + duration → canvas aspect). Defaults next to FFMPEG when that path is set, else PATH.
export const FFPROBE = process.env.VEED_ENGINE_FFPROBE
  ?? (process.env.VEED_ENGINE_FFMPEG ? process.env.VEED_ENGINE_FFMPEG.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1') : 'ffprobe');

// veed-engine-cli render engine (veed-engine-cli.exe on Windows). PREFLIGHT (pipeline/scripts/preflight.mjs)
// checks your binary against the latest veedstudio/weave-renderer-public-releases GitHub release (upstream
// repo name) and offers an install if behind — no version is pinned here. Default: the repo-local
// .veed-engine/ install produced by pipeline/scripts/install-veed-engine.mjs.
export const VEED_ENGINE_BIN = process.env.VEED_ENGINE_BIN ?? path.join(REPO_ROOT, '.veed-engine', engineBinaryName());

// WhisperX — the local, free transcription provider (prep/transcribe.ts), installed on request by
// pipeline/scripts/install-whisperx.mjs. Default: PATH.
export const WHISPERX_BIN = process.env.WHISPERX_BIN ?? 'whisperx';

// Fallback quality tier, used only until the user's choice is recorded in .open-edit-prefs.json.
export const WHISPERX_MODEL = process.env.WHISPERX_MODEL ?? 'small.en';

// WhisperX device/compute. cpu/int8 runs everywhere (CTranslate2 has no GPU path on Apple Silicon);
// a CUDA-capable box can override, e.g. OPEN_EDIT_WHISPERX_DEVICE=cuda OPEN_EDIT_WHISPERX_COMPUTE=float16.
export const WHISPERX_DEVICE = process.env.OPEN_EDIT_WHISPERX_DEVICE ?? 'cpu';
export const WHISPERX_COMPUTE = process.env.OPEN_EDIT_WHISPERX_COMPUTE ?? 'int8';

// --- WCAG pass (creative runs run it by default; recipes via --wcag) -------
// The analyzer ships INSIDE the release engine (since 0.8.0; the repo floor is 0.9.0, the first
// release with a Windows asset): one binary, no source
// checkout — `veed-engine-cli <dir> --contrast-audit <report> --statistics <stats>`.

// Remediation applier — lives in this repo (application policy belongs to the
// consumer). Requires plain `node` (native .ts type-stripping, >=22.18), NOT
// tsx; wcag-pass spawns it accordingly.
export const WCAG_REMEDIATE =
  process.env.WCAG_REMEDIATE ?? path.join(REPO_ROOT, 'pipeline', 'scripts', 'wcag', 'remediate.ts');
