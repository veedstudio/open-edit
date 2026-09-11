import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ENGINE_ASSETS, engineBinaryName, platformKey, unsupportedMessage } from '../src/platform.ts';
import { engineBinPath, engineDir, stateDir } from '../src/config.ts';

test('only macOS arm64 and Windows x64 render, and each maps to a published asset', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformKey('win32', 'x64'), 'win32-x64');
  assert.equal(platformKey('linux', 'x64'), null);
  assert.equal(platformKey('darwin', 'x64'), null);
  for (const key of ['darwin-arm64', 'win32-x64'] as const) {
    assert.ok(ENGINE_ASSETS[key].archive.length > 0);
    assert.ok(ENGINE_ASSETS[key].upstreamBin.length > 0);
  }
  assert.match(unsupportedMessage('linux', 'x64'), /linux\/x64/);
});

test('the installed binary name matches what the installer renames to', () => {
  assert.equal(engineBinaryName('darwin'), 'veed-engine-cli');
  assert.equal(engineBinaryName('win32'), 'veed-engine-cli.exe');
});

test('the engine lives in the app-data dir; VEED_ENGINE_BIN overrides', () => {
  const savedBin = process.env.VEED_ENGINE_BIN;
  delete process.env.VEED_ENGINE_BIN;
  try {
    assert.equal(engineDir(), join(stateDir(), 'engine'));
    assert.equal(engineBinPath(), join(engineDir(), engineBinaryName()));
    process.env.VEED_ENGINE_BIN = '/custom/engine-bin';
    assert.equal(engineBinPath(), '/custom/engine-bin');
  } finally {
    if (savedBin === undefined) delete process.env.VEED_ENGINE_BIN;
    else process.env.VEED_ENGINE_BIN = savedBin;
  }
});
