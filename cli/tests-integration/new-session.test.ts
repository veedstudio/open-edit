// NEW SESSION: a fresh, empty folder becomes a ready project — real npm, real git, the packed
// tarball as the pinned dep. Needs a provisioned host; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FFMPEG } from '../src/config.ts';
import { BASE_TGZ, SKIP_REASON, TOOLS_READY, TOOLS_SKIP, cli, initWorkspace, installCli, onlyRendererApproval, real, tmp } from './harness.ts';

const installed = TOOLS_READY ? installCli(BASE_TGZ, tmp('openedit-it-host-')) : '';

test('bare init in an empty folder yields a ready, git-friendly npm project', { skip: TOOLS_SKIP }, () => {
  const proj = tmp('openedit-it-fresh-');
  const r = initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  if (r.status === 10) {
    assert.ok(onlyRendererApproval(r.stderr), `unexpected approvals:\n${r.stderr}`);
  } else {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(real(r.stdout.trim()), real(proj), 'stdout carries the workspace as OPEN_EDIT_ROOT');
    assert.match(r.stderr, /ready — OPEN_EDIT_ROOT=/);
  }
  assert.match(r.stderr, /packaged content/);

  const pkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.ok(pkg.devDependencies['@veedstudio/openedit-cli'], 'the CLI is pinned as a devDependency');
  assert.ok(existsSync(join(proj, 'package-lock.json')), 'the project is lockfile-reproducible');
  const ignore = readFileSync(join(proj, '.gitignore'), 'utf8').split('\n');
  for (const line of ['node_modules/', 'runs/', '.open-edit/', '.open-edit-prefs.json']) assert.ok(ignore.includes(line), line);
  assert.ok(existsSync(join(proj, '.git')), 'git init ran');
  assert.ok(existsSync(join(proj, '.claude', 'skills', 'open-edit', 'SKILL.md')), 'the skill rode in from packaged content');
  assert.ok(existsSync(join(proj, '.claude', 'settings.json')), 'the Claude SessionStart hook landed');
  assert.ok(!existsSync(join(proj, '.open-edit')), 'nothing was cloned');
  assert.ok(!existsSync(join(proj, 'node_modules', '.bin', 'tsx')), 'no tsx, no pnpm-installed runtime');
});

test('the scaffolded project runs the gates offline through ITS OWN pinned CLI', { skip: TOOLS_SKIP }, () => {
  const proj = tmp('openedit-it-fresh2-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  const projectCli = join(proj, 'node_modules', '@veedstudio', 'openedit-cli');
  assert.ok(existsSync(join(projectCli, 'cli', 'dist', 'cli.js')), 'the pinned dep is a full install');

  const version = cli(projectCli, ['--version'], { cwd: proj });
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(projectCli, 'package.json'), 'utf8')).version);

  const root = cli(projectCli, ['content-root'], { cwd: proj });
  assert.equal(real(root.stdout.trim()), real(projectCli), 'the project CLI reads its own packaged content');

  const bad = join(proj, 'bad.wv');
  writeFileSync(bad, '<html><style>.x{color:red} @import url("https://fonts.googleapis.com/css2?family=Inter");</style><body><div class="x">hi</div></body></html>');
  const gate = cli(projectCli, ['lint', bad], { cwd: proj });
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /import-not-first/, 'the compiled lint gate runs in the workspace, no tsx');
});

// The classic-pool route the skill documents: whisper JSON → prep → --module …/recipe.js (the
// compiled module runs as plain node anywhere; node_modules .ts is never type-stripped).
function classicRun(prefix: string): { proj: string; projectCli: string; module: string } {
  const proj = tmp(prefix);
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

  // No OPEN_EDIT_ROOT anywhere: these land in the project only because the CLI walks up from cwd.
  // An explicit --run on the step after would have hidden it.
  const whisper = cli(projectCli, ['whisper', 'whisper.json', 'sample.mp4'], { cwd: proj });
  assert.equal(whisper.status, 0, whisper.stderr);
  assert.ok(existsSync(join(proj, 'runs', 'sample', 'transcript.json')), 'the transcript landed in the project');
  const prep = cli(projectCli, ['prep', 'sample.mp4'], { cwd: proj });
  assert.equal(prep.status, 0, prep.stderr);
  assert.ok(existsSync(join(proj, 'runs', 'sample', 'meta.json')), 'prep wrote into the project, not app-data');

  const module = join(projectCli, 'refs', 'html', 'classic', 'mint', 'recipe.js');
  assert.ok(existsSync(module), 'the classic pool ships compiled');
  return { proj, projectCli, module };
}

test('the classic --module route runs through the compiled recipe.js, into the project', { skip: TOOLS_SKIP }, () => {
  const { proj, projectCli, module } = classicRun('openedit-it-classic-');
  const generate = cli(projectCli, ['generate-recipe', '--run', join(proj, 'runs', 'sample'), '--module', module], { cwd: proj });
  assert.equal(generate.status, 0, generate.stdout + generate.stderr);
  assert.ok(existsSync(join(proj, 'runs', 'sample', 'final', 'template.wv')), 'the compiled classic recipe emitted the document');
  assert.ok(existsSync(join(proj, 'runs', 'sample', 'final', 'manifest.json')));
});

// The only case that needs a real renderer: the engine's cwd, env and fonts are what a packaged
// tree can break.
test('the installed engine verifies the document the packaged recipe emitted', { skip: SKIP_REASON }, () => {
  const { proj, projectCli, module } = classicRun('openedit-it-verify-');
  const generate = cli(projectCli, ['generate-recipe', '--run', join(proj, 'runs', 'sample'), '--module', module, '--verify'], { cwd: proj });
  assert.equal(generate.status, 0, generate.stdout + generate.stderr);
  assert.match(generate.stdout, /verify clean/, 'the renderer read the packaged document');
});

test('--module at packaged TypeScript resolves the compiled sibling instead of failing', { skip: TOOLS_SKIP }, () => {
  // The agent that types the .ts path from a recipe sheet gets a module that loads, not advice.
  const proj = tmp('openedit-it-modts-');
  initWorkspace(installed, proj, { OPENEDIT_PACKAGE_SOURCE: BASE_TGZ });
  const projectCli = join(proj, 'node_modules', '@veedstudio', 'openedit-cli');
  const source = join(projectCli, 'refs', 'html', 'classic', 'mint', 'recipe.ts');
  assert.ok(existsSync(source), 'the sheet-named .ts ships alongside its compiled module');

  const r = cli(projectCli, ['generate-recipe', '--run', join(proj, 'runs', 'none'), '--module', source], { cwd: proj });
  assert.match(r.stdout, /module .*recipe\.js/, 'the .ts argument resolved to the compiled sibling');
  assert.doesNotMatch(r.stderr, /TYPE_STRIPPING|is TypeScript/, 'no type-stripping wall, and no advice to retype the path');
});
