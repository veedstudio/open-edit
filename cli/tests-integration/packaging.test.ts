// PACKAGING: the tarball is a working install — what a file list cannot tell you. No engine and no
// ffmpeg; the install itself still fetches the CLI's own dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_TGZ, IT_VERSION, cli, installCli, real, tmp } from './harness.ts';

// The package root IS the content root: an install and a checkout carry the same layout.
const installed = installCli(BASE_TGZ, tmp('openedit-it-pack-'));

test('the installed CLI answers --version with the stamped version, from cli/dist/', () => {
  const r = cli(installed, ['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), IT_VERSION);
});

test('content-root resolves inside the installed package, without OPEN_EDIT_ROOT', () => {
  const r = cli(installed, ['content-root'], { cwd: tmp('openedit-it-cwd-') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(real(r.stdout.trim()), real(installed));
});

test('the packed manifest declares the engine floor the auto-update check reads pre-install', () => {
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.match(pkg.openedit?.minEngine ?? '', /^\d+\.\d+\.\d+$/, 'openedit.minEngine ships in every packument');
});

test('the compiled lint gate runs offline from packaged content: plain node, no tsx, no pnpm', () => {
  const dir = tmp('openedit-it-lint-');
  const bad = join(dir, 'bad.wv');
  writeFileSync(bad, '<html><style>.x{display:grid}</style><body><div class="x">hi</div></body></html>');
  const fail = cli(installed, ['lint', bad], { cwd: dir });
  assert.equal(fail.status, 1, 'a grid document fails the engine-limit lint');
  assert.match(fail.stdout, /css-grid/);

  const clean = join(dir, 'clean.wv');
  writeFileSync(clean, '<html><body><div>hi</div></body></html>');
  const pass = cli(installed, ['lint', clean], { cwd: dir });
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
});

test('the design gate runs from packaged content and reads a run directory', () => {
  const run = tmp('openedit-it-gate-');
  const r = cli(installed, ['design-gate', run], { cwd: run });
  assert.equal(r.status, 1, 'an empty run has no design system — the gate says so');
  assert.match(r.stdout, /no-design-system/);
});

test('sample-style draws from the packaged index and stores a relative refPath', () => {
  const run = tmp('openedit-it-style-');
  writeFileSync(join(run, 'meta.json'), JSON.stringify({ key: 'it-style', width: 736, height: 1312 }));
  const r = cli(installed, ['sample-style', '--run', run], { cwd: run });
  assert.equal(r.status, 0, r.stderr);
  const style = JSON.parse(readFileSync(join(run, 'style.json'), 'utf8'));
  assert.ok(style.refId, 'a pick landed');
  assert.equal(style.hasRecipe, true, 'the packaged pool is recipes-only');
  assert.ok(!style.refPath.startsWith('/') && !/^[A-Za-z]:/.test(style.refPath), `refPath is relative: ${style.refPath}`);
  assert.ok(existsSync(join(installed, style.refPath)), 'the relative refPath resolves against the packaged content');
});
