#!/usr/bin/env node
// Compatibility entrypoint (the cross-platform twin of preflight.sh). The canonical setup lives in
// the published CLI: `npx @veedstudio/openedit-cli init`. This shim only defaults the workspace to
// this checkout.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Only default the workspace when the caller did not give one, otherwise it is passed twice.
const args = process.argv.slice(2);
if (!args.includes('--workspace')) args.unshift('--workspace', repoRoot);

// Shell on Windows: npx installs as a .cmd shim Node cannot exec directly.
const result = spawnSync('npx', ['--yes', '@veedstudio/openedit-cli', 'init', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
