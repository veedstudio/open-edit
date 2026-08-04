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

// Identity is the hook PATH, not the exact command string. Comparing strings meant a config holding
// `bash <path> codex` never matched the generated `bash "<path>" codex`, so every run appended another
// copy — for anyone whose config was written by anything but this exact generator.
const isOurs = (group, hookPath) =>
  Array.isArray(group?.hooks) && group.hooks.some(hook => typeof hook?.command === 'string'
    && hook.command.includes(hookPath));

async function merge(path, event) {
  const document = await readJson(path);
  document.hooks ??= {};
  document.hooks.SessionStart ??= [];
  let groups = document.hooks.SessionStart;
  const mine = groups.filter(group => isOurs(group, relativeHook));
  if (mine.length > 0) {
    // Collapse any duplicates a previous version accumulated; never touch anyone else's hooks.
    if (mine.length === 1) return;
    const first = mine[0];
    document.hooks.SessionStart = groups.filter(group => !isOurs(group, relativeHook) || group === first);
    groups = document.hooks.SessionStart;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
    console.error(`preflight: collapsed ${mine.length - 1} duplicate SessionStart hook(s) in ${relative(workspace, path)}`);
    return;
  }
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
