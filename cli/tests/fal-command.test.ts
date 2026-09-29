// Tests src/commands/fal.ts against a fake fal: every route the command touches (pricing, storage,
// queue, results, file downloads, billing) is answered here, so nothing needs a key, a network or a bill.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  describeInput, localFile, outputFiles, renderSchema, runFalJobs, schemaListing, schemaOf, type FalJobSpec,
} from '../src/commands/fal.ts';
import { uploadFile } from '../src/providers/fal-storage.ts';
import { describeListing, type Http } from '../src/providers/fal.ts';
import { readManifest, record, recordRequest, spendLine, type AssetRecord } from '../src/providers/assets.ts';
import { jobKey, ledgerDir, type Attempt } from '../src/providers/queue-ledger.ts';
import { falCommand } from '../src/commands/fal.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'fal-cmd-'));
const reply = (status: number, body: unknown, bytes = new Uint8Array()) => ({
  status,
  json: async () => body,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  header: () => null,
});

interface FakeFal {
  http: Http;
  submits: { model: string; body: Record<string, unknown> }[];
  uploads: string[];
  parts: number[];
  /** The bytes each storage PUT carried, a single upload or a part, in order. */
  bodies: Uint8Array[];
}

interface FakeFalOptions {
  billing?: 'forbidden' | 'error' | number;
  pricing?: 'error';
  /** What every status check answers; COMPLETED unless set. */
  status?: string;
  /** The HTTP status output downloads answer with. */
  download?: number;
  /** The file_name the result gives its first output. */
  fileName?: string;
  /** A result that carries no {url} file object at all. */
  noFiles?: boolean;
  /** A result whose only file object has a plain-http url; `long` makes that url 5000 characters. */
  plainHttp?: boolean | 'long';
  /** A result whose only file carries its bytes inline, as a base64 data url. */
  inline?: boolean;
  /** A multipart part number every PUT of which fails. */
  failPart?: number;
  /** What a submit answers with, when not an acceptance. */
  submitStatus?: number;
  /** The requests fal's request history lists. */
  history?: { request_id: string; json_input: unknown }[];
}

const INLINE_BYTES = 'png bytes '.repeat(2000);

function fakeFal(opts: FakeFalOptions = {}): FakeFal {
  const submits: FakeFal['submits'] = [];
  const uploads: string[] = [];
  const parts: number[] = [];
  const bodies: Uint8Array[] = [];
  let n = 0;
  const http: Http = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'api.fal.ai' && u.pathname === '/v1/models/pricing') {
      if (opts.pricing === 'error') return reply(503, { error: 'down' });
      return reply(200, { prices: [{ endpoint_id: 'owner/image-model', unit_price: 0.02, unit: 'images', currency: 'USD' }] });
    }
    if (u.host === 'api.fal.ai' && u.pathname === '/v1/models/requests/by-endpoint') return reply(200, { items: opts.history ?? [], next_cursor: null });
    if (u.host === 'api.fal.ai' && u.pathname === '/v1/models/billing-events') {
      if (opts.billing === 'error') return reply(502, { error: 'bad gateway' });
      if (opts.billing === 'forbidden' || opts.billing === undefined) return reply(403, { error: 'no' });
      return reply(200, { billing_events: [{ request_id: u.searchParams.get('request_id'), cost_total: opts.billing, output_units: 1 }] });
    }
    if (u.host === 'rest.fal.ai') {
      const name = JSON.parse(String(init.body)).file_name as string;
      uploads.push(name);
      const multipart = u.pathname.endsWith('initiate-multipart');
      return reply(200, { upload_url: `https://upload.example/${name}${multipart ? '/mp' : ''}?sig=1`, file_url: `https://cdn.example/${name}` });
    }
    if (u.host === 'upload.example') {
      const part = /\/mp\/(\d+)$/.exec(u.pathname);
      if (part && Number(part[1]) === opts.failPart) return reply(503, {});
      if (init.method === 'PUT') bodies.push(new Uint8Array(init.body as Uint8Array));
      if (part) { parts.push(Number(part[1])); return reply(200, { partNumber: Number(part[1]), etag: `e${part[1]}` }); }
      if (u.pathname.endsWith('/mp/complete')) {
        const body = JSON.parse(String(init.body)) as { parts: { etag: string }[] };
        assert.deepEqual(body.parts.map((p) => p.etag), parts.map((p) => `e${p}`));
        return reply(200, {});
      }
      return reply(200, {});
    }
    if (u.host === 'queue.fal.run' && init.method === 'POST') {
      submits.push({ model: u.pathname.slice(1), body: JSON.parse(String(init.body)) });
      if (opts.submitStatus) return reply(opts.submitStatus, { detail: 'bad gateway' });
      const id = `req-${++n}`;
      return reply(200, { request_id: id, status_url: `https://queue.fal.run/owner/x/requests/${id}/status`, response_url: `https://queue.fal.run/owner/x/requests/${id}` });
    }
    if (u.host === 'queue.fal.run' && u.pathname.endsWith('/status')) return reply(200, { status: opts.status ?? 'COMPLETED' });
    if (u.host === 'queue.fal.run') {
      const id = u.pathname.split('/').pop();
      if (opts.noFiles) return reply(200, { text: 'a caption', video_url: `https://files.example/${id}/bare.mp4` });
      if (opts.plainHttp === 'long') return reply(200, { images: [{ url: `http://files.example/${'x'.repeat(5000)}.png` }] });
      if (opts.plainHttp) return reply(200, { images: [{ url: `http://files.example/${id}/out.png?sig=secret` }] });
      if (opts.inline) return reply(200, { images: [{ url: `data:image/png;base64,${Buffer.from(INLINE_BYTES).toString('base64')}` }] });
      return reply(200, { images: [{ url: `https://files.example/${id}/out.png`, file_name: opts.fileName ?? 'out.png' }], extra: { url: `https://files.example/${id}/out.png` } });
    }
    if (u.host === 'files.example') return reply(opts.download ?? 200, {}, new TextEncoder().encode(`bytes of ${u.pathname}`));
    throw new Error(`fake fal has no route for ${init.method} ${url}`);
  };
  return { http, submits, uploads, parts, bodies };
}

const quiet = { log: () => {}, sleep: async () => {} };

await test('a path in the input is a file only when it looks like one and is there', () => {
  const dir = fresh();
  const other = fresh();
  writeFileSync(join(dir, 'face.png'), 'png');
  writeFileSync(join(other, 'ref.jpg'), 'jpg');
  assert.equal(localFile('face.png', [dir]), join(dir, 'face.png'));
  assert.equal(localFile('./face.png', [dir]), join(dir, 'face.png'));
  assert.equal(localFile('ref.jpg', [dir, other]), join(other, 'ref.jpg'), 'the input file\'s own folder is looked in second');
  assert.equal(localFile(pathToFileURL(join(dir, 'face.png')).href, []), join(dir, 'face.png'));
  assert.equal(localFile('https://cdn.example/face.png', [dir]), undefined);
  assert.equal(localFile('a portrait of a face', [dir]), undefined, 'prose is never looked up');
  assert.equal(localFile('missing.png', [dir]), undefined);
});

await test('a file stands in the identity as its content, so the same bytes under two names are one job', async () => {
  const dir = fresh();
  writeFileSync(join(dir, 'a.png'), 'same bytes');
  writeFileSync(join(dir, 'b.png'), 'same bytes');
  const a = await describeInput({ image_url: 'a.png', prompt: 'x' }, [dir]);
  const b = await describeInput({ image_url: 'b.png', prompt: 'x' }, [dir]);
  assert.deepEqual(a.identity, b.identity);
  assert.match(String(a.identity.image_url), /^file:sha256:[0-9a-f]{64}$/);
  writeFileSync(join(dir, 'b.png'), 'other bytes');
  assert.notDeepEqual((await describeInput({ image_url: 'b.png', prompt: 'x' }, [dir])).identity, a.identity);
});

await test('every url-bearing object in a response is an output, however deep', () => {
  const { files } = outputFiles({ video: [{ url: 'https://x/color.mp4', file_name: 'color.mp4' }, { url: 'https://x/alpha.mp4' }], seed: 3, meta: { thumb: { url: 'https://x/t.jpg' } } });
  assert.deepEqual(files.map((f) => f.url), ['https://x/color.mp4', 'https://x/alpha.mp4', 'https://x/t.jpg']);
});

await test('a batch buys each distinct request once, uploads each file once, and lands every output', async () => {
  const dir = fresh();
  writeFileSync(join(dir, 'face.png'), 'png bytes');
  const fal = fakeFal({ billing: 'forbidden' });
  const lines: string[] = [];
  const job = (name: string, input: Record<string, unknown>): FalJobSpec => ({ model: 'owner/image-model', input, name, bases: [dir], outDir: join(dir, 'out', name) });
  const outcomes = await runFalJobs([
    job('one', { image_url: 'face.png', prompt: 'smile' }),
    job('two', { prompt: 'smile', image_url: 'face.png' }),
    job('three', { image_url: 'face.png', prompt: 'frown' }),
  ], { key: 'k', ledgerRoot: join(dir, 'ledger'), timeoutMs: 5_000, http: fal.http, ...quiet, log: (l) => lines.push(l) }, 3);

  assert.equal(fal.submits.length, 2, 'the duplicate is resumed, not bought');
  assert.deepEqual(fal.uploads, ['face.png'], 'one upload for three mentions');
  assert.equal(fal.submits[0].body.image_url, 'https://cdn.example/face.png', 'the queue sees a url, never a local path');
  assert.equal(outcomes.filter((o) => o.reused).length, 1);
  for (const name of ['one', 'two', 'three']) {
    assert.ok(existsSync(join(dir, 'out', name, 'out.png')), `${name} has its output`);
    assert.ok(existsSync(join(dir, 'out', name, 'out-2.png')), 'a second file of the same name is kept beside the first');
    assert.equal(JSON.parse(readFileSync(join(dir, 'out', name, 'fal-result.json'), 'utf8')).model, 'owner/image-model');
  }
  assert.ok(lines.some((l) => l.includes('fal lists $0.02 per images')), 'the listed rate is stated before anything is bought');
  assert.ok(lines.some((l) => /cost: unknown \(this key may not read fal billing records; fal lists \$0\.02 per images\)/.test(l)));
  assert.ok(lines.some((l) => /cost: nothing new/.test(l)));
  assert.ok(!lines.some((l) => /cost: \$/.test(l)), 'no figure is invented when fal gives none');
});

await test('a key that may read billing gets the charged figure per job, and the batch total', async () => {
  const dir = fresh();
  const fal = fakeFal({ billing: 0.045 });
  const lines: string[] = [];
  await runFalJobs([{ model: 'owner/image-model', input: { prompt: 'p' }, name: 'only', bases: [dir], outDir: join(dir, 'o') }],
    { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fal.http, ...quiet, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => l.includes('cost: $0.0450 (fal billing record, 1 units)')));
  assert.ok(lines.some((l) => l.includes('$0.0450 billed')));
});

await test('a failed job is reported by name and the others still finish', async () => {
  const dir = fresh();
  const fal = fakeFal();
  const failing: Http = async (url, init) => {
    if (init.method === 'POST' && url.includes('owner/broken')) return reply(422, { detail: 'bad input' });
    return fal.http(url, init);
  };
  const lines: string[] = [];
  const outcomes = await runFalJobs([
    { model: 'owner/broken', input: { prompt: 'p' }, name: 'bad', bases: [dir], outDir: join(dir, 'bad') },
    { model: 'owner/image-model', input: { prompt: 'p' }, name: 'good', bases: [dir], outDir: join(dir, 'good') },
  ], { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: failing, ...quiet, log: (l) => lines.push(l) });
  assert.match(outcomes[0].error ?? '', /422/);
  assert.equal(outcomes[1].error, undefined);
  assert.ok(lines.at(-1)?.includes('failed: bad'));
});

await test('a file over the single-request ceiling goes up in parts, in order, and is assembled', async () => {
  const dir = fresh();
  const path = join(dir, 'big.mp4');
  const bytes = Buffer.from(Array.from({ length: 25 }, (_, i) => i));
  writeFileSync(path, bytes);
  const fal = fakeFal();
  const url = await uploadFile(path, { key: 'k', http: fal.http, multipartAboveBytes: 10, partBytes: 10 });
  assert.equal(url, 'https://cdn.example/big.mp4');
  assert.deepEqual(fal.parts, [1, 2, 3]);
  assert.deepEqual(fal.bodies.map((b) => b.length), [10, 10, 5]);
  assert.deepEqual(Buffer.concat(fal.bodies), bytes, 'every byte is sent once, at its own offset');

  const small = join(dir, 'small.png');
  writeFileSync(small, 'small bytes');
  const single = fakeFal();
  await uploadFile(small, { key: 'k', http: single.http, multipartAboveBytes: 100 });
  assert.equal(Buffer.from(single.bodies[0]).toString(), 'small bytes');

  const failing = fakeFal({ failPart: 2 });
  await assert.rejects(() => uploadFile(path, { key: 'k', http: failing.http, multipartAboveBytes: 10, partBytes: 10 }), /part 2 of big\.mp4 failed 3 times \(status 503\)/);
});

await test('the schema reads input and output out of the queue document, references resolved', () => {
  const doc = {
    info: { 'x-fal-metadata': { category: 'text-to-image', documentationUrl: 'https://fal.ai/models/o/m/api' } },
    paths: {
      '/o/m': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/In' } } } } } },
      '/o/m/requests/{request_id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Out' } } } } } } },
    },
    components: { schemas: {
      In: { type: 'object', required: ['prompt'], 'x-fal-order-properties': ['prompt', 'size'], properties: { size: { enum: ['s', 'l'], default: 's' }, prompt: { type: 'string', description: 'What to draw.' } } },
      Out: { type: 'object', properties: { images: { type: 'array', items: { $ref: '#/components/schemas/File' } } } },
      File: { type: 'object', properties: { url: { type: 'string' } } },
    } },
  };
  const s = schemaOf(doc, 'o/m');
  const text = renderSchema('o/m', s, describeListing('o/m', { prices: new Map([['o/m', { unitPrice: 0.02, unit: 'images', currency: 'USD' }]]) }));
  assert.match(text, /price: fal lists \$0\.02 per images/);
  assert.match(text, /\*prompt  string  What to draw\.\n\s+size  s\|l, default "s"/, 'required first, in fal\'s own order');
  assert.match(text, /images  array<\{url\}>/);
});

await test('the command refuses an input it cannot read before anything is bought', async () => {
  const { falCommand } = await import('../src/commands/fal.ts');
  await assert.rejects(() => falCommand(['run', 'owner/m', '--input', '{not json']), /--input: not JSON/);
  await assert.rejects(() => falCommand(['run', 'not a model', '--input', '{}']), /not a fal endpoint id/);
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify([{ model: 'o/m', input: {} , name: 'a' }, { model: 'o/m', input: {}, name: 'a' }]));
  await assert.rejects(() => falCommand(['run', '--batch', join(dir, 'jobs.json')]), /two jobs are named "a"/);
});

const one = (dir: string): FalJobSpec[] => [{ model: 'owner/image-model', input: { prompt: 'p' }, name: 'only', bases: [dir], outDir: join(dir, 'o') }];

await test('a job fal accepted and then lost is still reported as bought, with its charge looked up', async () => {
  const dir = fresh();
  const fal = fakeFal({ billing: 0.05, download: 500 });
  const lines: string[] = [];
  const [outcome] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fal.http, ...quiet, log: (l) => lines.push(l) });
  assert.match(outcome.error ?? '', /download failed \(500\)/);
  assert.equal(outcome.requestId, 'req-1');
  assert.equal(outcome.costUsd, 0.05);
  assert.ok(lines.some((l) => /FAILED after fal accepted it as req-1, so it was bought: download failed/.test(l)));
  assert.ok(lines.some((l) => l.includes('cost: $0.0500 (fal billing record, 1 units)')), 'the charge is looked up for a failed job too');
  assert.match(lines.at(-1) ?? '', /0\/1 done; 1 bought this run \(1 failed after fal accepted it: only as req-1\), \$0\.0500 billed; failed: only/);

  const rerun: string[] = [];
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05 }).http, ...quiet, log: (l) => rerun.push(l) });
  assert.ok(rerun.some((l) => /cost: nothing new \(request req-1/.test(l)), 'the re-run resumes it, and does not count it twice');
});

await test('a job fal reports failed, or that outlives the deadline, counts as bought at unknown cost', async () => {
  for (const status of ['FAILED', 'IN_PROGRESS']) {
    const dir = fresh();
    const lines: string[] = [];
    await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: status === 'FAILED' ? 5_000 : 1, http: fakeFal({ status }).http, ...quiet, log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /cost: unknown \(this key may not read fal billing records; fal lists \$0\.02 per images\)/.test(l)), status);
    assert.match(lines.at(-1) ?? '', /1 bought this run \(1 failed after fal accepted it: only as req-1\), no billed figure, 1 at unknown cost/, status);
  }
});

await test('a price or billing lookup that fails says so rather than asserting fal has none', async () => {
  const dir = fresh();
  const lines: string[] = [];
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ pricing: 'error', billing: 'error' }).http, ...quiet, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /owner\/image-model: fal's listed price is unknown \(the pricing API answered 503/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /lists no unit price/.test(l)));
  assert.ok(lines.some((l) => /cost: unknown \(the billing API answered 502/.test(l)));
  assert.ok(!lines.some((l) => /has not recorded/.test(l)));
});

await test('fal schema shows a broken key setting instead of calling it a missing key', async () => {
  assert.match(await schemaListing('o/m', {}), /^not asked \(no fal key/);
  assert.match(await schemaListing('o/m', { OPEN_EDIT_FAL_KEY_FILE: join(fresh(), 'nope.txt') }), /^not asked: OPEN_EDIT_FAL_KEY_FILE points at .*does not exist/);
  assert.equal(await schemaListing('owner/image-model', { FAL_KEY: 'k' }, fakeFal().http), 'fal lists $0.02 per images');
});

await test('every purchase lands one record in the run\'s asset manifest, so its spend is counted', async () => {
  const dir = fresh();
  writeFileSync(join(dir, 'face.png'), 'png bytes');
  const ledger = join(dir, 'ledger');
  const job = (name: string, input: Record<string, unknown>): FalJobSpec => ({ model: 'owner/image-model', input, name, bases: [dir], outDir: join(ledger, 'assets', 'fal', name) });
  await runFalJobs([
    job('one', { image_url: 'face.png', prompt: 'smile' }),
    job('two', { prompt: 'smile', image_url: 'face.png' }),
    job('three', { image_url: 'face.png', prompt: 'frown' }),
  ], { key: 'k', ledgerRoot: ledger, timeoutMs: 5_000, http: fakeFal({ billing: 0.045 }).http, ...quiet }, 3);
  const assets = readManifest(ledger).assets;
  assert.equal(assets.length, 2, 'two purchases; the duplicate resumed one of them and is not counted again');
  const smile = assets.find((a) => a.prompt === 'smile')!;
  assert.equal(smile.provider, 'fal');
  assert.equal(smile.model, 'owner/image-model');
  assert.equal(smile.kind, 'image');
  assert.equal(smile.cost, 0.045);
  assert.match(String(smile.meta?.requestId), /^req-\d$/);
  assert.ok(existsSync(join(ledger, smile.path)), 'the path is relative to the run and names the file');
  assert.match(spendLine(ledger), /^2 generated assets \(2 image\) — 0\.09 USD$/);
});

await test('a purchase lost after acceptance is still recorded, with its charge', async () => {
  const dir = fresh();
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05, download: 500 }).http, ...quiet });
  const [lost] = readManifest(dir).assets;
  assert.equal(lost.cost, 0.05);
  assert.equal(lost.meta?.requestId, 'req-1');
  assert.match(String(lost.meta?.error), /download failed/);
  assert.equal(lost.kind, 'other');
  assert.match(spendLine(dir), /^1 generated assets \(1 other\) — 0\.05 USD$/);
});

await test('fal run keeps its outputs inside the run it records them in, and reads the {"jobs": [...]} batch form', async () => {
  const dir = fresh();
  const fal = fakeFal();
  const lines: string[] = [];
  const seams = { http: fal.http, key: 'k', sleep: async () => {}, log: (l: string) => lines.push(l) };
  assert.equal(await falCommand(['run', 'owner/image-model', '--input', '{"prompt":"p"}', '--run', dir], seams), 0);
  const [folder] = readdirSync(join(dir, 'assets', 'fal'));
  assert.match(folder, /^owner-image-model-[0-9a-f]{8}$/);
  assert.ok(existsSync(join(dir, 'assets', 'fal', folder, 'out.png')));
  assert.equal(readManifest(dir).assets[0].path, `assets/fal/${folder}/out.png`);

  writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs: [{ model: 'owner/image-model', input: { prompt: 'q' }, name: 'q' }] }));
  assert.equal(await falCommand(['run', '--batch', join(dir, 'jobs.json'), '--run', dir], seams), 0);
  assert.ok(existsSync(join(dir, 'assets', 'fal', 'q', 'out.png')));
  assert.equal(fal.submits.length, 2);
});

// Without --run the outputs, purchase records and ledger land in <workspace>/runs/fal, outside the piece's folder.
await test('SKILL.md runs fal inside the piece it is for', () => {
  const skill = readFileSync(join(import.meta.dirname, '../../.claude/skills/open-edit/SKILL.md'), 'utf8');
  const row = skill.split('\n').find((line) => line.includes('`fal run <model>'));
  assert.ok(row, 'SKILL.md no longer carries the fal run row');
  assert.match(row, /`fal run <model> [^`]*--run runs\/<key>`/);
});

await test('unnamed jobs of two batches in one run never share a folder or a manifest id', async () => {
  const dir = fresh();
  const seams = { http: fakeFal({ billing: 0.02 }).http, key: 'k', sleep: async () => {}, log: () => {} };
  for (const prompt of ['first', 'second']) {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify([{ model: 'owner/image-model', input: { prompt } }]));
    assert.equal(await falCommand(['run', '--batch', join(dir, 'jobs.json'), '--run', dir], seams), 0);
  }
  const folders = readdirSync(join(dir, 'assets', 'fal'));
  assert.equal(folders.length, 2, folders.join(', '));
  for (const f of folders) assert.match(f, /^job-01-[0-9a-f]{8}$/);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(rows.every((r) => !r.supersededBy), 'a later batch does not replace an earlier one\'s purchase');
});

await test('an output name from the response never writes outside the job\'s folder', async () => {
  for (const fileName of ['../../evil.png', '..', '/etc/passwd']) {
    const dir = fresh();
    const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ fileName }).http, ...quiet });
    assert.equal(o.error, undefined, fileName);
    for (const f of o.files ?? []) assert.ok(!relative(join(dir, 'o'), f).startsWith('..'), `${fileName} -> ${f}`);
  }
});

await test('a job fal reports failed is resumed, never re-bought, by a re-run, which is told how to buy it again', async () => {
  const dir = fresh();
  const fal = fakeFal({ status: 'FAILED' });
  for (let run = 0; run < 2; run++) {
    const lines: string[] = [];
    const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fal.http, ...quiet, log: (l) => lines.push(l) });
    assert.match(o.error ?? '', /req-1 failed after fal accepted it/);
    const record = join(dir, 'assets', 'jobs', jobKey('owner/image-model', { prompt: 'p' }));
    assert.ok(lines.some((l) => l.endsWith(`to buy it again, a second charge: remove ${record} and re-run`)), lines.join('\n'));
  }
  assert.equal(fal.submits.length, 1, 'the second run resumed the failed request instead of buying it again');

  rmSync(join(dir, 'assets', 'jobs', jobKey('owner/image-model', { prompt: 'p' })), { recursive: true });
  const again = fakeFal();
  const [bought] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: again.http, ...quiet });
  assert.equal(again.submits.length, 1, 'doing what the line says buys it a second time');
  assert.equal(bought.error, undefined);
  assert.equal(bought.reused, false);
});

await test('a path in the input that names no file is refused before anything is bought', async () => {
  const dir = fresh();
  for (const bad of ['./shots/fram.png', '../nope.mp4', join(dir, 'gone.png'), '~/definitely-not-here-7f3a.png', join(dir, 'Screen Recording 2026.mov')]) {
    await assert.rejects(() => describeInput({ image_url: bad }, [dir]), /looks like a local path, but there is no file at it/, bad);
  }
  const fine = await describeInput({
    prompt: '/imagine a cat', seed: '7', url: 'https://cdn.example/x.png', note: 'see ./notes\nlater',
    styled: '/imagine a cat.png', elsewhere: join(dir, 'no such folder', 'My Clip.mov'),
  }, [dir]);
  assert.deepEqual(fine.files, [], 'prose, urls, multi-line text, and spaced text no real folder holds are never taken for paths');
  const fal = fakeFal();
  const [o] = await runFalJobs([{ model: 'owner/image-model', input: { image_url: './fram.png' }, name: 'typo', bases: [dir], outDir: join(dir, 'o') }],
    { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fal.http, ...quiet });
  assert.match(o.error ?? '', /looks like a local path/);
  assert.equal(fal.submits.length, 0);
});

await test('only https outputs are fetched, and a response with no file object says where it is kept', async () => {
  const mixed = outputFiles({ a: { url: 'http://169.254.169.254/latest/meta-data' }, b: { url: 'https://x/ok.png' } });
  assert.deepEqual(mixed.files.map((f) => f.url), ['https://x/ok.png']);
  assert.deepEqual(mixed.skipped, ['http://169.254.169.254/latest/meta-data'], 'a url that is not fetched is still named');
  const dir = fresh();
  const lines: string[] = [];
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ noFiles: true }).http, ...quiet, log: (l) => lines.push(l) });
  assert.deepEqual(o.files, []);
  assert.ok(lines.some((l) => l.includes(`no {url} file object in the response; it is kept in ${join(dir, 'o', 'fal-result.json')}`)), lines.join('\n'));
  assert.ok(!lines.some((l) => /no files in the response/.test(l)));
});

// --- purchases nobody finished recording ------------------------------------------------------------

/** A pid that certainly belongs to no running process: a child that has already exited. */
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

/** The ledger entry a buyer leaves the moment fal accepts `one(dir)`'s request. */
function plantAccepted(runDir: string, requestId: string, pid: number): void {
  const key = jobKey('owner/image-model', { prompt: 'p' });
  const a: Attempt = {
    key, model: 'owner/image-model', n: 0, attempt: 'planted', state: 'accepted', pid, host: hostname(),
    claimedAt: new Date().toISOString(), leaseUntil: 0, requestId, submittedAt: new Date().toISOString(),
    statusUrl: `https://queue.fal.run/owner/image-model/requests/${requestId}/status`, responseUrl: `https://queue.fal.run/owner/image-model/requests/${requestId}`,
  };
  mkdirSync(join(ledgerDir(runDir), key), { recursive: true });
  writeFileSync(join(ledgerDir(runDir), key, 'attempt-0.json'), JSON.stringify(a));
}

await test('a purchase is on the books from the moment fal accepts it, before the job has run', async () => {
  const dir = fresh();
  const fal = fakeFal({ billing: 0.05 });
  let seen: AssetRecord[] | undefined;
  const watching: Http = async (url, init) => {
    if (url.endsWith('/status')) seen ??= readManifest(dir).assets;
    return fal.http(url, init);
  };
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: watching, ...quiet });
  assert.equal(seen?.length, 1, 'a run killed while fal works still leaves the purchase in the manifest');
  assert.equal(seen[0].meta?.requestId, 'req-1');
  assert.equal(seen[0].cost, null);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1, 'the job filled in its own row rather than adding a second');
  assert.equal(rows[0].cost, 0.05);
  assert.equal(rows[0].kind, 'image');
});

await test('a purchase whose buyer was killed before it was recorded is costed and recorded by the run that resumes it', async () => {
  const dir = fresh();
  plantAccepted(dir, 'req-9', deadPid());
  const fal = fakeFal({ billing: 0.05 });
  const lines: string[] = [];
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fal.http, ...quiet, log: (l) => lines.push(l) });
  assert.equal(fal.submits.length, 0, 'resumed, not bought again');
  assert.equal(o.recordedLate, true);
  assert.ok(lines.some((l) => l.includes('cost: $0.0500 (fal billing record, 1 units); bought in an earlier run')), lines.join('\n'));
  assert.match(lines.at(-1) ?? '', /1\/1 done; 0 bought this run, no billed figure; 1 recorded from an earlier run \(only\), \$0\.0500 billed$/);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta?.requestId, 'req-9');
  assert.equal(rows[0].cost, 0.05);

  const again: string[] = [];
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fal.http, ...quiet, log: (l) => again.push(l) });
  assert.ok(again.some((l) => l.includes('cost: nothing new (request req-9 was bought earlier and is recorded)')), again.join('\n'));
  assert.doesNotMatch(again.at(-1) ?? '', /recorded from an earlier run/, 'once on the books, it is not counted again');
  assert.equal(readManifest(dir).assets.length, 1);
});

await test('a row a killed buyer left without a charge or files is filled in by the resume, not duplicated', async () => {
  const dir = fresh();
  plantAccepted(dir, 'req-9', deadPid());
  record(dir, { id: 'o', kind: 'other', path: 'o', provider: 'fal', model: 'owner/image-model', prompt: 'p', createdAt: '2026-09-01T00:00:00.000Z', cost: null, meta: { requestId: 'req-9', files: [] } });
  const lines: string[] = [];
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05 }).http, ...quiet, log: (l) => lines.push(l) });
  assert.equal(o.recordedLate, true);
  assert.match(lines.at(-1) ?? '', /1 recorded from an earlier run \(only\), \$0\.0500 billed$/);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 0.05);
  assert.equal(rows[0].createdAt, '2026-09-01T00:00:00.000Z', 'the purchase keeps the time it was made');
  assert.equal(rows[0].kind, 'image');
  assert.deepEqual(rows[0].meta?.files, ['o/out.png', 'o/out-2.png']);
});

await test('a send whose answer was lost is possibly bought, and the run that finds it on fal\'s history reports and records its charge', async () => {
  const dir = fresh();
  const lost = fakeFal({ submitStatus: 502 });
  const first: string[] = [];
  const [o1] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: lost.http, ...quiet, log: (l) => first.push(l) });
  assert.equal(o1.possiblyBought, true);
  assert.ok(first.some((l) => /FAILED, possibly bought: fal's queue answered the owner\/image-model request with 502.*fal may have accepted it/.test(l)), first.join('\n'));
  assert.match(first.at(-1) ?? '', /0\/1 done; 0 bought this run, no billed figure; 1 possibly bought \(sent, and fal's answer was lost: only; a re-run looks for it instead of buying it again\); failed: only$/);
  assert.deepEqual(readManifest(dir).assets, []);

  const found = fakeFal({ billing: 0.05, history: [{ request_id: 'lost-1', json_input: { prompt: 'p' } }] });
  const second: string[] = [];
  const [o2] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: found.http, ...quiet, log: (l) => second.push(l) });
  assert.equal(found.submits.length, 0, 'found, never bought again');
  assert.equal(o2.recovered, true);
  assert.ok(second.some((l) => l.includes('cost: $0.0500 (fal billing record, 1 units); bought by an earlier attempt whose acceptance never reached the ledger')), second.join('\n'));
  assert.match(second.at(-1) ?? '', /1\/1 done; 0 bought this run, no billed figure; 1 recorded from an earlier run \(only\), \$0\.0500 billed$/);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta?.requestId, 'lost-1');
  assert.equal(rows[0].cost, 0.05);
});

/** The ledger entry of a send whose answer was lost: fal's history lists it as `lost-1`. */
function plantUncertain(runDir: string): void {
  const key = jobKey('owner/image-model', { prompt: 'p' });
  const a: Attempt = {
    key, model: 'owner/image-model', n: 0, attempt: 'planted', state: 'uncertain', pid: deadPid(), host: hostname(),
    claimedAt: new Date().toISOString(), leaseUntil: 0, body: { prompt: 'p' }, submittingAt: new Date().toISOString(),
  };
  mkdirSync(join(ledgerDir(runDir), key), { recursive: true });
  writeFileSync(join(ledgerDir(runDir), key, 'attempt-0.json'), JSON.stringify(a));
}
const lostOnHistory = [{ request_id: 'lost-1', json_input: { prompt: 'p' } }];

await test('a recovered purchase is reported once, however many jobs in the batch resume it', async () => {
  const dir = fresh();
  plantUncertain(dir);
  const fal = fakeFal({ billing: 0.05, history: lostOnHistory });
  // The job that recovers the request polls first; held back, its duplicate reaches the accounting first.
  let first = true;
  const slowFirst: Http = async (url, init) => {
    if (url.endsWith('/status') && first) { first = false; await new Promise((r) => setTimeout(r, 100)); }
    return fal.http(url, init);
  };
  const jobs = ['a', 'b'].map((name): FalJobSpec => ({ model: 'owner/image-model', input: { prompt: 'p' }, name, bases: [dir], outDir: join(dir, name) }));
  const lines: string[] = [];
  const outcomes = await runFalJobs(jobs, { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: slowFirst, ...quiet, log: (l) => lines.push(l) }, 2);
  assert.equal(fal.submits.length, 0);
  assert.equal(outcomes.filter((o) => o.recovered).length, 1);
  assert.equal(lines.filter((l) => /cost: \$/.test(l)).length, 1, lines.join('\n'));
  assert.equal(outcomes.filter((o) => o.recordedLate).length, 1);
  assert.match(lines.at(-1) ?? '', /^\[fal\] 2\/2 done; 0 bought this run, no billed figure; 1 recorded from an earlier run \([ab]\), \$0\.0500 billed$/);
  assert.equal(readManifest(dir).assets.length, 1);
});

await test('a recovered purchase whose charge an earlier run already recorded is not reported again', async () => {
  const dir = fresh();
  plantUncertain(dir);
  // What a run leaves when it heard fal accept the request, reported its charge, and could not write the ledger.
  recordRequest(dir, 'lost-1', () => ({ id: 'o', kind: 'image', path: 'o/out.png', provider: 'fal', model: 'owner/image-model', createdAt: new Date().toISOString(), cost: 0.05, meta: { files: ['o/out.png'] } }));
  const lines: string[] = [];
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05, history: lostOnHistory }).http, ...quiet, log: (l) => lines.push(l) });
  assert.equal(o.recovered, true);
  assert.ok(lines.some((l) => l.includes('cost: nothing new (request lost-1 was bought earlier and is recorded)')), lines.join('\n'));
  assert.ok(!lines.some((l) => /cost: \$/.test(l)), 'one purchase, one cost line across both runs');
  assert.match(lines.at(-1) ?? '', /^\[fal\] 1\/1 done; 0 bought this run, no billed figure$/);
  assert.equal(readManifest(dir).assets.length, 1);
});

await test('a resume leaves the charge to a buyer still running in another process', async () => {
  const dir = fresh();
  const buyer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    plantAccepted(dir, 'req-9', buyer.pid!);
    const lines: string[] = [];
    const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05 }).http, ...quiet, log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes(`cost: nothing new (request req-9 is being bought by pid ${buyer.pid}, which records it)`)), lines.join('\n'));
    assert.equal(o.recordedLate, undefined);
    assert.deepEqual(readManifest(dir).assets, [], 'its buyer records it; a second row would count it twice');
  } finally {
    buyer.kill();
  }
});

await test('a job fal resumes after the deadline has its files filled into the row its buyer wrote, charged once', async () => {
  const dir = fresh();
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 1, http: fakeFal({ billing: 0.05, status: 'IN_PROGRESS' }).http, ...quiet });
  assert.match(String(readManifest(dir).assets[0].meta?.error), /did not finish within the deadline/);
  const lines: string[] = [];
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05 }).http, ...quiet, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => l.includes('cost: nothing new (request req-1 was bought earlier and is recorded)')), lines.join('\n'));
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'image');
  assert.equal(rows[0].path, 'o/out.png');
  assert.equal(rows[0].meta?.error, undefined);
  assert.match(spendLine(dir), /^1 generated assets \(1 image\) — 0\.05 USD$/);
});

await test('a job fal resumes after the deadline with no file in its response clears the error its buyer recorded', async () => {
  const dir = fresh();
  await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 1, http: fakeFal({ billing: 0.05, status: 'IN_PROGRESS' }).http, ...quiet });
  assert.match(String(readManifest(dir).assets[0].meta?.error), /did not finish within the deadline/);
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.05, noFiles: true }).http, ...quiet });
  assert.equal(o.error, undefined);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta?.error, undefined, 'the job came back, so the deadline error no longer describes it');
  assert.equal(rows[0].cost, 0.05);
});

await test('a purchase the manifest could not take is reported as not recorded, not as failed, and a re-run records it', async () => {
  const dir = fresh();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  // A file where the records directory goes fails every manifest write, and the job ledger beside it not at all.
  writeFileSync(join(dir, 'assets', 'records'), 'in the way');
  const argv = ['run', 'owner/image-model', '--input', '{"prompt":"p"}', '--run', dir];
  const lines: string[] = [];
  assert.equal(await falCommand(argv, { http: fakeFal({ billing: 0.05 }).http, key: 'k', sleep: async () => {}, log: (l) => lines.push(l) }), 1,
    'a purchase missing from the manifest is not a clean exit');
  assert.match(lines.at(-1) ?? '', /^\[fal\] 1\/1 done; 1 bought this run, \$0\.0500 billed; 1 bought but not recorded in \S+records \(owner-image-model; a re-run records it\)$/);
  assert.ok(!lines.some((l) => /failed after fal accepted it/.test(l)), 'the job itself finished');
  rmSync(join(dir, 'assets', 'records'));

  const again: string[] = [];
  assert.equal(await falCommand(argv, { http: fakeFal({ billing: 0.05 }).http, key: 'k', sleep: async () => {}, log: (l) => again.push(l) }), 0);
  assert.match(again.at(-1) ?? '', /1 recorded from an earlier run \(owner-image-model\), \$0\.0500 billed$/);
  const rows = readManifest(dir).assets;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 0.05);
  assert.equal((rows[0].meta?.files as string[]).length, 2);
});

// chmod does not stop a write on Windows, and root ignores it.
await test('a request fal accepted whose ledger write then failed is still bought, costed and recorded', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const dir = fresh();
  const keyDir = join(ledgerDir(dir), jobKey('owner/image-model', { prompt: 'p' }));
  const fal = fakeFal({ billing: 0.05 });
  const locking: Http = async (url, init) => {
    if (init.method === 'POST' && url.startsWith('https://queue.fal.run/')) chmodSync(keyDir, 0o555);
    return fal.http(url, init);
  };
  const lines: string[] = [];
  try {
    await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: locking, ...quiet, log: (l) => lines.push(l) });
  } finally {
    chmodSync(keyDir, 0o755);
  }
  assert.ok(lines.some((l) => l.startsWith('[only] FAILED after fal accepted it as req-1, so it was bought: fal accepted the owner/image-model request as req-1, so it is bought, but recording that failed')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('cost: $0.0500 (fal billing record, 1 units)')));
  assert.match(lines.at(-1) ?? '', /^\[fal\] 0\/1 done; 1 bought this run \(1 failed after fal accepted it: only as req-1\), \$0\.0500 billed; failed: only$/);
  assert.ok(!lines.some((l) => /possibly bought|answer was lost/.test(l)), 'a purchase whose id was heard is bought, never possibly bought');
  assert.equal(readManifest(dir).assets.length, 1);
});

await test('a refusal the ledger could not record is not bought, and is not called sent', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const dir = fresh();
  const keyDir = join(ledgerDir(dir), jobKey('owner/image-model', { prompt: 'p' }));
  const fal = fakeFal({ submitStatus: 422 });
  const locking: Http = async (url, init) => {
    if (init.method === 'POST' && url.startsWith('https://queue.fal.run/')) chmodSync(keyDir, 0o555);
    return fal.http(url, init);
  };
  const lines: string[] = [];
  let o;
  try {
    [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: locking, ...quiet, log: (l) => lines.push(l) });
  } finally {
    chmodSync(keyDir, 0o755);
  }
  assert.equal(o.refusalUnrecorded, true);
  assert.equal(o.possiblyBought, undefined);
  assert.ok(lines.some((l) => /^\[only\] FAILED: fal rejected the owner\/image-model request \(422\).*Nothing was bought, but recording that it never got in failed/.test(l)), lines.join('\n'));
  assert.match(lines.at(-1) ?? '', /^\[fal\] 0\/1 done; 0 bought this run, no billed figure; 1 not bought but held as possibly bought \(refused or never sent, and recording that failed: only; a re-run looks for it instead of buying it\); failed: only$/);
  assert.ok(!lines.some((l) => /answer was lost/.test(l)));
});

await test('a paid job whose outputs are all plain http is not reported done, and says which urls it left', async () => {
  const dir = fresh();
  const lines: string[] = [];
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ plainHttp: true }).http, ...quiet, log: (l) => lines.push(l) });
  assert.match(o.error ?? '', /1 output url\(s\) not fetched because they are not https \(http:\/\/files\.example\/req-1\/out\.png\?…\); the response is kept in \S+fal-result\.json/);
  assert.doesNotMatch(o.error ?? '', /secret/, 'a signed query string never reaches a message');
  assert.ok(!lines.some((l) => /no \{url\} file object/.test(l)), 'the response had one; it was not fetched');
  assert.ok(lines.some((l) => l.startsWith('[only] FAILED after fal accepted it as req-1, so it was bought')), lines.join('\n'));

  const long = fresh();
  const [l] = await runFalJobs(one(long), { key: 'k', ledgerRoot: long, timeoutMs: 5_000, http: fakeFal({ plainHttp: 'long' }).http, ...quiet });
  assert.match(l.error ?? '', /\(http:\/\/files\.example\/x+… \(5025 characters\)\)/);
  assert.ok((l.error ?? '').length < 400, 'a url an endpoint returns cannot make the message as long as it likes');
});

await test('an output that comes inline as a data url is saved as a file, and its payload is never printed', async () => {
  const dir = fresh();
  const lines: string[] = [];
  const [o] = await runFalJobs(one(dir), { key: 'k', ledgerRoot: dir, timeoutMs: 5_000, http: fakeFal({ billing: 0.02, inline: true }).http, ...quiet, log: (l) => lines.push(l) });
  assert.equal(o.error, undefined, 'a finished paid job is not failed over where its file came from');
  assert.deepEqual(o.files, [join(dir, 'o', 'output-1.png')]);
  assert.equal(readFileSync(join(dir, 'o', 'output-1.png'), 'utf8'), INLINE_BYTES);
  assert.ok(!lines.some((line) => line.includes('base64,') || line.length > 400), lines.join('\n'));
  const [row] = readManifest(dir).assets;
  assert.equal(row.kind, 'image');
  assert.equal(row.path, 'o/output-1.png');
  assert.equal(row.meta?.error, undefined);
});
