// The charge-record classifier: one pure function over the records found in runs/<key>/, so every row of
// the "who may charge" table is testable without a filesystem, a clock or a second process.
//   Run:  node --import tsx tests/charge-records.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHARGE_LEASE_MS, chargeFileName, classifyChargeRecords, parseChargeRecord, sessionIdOfChargeFile,
  type ChargeRecord,
} from '../src/veed/charge-records.ts';

const HOST = 'laptop.local';

function record(over: Partial<ChargeRecord> & { sessionId: string }): ChargeRecord {
  return { pid: 4242, host: HOST, startedAt: 0, phase: 'charging', ...over };
}

// Liveness is only ever asked about a pid on THIS host; `never` proves the other branches do not ask.
const never = (): boolean => { throw new Error('isAlive must not be consulted here'); };

await test('a resolved record is ignored, whatever else it says', async () => {
  const [verdict] = classifyChargeRecords(
    [record({ sessionId: 's1', phase: 'charged', jobId: 'job-1', resolvedAt: 10 })],
    { host: HOST, now: 20, isAlive: never },
  );
  assert.equal(verdict.state, 'resolved');
});

await test('a charging record whose owner is alive is a charge in flight', async () => {
  const [verdict] = classifyChargeRecords(
    [record({ sessionId: 's1', pid: 77 })],
    { host: HOST, now: 1_000, isAlive: (pid) => pid === 77 },
  );
  assert.equal(verdict.state, 'charging');
});

await test('a charging record whose owner is gone is orphaned, not in flight', async () => {
  const [verdict] = classifyChargeRecords(
    [record({ sessionId: 's1', pid: 77 })],
    { host: HOST, now: 1_000, isAlive: () => false },
  );
  assert.equal(verdict.state, 'orphaned');
});

await test('a charged record that was never resolved is paid work, however dead its owner', async () => {
  // Liveness cannot change the answer: the money is gone and the job id is on record, so the only route is
  // --resume. Asking about the pid at all would invite a dead owner to look like a fresh start.
  const [verdict] = classifyChargeRecords(
    [record({ sessionId: 's1', phase: 'charged', jobId: 'job-1' })],
    { host: HOST, now: 1_000, isAlive: never },
  );
  assert.equal(verdict.state, 'paid');
});

await test('a record from ANOTHER host is leased, not probed: inside the lease it counts as in flight', async () => {
  const [verdict] = classifyChargeRecords(
    [record({ sessionId: 's1', host: 'build-box', startedAt: 0 })],
    { host: HOST, now: CHARGE_LEASE_MS - 1, isAlive: never },
  );
  assert.equal(verdict.state, 'charging');
});

await test('a record from another host is orphaned once its lease has run out', async () => {
  const [verdict] = classifyChargeRecords(
    [record({ sessionId: 's1', host: 'build-box', startedAt: 0 })],
    { host: HOST, now: CHARGE_LEASE_MS + 1, isAlive: never },
  );
  assert.equal(verdict.state, 'orphaned');
});

await test('the lease outlives the poll deadline, so a working run is never declared dead', async () => {
  assert.ok(CHARGE_LEASE_MS > 15 * 60_000, `the lease must exceed the 15-minute poll deadline; got ${CHARGE_LEASE_MS}`);
});

await test('records are classified independently, in the order they were given', async () => {
  const verdicts = classifyChargeRecords(
    [
      record({ sessionId: 'alive', pid: 1 }),
      record({ sessionId: 'dead', pid: 2 }),
      record({ sessionId: 'paid', phase: 'charged', jobId: 'job-1' }),
      record({ sessionId: 'done', phase: 'charged', jobId: 'job-0', resolvedAt: 5 }),
    ],
    { host: HOST, now: 1_000, isAlive: (pid) => pid === 1 },
  );
  assert.deepEqual(verdicts.map((v) => v.sessionId), ['alive', 'dead', 'paid', 'done']);
  assert.deepEqual(verdicts.map((v) => v.state), ['charging', 'orphaned', 'paid', 'resolved']);
});

// --- the filename IS the session id, because that is what makes the writes non-contending ---

await test('a charge filename carries its session id and round-trips', async () => {
  const name = chargeFileName('9f1c-uuid');
  assert.equal(name, '.fabric-charge-9f1c-uuid.json');
  assert.equal(sessionIdOfChargeFile(name), '9f1c-uuid');
});

await test('the other files in a run directory are not charge records', async () => {
  for (const name of ['.fabric-pending.json', '.fabric-spend.json', 'test-run.mp4', '.fabric-charge-.json']) {
    assert.equal(sessionIdOfChargeFile(name), null, `${name} must not read as a charge record`);
  }
});

// --- a record that cannot be read is not a record that can be ignored ---

await test('an unreadable record parses to null rather than a half-built one', async () => {
  // Money: a corrupt record is refused by the caller, never skipped. Guessing its phase would guess whether
  // a charge landed.
  assert.equal(parseChargeRecord('{not json'), null);
  assert.equal(parseChargeRecord('{"sessionId":"s1"}'), null, 'a record without a phase says nothing about a charge');
  assert.equal(parseChargeRecord('{"sessionId":"s1","phase":"wat","pid":1,"host":"h","startedAt":0}'), null);
  const ok = parseChargeRecord('{"sessionId":"s1","phase":"charging","pid":1,"host":"h","startedAt":0}');
  assert.equal(ok?.sessionId, 's1');
});

