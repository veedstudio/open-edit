// NEW SESSION: a fresh, empty folder becomes a ready project — real npm, real git, the packed
// tarball as the pinned dep. Needs a provisioned host; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FFMPEG } from '../src/config.ts';
import { BASE_TGZ, TOOLS_READY, TOOLS_SKIP, cli, initWorkspace, installCli, real, tmp } from './harness.ts';

const installed = TOOLS_READY ? installCli(BASE_TGZ, tmp('openedit-it-host-')) : '';

test('bare init in an empty folder yields a ready, git-friendly npm project', { skip: TOOLS_SKIP }, () => {
  const proj = tmp('openedit-it-fresh-');
  const r = initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(real(r.stdout.trim()), real(proj), 'stdout carries the workspace as OPEN_EDIT_ROOT');
  assert.match(r.stderr, /ready — OPEN_EDIT_ROOT=/);
  assert.match(r.stderr, /packaged content/);

  const pkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.ok(pkg.devDependencies['@veedstudio/openedit-cli'], 'the CLI is pinned as a devDependency');
  assert.ok(existsSync(join(proj, 'package-lock.json')), 'the project is lockfile-reproducible');
  const ignore = readFileSync(join(proj, '.gitignore'), 'utf8').split('\n');
  for (const line of ['node_modules/', 'runs/', '.open-edit-prefs.json']) assert.ok(ignore.includes(line), line);
  assert.ok(existsSync(join(proj, '.git')), 'git init ran');
  assert.ok(existsSync(join(proj, '.claude', 'skills', 'open-edit', 'SKILL.md')), 'the skill rode in from packaged content');
  assert.ok(existsSync(join(proj, '.claude', 'settings.json')), 'the Claude SessionStart hook landed');
  assert.ok(!existsSync(join(proj, 'node_modules', '.bin', 'tsx')), 'no tsx: nothing pnpm-installed');
});

test('the scaffolded project runs ITS OWN pinned CLI', { skip: TOOLS_SKIP }, () => {
  const proj = tmp('openedit-it-fresh2-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  const projectCli = join(proj, 'node_modules', '@veedstudio', 'openedit-cli');
  assert.ok(existsSync(join(projectCli, 'cli', 'dist', 'cli.js')), 'the pinned dep is a full install');

  const version = cli(projectCli, ['--version'], { cwd: proj });
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(projectCli, 'package.json'), 'utf8')).version);
});

test('whisper writes into the project the CLI walks up to, with no OPEN_EDIT_ROOT', { skip: TOOLS_SKIP }, () => {
  const proj = tmp('openedit-it-whisper-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  const projectCli = join(proj, 'node_modules', '@veedstudio', 'openedit-cli');

  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=736x1312:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'sample.mp4',
  ], { cwd: proj, stdio: 'ignore' });
  writeFileSync(join(proj, 'whisper.json'), JSON.stringify({
    text: 'one command builds this video',
    language: 'en',
    segments: [{
      id: 0, start: 0.3, end: 3.4, text: ' one command builds this video',
      words: [
        { word: ' one', start: 0.3, end: 0.8 },
        { word: ' command', start: 0.8, end: 1.6 },
        { word: ' builds', start: 1.6, end: 2.2 },
        { word: ' this', start: 2.2, end: 2.7 },
        { word: ' video', start: 2.7, end: 3.4 },
      ],
    }],
  }));

  const whisper = cli(projectCli, ['whisper', 'whisper.json', 'sample.mp4'], { cwd: proj });
  assert.equal(whisper.status, 0, whisper.stderr);
  assert.ok(existsSync(join(proj, 'runs', 'sample', 'transcript.json')), 'the transcript landed in the project, not app-data');
});
