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

// veed-engine-cli render engine. Step 0 (pipeline/scripts/preflight.sh) checks your binary against the
// latest veedstudio/weave-renderer-public-releases GitHub release (upstream repo name) and offers an
// install if behind — no version is pinned here. Default: the repo-local .veed-engine/ install produced
// by pipeline/scripts/install-veed-engine.sh.
export const VEED_ENGINE_BIN = process.env.VEED_ENGINE_BIN ?? path.join(REPO_ROOT, '.veed-engine', 'veed-engine-cli');
