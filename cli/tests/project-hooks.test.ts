import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProjectHooks } from '../src/project-hooks.ts';
import { composeContext, formatNote } from '../src/commands/session-start.ts';

const quiet = () => {};

test('project hook installation preserves settings and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-hook-install-'));
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude/settings.json'), '{"existing":true}\n');

  installProjectHooks(root, quiet);
  installProjectHooks(root, quiet);

  const claude = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(claude.existing, true);
  assert.equal(claude.hooks.SessionStart.length, 1);
  assert.match(JSON.stringify(claude.hooks.SessionStart), /npx --yes @veedstudio\/openedit-cli session-start claude/);
  for (const path of [join(root, '.codex/hooks.json'), join(root, '.gemini/settings.json')]) {
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.hooks.SessionStart.length, 1);
  }
});

// Configs written by the skill-bundled installers point at hooks/session-start.mjs or .sh, quoted or
// not. Those are OURS: they migrate to the package command in place, never gain a second copy.
test('a legacy skill-adapter entry is migrated to the CLI command, not duplicated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-hook-legacy-'));
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex/hooks.json'), `${JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: 'startup|resume|clear',
        hooks: [{ type: 'command', command: 'bash .claude/skills/open-edit/hooks/session-start.sh codex', name: 'Open Edit preflight', timeout: 120000 }],
      }],
    },
  }, null, 2)}\n`);

  installProjectHooks(root, quiet);

  const codex = JSON.parse(await readFile(join(root, '.codex/hooks.json'), 'utf8'));
  assert.equal(codex.hooks.SessionStart.length, 1, 'appended a duplicate of a hook that was already installed');
  const serialized = JSON.stringify(codex.hooks.SessionStart);
  assert.match(serialized, /openedit-cli session-start codex/, 'legacy entry was not migrated to the CLI command');
  assert.doesNotMatch(serialized, /session-start\.sh/, 'legacy entry survived the migration');
});

test('duplicates already accumulated are collapsed, and unrelated hooks are left alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-hook-dupes-'));
  const rel = '.claude/skills/open-edit/hooks/session-start.mjs';
  const ours = (q: string) => ({
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: `node ${q}${rel}${q} gemini`, name: 'Open Edit preflight', timeout: 120000 }],
  });
  await mkdir(join(root, '.gemini'), { recursive: true });
  await writeFile(join(root, '.gemini/settings.json'), `${JSON.stringify({
    hooks: { SessionStart: [ours(''), ours('"'), { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2)}\n`);

  installProjectHooks(root, quiet);

  const gemini = JSON.parse(await readFile(join(root, '.gemini/settings.json'), 'utf8'));
  const serialized = JSON.stringify(gemini.hooks.SessionStart);
  assert.equal((serialized.match(/echo mine/g) ?? []).length, 1, "someone else's SessionStart hook was disturbed");
  assert.equal((serialized.match(/session-start/g) ?? []).length, 1, 'accumulated duplicates were not collapsed');
});

test('an installed CLI entry is recognised as ours on the next run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-edit-hook-stable-'));
  installProjectHooks(root, quiet);
  const before = await readFile(join(root, '.claude/settings.json'), 'utf8');
  installProjectHooks(root, quiet);
  assert.equal(await readFile(join(root, '.claude/settings.json'), 'utf8'), before);
});

// The session-start adapter itself: advisory notes, Gemini's JSON envelope.
test('a clean init becomes the ready note; a failing one carries the report verbatim', () => {
  const ready = composeContext(0, 'preflight: reusing the local checkout at /x');
  assert.match(ready, /preflight is ready/);
  const blocked = composeContext(10, 'preflight: APPROVAL REQUIRED — install ffmpeg');
  assert.match(blocked, /APPROVAL REQUIRED — install ffmpeg/);
  assert.match(blocked, /wait for explicit approval/);
  // exit 0 with an approval still pending in the text must NOT read as ready
  assert.match(composeContext(0, 'preflight: APPROVAL REQUIRED — x'), /wait for explicit approval/);
});

test('a ready init that printed its root sends the agent to the content root AGENTS.md and to no second preflight', () => {
  const note = composeContext(0, 'preflight: reusing the local checkout at /x\nready — OPEN_EDIT_ROOT=/x/runtime');
  assert.match(note, /OPEN_EDIT_ROOT=\/x\/runtime/);
  assert.match(note, /read AGENTS\.md from the content root \(`npx @veedstudio\/openedit-cli content-root`\) completely/);
  assert.match(note, /No further preflight/);
  assert.doesNotMatch(note, /init --dry/);
});

test('the Gemini note is valid SessionStart JSON; the others are plain text', () => {
  const parsed = JSON.parse(formatNote('gemini', 'hello'));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'hello');
  assert.equal(formatNote('claude', 'hello'), 'hello');
});
