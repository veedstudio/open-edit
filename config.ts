// Single source of truth for machine-specific paths. Edit here, or set the env vars below; NO user
// paths are hardcoded anywhere else in the repo. The TypeScript scripts import this; the shell scripts
// (pipeline/scripts/*.sh) read the same env vars (VEED_ENGINE_BIN / VEED_ENGINE_FFMPEG).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

// ffmpeg — base-frame extraction + audio mux. Default: PATH.
export const FFMPEG = process.env.VEED_ENGINE_FFMPEG ?? 'ffmpeg';

// ffprobe (source dims + duration → canvas aspect). Defaults next to FFMPEG when that path is set, else PATH.
export const FFPROBE = process.env.VEED_ENGINE_FFPROBE
  ?? (process.env.VEED_ENGINE_FFMPEG ? process.env.VEED_ENGINE_FFMPEG.replace(/ffmpeg([^/]*)$/, 'ffprobe$1') : 'ffprobe');

// veed-engine-cli render engine. PREFLIGHT (pipeline/scripts/preflight.sh) checks your binary against the
// latest veedstudio/weave-renderer-public-releases GitHub release (upstream repo name) and offers an
// install if behind — no version is pinned here. Default: the repo-local .veed-engine/ install produced
// by pipeline/scripts/install-veed-engine.sh.
export const VEED_ENGINE_BIN = process.env.VEED_ENGINE_BIN ?? path.join(REPO_ROOT, '.veed-engine', 'veed-engine-cli');

// WhisperX — the local, free transcription provider (prep/transcribe.ts), installed on request by
// pipeline/scripts/install-whisperx.sh. Default: PATH.
export const WHISPERX_BIN = process.env.WHISPERX_BIN ?? 'whisperx';

// Fallback quality tier, used only until the user's choice is recorded in .open-edit-prefs.json.
export const WHISPERX_MODEL = process.env.WHISPERX_MODEL ?? 'small.en';

// --- WCAG pass (creative runs run it by default; recipes via --wcag) -------
// The analyzer is not bundled with the release engine binary; default to a
// sibling weave-renderer checkout, overridable via the env vars.
export const WEAVE_RENDERER_ROOT =
  process.env.WEAVE_RENDERER_ROOT ?? path.join(REPO_ROOT, '..', 'weave-renderer');

// wcag-contrast analyzer binary. Build once in the checkout:
//   cd src/crates/wcag-contrast && cargo build
export const WCAG_CONTRAST_BIN =
  process.env.WCAG_CONTRAST_BIN ??
  path.join(WEAVE_RENDERER_ROOT, 'src', 'crates', 'wcag-contrast', 'target', 'debug', 'wcag-contrast');

// Remediation applier — lives in this repo (application policy belongs to the
// consumer). Requires plain `node` (native .ts type-stripping, >=22.18), NOT
// tsx; wcag-pass spawns it accordingly.
export const WCAG_REMEDIATE =
  process.env.WCAG_REMEDIATE ?? path.join(REPO_ROOT, 'pipeline', 'scripts', 'wcag', 'remediate.ts');
