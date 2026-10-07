// RESUME: an existing project is untouched, apart from the old hook going and the .agents skill copy arriving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_TGZ, TOOLS_READY, TOOLS_SKIP, cli, initWorkspace, installCli, tmp } from './harness.ts';

const installed = TOOLS_READY ? installCli(BASE_TGZ, tmp('openedit-it-reshost-')) : '';

function scaffolded(): string {
  const proj = tmp('openedit-it-resume-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  return proj;
}

// What the SessionStart hook of an earlier version still runs after the project updates past it.
test('session-start on an existing project removes the old hook, lays the .agents copy, and touches nothing else', { skip: TOOLS_SKIP }, () => {
  const proj = scaffolded();
  writeFileSync(join(proj, '.open-edit-prefs.json'), '{"transcription":{"provider":"whisperx","model":"medium"}}\n');
  mkdirSync(join(proj, 'runs', 'old-run'), { recursive: true });
  writeFileSync(join(proj, 'runs', 'old-run', 'transcript.json'), '{"text":"","chunks":[]}');
  rmSync(join(proj, '.agents'), { recursive: true, force: true });
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx --yes @veedstudio/openedit-cli session-start claude' }] }] },
  }));
  const before = {
    pkg: readFileSync(join(proj, 'package.json'), 'utf8'),
    lock: readFileSync(join(proj, 'package-lock.json'), 'utf8'),
    ignore: readFileSync(join(proj, '.gitignore'), 'utf8'),
  };
  // With the notice on and a newer release cached, a hook must still print nothing.
  const stateDir = tmp('openedit-it-resume-state-');
  writeFileSync(join(stateDir, 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: '9.9.9' }));

  const r = cli(installed, ['session-start', 'claude'], { cwd: proj, env: { OPENEDIT_STATE_DIR: stateDir, NO_UPDATE_NOTIFIER: '', CI: '' } });
  assert.equal(r.status, 0, 'session-start always exits 0');
  assert.equal(r.stdout, '', 'nothing reaches the agent\'s context');
  assert.equal(r.stderr, '', 'no update notice, nothing else');
  assert.ok(!existsSync(join(proj, '.claude', 'settings.json')), 'the old hook is gone');
  assert.ok(existsSync(join(proj, '.agents', 'skills', 'open-edit', 'SKILL.md')), 'Codex and Gemini find the skill without the hook');

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
