import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineArgs, windowsPath } from '../pipeline/scripts/linux-proton-engine.mjs';

test('translates project and output paths with spaces without shell interpretation', () => {
  assert.deepEqual(engineArgs(['a project', '--record', 'out/$(touch nope).mp4', '--fps', '30'], '/work'),
    ['Z:/work/a project', '--record', 'Z:/work/out/$(touch nope).mp4', '--fps', '30']);
});
test('preserves Windows and UNC paths', () => {
  assert.equal(windowsPath('C:\\clips\\in.mp4'), 'C:\\clips\\in.mp4');
  assert.equal(windowsPath('\\\\server\\share\\in.mp4'), '\\\\server\\share\\in.mp4');
});
test('handles template mode and report paths independently of numeric flags', () => {
  assert.deepEqual(engineArgs(['--template', '/tmp/a.wv', '--width', '320', '--verify-report', './qa.json'], '/work'),
    ['--template', 'Z:/tmp/a.wv', '--width', '320', '--verify-report', 'Z:/work/qa.json']);
});
test('rejects missing paths rather than forwarding a different flag as a filename', () => {
  assert.throws(() => engineArgs(['--record']), /Missing path/);
  assert.throws(() => engineArgs(['--record', '--headless']), /Missing path/);
});
test('rejects batch stdin and embedded custom-zone paths until they have a path bridge', () => {
  assert.throws(() => engineArgs(['--render-server']), /stdin job paths/);
  assert.throws(() => engineArgs(['--verify=safezones:zones.json']), /manifest/);
  assert.deepEqual(engineArgs(['--verify=bounds']), ['--verify=bounds']);
});

test('a logged decode failure cannot masquerade as exit-zero success', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openedit-proton-test-'));
  try {
    mkdirSync(path.join(root, 'files/bin'), { recursive: true });
    const fakeWine = path.join(root, 'files/bin/wine64');
    writeFileSync(fakeWine, '#!/bin/sh\nprintf "[error] VideoDecoder(MF): failed to open source\\n"\nexit 0\n', { mode: 0o755 });
    for (const file of ['weave-viewer-cli.exe', 'dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d12core.dll']) writeFileSync(path.join(root, file), 'fixture');
    const script = fileURLToPath(new URL('../pipeline/scripts/linux-proton-engine.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [script, '--version'], {
      env: { ...process.env, OPENEDIT_PROTON_DIR: root, OPENEDIT_WINDOWS_ENGINE_DIR: root, OPENEDIT_LINUX_STATE_DIR: path.join(root, 'state') },
      encoding: 'utf8', timeout: 10000,
    });
    const failure = run();
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /not a successful render/);
    writeFileSync(fakeWine, '#!/bin/sh\nprintf "weave-viewer-cli 0.10.2\\n"\nexit 0\n');
    assert.equal(run().status, 0);
    writeFileSync(fakeWine, '#!/bin/sh\nexit 7\n');
    assert.equal(run().status, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
