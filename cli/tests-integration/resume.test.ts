// RESUME: an existing project is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_TGZ, TOOLS_READY, TOOLS_SKIP, cli, initWorkspace, installCli, tmp } from './harness.ts';

const installed = TOOLS_READY ? installCli(BASE_TGZ, tmp('openedit-it-reshost-')) : '';

function scaffolded(): string {
  const proj = tmp('openedit-it-resume-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  return proj;
}

test('session-start on an existing project is a quiet no-op: nothing rewritten, nothing re-asked', { skip: TOOLS_SKIP }, () => {
  const proj = scaffolded();
  writeFileSync(join(proj, '.open-edit-prefs.json'), '{"transcription":{"provider":"whisperx","model":"medium"}}\n');
  mkdirSync(join(proj, 'runs', 'old-run'), { recursive: true });
  writeFileSync(join(proj, 'runs', 'old-run', 'transcript.json'), '{"text":"","chunks":[]}');
  const before = {
    pkg: readFileSync(join(proj, 'package.json'), 'utf8'),
    lock: readFileSync(join(proj, 'package-lock.json'), 'utf8'),
    ignore: readFileSync(join(proj, '.gitignore'), 'utf8'),
  };

  const r = cli(installed, ['session-start', 'claude'], { cwd: proj });
  assert.equal(r.status, 0, 'the hook adapter always exits 0');
  assert.match(r.stdout, /Open Edit/, 'a context note is emitted for the agent');

  assert.equal(readFileSync(join(proj, 'package.json'), 'utf8'), before.pkg, 'package.json untouched');
  assert.equal(readFileSync(join(proj, 'package-lock.json'), 'utf8'), before.lock, 'lockfile untouched');
  assert.equal(readFileSync(join(proj, '.gitignore'), 'utf8'), before.ignore, '.gitignore untouched');
  assert.equal(
    readFileSync(join(proj, '.open-edit-prefs.json'), 'utf8'),
    '{"transcription":{"provider":"whisperx","model":"medium"}}\n',
    'the recorded provider is never re-asked or rewritten',
  );
  assert.ok(existsSync(join(proj, 'runs', 'old-run', 'transcript.json')), 'existing runs stay put');
});
