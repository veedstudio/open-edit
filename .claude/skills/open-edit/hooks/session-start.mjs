#!/usr/bin/env node
// Adapter for Claude Code, Codex, and Gemini CLI SessionStart hooks.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = process.argv[2] ?? 'plain';
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.realpathSync(process.cwd());
const preflight = process.env.OPEN_EDIT_PREFLIGHT ?? path.join(skillRoot, 'scripts', 'preflight.mjs');

// An OPEN_EDIT_PREFLIGHT override may point at a shell preflight; only .mjs goes through Node.
const argv = preflight.endsWith('.mjs') ? [process.execPath, preflight] : [preflight];
const run = spawnSync(argv[0], [...argv.slice(1), '--workspace', workspace], { encoding: 'utf8' });
const status = run.status ?? 1;
// The report goes to stderr and stdout carries only the final root, so stderr-then-stdout reads in order.
const output = `${run.stderr ?? ''}${run.stdout ?? ''}`.replace(/\n+$/, '');

let context;
if (status === 0 && !/APPROVAL REQUIRED|incomplete|not ready|waiting/.test(output)) {
  context = 'Open Edit preflight is ready. Before using the open-edit skill in this session, still run preflight --dry, resolve OPEN_EDIT_ROOT, and read OPEN_EDIT_ROOT/AGENTS.md completely. Proceed silently if preflight remains ready.';
} else {
  context = `Open Edit startup preflight reported:\n${output}\nBefore doing Open Edit work, ALWAYS run preflight --dry, communicate every APPROVAL REQUIRED action to the user, and wait for explicit approval. Run preflight --auto-approve only after the user approves all reported actions. Never install machine-global dependencies or update existing code without that approval. After resolving OPEN_EDIT_ROOT, read OPEN_EDIT_ROOT/AGENTS.md completely before running repository commands.`;
}

if (agent === 'gemini') {
  // Gemini requires JSON on stdout.
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
} else {
  console.log(context);
}

// Session startup is advisory. The context carries any setup failure to the agent.
process.exit(0);
