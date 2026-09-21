// UPDATES: the flow end to end against a stub registry over real HTTP, the project's own npm
// installing. Tier logic is unit-pinned; this proves the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_TGZ, NEXT_TGZ, SKIP_REASON, TOOLS_READY, TOOLS_SKIP, cli, initWorkspace, installCli, onlyRendererApproval, tmp } from './harness.ts';

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

// Needs a real engine: the silent tier grades the release's floor against the installed renderer,
// so an under-floor host correctly refuses.
test('a minor release flows through: lookup → project npm install → moved pin, moved lockfile', { skip: SKIP_REASON }, async () => {
  const proj = project();
  const lockBefore = readFileSync(join(proj, 'package-lock.json'), 'utf8');
  // No injected floor: the stub serves the tarball's own openedit.minEngine, so this fails the
  // day a release ships without the field.
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '1.3.0']);
  try {
    // The scoped line too: a user-level @veedstudio:registry mapping outranks plain registry=.
    writeFileSync(join(proj, '.npmrc'), `registry=${registry.url}\n@veedstudio:registry=${registry.url}\n`);
    const r = cli(installed, ['init', '--workspace', proj], { cwd: proj, env: { OPENEDIT_REGISTRY: registry.url } });
    assert.ok(r.status === 0 || (r.status === 10 && onlyRendererApproval(r.stderr)), r.stderr);
    assert.match(r.stderr, /updated @veedstudio\/openedit-cli 1\.2\.3 → 1\.3\.0/);
    assert.equal(pinOf(proj), '1.3.0', 'the exact pin moved');
    assert.notEqual(readFileSync(join(proj, 'package-lock.json'), 'utf8'), lockBefore, 'the update is a visible lockfile diff');
    const installedVersion = JSON.parse(readFileSync(
      join(proj, 'node_modules', '@veedstudio', 'openedit-cli', 'package.json'), 'utf8')).version;
    assert.equal(installedVersion, '1.3.0', 'the project now runs the new version');
  } finally {
    registry.stop();
  }
});

test('a major release is reported and waits — the real binary asks, nothing installs', { skip: TOOLS_SKIP }, async () => {
  const proj = project();
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '2.0.0', '--min-engine', '0.9.0']);
  try {
    writeFileSync(join(proj, '.npmrc'), `registry=${registry.url}\n@veedstudio:registry=${registry.url}\n`);
    const r = cli(installed, ['init', '--workspace', proj], { cwd: proj, env: { OPENEDIT_REGISTRY: registry.url } });
    assert.equal(r.status, 10, r.stderr);
    assert.match(r.stderr, /APPROVAL REQUIRED — update @veedstudio\/openedit-cli from 1\.2\.3 to 2\.0\.0/);
    assert.notEqual(pinOf(proj), '2.0.0', 'nothing installed without approval');
  } finally {
    registry.stop();
  }
});

test('an unreachable registry is silent: the session starts on what it has', { skip: TOOLS_SKIP }, () => {
  const proj = project();
  const r = cli(installed, ['init', '--workspace', proj], { cwd: proj });
  assert.ok(r.status === 0 || (r.status === 10 && onlyRendererApproval(r.stderr)), r.stderr);
  assert.doesNotMatch(r.stderr, /updated @veedstudio/);
  assert.doesNotMatch(r.stderr, /update .* failed/);
});

test('a registry that accepts and never answers is bounded by the lookup timeout, then silent', { skip: TOOLS_SKIP }, async () => {
  const proj = project();
  const registry = await startRegistry(['--tarball', NEXT_TGZ, '--latest', '1.3.0', '--mode', 'hang']);
  try {
    const started = Date.now();
    const r = cli(installed, ['init', '--workspace', proj], { cwd: proj, env: { OPENEDIT_REGISTRY: registry.url } });
    assert.ok(Date.now() - started < 60_000, 'the hung socket cannot stall the session start');
    assert.ok(r.status === 0 || (r.status === 10 && onlyRendererApproval(r.stderr)), r.stderr);
    assert.doesNotMatch(r.stderr, /updated @veedstudio/);
  } finally {
    registry.stop();
  }
});
