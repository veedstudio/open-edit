// PACKAGING: the tarball is a working install — what a file list cannot tell you. No ffmpeg; the
// install itself still fetches the CLI's own dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_TGZ, IT_VERSION, cli, installCli, tmp } from './harness.ts';

const installed = installCli(BASE_TGZ, tmp('openedit-it-pack-'));

test('the installed CLI answers --version with the stamped version, from cli/dist/', () => {
  const r = cli(installed, ['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), IT_VERSION);
});

test('the installed package carries the skill init installs', () => {
  assert.ok(existsSync(join(installed, '.claude', 'skills', 'open-edit', 'SKILL.md')));
});
