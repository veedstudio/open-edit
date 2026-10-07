// UPDATES: the notice and init --update end to end against a stub registry over real HTTP, the
// project's own npm installing. The logic is unit-pinned; this proves the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { BASE_TGZ, NEXT_TGZ, TOOLS_READY, TOOLS_SKIP, cli, initWorkspace, installCli, tmp } from './harness.ts';

const installed = TOOLS_READY ? installCli(BASE_TGZ, tmp('openedit-it-uphost-')) : '';
const STUB = fileURLToPath(new URL('./stub-registry.mjs', import.meta.url));

interface Registry { url: string; stop: () => void }

function startRegistry(args: string[]): Promise<Registry> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STUB, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const port = buffer.match(/PORT (\d+)/)?.[1];
      if (port) resolve({ url: `http://127.0.0.1:${port}/`, stop: () => child.kill() });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`stub registry exited ${code} before listening`)));
  });
}

function project(): string {
  const proj = tmp('openedit-it-update-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  return proj;
}

const pinOf = (proj: string) =>
  JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8')).devDependencies['@veedstudio/openedit-cli'];

// The notice suites give the CLI a state dir of their own, which on Windows is also where FFmpeg was
// installed; naming the binaries keeps init from reporting it missing.
const noticeEnv = (registry: Registry, stateDir: string) => ({
  OPENEDIT_REGISTRY: registry.url, OPENEDIT_STATE_DIR: stateDir, OPENEDIT_FFMPEG: FFMPEG, OPENEDIT_FFPROBE: FFPROBE, NO_UPDATE_NOTIFIER: '', CI: '',
});

const viaStub = (proj: string, registry: Registry) =>
  // The scoped line too: a user-level @veedstudio:registry mapping outranks plain registry=.
  writeFileSync(join(proj, '.npmrc'), `registry=${registry.url}\n@veedstudio:registry=${registry.url}\n`);

test('bare init leaves a newer release alone: nothing moves until someone asks', { skip: TOOLS_SKIP }, async () => {
  const proj = project();
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '1.3.0']);
  try {
    viaStub(proj, registry);
    const pinBefore = pinOf(proj);
    const r = cli(installed, ['init', '--workspace', proj], { cwd: proj, env: { OPENEDIT_REGISTRY: registry.url } });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /updated @veedstudio/);
    assert.equal(pinOf(proj), pinBefore, 'the pin did not move');
  } finally {
    registry.stop();
  }
});

test('--update <version> flows through: project npm install → moved pin, moved lockfile', { skip: TOOLS_SKIP }, async () => {
  const proj = project();
  const lockBefore = readFileSync(join(proj, 'package-lock.json'), 'utf8');
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '1.3.0']);
  try {
    viaStub(proj, registry);
    const r = cli(installed, ['init', '--update', '1.3.0', '--workspace', proj], { cwd: proj });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /updated @veedstudio\/openedit-cli \S+ → 1\.3\.0/);
    assert.equal(pinOf(proj), '1.3.0', 'the exact pin moved');
    assert.notEqual(readFileSync(join(proj, 'package-lock.json'), 'utf8'), lockBefore, 'the update is a visible lockfile diff');
    const installedVersion = JSON.parse(readFileSync(
      join(proj, 'node_modules', '@veedstudio', 'openedit-cli', 'package.json'), 'utf8')).version;
    assert.equal(installedVersion, '1.3.0', 'the project now runs the new version');
  } finally {
    registry.stop();
  }
});

test('the real binary announces a newer release first thing on the run after its lookup', { skip: TOOLS_SKIP }, async () => {
  const proj = project();
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '1.3.0']);
  try {
    const env = noticeEnv(registry, tmp('openedit-it-notice-'));
    const pinBefore = pinOf(proj);
    const first = cli(installed, ['init', '--dry', '--workspace', proj], { cwd: proj, env });
    assert.doesNotMatch(first.stderr, /update available/);
    const second = cli(installed, ['init', '--dry', '--workspace', proj], { cwd: proj, env });
    assert.match(second.stderr.split(/\r?\n/)[0], /^openedit: update available — @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0\. .*init --update 1\.3\.0$/);
    assert.equal(pinOf(proj), pinBefore, 'announcing installs nothing');
  } finally {
    registry.stop();
  }
});

test('a registry that accepts and never answers holds a command up only for the lookup timeout', { skip: TOOLS_SKIP }, async () => {
  const proj = project();
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '1.3.0', '--mode', 'hang']);
  try {
    const env = noticeEnv(registry, tmp('openedit-it-hang-'));
    const started = Date.now();
    const r = cli(installed, ['init', '--dry', '--workspace', proj], { cwd: proj, env });
    assert.ok(Date.now() - started < 15_000, 'the hung socket held the command open');
    assert.equal(r.status, 0, r.stderr);
  } finally {
    registry.stop();
  }
});
