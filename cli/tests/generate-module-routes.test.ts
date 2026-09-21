// The tsx runner cannot reproduce the node_modules type-strip refusal (its loader transforms the
// .ts), so the handler is pinned directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleLoadHint } from '../src/commands/generate-recipe.ts';

test('a .ts module refused by node_modules type-stripping is answered with the compiled sibling', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'openedit-module-')), 'node_modules', 'pkg', 'content', 'refs', 'html', 'classic', 'mint');
  mkdirSync(dir, { recursive: true });
  const tsPath = join(dir, 'recipe.ts');
  writeFileSync(tsPath, 'export default {};\n');
  writeFileSync(join(dir, 'recipe.js'), 'export default {};\n');

  const hint = moduleLoadHint(tsPath, 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
  assert.ok(hint, 'the refusal is translated, not rethrown');
  assert.match(hint!, /never type-strip/i);
  assert.ok(hint!.includes(join(dir, 'recipe.js')), 'the fix is named: the compiled sibling');
});

test('the hint stays quiet for other load failures and for a sibling that does not exist', () => {
  assert.equal(moduleLoadHint('/x/recipe.ts', 'ERR_UNKNOWN_FILE_EXTENSION'), null, 'the strip-types retry path keeps owning this code');
  assert.equal(moduleLoadHint('/x/recipe.ts', undefined), null);
  const lone = join(mkdtempSync(join(tmpdir(), 'openedit-module-lone-')), 'recipe.ts');
  writeFileSync(lone, 'export default {};\n');
  const hint = moduleLoadHint(lone, 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
  assert.ok(hint && !hint.includes('--module '), 'no invented suggestion when no compiled sibling exists');
});
