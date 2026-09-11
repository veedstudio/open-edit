// This package's copy of the run-key law must never drift from the Open Edit repository's
// (pipeline/scripts/resolve-video.ts): a transcript keyed by one and read by the other would
// silently orphan the run. These vectors are pinned IDENTICALLY on both sides — change them
// together or not at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveVideoArg, runKeyOf } from '../src/resolve-video.ts';

export const RUN_KEY_VECTORS: [string, string][] = [
  ['/videos/My Clip.mp4', 'My_Clip'],
  ['clip.final.mov', 'clip.final'],
  ['/a/b/my  spaced   clip.mp4', 'my_spaced_clip'],
  ['narration.wav', 'narration'],
  ['no-extension', 'no-extension'],
  ['/x/UPPER Case.MOV', 'UPPER_Case'],
  ['tab\tand space.mp4', 'tab_and_space'],
];

test('runKeyOf matches the pinned cross-codebase vectors', () => {
  for (const [input, expected] of RUN_KEY_VECTORS) {
    assert.equal(runKeyOf(input), expected, `runKeyOf(${JSON.stringify(input)})`);
  }
});

test('an absolute path passes through; anything else resolves from the CWD', () => {
  assert.equal(resolveVideoArg('/abs/path/clip.mp4'), '/abs/path/clip.mp4');
  assert.equal(resolveVideoArg('rel/clip.mp4'), resolve('rel/clip.mp4'));
  // ...even when the file is missing, so errors name the real path
  assert.equal(resolveVideoArg('missing-file.mp4'), resolve('missing-file.mp4'));
});
