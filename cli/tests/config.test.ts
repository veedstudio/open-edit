import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { clientPath, contentRoot, packageRoot, prefsPath, runsDir, stateDir, tokenPath, voiceRatesPath, workspacePath, workspaceRoot } from '../src/config.ts';

// config reads env at call time, so each case swaps env around the call.
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A directory that looks like content to contentRoot(): the runtime index is the marker it keys on.
const scratch: string[] = [];
function contentTree(withIndex: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-content-'));
  scratch.push(dir);
  if (withIndex) {
    mkdirSync(join(dir, 'refs'), { recursive: true });
    writeFileSync(join(dir, 'refs', 'tags.json'), '{"refs":[]}');
  }
  return dir;
}
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

test('the package root is the tree this module ships in, two levels up', () => {
  // cli/src/config.ts under tsx, cli/dist/config.js when published — the same two levels either way,
  // which is what lets a checkout and an install share one content layout.
  // This file is cli/tests/config.test.ts, two levels below the same root.
  assert.equal(packageRoot(), fileURLToPath(new URL('../..', import.meta.url)));
});

test('OPEN_EDIT_ROOT pins the content root only when the directory carries the runtime index', () => {
  const real = contentTree(true);
  withEnv({ OPEN_EDIT_ROOT: real }, () => {
    assert.equal(contentRoot(), real);
  });
  // A workspace that merely exported the variable must not hide the content the package ships: the
  // fallback is what keeps a recipe run working instead of failing on an index that was never there.
  const bare = contentTree(false);
  withEnv({ OPEN_EDIT_ROOT: bare }, () => {
    assert.equal(contentRoot(), packageRoot());
  });
  withEnv({ OPEN_EDIT_ROOT: undefined }, () => {
    assert.equal(contentRoot(), packageRoot());
  });
});

test('the workspace root honours OPEN_EDIT_ROOT unconditionally — content and writes are separate roots', () => {
  // Where the CLI WRITES is the user's call, marker or no marker; the content root is the one that
  // has to be a real content tree. Pointing the variable at an empty directory still directs renders
  // there, and must never direct them into the package.
  const bare = contentTree(false);
  withEnv({ OPEN_EDIT_ROOT: bare, OPENEDIT_STATE_DIR: '/state' }, () => {
    assert.equal(workspaceRoot(), bare);
    assert.equal(contentRoot(), packageRoot());
    assert.notEqual(workspaceRoot(), contentRoot());
  });
  withEnv({ OPEN_EDIT_ROOT: undefined, OPENEDIT_STATE_DIR: '/state' }, () => {
    assert.equal(workspaceRoot(), '/state');
  });
});

test('OPENEDIT_STATE_DIR overrides the platform default', () => {
  withEnv({ OPENEDIT_STATE_DIR: '/custom/state' }, () => {
    assert.equal(stateDir(), '/custom/state');
    assert.equal(tokenPath(), join('/custom/state', 'token.json'));
    assert.equal(clientPath(), join('/custom/state', 'client.json'));
  });
});

test('uses the platform app-data directory', () => {
  withEnv({ OPENEDIT_STATE_DIR: undefined, XDG_CONFIG_HOME: undefined }, () => {
    const dir = stateDir();
    if (process.platform === 'darwin') {
      assert.equal(dir, join(homedir(), 'Library', 'Application Support', 'veed-openedit'));
    } else if (process.platform === 'win32') {
      assert.ok(dir.endsWith(join('AppData', 'Roaming', 'veed-openedit')) || dir.endsWith('veed-openedit'));
    } else {
      assert.equal(dir, join(homedir(), '.config', 'veed-openedit'));
    }
  });
});

test('runs and prefs anchor to OPEN_EDIT_ROOT when set, and to the app dir when not', () => {
  withEnv({ OPEN_EDIT_ROOT: '/some/runtime', OPENEDIT_STATE_DIR: '/state' }, () => {
    assert.equal(runsDir(), join('/some/runtime', 'runs'));
    assert.equal(prefsPath(), join('/some/runtime', '.open-edit-prefs.json'));
  });
  // No working directory exists in a plugin host, so the default is the app dir, never cwd.
  withEnv({ OPEN_EDIT_ROOT: undefined, OPENEDIT_STATE_DIR: '/state' }, () => {
    assert.equal(runsDir(), join('/state', 'runs'));
    assert.equal(prefsPath(), join('/state', '.open-edit-prefs.json'));
    assert.equal(workspacePath(), join('/state', 'workspace.json'));
    assert.equal(voiceRatesPath(), join('/state', 'voice-rates.json'));
  });
});

test('linux respects XDG_CONFIG_HOME', { skip: process.platform !== 'linux' }, () => {
  withEnv({ OPENEDIT_STATE_DIR: undefined, XDG_CONFIG_HOME: '/xdg' }, () => {
    assert.equal(stateDir(), join('/xdg', 'veed-openedit'));
  });
});
