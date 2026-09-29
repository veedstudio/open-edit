// The repository root, for the repo's own tests and probes. The CLI resolves its machine paths
// (ffmpeg, ffprobe, WhisperX, app data) itself, in cli/src/config.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
