import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHint, stateDirFor } from '../src/platform.ts';
import { stateDir } from '../src/config.ts';

test('install hints follow the platform, and an unlisted Unix gets the Linux ones rather than Homebrew', () => {
  assert.equal(installHint('ffmpeg', 'darwin'), 'brew install ffmpeg');
  assert.equal(installHint('ffmpeg', 'win32'), 'winget install --id Gyan.FFmpeg');
  assert.equal(installHint('ffmpeg', 'linux'), 'sudo apt install ffmpeg');
  assert.equal(installHint('ffmpeg', 'freebsd'), 'sudo apt install ffmpeg');
});

test('init computes the same app-data dir the CLI reads', () => {
  assert.equal(stateDirFor(process.platform, process.env), stateDir());
});
