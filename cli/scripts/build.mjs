#!/usr/bin/env node
// Builds the package: cli/src -> cli/dist.
//
//   node cli/scripts/build.mjs [--root <dir>]
//
// --root builds a DIFFERENT copy of the tree. The packer uses it to build its pristine export while
// resolving tsc through this checkout's node_modules, which the export does not carry.
import { chmodSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag === -1 ? fileURLToPath(new URL('../..', import.meta.url)) : resolve(process.argv[rootFlag + 1]);

// Resolved through node rather than assumed at node_modules/.bin, so a temp copy of the tree with no
// node_modules of its own still builds against the checkout that invoked it.
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');

function tsc(project) {
  const r = spawnSync(process.execPath, [TSC, '-p', join(ROOT, project)], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`build: tsc -p ${project} failed`);
}

tsc('cli/tsconfig.build.json');

// The bin entry is executed directly by npm's shim, and tsc does not carry the mode across.
chmodSync(join(ROOT, 'cli', 'dist', 'cli.js'), 0o755);

// Static assets tsc does not know about: the OAuth landing page.
mkdirSync(join(ROOT, 'cli', 'dist', 'veed'), { recursive: true });
copyFileSync(join(ROOT, 'cli', 'src', 'veed', 'login-success.html'), join(ROOT, 'cli', 'dist', 'veed', 'login-success.html'));

console.log('build: cli/dist');
