// One resolution rule for a video argument, shared by every entry point (veed/go.ts,
// prep/prep.ts) so transcription and prep can never disagree about which file a run is
// for: an absolute path passes through, anything else resolves from the CWD — in both
// cases even when the file is missing, so errors name the real path. There is no repo
// video dir; the user supplies the source path. Always returns an absolute path —
// meta.json's videoPath is read by consumers with other working directories (mux, the
// preview server).
import { basename, extname, isAbsolute, resolve } from 'node:path';

export function resolveVideoArg(arg: string): string {
  return isAbsolute(arg) ? arg : resolve(arg);
}

// The ONE run-key derivation, shared by every entry point that names a runs/<key> directory
// (veed/go.ts, prep/prep.ts, prep/whisper.ts) so they can never disagree about which run a video belongs
// to — the same job resolveVideoArg does for the source path itself. It lived in three places, spelled
// identically three times, which is a rule waiting to drift. Runs of whitespace collapse to a single
// underscore so "my  clip.mp4" and "my clip.mp4" land on the same key.
export function runKeyOf(videoPath: string): string {
  return basename(videoPath, extname(videoPath)).replace(/\s+/g, '_');
}
