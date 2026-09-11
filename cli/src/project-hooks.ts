// SessionStart hooks for the agent harnesses (Claude Code, Codex, Gemini CLI), installed by init
// into the WORKSPACE's agent configs — never a global one. Each entry invokes this package's
// session-start command, so the hook needs no files on disk beyond the configs themselves.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Package-name invocation, deliberately: a path into the npx cache dies on cache eviction, and a
// copied script would go stale. Shell-neutral — every supported agent runs SessionStart hooks with
// cwd = project dir, and `$CLAUDE_PROJECT_DIR`-style expansion does not exist under cmd.exe.
const command = (agent: string) => `npx --yes @veedstudio/openedit-cli session-start ${agent}`;

// Identity is loose on purpose: configs written by earlier versions point at the skill-bundled
// adapters (hooks/session-start.mjs or .sh, quoted or not). Those are OURS — migrate them in place,
// never append a second copy next to them.
const OURS = [/openedit-cli['" ]+session-start/, /open-edit[/\\]hooks[/\\]session-start\.(mjs|sh)/];
const isOurs = (group: unknown): boolean => {
  const hooks = (group as { hooks?: { command?: string }[] })?.hooks;
  return Array.isArray(hooks) && hooks.some((hook) =>
    typeof hook?.command === 'string' && OURS.some((pattern) => pattern.test(hook.command!)));
};

const readJson = (path: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
};

const persist = (path: string, document: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
};

const merge = (workspace: string, path: string, group: Record<string, unknown>, report: (line: string) => void): void => {
  const document = readJson(path);
  document.hooks ??= {};
  document.hooks.SessionStart ??= [];
  const groups: unknown[] = document.hooks.SessionStart;
  const mine = groups.filter(isOurs);
  const current = mine.filter((g) => JSON.stringify(g).includes('openedit-cli'));
  if (mine.length === 1 && current.length === 1) return;
  if (mine.length === 0) {
    groups.push(group);
    persist(path, document);
    report(`installed SessionStart hook in ${relative(workspace, path)}`);
    return;
  }
  // One write covers both repairs: collapse duplicates a previous version accumulated, and replace a
  // legacy skill-adapter entry with the package command. Never touch anyone else's hooks.
  let kept = false;
  document.hooks.SessionStart = groups.flatMap((entry) => {
    if (!mine.includes(entry)) return [entry];
    if (kept) return [];
    kept = true;
    return [current[0] ?? group];
  });
  persist(path, document);
  if (current.length === 0) {
    report(`migrated SessionStart hook to the CLI command in ${relative(workspace, path)}`);
  } else {
    report(`collapsed ${mine.length - 1} duplicate SessionStart hook(s) in ${relative(workspace, path)}`);
  }
};

export function installProjectHooks(workspace: string, report: (line: string) => void): void {
  merge(workspace, resolve(workspace, '.claude/settings.json'), {
    hooks: [{ type: 'command', command: command('claude') }],
  }, report);
  merge(workspace, resolve(workspace, '.codex/hooks.json'), {
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: command('codex'), statusMessage: 'Checking Open Edit setup' }],
  }, report);
  merge(workspace, resolve(workspace, '.gemini/settings.json'), {
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: command('gemini'), name: 'Open Edit preflight', timeout: 120000 }],
  }, report);
}
