import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { clientPath, packageRoot, prefsPath, runsDir, stateDir, tokenPath, voiceRatesPath, workspacePath, workspaceRoot } from '../src/config.ts';

// The walk starts at cwd, and the repository itself is a workspace that would answer every one.
function withCwd<T>(dir: string, fn: () => T): T {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

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

const scratch: string[] = [];
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-content-'));
  scratch.push(dir);
  return dir;
}
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

test('the package root is the tree this module ships in, two levels up', () => {
  // cli/src/config.ts under tsx, cli/dist/config.js when published — the same two levels either way,
  // which is what lets a checkout and an install share one layout.
  // This file is cli/tests/config.test.ts, two levels below the same root.
  assert.equal(packageRoot(), resolve(fileURLToPath(new URL('../..', import.meta.url))), 'two levels up, with no trailing separator');
});

test('the workspace root honours OPEN_EDIT_ROOT unconditionally, never the package', () => {
  // Where the CLI WRITES is the user's call, marker or no marker. Pointing the variable at an empty
  // directory still directs renders there, and must never direct them into the package.
  const bare = emptyDir();
  withEnv({ OPEN_EDIT_ROOT: bare, OPENEDIT_STATE_DIR: '/state' }, () => {
    assert.equal(workspaceRoot(), bare);
    assert.notEqual(workspaceRoot(), packageRoot());
  });
  withEnv({ OPEN_EDIT_ROOT: undefined, OPENEDIT_STATE_DIR: '/state' }, () => {
    withCwd(mkdtempSync(join(tmpdir(), 'openedit-cfg-bare-')), () => {
      assert.equal(workspaceRoot(), '/state');
    });
  });
});

test('with no OPEN_EDIT_ROOT the writes root is the nearest enclosing project, from any depth', () => {
  // The spawns after init inherit none of its env, so each of them has to find the project itself.
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'openedit-cfg-proj-')));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({
    name: 'proj', private: true, devDependencies: { '@veedstudio/openedit-cli': '1.2.3' },
  }));
  const deep = join(proj, 'runs', 'a-clip');
  mkdirSync(deep, { recursive: true });

  withEnv({ OPEN_EDIT_ROOT: undefined, OPENEDIT_STATE_DIR: '/state' }, () => {
    for (const from of [proj, deep]) {
      withCwd(from, () => {
        assert.equal(realpathSync(workspaceRoot()), proj, `walked up from ${from}`);
        assert.equal(realpathSync(runsDir()), join(proj, 'runs'));
      });
    }
    // The recorded provider choice claims a folder on its own: a project can exist before any pin.
    const prefsOnly = realpathSync(mkdtempSync(join(tmpdir(), 'openedit-cfg-prefs-')));
    writeFileSync(join(prefsOnly, '.open-edit-prefs.json'), '{}');
    withCwd(prefsOnly, () => assert.equal(realpathSync(workspaceRoot()), prefsOnly));
    // node_modules is the one directory the package layout exists to keep renders out of.
    const inside = join(proj, 'node_modules', '@veedstudio', 'openedit-cli');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, 'package.json'), '{"name":"@veedstudio/openedit-cli","version":"1.2.3"}');
    withCwd(inside, () => assert.equal(realpathSync(workspaceRoot()), proj));
    // A checkout of the package itself keeps its runs in the checkout; a lookalike source tree under
    // another name is not one of ours.
    const sourceTree = (name: string) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'openedit-cfg-checkout-')));
      mkdirSync(join(dir, 'cli', 'src'), { recursive: true });
      writeFileSync(join(dir, 'cli', 'src', 'cli.ts'), '');
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
      return dir;
    };
    const checkout = sourceTree('@veedstudio/openedit-cli');
    withCwd(checkout, () => assert.equal(realpathSync(workspaceRoot()), checkout));
    withCwd(sourceTree('their-tool'), () => assert.equal(workspaceRoot(), '/state'));
    // An unrelated npm project is NOT one of ours, however deep the walk goes.
    const stranger = realpathSync(mkdtempSync(join(tmpdir(), 'openedit-cfg-other-')));
    writeFileSync(join(stranger, 'package.json'), '{"name":"someone-elses-app"}');
    withCwd(stranger, () => assert.equal(workspaceRoot(), '/state'));
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
  // With no project above cwd the default is the app dir, never cwd itself.
  withEnv({ OPEN_EDIT_ROOT: undefined, OPENEDIT_STATE_DIR: '/state' }, () => withCwd(mkdtempSync(join(tmpdir(), 'openedit-cfg-none-')), () => {
    assert.equal(runsDir(), join('/state', 'runs'));
    assert.equal(prefsPath(), join('/state', '.open-edit-prefs.json'));
    assert.equal(workspacePath(), join('/state', 'workspace.json'));
    assert.equal(voiceRatesPath(), join('/state', 'voice-rates.json'));
  }));
});

test('linux respects XDG_CONFIG_HOME', { skip: process.platform !== 'linux' }, () => {
  withEnv({ OPENEDIT_STATE_DIR: undefined, XDG_CONFIG_HOME: '/xdg' }, () => {
    assert.equal(stateDir(), join('/xdg', 'veed-openedit'));
  });
});

// FFMPEG and FFPROBE are fixed at import, so each case loads the module in a fresh process.
const configUrl = new URL('../src/config.ts', import.meta.url).href;
const importedPair = (env: Record<string, string>): [string, string] => {
  const merged: Record<string, string | undefined> = { ...process.env, OPENEDIT_STATE_DIR: emptyDir() };
  delete merged.OPENEDIT_FFMPEG;
  delete merged.OPENEDIT_FFPROBE;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify([m.FFMPEG, m.FFPROBE]));`],
  { encoding: 'utf8', env: { ...merged, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// Spawning '' fails every command, and init and install-ffmpeg read an empty variable as unset.
test('an empty OPENEDIT_FFMPEG or OPENEDIT_FFPROBE counts as unset', () => {
  assert.deepEqual(importedPair({ OPENEDIT_FFMPEG: '', OPENEDIT_FFPROBE: '' }), ['ffmpeg', 'ffprobe']);
  assert.deepEqual(importedPair({ OPENEDIT_FFMPEG: '/opt/ff/ffmpeg', OPENEDIT_FFPROBE: '' }), ['/opt/ff/ffmpeg', '/opt/ff/ffprobe']);
  assert.deepEqual(importedPair({ OPENEDIT_FFPROBE: '/opt/ff/ffprobe' }), ['ffmpeg', '/opt/ff/ffprobe']);
});
