import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, readManifest, recordRequest, recordsDir, spend, spendLine, manifestPath, current, provenanceShare } from '../src/providers/assets.ts';
import { submit, await_, download, firstUrl, submitOnce, completeJob, falKey, billedCost, describeBilled, type Http, type FalJob } from '../src/providers/fal.ts';
import { inFlight, readLedger, recordJob, legacyLedgerPath } from '../src/providers/queue-ledger.ts';

const run = () => mkdtempSync(join(tmpdir(), 'assets-'));
const recordChild = fileURLToPath(new URL('./helpers/record-child.ts', import.meta.url));
const asset = (id: string, over: Partial<Parameters<typeof record>[1]> = {}) => ({
  id, kind: 'image' as const, path: `assets/${id}.png`, provider: 'fal',
  model: 'seedream', createdAt: '2026-08-09T00:00:00Z', cost: null, ...over,
});

test('assets: a record round-trips, and a re-record supersedes without erasing', () => {
  const dir = run();
  record(dir, asset('a1'));
  record(dir, asset('a1', { prompt: 'a desert at noon' }));

  // Both calls happened and both were billed; only the second one is the asset a document places.
  const m = readManifest(dir);
  assert.equal(m.assets.length, 2);
  assert.ok(m.assets[0].supersededBy, 'the first is marked, not deleted');

  const live = current(dir);
  assert.equal(live.length, 1);
  assert.equal(live[0].prompt, 'a desert at noon');
});

test('assets: an unpriced call is counted but never folded into the total', () => {
  const dir = run();
  record(dir, asset('a1', { cost: 0.03 }));
  record(dir, asset('a2'));
  record(dir, asset('a3', { kind: 'video', cost: 0.5 }));
  const s = spend(dir);
  assert.equal(s.calls, 3);
  assert.equal(s.priced, 2);
  assert.equal(s.unpriced, 1);
  assert.equal(s.total, 0.53);
  assert.equal(s.byKind.video.calls, 1);
});

test('assets: the spend line says when the figure is a lower bound, and when there is none', () => {
  const dir = run();
  record(dir, asset('a1'));
  assert.match(spendLine(dir), /none has a cost figure \(no price came back with the call and no billing record for it was read\), so this run has no cost figure/);
  assert.doesNotMatch(spendLine(dir), /the provider returned no price/, 'a figure may be missing only because its billing record could not be read');
  record(dir, asset('a2', { cost: 0.1 }));
  assert.match(spendLine(dir), /lower bound/);
});

test('assets: a corrupt manifest does not cost the user what was already paid for', () => {
  const dir = run();
  record(dir, asset('a1', { cost: 1 }));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(manifestPath(dir), '{ broken');
  assert.deepEqual(readManifest(dir).assets, []);
});

/** A queue that accepts, reports RUNNING once, then COMPLETED — with no key, network or bill. */
function fakeQueue(script: { status: number; body: unknown }[]): { http: Http; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const http: Http = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const step = script[Math.min(i++, script.length - 1)];
    return {
      status: step.status,
      json: async () => step.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { http, calls };
}

test('fal: the job id is written down before the first poll, because the queue already took the money', async () => {
  const { http } = fakeQueue([{ status: 200, body: { request_id: 'r1', status_url: 's', response_url: 'p' } }]);
  const seen: FalJob[] = [];
  const job = await submit('m', {}, { key: 'k', http, onAccepted: (j) => { seen.push(j); } });
  assert.equal(job.requestId, 'r1');
  assert.equal(seen.length, 1, 'recorded before anything else can fail');
});

test('fal: a rejected submit never echoes the key back in the error', async () => {
  const { http } = fakeQueue([{ status: 401, body: { detail: 'bad Key sk-secret-123' } }]);
  await assert.rejects(
    () => submit('m', {}, { key: 'sk-secret-123', http }),
    (e: Error) => !e.message.includes('sk-secret-123') && e.message.includes('«key»'),
  );
});

test('fal: transient status failures are tolerated, a persistent one names the resume path', async () => {
  const { http } = fakeQueue([{ status: 500, body: {} }]);
  await assert.rejects(
    () => await_({ requestId: 'r1', statusUrl: 's', responseUrl: 'p' }, { key: 'k', http, sleep: async () => {}, maxStatusFailures: 2 }),
    /may still complete\. Re-running the same command resumes request r1; it does not buy it again\./,
  );
});

test('fal: a FAILED job is not retried here — a retry is a second charge', async () => {
  const { http } = fakeQueue([{ status: 200, body: { status: 'FAILED' } }]);
  await assert.rejects(
    () => await_({ requestId: 'r1', statusUrl: 's', responseUrl: 'p' }, { key: 'k', http, sleep: async () => {} }),
    /failed after fal accepted it, so it has been paid for\. Re-running the same command resumes this failed request/,
  );
  await assert.rejects(
    () => await_({ requestId: 'r1', statusUrl: 's', responseUrl: 'p' }, { key: 'k', http, sleep: async () => {}, ledgerRecord: '/runs/x/assets/jobs/0123abcd' }),
    (e: Error) => e.message.endsWith("made by removing its record from the run's job ledger, /runs/x/assets/jobs/0123abcd, first.") && !e.message.includes('<key>'),
  );
});

test('fal: a completed job returns its payload with no invented price', async () => {
  const http: Http = async (url) => ({
    status: 200,
    json: async () => (url === 's' ? { status: 'COMPLETED' } : { images: [{ url: 'https://cdn/x.png' }] }),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const r = await await_({ requestId: 'r1', statusUrl: 's', responseUrl: 'p' }, { key: 'k', http, sleep: async () => {} });
  assert.ok(!('cost' in r), 'fal prices nothing in a result, so none is carried to be mistaken for a charge');
  assert.equal(firstUrl(r.payload), 'https://cdn/x.png');
});

test('assets: a corrupt manifest is kept aside, never written over', () => {
  const dir = run();
  record(dir, asset('a1', { cost: 0.5 }));
  record(dir, asset('a2', { cost: 0.25 }));
  writeFileSync(manifestPath(dir), '{ truncated mid-write');

  // An unreadable file makes the account unknown, not empty of what it held.
  assert.deepEqual(readManifest(dir).assets, []);
  assert.equal(readManifest(dir).corrupt, true);

  record(dir, asset('a3', { cost: 0.1 }));
  const kept = manifestPath(dir).replace(/\.json$/, '.corrupt.json');
  assert.ok(existsSync(kept), 'the unreadable bytes are preserved');
  assert.equal(readFileSync(kept, 'utf8'), '{ truncated mid-write');
  assert.deepEqual(readManifest(dir).assets.map((a) => a.id), ['a1', 'a2', 'a3'], 'the records beside it are not lost with it');

  // A damaged record file is set aside the same way, and only it.
  const [row] = readdirSync(recordsDir(dir)).filter((f) => f.endsWith('.json'));
  writeFileSync(join(recordsDir(dir), row), '{ torn');
  utimesSync(join(recordsDir(dir), row), new Date(0), new Date(0));
  assert.equal(readManifest(dir).corrupt, true);
  record(dir, asset('a4'));
  assert.equal(readFileSync(join(recordsDir(dir), row.replace(/\.json$/, '.corrupt.json')), 'utf8'), '{ torn');
  assert.deepEqual(readManifest(dir).assets.map((a) => a.id), ['a2', 'a3', 'a4']);
});

test('assets: a manifest recorded before per-row files is read with them, and its request rows are filled in place', () => {
  const dir = run();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(manifestPath(dir), JSON.stringify({ runKey: 'old-run', assets: [
    asset('plate', { cost: 0.04 }),
    asset('shot', { meta: { requestId: 'req-old' } }),
  ] }));
  record(dir, asset('plate', { createdAt: '2026-08-10T00:00:00Z', cost: 0.04 }));
  const filled = recordRequest(dir, 'req-old', (prior) => ({ ...prior!, cost: 0.5 }));
  assert.equal(filled.created, false, 'the old row is the request\'s row');
  const m = readManifest(dir);
  assert.equal(m.runKey, 'old-run');
  assert.deepEqual(m.assets.map((a) => [a.id, a.cost, a.supersededBy]), [
    ['plate', 0.04, '2026-08-10T00:00:00Z'], ['shot', 0.5, undefined], ['plate', 0.04, undefined],
  ]);
  assert.equal(spend(dir).calls, 3, 'the filled-in request is still one call');
  assert.equal(readFileSync(manifestPath(dir), 'utf8').includes('"cost":0.5'), false, 'the old file is only read');
});

test('assets: the run key is set by the caller, not pinned empty on first write', () => {
  const dir = run();
  record(dir, asset('a1'), 'fear-and-loathing');
  assert.equal(readManifest(dir).runKey, 'fear-and-loathing');
});

test('fal: a proxy error reports its status, not a JSON parse error', async () => {
  // `res.json()` ran before the status check, so an HTML 502 threw a SyntaxError carrying a slice of
  // that HTML — the real status was lost, and the body could carry the echoed key out with it.
  const http: Http = async () => ({
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0 — <html>Key sk-secret-123</html>'); },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(
    () => submit('m', {}, { key: 'sk-secret-123', http }),
    (e: Error) => {
      assert.match(e.message, /502/, 'the status is what tells the caller what happened');
      assert.doesNotMatch(e.message, /sk-secret-123/);
      return true;
    },
  );
});

test('fal: a revoked key is terminal — it is not retried and it does not name a resume path', async () => {
  // A refusal cannot become a success by waiting, so it is asked once and must not point at a resume.
  let calls = 0;
  const http: Http = async () => {
    calls++;
    return { status: 401, json: async () => ({ detail: 'unauthorized' }), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(
    () => await_({ requestId: 'r1', statusUrl: 's', responseUrl: 'p' }, { key: 'k', http, sleep: async () => {} }),
    (e: Error) => {
      assert.match(e.message, /401/);
      assert.doesNotMatch(e.message, /resumes request/);
      return true;
    },
  );
  assert.equal(calls, 1, 'a refusal is asked once, not four times');
});

test('fal: a failed download does not put the signed url in the error', async () => {
  const http: Http = async () => ({ status: 403, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    () => download('https://cdn.fal.media/x.png?sig=SECRETSIGNATURE&exp=1', '/tmp/none', http),
    (e: Error) => {
      assert.doesNotMatch(e.message, /SECRETSIGNATURE/, 'a signed query string is a bearer credential');
      assert.match(e.message, /cdn\.fal\.media\/x\.png/, 'the path still identifies the file');
      return true;
    },
  );
});

test('fal: an identical request is not bought twice', async () => {
  // The queue charges on acceptance. A retry after a lost poll must resume the job that exists.
  const dir = mkdtempSync(join(tmpdir(), 'queue-'));
  let submits = 0;
  const http: Http = async () => {
    submits++;
    return { status: 200, json: async () => ({ request_id: `r${submits}`, status_url: 's', response_url: 'p' }), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const input = { prompt: 'a neon sign', seed: 7 };

  const first = await submitOnce(dir, 'm', input, { key: 'k', http });
  assert.equal(first.reused, false);
  assert.equal(first.job.requestId, 'r1');

  // Same request, keys written in a different order — the same job all the same.
  const again = await submitOnce(dir, 'm', { seed: 7, prompt: 'a neon sign' }, { key: 'k', http });
  assert.equal(again.reused, true, 'the second call must not reach the queue');
  assert.equal(again.job.requestId, 'r1');
  assert.equal(submits, 1, 'one submission, one charge');

  // A different request is a different job.
  const other = await submitOnce(dir, 'm', { prompt: 'a neon sign', seed: 8 }, { key: 'k', http });
  assert.equal(other.reused, false);
  assert.equal(submits, 2);

  assert.equal(inFlight(dir).length, 2, 'both are in flight until they are closed');
  completeJob(dir, 'm', input);
  assert.equal(inFlight(dir).length, 1, 'a resume picks up only what never finished');
});

test('assets: regenerating under the same id is a second billed call, not a correction', () => {
  // The manifest upserted by id, so a real film's 99 rows hid at least 27 further billed calls.
  const dir = mkdtempSync(join(tmpdir(), 'assets-'));
  record(dir, { ...asset('plate-1'), cost: 0.04, createdAt: '2026-01-01T00:00:00.000Z' }, 'k');
  record(dir, { ...asset('plate-1'), cost: 0.04, createdAt: '2026-01-01T00:05:00.000Z' }, 'k');
  record(dir, { ...asset('plate-2'), cost: 0.04, createdAt: '2026-01-01T00:06:00.000Z' }, 'k');

  const s = spend(dir);
  assert.equal(s.calls, 3, 'three calls were made and three were charged');
  assert.equal(s.total, 0.12);

  const live = current(dir);
  assert.deepEqual(live.map((a) => a.id).sort(), ['plate-1', 'plate-2'], 'two assets survive');
  assert.equal(live.find((a) => a.id === 'plate-1')!.createdAt, '2026-01-01T00:05:00.000Z', 'the later one is the live one');

  assert.match(spendLine(dir), /3 generated assets/);
});

test('assets: the provenance share sums before it divides', () => {
  // It used to feed each entry back through the ROUNDED percentage of the entries before it, so a
  // repeated origin drifted down: 300 one-second shots of one source reported 90%. This is the number
  // that answers "how much of this is real footage?", so it has to be the real number.
  const many = Array.from({ length: 300 }, () => ({ origin: 'archive', seconds: 1 }));
  assert.deepEqual(provenanceShare(many), { archive: 100 });

  assert.deepEqual(
    provenanceShare([{ origin: 'archive', seconds: 78 }, { origin: 'generated', seconds: 22 }]),
    { archive: 78, generated: 22 },
  );
  // Interleaved, which is how a real cut arrives.
  assert.deepEqual(
    provenanceShare([
      { origin: 'archive', seconds: 30 }, { origin: 'generated', seconds: 10 },
      { origin: 'archive', seconds: 48 }, { origin: 'generated', seconds: 12 },
    ]),
    { archive: 78, generated: 22 },
  );
  assert.deepEqual(provenanceShare([]), {});
  assert.throws(() => provenanceShare([{ origin: 'x', seconds: NaN }]), /cannot be computed/);
});

test('assets: an unreadable manifest never reads as "nothing generated"', () => {
  const dir = run();
  record(dir, asset('a1', { cost: 2 }));
  writeFileSync(manifestPath(dir), '{ truncated');
  assert.match(spendLine(dir), /could not be read/);
  assert.doesNotMatch(spendLine(dir), /nothing generated/);
  assert.throws(() => current(dir), /could not be read/);
});

test('queue: an earlier single-file ledger of the wrong shape is kept, not read through', () => {
  // Valid JSON that is not a list of job records returned [] and the next write erased two accepted
  // job ids — the exact loss the file exists to prevent, through the door quarantine did not cover.
  const dir = mkdtempSync(join(tmpdir(), 'queue-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(legacyLedgerPath(dir), JSON.stringify({ jobs: [] }));

  assert.deepEqual(readLedger(dir), [], 'reading through it is honest');
  recordJob(dir, { key: 'k2', model: 'm', requestId: 'r2', statusUrl: 's', responseUrl: 'p', submittedAt: 'now' });
  const kept = legacyLedgerPath(dir).replace(/\.json$/, '.corrupt.json');
  assert.ok(existsSync(kept), 'the unreadable bytes are preserved');
  assert.deepEqual(readLedger(dir).map((e) => e.key), ['k2']);
});

test('fal: there is a way to get a key, and it is never the value in an error', () => {
  // `FalOptions.key` was required and nothing read an environment variable or named a place to put
  // one, so the first thing a run needing a generated asset had to do was write its own client.
  assert.equal(falKey({ FAL_KEY: 'k-from-env' } as NodeJS.ProcessEnv), 'k-from-env');
  assert.equal(falKey({ FAL_API_KEY: 'k-alt' } as NodeJS.ProcessEnv), 'k-alt');

  const dir = mkdtempSync(join(tmpdir(), 'falkey-'));
  const file = join(dir, 'notes.md');
  // A key kept in a notes file sits among prose, so the caller never has to paste the secret itself.
  writeFileSync(file, '# my keys\n\nfal:\n\nabcdefghij0123456789KLMNOP\n\nthat is the one\n');
  assert.equal(falKey({ OPEN_EDIT_FAL_KEY_FILE: file } as NodeJS.ProcessEnv), 'abcdefghij0123456789KLMNOP');

  writeFileSync(file, '# my keys\n\nnothing here\n');
  assert.throws(() => falKey({ OPEN_EDIT_FAL_KEY_FILE: file } as NodeJS.ProcessEnv), /no key found/);
  assert.throws(() => falKey({ OPEN_EDIT_FAL_KEY_FILE: join(dir, 'nope.md') } as NodeJS.ProcessEnv), /does not exist/);

  // The one that matters: the error must say where to put a key, not what the key is.
  try {
    falKey({} as NodeJS.ProcessEnv);
    assert.fail('expected a throw');
  } catch (e) {
    assert.match((e as Error).message, /FAL_KEY/);
    assert.match((e as Error).message, /never echo the value/);
  }
});

test('assets: writers in parallel processes each keep every record they write', async () => {
  const dir = run();
  const writers = 8;
  const each = 25;
  const startAt = Date.now() + 2500;
  await Promise.all(Array.from({ length: writers }, (_, w) => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', recordChild, dir, String(startAt), `w${w}`, String(each)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}: ${err}`))));
  })));
  const m = readManifest(dir);
  assert.equal(m.corrupt, undefined, 'no writer ever read a torn file');
  assert.equal(m.assets.length, writers * each, `${m.assets.length} of ${writers * each} records survived`);
  assert.equal(new Set(m.assets.map((a) => a.id)).size, writers * each);
  const left = readdirSync(recordsDir(dir));
  assert.deepEqual(left.filter((f) => /corrupt|\.tmp$/.test(f)), [], 'nothing was quarantined and every write was renamed into place');
});


test('assets: processes filling in one request\'s row at once each keep every change they make', async () => {
  const dir = run();
  const writers = 4;
  const each = 10;
  const startAt = Date.now() + 2500;
  await Promise.all(Array.from({ length: writers }, (_, w) => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', recordChild, dir, String(startAt), `w${w}`, String(each), 'req-1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}: ${err}`))));
  })));
  const m = readManifest(dir);
  assert.equal(m.assets.length, 1, 'one request, one row');
  const fills = m.assets[0].meta?.fills as string[];
  assert.equal(fills.length, writers * each, `${fills.length} of ${writers * each} fill-ins survived`);
  assert.equal(new Set(fills).size, writers * each);
});

test('assets: a writer between its read and its write neither blocks another process nor loses its record', () => {
  const dir = run();
  let calls = 0;
  const other = (requestId?: string) => spawnSync(process.execPath, ['--import', 'tsx', recordChild, dir, '0', 'other', '1', ...(requestId ? [requestId] : [])], { encoding: 'utf8', timeout: 60_000 });
  const { created } = recordRequest(dir, 'req-1', (prior) => {
    if (calls++ === 0) {
      for (const r of [other(), other('req-1')]) {
        assert.equal(r.status, 0, `${r.error ?? r.stderr}`);
        assert.ok(Number(r.stdout) < 5_000, `the other writer waited ${r.stdout} ms on this one`);
      }
    }
    return { ...(prior ?? asset('shot')), meta: { ...prior?.meta, fills: [...((prior?.meta?.fills as string[] | undefined) ?? []), 'mine'] } };
  });
  assert.equal(created, false, 'the other writer made the row first');
  assert.equal(calls, 2, 'the stale change was made again on the newer row');
  const m = readManifest(dir);
  assert.equal(m.assets.length, 2, 'the other writer\'s plain record and the request\'s one row');
  assert.deepEqual(m.assets.find((a) => a.meta?.requestId === 'req-1')?.meta?.fills, ['other-0', 'mine']);
});

test('assets: a request keeps one row, filled in by whoever learns more, so it is counted once', () => {
  const dir = run();
  const first = recordRequest(dir, 'req-1', (prior) => prior ?? asset('shot', { meta: { files: [] } }));
  assert.equal(first.created, true);
  const again = recordRequest(dir, 'req-1', (prior) => prior ?? asset('shot', { cost: 9 }));
  assert.equal(again.created, false, 'a row that exists is left as it is');
  record(dir, asset('shot', { createdAt: '2026-08-10T00:00:00Z' }));
  const filled = recordRequest(dir, 'req-1', (prior) => ({ ...prior!, cost: 0.05, path: 'assets\\shot.png' }));
  assert.equal(filled.created, false);
  const m = readManifest(dir);
  assert.equal(m.assets.length, 2);
  assert.equal(m.assets[0].cost, 0.05);
  assert.equal(m.assets[0].meta?.requestId, 'req-1');
  assert.equal(m.assets[0].path, 'assets/shot.png');
  assert.equal(m.assets[0].supersededBy, '2026-08-10T00:00:00Z', 'filled in, it is still the call a later one replaced');
  assert.equal(spend(dir).calls, 2);
});

test('assets: AGENTS.md describes the records directory as its writers leave it', () => {
  const dir = run();
  record(dir, asset('still'));
  recordRequest(dir, 'req-1', (prior) => prior ?? asset('shot'));
  recordRequest(dir, 'req-1', (prior) => ({ ...prior!, cost: 0.05 }));
  const files = readdirSync(recordsDir(dir));
  assert.equal(files.length, 3);
  assert.equal(readManifest(dir).assets.length, 2, 'one purchase leaves two files, so a file is not a record');
  const doc = readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');
  assert.ok(doc.includes('`runs/<key>/assets/records/`'));
  assert.ok(files.some((f) => /^row-.*\.json$/.test(f)) && doc.includes('one `row-*.json` per plain record'));
  assert.ok(files.includes('request-req-1.1.json') && doc.includes('`request-<id>.<n>.json` versions of which only the highest `n` stands'));
  assert.ok(!doc.includes('one file per record'));
});

test('fal: billing records that were read and hold no charge yet are absent, not unreadable', async () => {
  const answer = (status: number, body: unknown) => ({ status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const empty: Http = async () => answer(200, { billing_events: [] });
  const b = await billedCost('r1', { key: 'k', http: empty, sleep: async () => {} });
  assert.deepEqual(b, { kind: 'absent' });
  assert.match(describeBilled(b), /fal has not recorded the charge yet/);
  let calls = 0;
  const flaky: Http = async () => (calls++ ? answer(200, { billing_events: [] }) : answer(502, {}));
  assert.deepEqual(await billedCost('r1', { key: 'k', http: flaky, sleep: async () => {} }), { kind: 'absent' },
    'the second read got through, so the first failure no longer describes the records');
});
