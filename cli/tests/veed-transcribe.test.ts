// Tests the veed provider's batch HTTP wiring. A batch can outlive one access token, so the transport
// must re-resolve the token PER REQUEST rather than close over one — otherwise a later video 401s after
// the earlier ones already spent credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { connectRefreshing, parseArgs } from '../src/commands/transcribe.ts';

test('the batch transport resolves the token PER REQUEST, not once for the whole run', async () => {
  let calls = 0;
  // Throw right after counting, before any fetch — the point is only that resolution happens each request.
  const http = connectRefreshing(async () => { calls += 1; throw new Error('stop before fetch'); });
  await http.getJsonOrNull('/x').catch(() => {});
  await http.getJson('/y').catch(() => {});
  await http.postJson('/z', {}).catch(() => {});
  assert.equal(calls, 3, 'closing over one token (realHttp) resolves once; refreshing resolves each request');
});

test('a login that expires mid-run is a clear message, not a bare 401', async () => {
  const http = connectRefreshing(async () => null);
  await assert.rejects(http.getJsonOrNull('/x'), /login expired mid-run/);
});

// The provider flag routes; each provider refuses the other's flags rather than ignoring them.
test('--provider veed accepts --workspace and refuses WhisperX flags', () => {
  assert.deepEqual(
    parseArgs(['--provider', 'veed', 'clip.mp4', '--workspace', 'ws1']),
    { videos: ['clip.mp4'], provider: 'veed', workspace: 'ws1' },
  );
  assert.deepEqual(parseArgs(['--provider=veed', 'clip.mp4']), { videos: ['clip.mp4'], provider: 'veed' });
  assert.throws(() => parseArgs(['--provider', 'veed', 'clip.mp4', '--model', 'medium']), /WhisperX flags/);
  assert.throws(() => parseArgs(['--provider', 'veed', 'clip.mp4', '--language', 'de']), /WhisperX flags/);
});

test('the default provider is whisperx, which refuses --workspace', () => {
  assert.deepEqual(parseArgs(['clip.mp4']), { videos: ['clip.mp4'], provider: 'whisperx' });
  assert.throws(() => parseArgs(['clip.mp4', '--workspace', 'ws1']), /--workspace applies only/);
});

// Moved from the repository's cli-entry suite with the entry point itself. Argv is judged BEFORE the
// login gate: parsing is free and local, so a typo is named as a typo — checked the other way round, a
// mistyped flag surfaces as "No VEED login found" on any machine that happens not to be logged in.
test('a stray flag is a named typo, never a missing video or a missing login', async () => {
  const { execFile } = await import('node:child_process');
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (args: string[]) => new Promise<{ code: number; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, 'transcribe', ...args], { encoding: 'utf8' },
      (error, _out, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, err: stderr }));
  });

  const typo = await run(['--provider', 'veed', '--workspce', 'ws1', 'clip.mp4']);
  assert.equal(typo.code, 1);
  assert.match(typo.err, /Unknown option '--workspce'/);
  assert.ok(!/video not found/.test(typo.err), 'naming the wrong problem is what this fixes');
  assert.ok(!/No VEED login found/.test(typo.err), 'argv should be judged first');

  // `-workspace ws1 clip.mp4` used to gather two more "videos" and then report the first as missing.
  // parseArgs reads it as a short-option group, so it names `-w` — the point is that it stops.
  const singleDash = await run(['--provider', 'veed', '-workspace', 'ws1', 'clip.mp4']);
  assert.equal(singleDash.code, 1);
  assert.match(singleDash.err, /Unknown option '-w'/);
  assert.ok(!/video not found/.test(singleDash.err));
});

test('custom is a recorded choice, never a runnable --provider', () => {
  assert.throws(() => parseArgs(['--provider', 'custom', 'clip.mp4']), /whisper command/);
  // ...but --record custom still works: recording is not running.
  assert.deepEqual(
    parseArgs(['--record', 'custom']),
    { videos: [], provider: 'whisperx', record: 'custom' },
  );
});
