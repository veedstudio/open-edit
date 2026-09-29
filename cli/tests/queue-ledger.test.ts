// Tests the claim -> submit -> record lifecycle in src/providers/queue-ledger.ts and fal.ts's
// submitOnce. The property under test is the one a bill depends on: however many callers ask for the
// same request at once, in one process or many, the queue sees it once; and a caller that died between
// sending and writing the id down leaves a record that is resolved by lookup, never by buying again.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs, { chmodSync, existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PossiblyBought, submitOnce, completeJob, type Http } from '../src/providers/fal.ts';
import {
  AmbiguousAcceptance, LostClaim, claimJob, inFlight, jobKey, ledgerDir, legacyLedgerPath, readAttempts, readLedger, type Attempt,
} from '../src/providers/queue-ledger.ts';

const childPath = fileURLToPath(new URL('./helpers/submit-once-child.ts', import.meta.url));
const fresh = () => mkdtempSync(join(tmpdir(), 'ledger-'));
const MODEL = 'owner/model';
const INPUT = { prompt: 'the same neon sign', seed: 7 };

/** A queue that takes `delayMs` to accept, counting every submission it is sent. */
function countingQueue(delayMs = 50, status = 200): { http: Http; submits: () => number } {
  let n = 0;
  const http: Http = async (url, init) => {
    if (init.method === 'POST') {
      n++;
      const id = `req-${n}`;
      await new Promise((r) => setTimeout(r, delayMs));
      return { status, json: async () => (status < 300 ? { request_id: id, status_url: `s/${id}`, response_url: `r/${id}` } : { detail: 'no' }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { http, submits: () => n };
}

/** A pid that certainly belongs to no running process: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function plantAttempt(runDir: string, over: Partial<Attempt>): void {
  const key = jobKey(MODEL, INPUT);
  const n = over.n ?? 0;
  const a: Attempt = {
    key, model: MODEL, n, attempt: `planted-${n}`, state: 'claimed', pid: deadPid(), host: hostname(),
    claimedAt: new Date().toISOString(), leaseUntil: Date.now() + 60_000, ...over,
  };
  mkdirSync(join(ledgerDir(runDir), key), { recursive: true });
  writeFileSync(join(ledgerDir(runDir), key, `attempt-${n}.json`), JSON.stringify(a));
}

/**
 * Runs `fn` with one node:fs function replaced, so a test can land another process's write at the exact
 * point between two of this caller's file operations.
 */
async function withFsHook<K extends 'existsSync' | 'writeFileSync' | 'linkSync'>(name: K, hook: (orig: typeof fs[K]) => typeof fs[K], fn: () => Promise<void>): Promise<void> {
  const orig = fs[name];
  (fs as Record<K, typeof fs[K]>)[name] = hook(orig);
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    (fs as Record<K, typeof fs[K]>)[name] = orig;
    syncBuiltinESMExports();
  }
}

await test('sixteen identical calls in one process buy the job once and all get its id', async () => {
  const dir = fresh();
  const q = countingQueue(80);
  const results = await Promise.all(Array.from({ length: 16 }, () =>
    submitOnce(dir, MODEL, { ...INPUT }, { key: 'k', http: q.http, ledger: { pollMs: 5 } })));
  assert.equal(q.submits(), 1, 'one submission, one charge');
  assert.deepEqual(new Set(results.map((r) => r.job.requestId)), new Set(['req-1']));
  assert.equal(results.filter((r) => !r.reused).length, 1);
});

await test('eight processes racing on the same request produce exactly one submission', async () => {
  const dir = fresh();
  let submits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      submits++;
      const id = `req-${submits}`;
      // Slow acceptance widens the window in which the other seven are deciding.
      setTimeout(() => res.end(JSON.stringify({ request_id: id, status_url: `s/${id}`, response_url: `r/${id}` })), 300);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const startAt = Date.now() + 2500;
    const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', childPath, dir, String(port), String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}: ${err}`))));
    })));
    assert.equal(submits, 1, `the queue saw ${submits} submissions`);
    const parsed = outputs.map((o) => JSON.parse(o) as { requestId: string; reused: boolean });
    assert.deepEqual(new Set(parsed.map((p) => p.requestId)), new Set(['req-1']));
    assert.equal(parsed.filter((p) => !p.reused).length, 1);
    const files = readdirSync(join(ledgerDir(dir), jobKey(MODEL, INPUT)));
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [], 'every write was renamed into place');
  } finally {
    server.close();
  }
});

await test('a claim whose process is gone is taken over at once, not waited on for its whole lease', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'claimed', leaseUntil: Date.now() + 10 * 60_000 });
  const q = countingQueue(1);
  const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5, waitTimeoutMs: 2_000 } });
  assert.equal(r.reused, false);
  assert.equal(q.submits(), 1);
  assert.deepEqual(readAttempts(dir, jobKey(MODEL, INPUT)).map((a) => a.state), ['claimed', 'accepted'], 'the dead claim stays as it was written');
});

await test('a claim on another machine whose lease ran out is taken over', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'claimed', host: 'elsewhere', pid: 1, leaseUntil: Date.now() - 1 });
  const q = countingQueue(1);
  await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } });
  assert.equal(q.submits(), 1);
});

await test('a live claim held elsewhere is waited on, and its id is reused once it lands', async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  plantAttempt(dir, { state: 'claimed', host: 'elsewhere', pid: 1, leaseUntil: Date.now() + 60_000 });
  setTimeout(() => plantAttempt(dir, { n: 0, host: 'elsewhere', pid: 1, state: 'accepted', requestId: 'theirs', statusUrl: 's', responseUrl: 'r', leaseUntil: 0 }), 100);
  const q = countingQueue(1);
  const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 10 } });
  assert.equal(q.submits(), 0);
  assert.equal(r.job.requestId, 'theirs');
  assert.equal(readAttempts(dir, key).length, 1);
});

await test('an acceptance recorded while a waiter is between its reads is reused, not bought again', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'submitting', host: 'elsewhere', pid: 1, body: INPUT, submittingAt: new Date().toISOString(), leaseUntil: Date.now() + 60_000 });
  const q = countingQueue(1);
  let landed = false;
  // The legacy ledger is looked at after the attempts are read: the owner's acceptance lands right there.
  await withFsHook('existsSync', (orig) => ((p: fs.PathLike) => {
    if (!landed && String(p) === legacyLedgerPath(dir)) {
      landed = true;
      plantAttempt(dir, { n: 0, host: 'elsewhere', pid: 1, state: 'accepted', requestId: 'theirs', statusUrl: 's', responseUrl: 'r', leaseUntil: 0 });
    }
    return orig(p);
  }) as typeof fs.existsSync, async () => {
    const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } });
    assert.equal(landed, true);
    assert.equal(q.submits(), 0, 'the owner bought it, so the waiter does not');
    assert.equal(r.reused, true);
    assert.equal(r.job.requestId, 'theirs');
  });
  assert.equal(readAttempts(dir, jobKey(MODEL, INPUT)).length, 1, 'no second attempt was claimed');
});

await test('an attempt that died after sending is found on the queue by its body and resumed, not re-bought', async () => {
  const dir = fresh();
  const sentAt = new Date().toISOString();
  plantAttempt(dir, { state: 'submitting', body: { seed: 7, prompt: 'the same neon sign' }, submittingAt: sentAt });
  let submits = 0;
  let lookups = 0;
  const http: Http = async (url, init) => {
    if (init.method === 'POST') submits++;
    if (url.includes('/models/requests/by-endpoint')) {
      lookups++;
      assert.match(url, /endpoint_id=owner%2Fmodel/);
      assert.match(url, /expand=payloads/);
      return {
        status: 200,
        json: async () => ({ items: [
          { request_id: 'someone-else', json_input: { prompt: 'another sign', seed: 7 } },
          { request_id: 'the-lost-one', json_input: { prompt: 'the same neon sign', seed: 7 } },
        ], next_cursor: null }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return { status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http, ledger: { pollMs: 5 } });
  assert.equal(submits, 0, 'never bought again');
  assert.equal(lookups, 1);
  assert.equal(r.reused, true);
  assert.equal(r.recovered, true, 'nobody reported this charge, so the caller that adopted it is told');
  assert.equal(r.job.requestId, 'the-lost-one');
  assert.equal(r.job.statusUrl, 'https://queue.fal.run/owner/model/requests/the-lost-one/status');
  const again = await submitOnce(dir, MODEL, INPUT, { key: 'k', http, ledger: { pollMs: 5 } });
  assert.equal(again.job.requestId, 'the-lost-one');
  assert.equal(again.recovered, false, 'only the caller that adopted it hears it was recovered');
  assert.equal(lookups, 1, 'once adopted, the id is in the ledger and the queue is not asked again');
});

await test('an attempt that may have been accepted and cannot be found is reported, never bought', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'submitting', body: INPUT, submittingAt: new Date().toISOString() });
  let submits = 0;
  const http: Http = async (url, init) => {
    if (init.method === 'POST') submits++;
    return { status: 200, json: async () => ({ items: [], next_cursor: null }), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http, ledger: { pollMs: 5 } }), AmbiguousAcceptance);
  assert.equal(submits, 0);
});

await test('a send that fails without an answer leaves the job unresolved; a refusal leaves it free to retry', async () => {
  const dir = fresh();
  const flaky = countingQueue(1, 502);
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: flaky.http, ledger: { pollMs: 5 } }),
    (e: unknown) => e instanceof PossiblyBought && /with 502.*fal may have accepted it.*a re-run looks for it on fal's request history/s.test(e.message));
  assert.equal(readAttempts(dir, jobKey(MODEL, INPUT))[0].state, 'uncertain');
  const q = countingQueue(1);
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } }), AmbiguousAcceptance);
  assert.equal(q.submits(), 0, 'a 502 may have been accepted, so the retry does not buy');

  const other = fresh();
  const refusing = countingQueue(1, 422);
  await assert.rejects(() => submitOnce(other, MODEL, INPUT, { key: 'k', http: refusing.http }), /422/);
  assert.equal(readAttempts(other, jobKey(MODEL, INPUT))[0].state, 'refused');
  const ok = countingQueue(1);
  const r = await submitOnce(other, MODEL, INPUT, { key: 'k', http: ok.http });
  assert.equal(ok.submits(), 1, 'a refusal bought nothing, so the corrected retry goes through');
  assert.equal(r.reused, false);
});

await test('a failure while preparing the body abandons the claim, and the next caller buys', async () => {
  const dir = fresh();
  const q = countingQueue(1);
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, prepare: async () => { throw new Error('upload failed'); } }), /upload failed/);
  assert.equal(readAttempts(dir, jobKey(MODEL, INPUT))[0].state, 'abandoned');
  await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http });
  assert.equal(q.submits(), 1);
});

await test('an owner whose claim was taken over while it paused refuses to send', async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  const won = await claimJob(dir, key, MODEL, { leaseMs: 60_000 });
  assert.equal(won.kind, 'won');
  plantAttempt(dir, { n: 1, state: 'claimed', pid: process.pid, leaseUntil: Date.now() + 60_000 });
  assert.throws(() => won.kind === 'won' && won.claim.submitting(INPUT), LostClaim);
});

await test('an owner stalled past its lease while another process takes over does not send', async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  const ledgerModule = new URL('../src/providers/queue-ledger.ts', import.meta.url).href;
  const taker = `const { claimJob } = await import(process.argv[1]);
    const r = await claimJob(process.argv[2], process.argv[3], process.argv[4], { pollMs: 5, waitTimeoutMs: 5000 });
    process.stdout.write(r.kind);`;
  let took = '';
  const q = countingQueue(1);
  // Stalled after the lease check and before the write that marks it sending: another process takes over meanwhile.
  await withFsHook('writeFileSync', (orig) => ((p: fs.PathOrFileDescriptor, data: string, ...rest: []) => {
    if (!took && /attempt-0\.json\..*\.tmp$/.test(String(p)) && data.includes('"state": "submitting"')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', taker, ledgerModule, dir, key, MODEL], { encoding: 'utf8', timeout: 60_000 });
      took = r.stdout || `taker failed: ${r.stderr}`;
    }
    return orig(p, data, ...rest);
  }) as typeof fs.writeFileSync, async () => {
    await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { leaseMs: 300 } }), LostClaim);
  });
  assert.equal(took, 'won', 'the other process took the lapsed claim over');
  assert.equal(q.submits(), 0, 'the taker owns the purchase now, so the stalled owner sends nothing');
  assert.deepEqual(readAttempts(dir, key).map((a) => a.state), ['abandoned', 'claimed']);
});

await test('a taker whose claim went stale under it while it took over steps back instead of sending', async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  plantAttempt(dir, { state: 'claimed', host: 'elsewhere', pid: 1, leaseUntil: Date.now() - 1 });
  const q = countingQueue(1);
  let resumed = false;
  let accepted = false;
  // The paused owner comes back and marks the request sending just before the taker's attempt lands.
  await withFsHook('linkSync', (orig) => ((from: fs.PathLike, to: fs.PathLike) => {
    if (!resumed && String(to).endsWith('attempt-1.json')) {
      resumed = true;
      plantAttempt(dir, { state: 'submitting', host: 'elsewhere', pid: 1, body: INPUT, submittingAt: new Date().toISOString(), leaseUntil: Date.now() + 60_000 });
    }
    return orig(from, to);
  }) as typeof fs.linkSync, async () => {
    const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5, sleep: async () => {
      if (accepted) return;
      accepted = true;
      plantAttempt(dir, { n: 0, host: 'elsewhere', pid: 1, state: 'accepted', requestId: 'theirs', statusUrl: 's', responseUrl: 'r', leaseUntil: 0 });
    } } });
    assert.equal(r.reused, true);
    assert.equal(r.job.requestId, 'theirs');
  });
  assert.equal(resumed, true);
  assert.equal(q.submits(), 0, 'the owner was sending, so the taker does not');
  assert.equal(existsSync(join(ledgerDir(dir), key, 'attempt-1.json')), false, 'the taker withdrew its claim');
});

await test('the identity, not the uploaded body, decides whether two requests are the same job', async () => {
  const dir = fresh();
  const q = countingQueue(1);
  let uploads = 0;
  const prepare = async () => ({ image_url: `https://cdn.example/${++uploads}.png` });
  await submitOnce(dir, MODEL, {}, { key: 'k', http: q.http, identity: { image_url: 'sha256:abc' }, prepare });
  const again = await submitOnce(dir, MODEL, {}, { key: 'k', http: q.http, identity: { image_url: 'sha256:abc' }, prepare });
  assert.equal(again.reused, true);
  assert.equal(uploads, 1, 'a reused job uploads nothing');
  assert.equal(q.submits(), 1);
});

await test('a job the earlier single-file ledger recorded is still never bought again', async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(legacyLedgerPath(dir), JSON.stringify([{ key, model: MODEL, requestId: 'old', statusUrl: 's', responseUrl: 'r', submittedAt: 'then' }]));
  const q = countingQueue(1);
  const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http });
  assert.equal(r.job.requestId, 'old');
  assert.equal(q.submits(), 0);
  assert.equal(inFlight(dir).length, 1);
  completeJob(dir, MODEL, INPUT);
  assert.equal(inFlight(dir).length, 0);
  assert.equal(readLedger(dir)[0].completedAt !== undefined, true);
  assert.ok(existsSync(legacyLedgerPath(dir)), 'the earlier file is read, never rewritten');
});

// chmod does not stop a rename on Windows, and root ignores it.
await test('an earlier ledger that cannot be parsed or moved aside stops the claim instead of reading as empty', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const dir = fresh();
  const assets = join(dir, 'assets');
  mkdirSync(join(assets, 'jobs'), { recursive: true });
  writeFileSync(legacyLedgerPath(dir), '[{"key": "trunc');
  chmodSync(assets, 0o555);
  const q = countingQueue(1);
  try {
    await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http }), /could not be parsed, and moving it aside .* failed.*Nothing is bought/s);
  } finally {
    chmodSync(assets, 0o755);
  }
  assert.equal(q.submits(), 0, 'its jobs may be in it, so nothing is bought');
  assert.ok(existsSync(legacyLedgerPath(dir)), 'the file is left where it was');
});

/** A queue whose request history is `history`, counting purchases and lookups; everything else 404s. */
function historyQueue(history: (url: URL) => { status: number; body: unknown } | Promise<never>): { http: Http; submits: () => number; lookups: URL[] } {
  let submits = 0;
  const lookups: URL[] = [];
  const http: Http = async (url, init) => {
    if (init.method === 'POST') submits++;
    if (url.includes('/models/requests/by-endpoint')) {
      const u = new URL(url);
      lookups.push(u);
      const r = await history(u);
      return { status: r.status, json: async () => r.body, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { http, submits: () => submits, lookups };
}

await test('a history lookup that is refused is reported as unsearched, not as a request the queue does not list', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'uncertain', body: INPUT, submittingAt: new Date().toISOString(), reason: 'fal rejected the owner/model request (502): {}' });
  const q = historyQueue(() => ({ status: 403, body: { detail: 'key k may not read this' } }));
  const err = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } }).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof AmbiguousAcceptance);
  assert.equal(err.lookup.kind, 'unsearched');
  assert.match(err.message, /could not be searched for it \(the history answered 403/);
  assert.match(err.message, /A re-run searches again/, 'a refusal may be lifted, so a re-run is worth it');
  assert.doesNotMatch(err.message, /does not list it/);
  assert.match(err.message, /\(502\)/, "the attempt's own failure is shown");
  assert.doesNotMatch(err.message, /key k may/, 'the key never reaches a message');
  assert.equal(q.submits(), 0);
});

await test('a history the queue answers without the request says so, and a network failure is unsearched', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'submitting', body: INPUT, submittingAt: new Date().toISOString() });
  const empty = historyQueue(() => ({ status: 200, body: { items: [], next_cursor: null } }));
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: empty.http, ledger: { pollMs: 5 } }),
    (e: unknown) => e instanceof AmbiguousAcceptance && e.lookup.kind === 'not-listed' && /does not list it yet.*Re-run later/s.test(e.message));
  const down = historyQueue(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })));
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: down.http, ledger: { pollMs: 5 } }),
    (e: unknown) => e instanceof AmbiguousAcceptance && /could not be read: fetch failed \(ECONNREFUSED\)/.test(e.message));
  assert.equal(empty.submits() + down.submits(), 0);
});

await test('the lost request is found on a later page of the history, searched from before the send', async () => {
  const dir = fresh();
  const sentAt = new Date().toISOString();
  plantAttempt(dir, { state: 'uncertain', body: INPUT, submittingAt: sentAt, reason: '502' });
  const q = historyQueue((u) => u.searchParams.get('cursor') === 'page-2'
    ? { status: 200, body: { items: [{ request_id: 'on-page-2', json_input: { seed: 7, prompt: 'the same neon sign' } }], next_cursor: null } }
    : { status: 200, body: { items: [{ request_id: 'other', json_input: { prompt: 'x' } }], next_cursor: 'page-2' } });
  const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } });
  assert.equal(r.job.requestId, 'on-page-2');
  assert.equal(r.reused, true);
  assert.equal(q.submits(), 0);
  assert.deepEqual(q.lookups.map((u) => u.searchParams.get('cursor')), [null, 'page-2']);
  assert.ok(Date.parse(q.lookups[0].searchParams.get('start')!) <= Date.parse(sentAt), 'the window opens before the send');
});

await test('a history longer than the page cap is reported as unsearched, never as not listed', async () => {
  const dir = fresh();
  plantAttempt(dir, { state: 'submitting', body: INPUT, submittingAt: new Date().toISOString() });
  let page = 0;
  const q = historyQueue(() => ({ status: 200, body: { items: [], next_cursor: `p${++page}` } }));
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } }),
    (e: unknown) => e instanceof AmbiguousAcceptance && /runs past 10 pages.*a re-run will not get further/s.test(e.message) && !/A re-run searches again/.test(e.message));
  assert.equal(q.lookups.length, 10);
  assert.equal(q.submits(), 0);
});

await test('a damaged attempt file is possibly bought when old and a live claim when young; neither is bought', async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  const file = join(ledgerDir(dir), key, 'attempt-0.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"state": "acc');
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const q = historyQueue(() => ({ status: 200, body: { items: [], next_cursor: null } }));
  const err = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5 } }).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof AmbiguousAcceptance);
  assert.match(err.message, /its record could not be read, so whether it holds a request id is unknown/);
  assert.doesNotMatch(err.message, /no request id was recorded/);
  assert.match(err.message, /holds no request body to match\), and a re-run will not get further/);
  assert.deepEqual(q.lookups, [], 'there is nothing to search the history for');

  const young = fresh();
  const youngFile = join(ledgerDir(young), key, 'attempt-0.json');
  mkdirSync(dirname(youngFile), { recursive: true });
  writeFileSync(youngFile, '');
  await assert.rejects(() => submitOnce(young, MODEL, INPUT, { key: 'k', http: q.http, ledger: { pollMs: 5, waitTimeoutMs: 50 } }), /has held this exact request/);
  assert.equal(q.submits(), 0);
});

await test('a request that never left this machine is free to retry; one cut off after connecting is not', async () => {
  const dir = fresh();
  const offline: Http = async (_url, init) => {
    if (init.method === 'POST') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
    return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: offline }), /fetch failed/);
  assert.equal(readAttempts(dir, jobKey(MODEL, INPUT))[0].state, 'refused');
  const q = countingQueue(1);
  await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http });
  assert.equal(q.submits(), 1, 'nothing reached the queue, so the retry buys');

  const other = fresh();
  const reset: Http = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); };
  await assert.rejects(() => submitOnce(other, MODEL, INPUT, { key: 'k', http: reset }), /fetch failed/);
  assert.equal(readAttempts(other, jobKey(MODEL, INPUT))[0].state, 'uncertain', 'a reset may come after the queue read the request');

  // How undici reports a proxy that refused the tunnel: the request never reached the queue.
  const tunnel = fresh();
  const refusedTunnel: Http = async () => {
    throw new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }) }) });
  };
  await assert.rejects(() => submitOnce(tunnel, MODEL, INPUT, { key: 'k', http: refusedTunnel }), /fetch failed/);
  assert.equal(readAttempts(tunnel, jobKey(MODEL, INPUT))[0].state, 'refused', 'a refused tunnel sent nothing, so a retry is free to buy');

  const aborted = fresh();
  const cutOff: Http = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('This operation was aborted'), { code: 'UND_ERR_ABORTED' }) }); };
  await assert.rejects(() => submitOnce(aborted, MODEL, INPUT, { key: 'k', http: cutOff }), /fetch failed/);
  assert.equal(readAttempts(aborted, jobKey(MODEL, INPUT))[0].state, 'uncertain', 'any other abort may come after the request left');
});

await test('a caller hook that throws cannot lose the accepted id', async () => {
  const dir = fresh();
  const q = countingQueue(1);
  await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, onAccepted: () => { throw new Error('hook'); } }), /hook/);
  const [a] = readAttempts(dir, jobKey(MODEL, INPUT));
  assert.equal(a.state, 'accepted');
  assert.equal(a.requestId, 'req-1');
  const again = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http });
  assert.equal(again.reused, true);
  assert.equal(q.submits(), 1);
});

const noChmod = process.platform === 'win32' || process.getuid?.() === 0;

await test('an accepted id the ledger cannot write still reaches the caller and the error', { skip: noChmod }, async () => {
  const dir = fresh();
  const keyDir = join(ledgerDir(dir), jobKey(MODEL, INPUT));
  const q = countingQueue(1);
  const locking: Http = async (url, init) => {
    if (init.method === 'POST') chmodSync(keyDir, 0o555);
    return q.http(url, init);
  };
  const heard: string[] = [];
  try {
    await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: locking, onAccepted: (j) => { heard.push(j.requestId); } }),
      (e: Error) => !(e instanceof PossiblyBought) && /^fal accepted the owner\/model request as req-1, so it is bought, but recording that failed/.test(e.message),
      'an acceptance that was seen is bought, not possibly bought');
  } finally {
    chmodSync(keyDir, 0o755);
  }
  assert.deepEqual(heard, ['req-1']);
});

await test('an accepted id whose first ledger write fails and whose retry lands goes on as bought', { skip: noChmod }, async () => {
  const dir = fresh();
  const keyDir = join(ledgerDir(dir), jobKey(MODEL, INPUT));
  const q = countingQueue(1);
  const locking: Http = async (url, init) => {
    if (init.method === 'POST') chmodSync(keyDir, 0o555);
    return q.http(url, init);
  };
  try {
    // The write fails while the directory is locked; the caller's hook unlocks it before the retry.
    const r = await submitOnce(dir, MODEL, INPUT, { key: 'k', http: locking, onAccepted: () => { chmodSync(keyDir, 0o755); } });
    assert.equal(r.job.requestId, 'req-1');
    assert.equal(r.reused, false);
  } finally {
    chmodSync(keyDir, 0o755);
  }
  const [a] = readAttempts(dir, jobKey(MODEL, INPUT));
  assert.equal(a.state, 'accepted');
  assert.equal(a.requestId, 'req-1');
  assert.equal(q.submits(), 1);
});

await test('a claim whose lease renewal keeps failing says so when it refuses to send', { skip: noChmod }, async () => {
  const dir = fresh();
  const key = jobKey(MODEL, INPUT);
  const won = await claimJob(dir, key, MODEL, { leaseMs: 90 });
  assert.equal(won.kind, 'won');
  chmodSync(join(ledgerDir(dir), key), 0o555);
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.throws(() => won.kind === 'won' && won.claim.submitting(INPUT), (e: unknown) => e instanceof LostClaim && /ran low on its lease .*renewing it failed: EACCES/.test(e.message));
  } finally {
    chmodSync(join(ledgerDir(dir), key), 0o755);
  }
});

await test('a renewed lease holds a claim through a slow upload, so a second caller waits instead of buying', async () => {
  const dir = fresh();
  const q = countingQueue(1);
  const slowUpload = async () => { await new Promise((r) => setTimeout(r, 1_000)); return { ...INPUT }; };
  const first = submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, prepare: slowUpload, ledger: { leaseMs: 300 } });
  await new Promise((r) => setTimeout(r, 50));
  const second = submitOnce(dir, MODEL, INPUT, { key: 'k', http: q.http, ledger: { leaseMs: 300, pollMs: 5 } });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(q.submits(), 1);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(b.job.requestId, a.job.requestId);
});

await test('a job key is the one earlier versions derived, so jobs they recorded are still found', () => {
  assert.equal(jobKey('owner/model', { prompt: 'the same neon sign', seed: 7 }), 'fe6ca8fe27039fb5');
  // Keys out of order and nested: the sorting and the recursion are part of the derivation too.
  assert.equal(jobKey('owner/model', { seed: 7, loras: [{ scale: 1, path: 'x' }], prompt: 'p' }), 'af94743821464193');
});

await test('a lost answer whose ledger record then fails to write says both', { skip: noChmod }, async () => {
  const dir = fresh();
  const keyDir = join(ledgerDir(dir), jobKey(MODEL, INPUT));
  const flaky = countingQueue(1, 502);
  const locking: Http = async (url, init) => {
    if (init.method === 'POST') chmodSync(keyDir, 0o555);
    return flaky.http(url, init);
  };
  try {
    await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: locking }),
      (e: unknown) => e instanceof PossiblyBought && /fal may have accepted it.*; recording that failed too \(EACCES/s.test(e.message));
  } finally {
    chmodSync(keyDir, 0o755);
  }
  assert.equal(readAttempts(dir, jobKey(MODEL, INPUT))[0].state, 'submitting', 'left sending, which a re-run resolves by lookup');
});

await test('a refusal the ledger could not record says nothing was bought, and is not taken for a send', { skip: noChmod }, async () => {
  const dir = fresh();
  const keyDir = join(ledgerDir(dir), jobKey(MODEL, INPUT));
  const q = countingQueue(1, 422);
  const locking: Http = async (url, init) => {
    if (init.method === 'POST') chmodSync(keyDir, 0o555);
    return q.http(url, init);
  };
  try {
    await assert.rejects(() => submitOnce(dir, MODEL, INPUT, { key: 'k', http: locking }),
      (e: unknown) => e instanceof PossiblyBought && !e.sent && /\(422\).*Nothing was bought, but recording that it never got in failed \(EACCES/s.test(e.message));
  } finally {
    chmodSync(keyDir, 0o755);
  }
});
