// Untrusted input around the spend gate: everything the flow reads back off DISK (the approval, the charge
// records) and everything it receives from the SERVER (the confirmation, the create response) crosses a
// process boundary, so a value that gates a charge has to be PROVEN to be what the types claim. Driven with
// a fake MCP client and an in-memory state map, so nothing here touches the network or spends.
//   Run:  node --import tsx tests/generate-validation.test.ts
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runsDir, workspacePath } from '../src/config.ts';
import {
  chargePathFor, pendingPathFor, run, scriptHash, type Args, type GenerateDeps,
} from '../src/commands/generate.ts';
import type { VeedHttp } from '../src/veed/api.ts';
import { fakeFabricHttp } from './fabric-fake.ts';
import { DEFAULT_CHARACTER, DEFAULT_VOICE, makeFakeDeps, readCharge, spendArgs } from './generate-fake.ts';
import { estimateTotalCredits } from '../src/veed/fabric.ts';
import { resolveRate } from '../src/veed/voice-rates.ts';

const SCRIPT = 'Hello world.';
// Per-attempt, so "nothing was recorded as spent" means no spend record for ANY session, not one fixed path.
const spendRecordKeys = (state: Map<string, string>): string[] =>
  [...state.keys()].filter((p) => p.startsWith(join(runsDir(), 'test-run', '.fabric-spend-')));

type ToolCall = { name: string; args: Record<string, unknown> };

// `workspaces`, `voices` and `create` replace what the server answers with, which is the whole point
// here: the payloads under test are the ones a server that renamed, dropped or re-typed a field would
// send. The credit figure is no longer among them — it is computed locally from the script — so the
// shapes that can still poison a spend are the LISTINGS the confirmation is assembled from.
function fakeFabric(
  over: { workspaces?: unknown; voices?: unknown; create?: Record<string, unknown>; statuses?: string[] } = {},
) {
  return fakeFabricHttp({
    statuses: over.statuses ?? ['done'],
    workspaces: over.workspaces,
    voices: over.voices,
    createResponse: over.create,
    voiceId: DEFAULT_VOICE,
  });
}

let sessions = 0;
function fakeDeps(client: VeedHttp, over: Partial<GenerateDeps> = {}, state = new Map<string, string>()) {
  sessions += 1;
  return makeFakeDeps(client, { sessionId: `val-${sessions}`, pid: 2000 + sessions, ...over }, state);
}

const baseArgs: Args = {
  script: SCRIPT, key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE,
  workspace: 'ws1', yes: false, resume: false,
};
// The approval as JSON TEXT rather than as an object, because the values that break the gate are exactly the
// ones an object cannot carry through JSON.stringify: an absent field, and 1e999, which is legal JSON that
// parses back as Infinity. `over` with an undefined value drops that field; `rawOver` is spliced in verbatim.
function pendingText(over: Record<string, unknown> = {}, rawOver: Record<string, string> = {}): string {
  const record: Record<string, unknown> = {
    script: SCRIPT,
    scriptSha256: scriptHash(SCRIPT),
    characterId: DEFAULT_CHARACTER,
    voiceId: DEFAULT_VOICE,
    workspaceId: 'ws1',
    workspaceNamed: true,
    estimatedCredits: 64,
    approvedAt: 0,
    ...over,
  };
  for (const field of Object.keys(rawOver)) delete record[field];
  return `{${[
    ...Object.entries(record)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`),
    ...Object.entries(rawOver).map(([k, v]) => `${JSON.stringify(k)}: ${v}`),
  ].join(', ')}}`;
}

// --- F2: the approval comes off disk, so EVERY field of it is untrusted, not just two ---

// Each of these makes one field a lie. `approvedAt` is the sharp one: NaN arithmetic fails BOTH staleness
// comparisons, so an unchecked timestamp lets a month-old approval through the one-hour clock.
const BAD_PENDING: Array<{ label: string; expect: RegExp; text: string }> = [
  { label: 'no approvedAt at all', expect: /approvedAt/, text: pendingText({ approvedAt: undefined }) },
  { label: 'approvedAt as an ISO string', expect: /approvedAt/, text: pendingText({ approvedAt: '2026-07-30T09:00:00.000Z' }) },
  { label: 'approvedAt null', expect: /approvedAt/, text: pendingText({ approvedAt: null }) },
  { label: 'approvedAt as 1e999, which parses back as Infinity', expect: /approvedAt/, text: pendingText({}, { approvedAt: '1e999' }) },
  { label: 'no workspaceId', expect: /workspaceId/, text: pendingText({ workspaceId: undefined }) },
  { label: 'workspaceId as a number', expect: /workspaceId/, text: pendingText({ workspaceId: 7 }) },
  { label: 'no scriptSha256', expect: /scriptSha256/, text: pendingText({ scriptSha256: undefined }) },
  { label: 'no characterId', expect: /characterId/, text: pendingText({ characterId: undefined }) },
  { label: 'no voiceId', expect: /voiceId/, text: pendingText({ voiceId: undefined }) },
  { label: 'workspaceNamed as the string "true"', expect: /workspaceNamed/, text: pendingText({ workspaceNamed: 'true' }) },
  { label: 'estimatedCredits as 1e999, which parses back as Infinity', expect: /estimatedCredits/, text: pendingText({}, { estimatedCredits: '1e999' }) },
  { label: 'the whole record replaced by an array', expect: /not a JSON object/, text: '[]' },
];

for (const bad of BAD_PENDING) {
  await test(`an approval with ${bad.label} is refused by name, and nothing reaches the server`, async () => {
    const state = new Map<string, string>();
    state.set(pendingPathFor('test-run'), bad.text);
    const fabric = fakeFabric();
    const { deps, writes } = fakeDeps(fabric.client, {}, state);

    await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
      assert.match(e.message, /refusing to spend/i);
      assert.match(
        e.message, bad.expect,
        `the refusal must name what is wrong (${bad.expect}); got: ${e.message}`,
      );
      return true;
    });
    assert.deepEqual(fabric.names(), [], 'a malformed approval is refused before anything reaches the server');
    assert.deepEqual(writes, []);
  });
}

await test('a malformed approval is LEFT on disk, so what it claimed can still be inspected', async () => {
  // Deleting it would destroy the only evidence of what was approved, on the one path where the user is
  // about to be told their approval is unusable. Refusing is what stops the spend; deleting adds nothing.
  const state = new Map<string, string>();
  const text = pendingText({ approvedAt: undefined });
  state.set(pendingPathFor('test-run'), text);
  const { deps } = fakeDeps(fakeFabric().client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /refusing to spend/i);
  assert.equal(state.get(pendingPathFor('test-run')), text, 'the record must survive its own refusal, untouched');
});

await test('a well-formed but genuinely stale approval is still refused as stale (no regression)', async () => {
  const state = new Map<string, string>();
  state.set(pendingPathFor('test-run'), pendingText({ approvedAt: 0 }));
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, { now: () => 2 * 60 * 60_000 }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /minutes old/, `staleness must still be diagnosed as staleness; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'a stale approval may not spend');
  assert.deepEqual(writes, []);
});

await test('a well-formed fresh approval still spends exactly once', async () => {
  const state = new Map<string, string>();
  state.set(pendingPathFor('test-run'), pendingText());
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  const result = await run({ ...spendArgs }, deps);

  assert.equal(fabric.names().filter((n) => n === 'create_fabric_video').length, 1);
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

// --- F3: the confirmation is assembled from listings, and a bad listing must not become an approval ---

// The credit figure can no longer arrive malformed — it is computed from the script here, not quoted by
// the server — so that whole class of bug is gone by construction. These are what is left: a listing
// that renames or drops the fields the approval block has to name before anyone can approve it.
//
// A workspace id the caller NAMED is deliberately not re-checked against the listing: generate.ts owns
// that choice (it lists the workspaces, shows the balances and makes the user name one), so a second
// opinion here would only re-decide a settled question. A genuinely wrong id fails at the first scoped
// call, carrying the server's own message.
const BAD_LISTINGS: Array<{ label: string; over: { workspaces?: unknown; voices?: unknown }; expect: RegExp }> = [
  {
    label: 'a voice listing that does not contain the requested voice',
    over: { voices: [{ id: 'someone-else', name: 'Nobody', locale: 'en-GB', gender: '0' }] },
    expect: /not a known voice/,
  },
  {
    label: 'an empty voice listing',
    over: { voices: [] },
    expect: /not a known voice/,
  },
  {
    label: 'an empty workspace listing',
    over: { workspaces: [] },
    expect: /no VEED workspaces/,
  },
];

for (const bad of BAD_LISTINGS) {
  await test(`${bad.label} aborts the spend pass and NEVER creates`, async () => {
    const state = new Map<string, string>();
    state.set(pendingPathFor('test-run'), pendingText({ estimatedCredits: 64 }));
    const fabric = fakeFabric(bad.over);
    const { deps, writes } = fakeDeps(fabric.client, {}, state);

    await assert.rejects(() => run({ ...spendArgs }, deps), bad.expect);
    assert.ok(!fabric.names().includes('create_fabric_video'), 'a broken confirmation may not gate a real charge');
    assert.deepEqual(spendRecordKeys(state), [], 'and nothing may be recorded as spent');
    assert.deepEqual(writes, []);
  });

  await test(`${bad.label} aborts the confirm pass, recording no approval`, async () => {
    const state = new Map<string, string>();
    const fabric = fakeFabric(bad.over);
    const { deps } = fakeDeps(fabric.client, {}, state);

    await assert.rejects(() => run({ ...baseArgs }, deps), bad.expect);
    assert.equal(state.get(pendingPathFor('test-run')), undefined, 'a broken confirmation may not be recorded as approved');
    assert.ok(!fabric.names().includes('create_fabric_video'));
  });
}

await test('a well-formed confirmation still proceeds through both passes', async () => {
  const state = new Map<string, string>();
  const confirming = fakeFabric();
  const confirmed = await run({ ...baseArgs }, fakeDeps(confirming.client, {}, state).deps);
  // Priced at the rate this VOICE speaks at, which is what the engine quotes with — see voice-rates.ts.
  assert.deepEqual(confirmed, {
    status: 'confirmed',
    credits: estimateTotalCredits(SCRIPT, resolveRate(DEFAULT_VOICE).charsPerSecond),
  });

  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, {}, state);
  const result = await run({ ...spendArgs }, deps);

  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

await test('a create response with no usable jobId aborts, and leaves the attempt recorded as MAY-have-charged', async () => {
  // The money moved the moment VEED accepted the call, so this cannot be softened: the run stops, and the
  // record it wrote BEFORE the call is what stops the next --yes from buying the same script again.
  const state = new Map<string, string>();
  state.set(pendingPathFor('test-run'), pendingText());
  const fabric = fakeFabric({ create: { status: 'started', durationSeconds: 12.7 } });
  const { deps, writes } = fakeDeps(fabric.client, { sessionId: 'sess-nojob' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /createVideo/, `the abort must name the operation that answered badly; got: ${e.message}`);
    assert.match(e.message, /jobId/, `and the field it could not trust; got: ${e.message}`);
    return true;
  });
  const record = readCharge(state, 'test-run', 'sess-nojob');
  assert.ok(record, 'the attempt must still be on disk: the charge may well have landed');
  assert.equal(record.phase, 'charging', 'and it may not claim a charge it cannot name a job for');
  assert.equal(record.jobId, undefined);
  assert.deepEqual(writes, []);
});

// --- the charge records of commit 1 are read off disk too: malformed is never "absent" ---

await test('an unparseable charge record refuses the spend rather than reading as no record at all', async () => {
  const state = new Map<string, string>();
  state.set(pendingPathFor('test-run'), pendingText());
  state.set(chargePathFor('test-run', 'sess-corrupt'), '{"sessionId": "sess-corrupt", "phase": ');
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /sess-corrupt/, `the unreadable record must be named; got: ${e.message}`);
    return true;
  });
  assert.deepEqual(fabric.names(), [], 'a record that cannot be ruled out must stop the run before the server');
  assert.deepEqual(writes, []);
});

await test('a charge record whose resolvedAt is 1e999 is not read as resolved, so it still blocks', async () => {
  // Infinity is what 1e999 becomes on the way back off disk, and `resolvedAt !== undefined` waves it through
  // as a finished attempt — which is precisely the reading that clears the way to charge a second time.
  const state = new Map<string, string>();
  state.set(pendingPathFor('test-run'), pendingText());
  state.set(
    chargePathFor('test-run', 'sess-inf'),
    '{"sessionId": "sess-inf", "pid": 4242, "host": "test-host", "startedAt": 0, "phase": "charged", "jobId": "job-9", "resolvedAt": 1e999}',
  );
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /sess-inf/, `the record that blocks must be named; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'a record that cannot be trusted must not clear the way to charge');
  assert.deepEqual(writes, []);
});

