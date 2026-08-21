#!/usr/bin/env node
// Compatibility entrypoint (the cross-platform twin of preflight.sh). The installable skill owns
// the canonical preflight implementation.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const canonical = path.join(repoRoot, '.claude', 'skills', 'open-edit', 'scripts', 'preflight.mjs');

// Only default the workspace when the caller did not give one, otherwise it is passed twice.
const args = process.argv.slice(2);
if (!args.includes('--workspace')) args.unshift('--workspace', repoRoot);
const result = spawnSync(process.execPath, [canonical, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
