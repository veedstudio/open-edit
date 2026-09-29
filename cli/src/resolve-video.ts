// One resolution rule for a video argument, and the ONE run-key derivation naming a
// runs/<key> directory: every command that names one routes through it, and the test
// vectors in cli/tests/resolve-video.test.ts pin it. An absolute path passes through,
// anything else resolves from the CWD — in both cases even when the file is missing,
// so errors name the real path.
import { basename, extname, isAbsolute, resolve } from 'node:path';

export function resolveVideoArg(arg: string): string {
  return isAbsolute(arg) ? arg : resolve(arg);
}

// Runs of whitespace collapse to a single underscore so "my  clip.mp4" and
// "my clip.mp4" land on the same key.
export function runKeyOf(videoPath: string): string {
  return basename(videoPath, extname(videoPath)).replace(/\s+/g, '_');
}
