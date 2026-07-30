#!/usr/bin/env node
// Idempotently merge Open Edit SessionStart hooks into a project without replacing unrelated settings.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const [workspaceArg, skillRootArg] = process.argv.slice(2);
if (!workspaceArg || !skillRootArg) {
  console.error('usage: install-project-hooks.mjs <workspace> <skill-root>');
  process.exit(1);
}

const workspace = resolve(workspaceArg);
const skillRoot = resolve(skillRootArg);
const relativeHook = relative(workspace, resolve(skillRoot, 'hooks/session-start.sh')).split(sep).join('/');
if (!relativeHook || relativeHook.startsWith('../')) {
  console.error('preflight: hook installation skipped — installed skill is outside the project');
  process.exit(0);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

async function merge(path, event) {
  const document = await readJson(path);
  document.hooks ??= {};
  document.hooks.SessionStart ??= [];
  const groups = document.hooks.SessionStart;
  const alreadyPresent = groups.some(group =>
    Array.isArray(group?.hooks) && group.hooks.some(hook => hook?.command === event.command));
  if (alreadyPresent) return;
  groups.push(event.group);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  console.error(`preflight: installed SessionStart hook in ${relative(workspace, path)}`);
}

const plainCommand = `bash "${relativeHook}"`;
const claudeCommand = `bash "$CLAUDE_PROJECT_DIR/${relativeHook}" claude`;
await merge(resolve(workspace, '.claude/settings.json'), {
  command: claudeCommand,
  group: { hooks: [{ type: 'command', command: claudeCommand }] },
});
await merge(resolve(workspace, '.codex/hooks.json'), {
  command: `${plainCommand} codex`,
  group: {
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: `${plainCommand} codex`, statusMessage: 'Checking Open Edit setup' }],
  },
});
await merge(resolve(workspace, '.gemini/settings.json'), {
  command: `${plainCommand} gemini`,
  group: {
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: `${plainCommand} gemini`, name: 'Open Edit preflight', timeout: 120000 }],
  },
});
