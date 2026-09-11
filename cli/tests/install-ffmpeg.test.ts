import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Subprocess runs, because config.ts resolves the state dir at import time: each case needs its
// own OPENEDIT_STATE_DIR and PATH before the module loads.
const cliEntry = resolve(import.meta.dirname, '../src/cli.ts');
const run = (args: string[], env: Record<string, string>) => {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  // The host's own override must not leak into the fixture's resolution.
  delete merged.VEED_ENGINE_FFMPEG;
  delete merged.VEED_ENGINE_FFPROBE;
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, 'install-ffmpeg', ...args], {
    encoding: 'utf8',
    env: merged,
  });
};

// A PATH that resolves node (tsx needs it) but no ffmpeg.
const bareEnv = async () => {
  const state = await mkdtemp(join(tmpdir(), 'openedit-ffmpeg-state-'));
  return { OPENEDIT_STATE_DIR: state, PATH: join(state, 'empty-path') };
};

test('install-ffmpeg --check reports not installed when nothing works', async () => {
  const r = run(['--check'], await bareEnv());
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /not installed/);
});

test('install-ffmpeg finds an existing PATH install and installs nothing', async () => {
  const env = await bareEnv();
  const binDir = join(env.OPENEDIT_STATE_DIR, 'fake-path');
  mkdirSync(binDir, { recursive: true });
  for (const n of ['ffmpeg', 'ffprobe']) {
    const p = join(binDir, process.platform === 'win32' ? `${n}.CMD` : n);
    writeFileSync(p, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') chmodSync(p, 0o755);
  }
  const r = run([], { ...env, PATH: binDir });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /already installed via PATH/);
});

test('install-ffmpeg finds a previous app-data install and installs nothing', async () => {
  const env = await bareEnv();
  const binDir = join(env.OPENEDIT_STATE_DIR, 'ffmpeg', 'bin');
  mkdirSync(binDir, { recursive: true });
  const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);
  for (const n of ['ffmpeg', 'ffprobe']) writeFileSync(join(binDir, exe(n)), '');
  const r = run([], env);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /already installed via app-data install/);
});
