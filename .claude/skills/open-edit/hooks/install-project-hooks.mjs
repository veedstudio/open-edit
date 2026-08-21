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
const toRelative = (file) => relative(workspace, resolve(skillRoot, file)).split(sep).join('/');
const relativeHook = toRelative('hooks/session-start.mjs');
// Configs written before the Node port hold the shell adapter's path; recognise those as ours too.
const legacyHook = toRelative('hooks/session-start.sh');
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

async function persist(path, document) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

async function merge(path, event) {
  const document = await readJson(path);
  document.hooks ??= {};
  document.hooks.SessionStart ??= [];
  const groups = document.hooks.SessionStart;
  const mine = groups.filter(group => isOurs(group, relativeHook) || isOurs(group, legacyHook));
  const current = mine.filter(group => isOurs(group, relativeHook));
  if (mine.length === 1 && current.length === 1) return;
  if (mine.length === 0) {
    groups.push(event.group);
    await persist(path, document);
    console.error(`preflight: installed SessionStart hook in ${relative(workspace, path)}`);
    return;
  }
  // One write covers both repairs: collapse duplicates a previous version accumulated, and replace a
  // legacy shell-adapter entry with the node form. Never touch anyone else's hooks.
  let kept = false;
  document.hooks.SessionStart = groups.flatMap(group => {
    if (!mine.includes(group)) return [group];
    if (kept) return [];
    kept = true;
    return [current[0] ?? event.group];
  });
  await persist(path, document);
  if (current.length === 0) {
    console.error(`preflight: migrated SessionStart hook to the node adapter in ${relative(workspace, path)}`);
  } else {
    console.error(`preflight: collapsed ${mine.length - 1} duplicate SessionStart hook(s) in ${relative(workspace, path)}`);
  }
}

// Relative-path commands, deliberately shell-neutral: every supported agent runs SessionStart hooks
// with cwd = project dir, and `$CLAUDE_PROJECT_DIR`-style expansion does not exist under cmd.exe.
const command = (agentName) => `node "${relativeHook}" ${agentName}`;
await merge(resolve(workspace, '.claude/settings.json'), {
  group: { hooks: [{ type: 'command', command: command('claude') }] },
});
await merge(resolve(workspace, '.codex/hooks.json'), {
  group: {
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: command('codex'), statusMessage: 'Checking Open Edit setup' }],
  },
});
await merge(resolve(workspace, '.gemini/settings.json'), {
  group: {
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: command('gemini'), name: 'Open Edit preflight', timeout: 120000 }],
  },
});
