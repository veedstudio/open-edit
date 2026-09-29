import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { findOnPath } from '../src/platform.ts';

// Subprocess runs, because config.ts resolves the state dir at import time: each case needs its
// own OPENEDIT_STATE_DIR and PATH before the module loads.
const cliEntry = resolve(import.meta.dirname, '../src/cli.ts');
const run = (args: string[], env: Record<string, string>) => {
  const merged: Record<string, string | undefined> = { ...process.env };
  // The host's own override must not leak into the fixture's resolution; a case's own may.
  delete merged.OPENEDIT_FFMPEG;
  delete merged.OPENEDIT_FFPROBE;
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, 'install-ffmpeg', ...args], {
    encoding: 'utf8',
    env: { ...merged, ...env },
  });
};

// The host's own pair, named explicitly: its ffprobe need not sit beside its ffmpeg.
const hostPair = () => {
  const [ffmpeg, ffprobe] = [FFMPEG, FFPROBE].map((bin) => (isAbsolute(bin) ? bin : findOnPath(bin)));
  assert.ok(ffmpeg && ffprobe, 'the host has no ffmpeg/ffprobe to run');
  return { OPENEDIT_FFMPEG: ffmpeg, OPENEDIT_FFPROBE: ffprobe };
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

// CI's setup check rests on this: a binary that exists but cannot start (a missing DLL, a broken
// dylib) fails every command that needs it, so --check must run it rather than find it.
test('install-ffmpeg --check fails on an FFmpeg that is present but does not run', async () => {
  const env = await bareEnv();
  const binDir = join(env.OPENEDIT_STATE_DIR, 'broken-path');
  mkdirSync(binDir, { recursive: true });
  for (const n of ['ffmpeg', 'ffprobe']) {
    const p = join(binDir, process.platform === 'win32' ? `${n}.CMD` : n);
    writeFileSync(p, process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
    if (process.platform !== 'win32') chmodSync(p, 0o755);
  }
  const r = run(['--check'], { ...env, PATH: binDir });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /installed via PATH, but \S*ffmpeg\S* does not run/);
});

// config.ts uses the override unconditionally, so a broken one cannot be excused by a working PATH copy.
test('install-ffmpeg --check passes an FFmpeg that runs, and holds the env override to the same bar', async () => {
  const host = hostPair();
  const ok = run(['--check'], { ...(await bareEnv()), ...host });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /installed via OPENEDIT_FFMPEG \(ffprobe: OPENEDIT_FFPROBE\) — ffmpeg version/);

  const broken = run(['--check'], { ...(await bareEnv()), OPENEDIT_FFMPEG: join(tmpdir(), 'no-such-ffmpeg'), PATH: dirname(host.OPENEDIT_FFMPEG) });
  assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
  assert.match(broken.stdout, /installed via OPENEDIT_FFMPEG, but \S*no-such-ffmpeg does not run/);
});

// Every probe the pipeline makes goes through ffprobe, so an ffmpeg that runs beside an ffprobe that
// does not is no FFmpeg at all.
test('install-ffmpeg --check runs ffprobe too', async () => {
  const r = run(['--check'], { ...(await bareEnv()), ...hostPair(), OPENEDIT_FFPROBE: join(tmpdir(), 'no-such-ffprobe') });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /installed via OPENEDIT_FFMPEG \(ffprobe: OPENEDIT_FFPROBE\), but \S*no-such-ffprobe does not run/);
});

// A PATH holding both tools, so only the override can decide the outcome.
const hostPath = () => {
  const host = hostPair();
  return [dirname(host.OPENEDIT_FFMPEG), dirname(host.OPENEDIT_FFPROBE)].join(delimiter);
};

// config.ts takes OPENEDIT_FFPROBE ahead of app-data and PATH whether or not OPENEDIT_FFMPEG is set.
test('install-ffmpeg runs a set OPENEDIT_FFPROBE on its own, and names it when it fails', async () => {
  const noSuch = join(tmpdir(), 'no-such-ffprobe');
  const check = run(['--check'], { ...(await bareEnv()), PATH: hostPath(), OPENEDIT_FFPROBE: noSuch });
  assert.equal(check.status, 1, `${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /installed via PATH \(ffprobe: OPENEDIT_FFPROBE\), but \S*no-such-ffprobe does not run/);

  const plain = run([], { ...(await bareEnv()), PATH: hostPath(), OPENEDIT_FFPROBE: noSuch });
  assert.equal(plain.status, 1, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stderr, /OPENEDIT_FFPROBE is set, but \S*no-such-ffprobe does not run \(.+\); fix or unset it —/);
  assert.doesNotMatch(plain.stdout, /already installed/);

  const both = run([], { ...(await bareEnv()), ...hostPair(), OPENEDIT_FFPROBE: noSuch });
  assert.equal(both.status, 1, `${both.stdout}${both.stderr}`);
  assert.match(both.stderr, /OPENEDIT_FFPROBE is set, but \S*no-such-ffprobe does not run/);
  assert.doesNotMatch(both.stderr, /OPENEDIT_FFMPEG is set/, 'blamed a variable whose removal cannot help');

  // The inverse: a working override is what runs, however broken the PATH ffprobe is.
  const env = await bareEnv();
  const brokenDir = join(env.OPENEDIT_STATE_DIR, 'broken-path');
  mkdirSync(brokenDir, { recursive: true });
  const brokenProbe = join(brokenDir, process.platform === 'win32' ? 'ffprobe.CMD' : 'ffprobe');
  writeFileSync(brokenProbe, process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
  if (process.platform !== 'win32') chmodSync(brokenProbe, 0o755);
  const honoured = run(['--check'], { ...env, PATH: [brokenDir, hostPath()].join(delimiter), OPENEDIT_FFPROBE: hostPair().OPENEDIT_FFPROBE });
  assert.equal(honoured.status, 0, `${honoured.stdout}${honoured.stderr}`);
  assert.match(honoured.stdout, /installed via PATH \(ffprobe: OPENEDIT_FFPROBE\) — ffmpeg version/);
});

// config.ts keeps running an override over any app-data copy, so --force would download one nothing
// uses and then call it the FFmpeg every command finds.
test('install-ffmpeg --force refuses while an override is set, and downloads nothing', async () => {
  const both = run(['--force'], { ...(await bareEnv()), ...hostPair() });
  assert.equal(both.status, 1, `${both.stdout}${both.stderr}`);
  assert.match(both.stderr, /OPENEDIT_FFMPEG and OPENEDIT_FFPROBE are set, so every command runs .+ over the app-data copy --force would install; unset them, then re-run with --force\./);
  assert.doesNotMatch(`${both.stdout}${both.stderr}`, /installing FFmpeg|download route/);

  const probeOnly = run(['--force'], { ...(await bareEnv()), PATH: hostPath(), OPENEDIT_FFPROBE: hostPair().OPENEDIT_FFPROBE });
  assert.equal(probeOnly.status, 1, `${probeOnly.stdout}${probeOnly.stderr}`);
  assert.match(probeOnly.stderr, /OPENEDIT_FFPROBE is set, so every command runs \S+ over the app-data copy --force would install; unset it/);

  // Nor may the no-op answer point at the flag that is refused.
  const plain = run([], { ...(await bareEnv()), ...hostPair() });
  assert.equal(plain.status, 0, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stdout, /already installed via OPENEDIT_FFMPEG/);
  assert.doesNotMatch(plain.stdout, /--force/);
});

// Unsetting OPENEDIT_FFMPEG is not the only way out when it is the ffprobe beside it that is missing.
test('install-ffmpeg offers OPENEDIT_FFPROBE when the ffprobe beside OPENEDIT_FFMPEG is missing', { skip: process.platform === 'win32' && 'a script cannot stand in for ffmpeg.exe' }, async () => {
  const env = await bareEnv();
  const dir = join(env.OPENEDIT_STATE_DIR, 'lone');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\necho ffmpeg version fake\n');
  chmodSync(join(dir, 'ffmpeg'), 0o755);
  const r = run([], { ...env, OPENEDIT_FFMPEG: join(dir, 'ffmpeg') });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /OPENEDIT_FFMPEG is set, but \S*lone\/ffprobe does not run \(.+\); fix or unset it, or set OPENEDIT_FFPROBE to an ffprobe elsewhere —/);
});

// The override is what every command runs, so reporting it installed without running it sent init
// and the user on to an install that could never help.
test('install-ffmpeg runs a set OPENEDIT_FFMPEG before calling it installed', async () => {
  const ok = run([], { ...(await bareEnv()), ...hostPair() });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /already installed via OPENEDIT_FFMPEG/);

  const broken = run([], { ...(await bareEnv()), OPENEDIT_FFMPEG: join(tmpdir(), 'no-such-ffmpeg') });
  assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
  assert.match(broken.stderr, /OPENEDIT_FFMPEG is set, but \S*no-such-ffmpeg does not run \(.+\); fix or unset it/);
  assert.doesNotMatch(broken.stdout, /already installed/);
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

// A sudo command described as needing no admin rights reads as safe to run unasked.
test('install-ffmpeg claims no admin rights only for Homebrew; on Linux it names a system install', async () => {
  const { noDownloadRoute } = await import('../src/commands/install-ffmpeg.ts');
  assert.match(noDownloadRoute('darwin'), /`brew install ffmpeg`, which needs no admin rights/);
  const linux = noDownloadRoute('linux');
  assert.match(linux, /`sudo apt install ffmpeg`, a system install that needs root/);
  assert.doesNotMatch(linux, /no admin rights/);
});
