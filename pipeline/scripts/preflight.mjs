#!/usr/bin/env node
// Compatibility entrypoint (the cross-platform twin of preflight.sh). The canonical setup lives in
// the published CLI: `npx @veedstudio/openedit-cli init`. Every argument passes through untouched.
//
// It adds no --workspace of its own. This file travels with the content tree, which inside an
// install is a directory under node_modules — naming it as the workspace would put a user's renders
// there. Left alone, init takes the invoking checkout's top level, or the working directory.
import { spawnSync } from 'node:child_process';

// Shell on Windows: npx installs as a .cmd shim Node cannot exec directly.
const result = spawnSync('npx', ['--yes', '@veedstudio/openedit-cli', 'init', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
