#!/usr/bin/env node
// Builds the package: cli/src -> cli/dist, and with --content the content tree's .ts -> .js in place.
//
// Content is compiled ONLY when asked, because a checkout that carries both .ts and .js gets a stale
// .js shadowing an edited .ts on the next run, silently. The packer asks for it in its own copy of
// the tree; nobody needs it here.
//
//   node cli/scripts/build.mjs [--content] [--root <dir>]
//
// --root builds a DIFFERENT copy of the tree. The packer uses it to build its pristine export while
// resolving tsc through this checkout's node_modules, which the export does not carry.
import { chmodSync, cpSync, existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag === -1 ? fileURLToPath(new URL('../..', import.meta.url)) : resolve(process.argv[rootFlag + 1]);

// Resolved through node rather than assumed at node_modules/.bin, so a temp copy of the tree with no
// node_modules of its own still builds against the checkout that invoked it.
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');

function tsc(project) {
  const r = spawnSync(process.execPath, [TSC, '-p', join(ROOT, project)], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`build: tsc -p ${project} failed`);
}

/**
 * Every ref in the runtime index must import and expose the generator shape. A recipe that throws on
 * import, or that lost its default export in a refactor, is a run that fails at the last gate before
 * the render — after the transcript, the frames and the style draw are all already paid for.
 */
async function assertRecipesLoad(root) {
  const index = JSON.parse(readFileSync(join(root, 'refs', 'tags.json'), 'utf8'));
  const refs = Array.isArray(index) ? index : index.refs;
  // An index shape this cannot read must stop the build. Reading it as an empty pool would report
  // success having checked nothing, which is the one outcome worse than a failure here.
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(`build: refs/tags.json under ${root} is not a runtime index this understands`);
  }
  for (const { id } of refs) {
    const file = join(root, 'refs', 'html', id, 'recipe.js');
    if (!existsSync(file)) throw new Error(`build: ${id}/recipe.js was not emitted`);
    const mod = await import(pathToFileURL(file).href);
    const recipe = mod.default;
    if (!recipe || typeof recipe.generate !== 'function') throw new Error(`build: ${id}/recipe.js has no default export with a generate()`);
    if (recipe.refId !== id) throw new Error(`build: ${id}/recipe.js declares refId ${JSON.stringify(recipe.refId)}`);
  }
  return refs.length;
}

tsc('cli/tsconfig.build.json');

// The bin entry is executed directly by npm's shim, and tsc does not carry the mode across.
chmodSync(join(ROOT, 'cli', 'dist', 'cli.js'), 0o755);

// Static assets tsc does not know about: the OAuth landing page and the preview UI.
mkdirSync(join(ROOT, 'cli', 'dist', 'veed'), { recursive: true });
copyFileSync(join(ROOT, 'cli', 'src', 'veed', 'login-success.html'), join(ROOT, 'cli', 'dist', 'veed', 'login-success.html'));
cpSync(join(ROOT, 'cli', 'src', 'preview', 'page'), join(ROOT, 'cli', 'dist', 'preview', 'page'), { recursive: true });

if (process.argv.includes('--content')) {
  tsc('tsconfig.content.json');
  const n = await assertRecipesLoad(ROOT);
  console.log(`build: cli/dist + content (${n} recipes load)`);
} else {
  console.log('build: cli/dist');
}
