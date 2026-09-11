// The token command is an interface other tools spawn, so its contract is
// tested end to end through the real CLI: stdout carries ONLY the token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', cliPath, ...args],
      { env: { ...process.env, VEED_ACCESS_TOKEN: '', ...env }, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
      },
    );
  });
}

function stateDirWithToken(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-token-'));
  writeFileSync(
    join(dir, 'token.json'),
    JSON.stringify({
      accessToken: 'stored-access',
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      origin: 'https://www.veed.io',
      clientId: 'client-1',
      ...overrides,
    }),
  );
  return dir;
}

// A terminal is a person; the value would outlive the moment in scrollback and shell history. The
// pipe case above is the contract other tools depend on and must never change with it.
test('token masks the value when stdout is a terminal, and says how to capture it', async () => {
  // token-store.ts freezes the store path at import (DEFAULT_TOKEN_PATH), so the fixture has to be in
  // place BEFORE the import — otherwise this reads whatever login the machine happens to carry, and
  // passes on a developer's box while failing on every clean one.
  process.env.OPENEDIT_STATE_DIR = stateDirWithToken();
  // resolveToken gives the env token priority over the store, so an ambient VEED_ACCESS_TOKEN would
  // satisfy every assertion below without the fixture ever being read. runCli neutralises it for the
  // spawned cases; this one runs in-process and has to do it itself.
  const previousEnvToken = process.env.VEED_ACCESS_TOKEN;
  process.env.VEED_ACCESS_TOKEN = '';
  const { token } = await import('../src/commands/token.ts');
  const previous = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  console.log = (line: string) => { out.push(line); };
  console.error = (line: string) => { err.push(line); };
  try {
    assert.equal(await token(), 0);
  } finally {
    console.log = realLog;
    console.error = realError;
    if (previous) Object.defineProperty(process.stdout, 'isTTY', previous);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    delete process.env.OPENEDIT_STATE_DIR;
    if (previousEnvToken === undefined) delete process.env.VEED_ACCESS_TOKEN;
    else process.env.VEED_ACCESS_TOKEN = previousEnvToken;
  }
  assert.ok(!out.join('\n').includes('stored-access'), `the token reached stdout: ${out.join('\n')}`);
  // The fixture's own length, so an env token leaking in would be caught rather than matched.
  assert.match(out.join('\n'), /a valid token is stored, 13 characters/);
  assert.match(err.join('\n'), /VEED_ACCESS_TOKEN=\$\(npx/);
});

test('token prints ONLY the access token on stdout', async () => {
  const { code, stdout } = await runCli(['token'], { OPENEDIT_STATE_DIR: stateDirWithToken() });
  assert.equal(code, 0);
  assert.equal(stdout, 'stored-access\n');
});

test('an env token wins without a store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-empty-'));
  const { code, stdout } = await runCli(['token'], {
    OPENEDIT_STATE_DIR: dir,
    VEED_ACCESS_TOKEN: 'env-token',
  });
  assert.equal(code, 0);
  assert.equal(stdout, 'env-token\n');
});

test('no login exits 1 and points at the login command, with nothing on stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-empty-'));
  const { code, stdout, stderr } = await runCli(['token'], { OPENEDIT_STATE_DIR: dir });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /npx @veedstudio\/openedit-cli login/);
});

test('a login for a different origin is refused rather than sent', async () => {
  const dir = stateDirWithToken({ origin: 'https://dev.veed.example' });
  const { code, stdout } = await runCli(['token'], { OPENEDIT_STATE_DIR: dir });
  assert.equal(code, 1);
  assert.equal(stdout, '');
});

test('token --path prints the store location without needing a login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openedit-empty-'));
  const { code, stdout } = await runCli(['token', '--path'], { OPENEDIT_STATE_DIR: dir });
  assert.equal(code, 0);
  assert.equal(stdout, join(dir, 'token.json') + '\n');
});
