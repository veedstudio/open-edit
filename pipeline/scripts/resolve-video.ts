// One resolution rule for a video argument, shared by every entry point (veed/go.ts,
// prep/prep.ts) so transcription and prep can never disagree about which file a run is
// for: an absolute path passes through, anything else resolves from the CWD — in both
// cases even when the file is missing, so errors name the real path. There is no repo
// video dir; the user supplies the source path. Always returns an absolute path —
// meta.json's videoPath is read by consumers with other working directories (mux, the
// preview server).
import { isAbsolute, resolve } from 'node:path';

export function resolveVideoArg(arg: string): string {
  return isAbsolute(arg) ? arg : resolve(arg);
}
