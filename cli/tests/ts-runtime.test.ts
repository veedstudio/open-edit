import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nodeTsArgs,
  reexecFailureReason,
  reexecWithStripTypes,
  RETRY_ENV,
  STRIP_TYPES_FLAG,
  stripsTypesNatively,
  supportsStripTypesFlag,
  type Spawn,
} from '../src/ts-runtime.ts';

const spawnStub = (result: { status?: number | null; signal?: NodeJS.Signals; error?: Error }) => {
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn = ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ bin, args, env: opts.env });
    return result;
  }) as unknown as Spawn;
  return { spawn, calls };
};

const base = { version: 'v22.14.0', env: {}, argv: ['node', 'cli.js'], execArgv: [] };

test('native stripping starts at 22.18, and every 23+', () => {
  assert.equal(stripsTypesNatively('v22.18.0'), true);
  assert.equal(stripsTypesNatively('v22.17.1'), false);
  assert.equal(stripsTypesNatively('v23.0.0'), true);
  assert.equal(stripsTypesNatively('v20.11.0'), false);
});

// The range the old guard refused outright: it strips behind a flag, and the flag works.
test('the flag reaches back to 22.6, so 22.6-22.17 is runnable, not unsupported', () => {
  assert.equal(supportsStripTypesFlag('v22.14.0'), true);
  assert.equal(supportsStripTypesFlag('v22.6.0'), true);
  assert.equal(supportsStripTypesFlag('v22.5.1'), false);
  assert.equal(supportsStripTypesFlag('v20.11.0'), false);
});

// A published install spawns a COMPILED applier; the version gate this replaced refused that case.
test('nodeTsArgs: a .js entry needs no flag on any supported version', () => {
  assert.deepEqual(nodeTsArgs('/pkg/dist/wcag/remediate.js', 'v22.14.0'), []);
  assert.deepEqual(nodeTsArgs('/pkg/dist/wcag/remediate.js', 'v20.11.0'), []);
});

test('nodeTsArgs: a .ts entry takes the flag only where it is not native', () => {
  assert.deepEqual(nodeTsArgs('/src/wcag/remediate.ts', 'v22.14.0'), [STRIP_TYPES_FLAG]);
  assert.deepEqual(nodeTsArgs('/src/wcag/remediate.ts', 'v22.18.0'), []);
});

// package.json allows node >=20, and WCAG_REMEDIATE may name a .ts applier. Handing node 20 a flag
// it rejects would die as `bad option` inside the apply; this must fail early and say why.
test('nodeTsArgs: a .ts entry on a Node with no stripping at all throws, naming the floor', () => {
  assert.throws(
    () => nodeTsArgs('/custom/applier.ts', 'v20.11.0'),
    (e: Error) => e.message.includes('v20.11.0') && e.message.includes('22.6+'),
  );
});

test('reexec: replays argv under the flag and returns the child exit code', () => {
  const { spawn, calls } = spawnStub({ status: 0 });
  const out = reexecWithStripTypes({
    ...base,
    spawn,
    argv: ['/usr/bin/node', '/pkg/dist/cli.js', 'generate-recipe', '--run', 'runs/k', '--record'],
    execPath: '/usr/bin/node',
  });
  assert.deepEqual(out, { kind: 'ran', code: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/usr/bin/node');
  assert.deepEqual(calls[0].args, [
    STRIP_TYPES_FLAG, '/pkg/dist/cli.js', 'generate-recipe', '--run', 'runs/k', '--record',
  ]);
  assert.equal(calls[0].env[RETRY_ENV], '1', 'the child is marked so it cannot retry again');
});

// A retry that quietly drops --max-old-space-size re-sizes the run it is retrying.
test('reexec: carries the parent node flags into the child, ahead of the script', () => {
  const { spawn, calls } = spawnStub({ status: 0 });
  reexecWithStripTypes({
    ...base,
    spawn,
    execArgv: ['--max-old-space-size=8192', '--enable-source-maps'],
    argv: ['node', '/pkg/dist/cli.js', 'generate-recipe'],
  });
  assert.deepEqual(calls[0].args, [
    '--max-old-space-size=8192', '--enable-source-maps', STRIP_TYPES_FLAG,
    '/pkg/dist/cli.js', 'generate-recipe',
  ]);
});

test('reexec: the flag is not doubled when the parent already carried it', () => {
  const { spawn, calls } = spawnStub({ status: 0 });
  reexecWithStripTypes({ ...base, spawn, execArgv: [STRIP_TYPES_FLAG] });
  assert.deepEqual(calls[0].args.filter((a) => a === STRIP_TYPES_FLAG), [STRIP_TYPES_FLAG]);
});

test('reexec: a non-zero child is reported, not swallowed', () => {
  const { spawn } = spawnStub({ status: 3 });
  assert.deepEqual(reexecWithStripTypes({ ...base, spawn }), { kind: 'ran', code: 3 });
});

// Exit 1 is this CLI's "a gate failed"; a Ctrl-C must not be reported as a defect to chase.
test('reexec: a signal-killed child reports 128+N, never a gate failure', () => {
  const { spawn } = spawnStub({ status: null, signal: 'SIGINT' });
  assert.deepEqual(reexecWithStripTypes({ ...base, spawn }), { kind: 'ran', code: 130 });
});

// Each non-run outcome is a DIFFERENT true statement; the collapsed version told a user on a
// capable Node that their Node had no type-stripping.
test('reexec: refuses to retry when it IS the retry, and says the flag is already on', () => {
  const { spawn, calls } = spawnStub({ status: 0 });
  const out = reexecWithStripTypes({ ...base, spawn, env: { [RETRY_ENV]: '1' } });
  if (out.kind !== 'already-retried') assert.fail(`expected already-retried, got ${out.kind}`);
  assert.equal(calls.length, 0, 'no second child');
  assert.ok(reexecFailureReason(out).includes('already on'));
});

test('reexec: no retry on a Node with no such flag, and the reason names the version', () => {
  const { spawn, calls } = spawnStub({ status: 0 });
  const out = reexecWithStripTypes({ ...base, spawn, version: 'v20.11.0' });
  if (out.kind !== 'no-flag') assert.fail(`expected no-flag, got ${out.kind}`);
  assert.equal(out.version, 'v20.11.0');
  assert.equal(calls.length, 0);
  assert.ok(reexecFailureReason(out).includes('v20.11.0'));
});

test('reexec: a child that cannot be spawned is a spawn failure, not a Node capability claim', () => {
  const { spawn } = spawnStub({ error: new Error('ENOENT') });
  const out = reexecWithStripTypes({ ...base, spawn });
  if (out.kind !== 'spawn-failed') assert.fail(`expected a spawn failure, got ${out.kind}`);
  const reason = reexecFailureReason(out);
  assert.match(reason, /ENOENT/);
  assert.doesNotMatch(reason, /no type-stripping/);
});
