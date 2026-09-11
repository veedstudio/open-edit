// Concurrency tests for veed/generate.ts: two runs of the same key are a NORMAL workflow, so the spend
// gate has to survive a create call that never came back, a live rival process, and a dead one. Driven
// with a fake MCP client and an in-memory state map, so nothing here touches the network or spends.
//   Run:  node --import tsx tests/generate-charge.test.ts
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runsDir, workspacePath } from '../src/config.ts';
import {
  pendingPathFor, run, type Args, type GenerateDeps,
} from '../src/commands/generate.ts';
import type { ChargeRecord } from '../src/veed/charge-records.ts';
import type { VeedHttp } from '../src/veed/api.ts';
import { fakeFabricHttp } from './fabric-fake.ts';
import { DEFAULT_CHARACTER, DEFAULT_VOICE, makeFakeDeps, makeSeedPending, spendArgs } from './generate-fake.ts';

// Spelled out rather than imported, so these tests pin the on-disk LAYOUT as well as the behaviour: one
// record per attempt, named by the session that wrote it, so two runs can never contend for one file.
const chargePath = (key: string, sessionId: string): string =>
  join(runsDir(), key, `.fabric-charge-${sessionId}.json`);

const HOST = 'test-host';

// Answers the Fabric REST routes the way the live edge does. `onCreate` is the hook the concurrency
// tests need: it runs INSIDE the call that completes the spend, which is where the money moves.
function fakeFabric(statuses: string[] = ['done'], onCreate?: () => void, onConfirm?: () => void) {
  return fakeFabricHttp({ statuses, onCreate, onConfirm });
}

// One fakeDeps call is one PROCESS: its sessionId, pid and liveness answer are its own, while `state`
// (the files under runs/<key>/) is shared with every other process in the test. This suite's default
// process is ALIVE and named sess-self — a rival still running — unless a test overrides it.
function fakeDeps(client: VeedHttp, over: Partial<GenerateDeps> = {}, state = new Map<string, string>()) {
  return makeFakeDeps(client, { sessionId: 'sess-self', pid: 1001, isAlive: () => true, ...over }, state);
}

const baseArgs: Args = {
  script: 'Hello world.', key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE,
  workspace: 'ws1', yes: false, resume: false,
};
const seedPending = makeSeedPending(baseArgs.script as string);

function seedCharge(state: Map<string, string>, key: string, over: Partial<ChargeRecord> & { sessionId: string }): void {
  const record: ChargeRecord = {
    pid: 4242, host: HOST, startedAt: 0, phase: 'charging', ...over,
  };
  state.set(chargePath(key, record.sessionId), JSON.stringify(record, null, 2));
}

function chargeRecords(state: Map<string, string>, key: string): ChargeRecord[] {
  return [...state.entries()]
    .filter(([p]) => p.startsWith(join(runsDir(), key)) && p.includes('.fabric-charge-'))
    .map(([, raw]) => JSON.parse(raw) as ChargeRecord);
}

// --- F1: the charge is recorded BEFORE the create call, so a create that never returns is still visible ---

await test('a create call that throws still leaves a charge record on disk', async () => {
  // create_fabric_video charges server-side the moment it is accepted. A 60s transport timeout, a 502 or a
  // truncated body all throw AFTER the money moved, so a record written only on success records nothing at
  // exactly the moment it matters most.
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  const fabric = fakeFabric(['done'], () => { throw new Error('MCP request timed out after 60000ms'); });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-a', pid: 7001 }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /timed out/);

  const records = chargeRecords(state, 'test-run');
  assert.equal(records.length, 1, `the attempt must be on disk even though create threw; state was ${JSON.stringify([...state.keys()])}`);
  assert.equal(records[0].sessionId, 'sess-a');
  assert.equal(records[0].phase, 'charging', 'the record must say the charge was never confirmed');
  assert.equal(records[0].jobId, undefined, 'and it cannot name a job id, because none came back');
});

await test('after a create that threw, a fresh --yes refuses instead of charging a second time', async () => {
  // The whole of F1: the approval is still on disk and no job id was ever recorded, so every existing gate
  // passes. Only the charge record left by the dead attempt can stop the second charge.
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  const first = fakeFabric(['done'], () => { throw new Error('MCP request timed out after 60000ms'); });
  await assert.rejects(
    () => run({ ...spendArgs }, fakeDeps(first.client, { sessionId: 'sess-a', pid: 7001 }, state).deps),
    /timed out/,
  );

  // The process that charged is gone: it threw and exited.
  const second = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(second.client, { sessionId: 'sess-b', pid: 7002, isAlive: () => false }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /may/i, `the user must be told the charge MAY have landed; got: ${e.message}`);
    assert.match(e.message, /sess-a/, `and which attempt it was; got: ${e.message}`);
    assert.match(e.message, /--abandon sess-a/, `and how to clear it; got: ${e.message}`);
    return true;
  });
  assert.ok(!second.names().includes('create_fabric_video'), 'a script that may already be paid for must not be bought again');
  assert.deepEqual(second.names(), [], 'and the refusal must land before anything reaches the server');
  assert.deepEqual(writes, []);
});

// --- F4: two --yes processes on the same key must not both pass the gate ---

await test('a LIVE charging record from another session refuses, and never reaches create_fabric_video', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  seedCharge(state, 'test-run', { sessionId: 'sess-live', pid: 4242, startedAt: 0, phase: 'charging' });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(
    fabric.client,
    { sessionId: 'sess-mine', pid: 9000, isAlive: (pid) => pid === 4242, now: () => 1_000 },
    state,
  );

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /sess-live/, `the error must name the run it is standing down for; got: ${e.message}`);
    return true;
  });
  assert.deepEqual(fabric.names(), [], 'nothing may reach the server while another run is charging');
  assert.deepEqual(writes, []);
  assert.ok(state.get(pendingPathFor('test-run')), 'a refused run spent nothing, so the approval must survive');
});

// --- a dead owner is recoverable, and recovery names exactly one record ---

await test('a DEAD charging record refuses with the may-have-charged wording, naming the time', async () => {
  const state = new Map<string, string>();
  // Approved a few minutes ago, so the refusal under test is the charge record and not the one-hour clock.
  seedPending(state, 'test-run', { approvedAt: 89_000_000 });
  seedCharge(state, 'test-run', { sessionId: 'sess-dead', pid: 4242, startedAt: 86_400_000, phase: 'charging' });
  const fabric = fakeFabric(['done']);
  const { deps } = fakeDeps(
    fabric.client,
    { sessionId: 'sess-mine', pid: 9000, isAlive: () => false, now: () => 90_000_000 },
    state,
  );

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /may/i, `a charge that may have landed must be described as MAY; got: ${e.message}`);
    assert.match(e.message, /1970-01-02T00:00:00.000Z/, `the time it started must be named; got: ${e.message}`);
    assert.match(e.message, /--abandon sess-dead/, `and the way out must be spelled; got: ${e.message}`);
    return true;
  });
  assert.deepEqual(fabric.names(), []);
});

await test('--abandon clears exactly the named record, and touches no other run', async () => {
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-dead', pid: 4242, phase: 'charging' });
  seedCharge(state, 'other-run', { sessionId: 'sess-elsewhere', pid: 4243, phase: 'charging' });
  const before = state.get(chargePath('other-run', 'sess-elsewhere'));
  const fabric = fakeFabric(['done']);
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-mine' }, state);

  await run({ ...spendArgs, yes: false, abandon: 'sess-dead' } as Args, deps);

  assert.deepEqual(chargeRecords(state, 'test-run').filter((r) => r.resolvedAt === undefined), [],
    'the abandoned record must no longer block anything');
  assert.equal(state.get(chargePath('other-run', 'sess-elsewhere')), before,
    'another run\'s record is none of this command\'s business');
  assert.deepEqual(fabric.names(), [], '--abandon is local: it spends nothing and asks the server nothing');
});

await test('after --abandon, a fresh approval spends exactly once', async () => {
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-dead', pid: 4242, phase: 'charging' });
  const abandoner = fakeFabric(['done']);
  await run({ ...spendArgs, yes: false, abandon: 'sess-dead' } as Args, fakeDeps(abandoner.client, {}, state).deps);

  seedPending(state, 'test-run');
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, { sessionId: 'sess-next', isAlive: () => false }, state);
  const result = await run({ ...spendArgs }, deps);

  assert.equal(fabric.names().filter((n) => n === 'create_fabric_video').length, 1, 'exactly one charge');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

// --- a paid job is collected, never re-bought ---

await test('a CHARGED, unresolved record refuses and points at --resume', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1' });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, { sessionId: 'sess-mine', isAlive: () => false }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /--resume/, `paid work is one --resume away; got: ${e.message}`);
    assert.match(e.message, /job-1/, `and the job it already bought must be named; got: ${e.message}`);
    return true;
  });
  assert.deepEqual(fabric.names(), [], 'work already paid for must never be re-created');
  assert.deepEqual(writes, []);
});

await test('a RESOLVED record is ignored, so a sequential re-run of the same key proceeds', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  seedCharge(state, 'test-run', { sessionId: 'sess-done', phase: 'charged', jobId: 'job-0', resolvedAt: 5 });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, { sessionId: 'sess-mine', isAlive: () => false }, state);

  const result = await run({ ...spendArgs }, deps);

  assert.ok(fabric.names().includes('create_fabric_video'), 'a finished attempt must not block the next one');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

await test('a charge record for a DIFFERENT key never interferes', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  seedCharge(state, 'other-run', { sessionId: 'sess-elsewhere', pid: 4242, phase: 'charging' });
  const fabric = fakeFabric(['done']);
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-mine', isAlive: () => true }, state);

  const result = await run({ ...spendArgs }, deps);

  assert.equal(result.status, 'generated', 'runs of different keys are independent, and both may charge');
  assert.ok(fabric.names().includes('create_fabric_video'));
});

// --- F6: a job the server declared dead must not block the fresh approval the design prescribes ---

await test('a terminal FAILED job resolves its record, so a fresh approval can proceed', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  const failing = fakeFabric(['failed']);
  await assert.rejects(
    () => run({ ...spendArgs }, fakeDeps(failing.client, { sessionId: 'sess-a' }, state).deps),
    /failed/i,
  );

  const unresolved = chargeRecords(state, 'test-run').filter((r) => r.resolvedAt === undefined);
  assert.deepEqual(unresolved, [], `a dead job is not resumable, so it must block nothing; got ${JSON.stringify(unresolved)}`);

  // The design's prescription after a failure: a fresh confirm pass and a fresh yes.
  seedPending(state, 'test-run');
  const retry = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(retry.client, { sessionId: 'sess-b', isAlive: () => false }, state);
  const result = await run({ ...spendArgs }, deps);

  assert.equal(result.status, 'generated', 'the only way past a failed job is a fresh approval, and it must work');
  assert.equal(writes.length, 1);
});

await test('a poll TIMEOUT keeps its record, so the paid job is still resumable', async () => {
  // Indistinguishable from the failure above at the call site, and the opposite answer: the job may well be
  // finishing server-side, so throwing its record away would strand a job that has already been paid for.
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  const stalled = fakeFabric(['processing']);
  await assert.rejects(
    () => run({ ...spendArgs }, fakeDeps(stalled.client, { sessionId: 'sess-a' }, state).deps),
    /timed out/i,
  );

  const unresolved = chargeRecords(state, 'test-run').filter((r) => r.resolvedAt === undefined);
  assert.equal(unresolved.length, 1, 'a job that may still be running must stay on record');
  assert.equal(unresolved[0].phase, 'charged');
  assert.equal(unresolved[0].jobId, 'job-1', 'and it must still name the job --resume needs');

  const resuming = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(resuming.client, { sessionId: 'sess-b' }, state);
  const result = await run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps);

  assert.ok(!resuming.names().includes('create_fabric_video'), '--resume must never spend');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

// --- the write-then-recheck: a symmetric race is resolved without anyone holding a mutex ---

await test('a concurrent record that started EARLIER makes this run yield, and take its own record back', async () => {
  // The rival appears after this run has scanned and before it has charged — the window a scan alone cannot
  // close. Writing first and re-reading is what makes both processes agree on who goes.
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  const fabric = fakeFabric(['done'], undefined, () => {
    seedCharge(state, 'test-run', { sessionId: 'sess-earlier', pid: 4242, startedAt: 500, phase: 'charging' });
  });
  const { deps, writes } = fakeDeps(
    fabric.client,
    { sessionId: 'sess-mine', pid: 9000, isAlive: () => true, now: () => 1_000 },
    state,
  );

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /sess-earlier/, `the run that goes first must be named; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'the run that stood down must not charge');
  assert.equal(state.get(chargePath('test-run', 'sess-mine')), undefined,
    'a run that yielded must take its own record back, or it blocks the winner forever');
  assert.ok(state.get(chargePath('test-run', 'sess-earlier')), 'and must leave the winner\'s record alone');
  assert.deepEqual(writes, []);
});

