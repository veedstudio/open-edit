// Tests background removal's modes against fake transports (no network): the live VEED route
// (default), its refusal to spend when that route is down, --fal and --fast on the user's fal key. Uploads are in
// tests/asset-upload.test.ts — this file proves the orchestration and routing around it.
// Run:  node --import tsx tests/background-removal.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { VeedHttp } from '../src/veed/api.ts';
import type { Http as FalHttp } from '../src/providers/fal.ts';
import { jobKey, ledgerDir, type Attempt } from '../src/providers/queue-ledger.ts';
import { test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Moved from the repository's cli-entry suite with the entry point itself.
test('--no-refine is a recognized flag, not rejected as unknown', async () => {
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const { code, err } = await new Promise<{ code: number; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, 'background-removal', '--fast', '--no-refine', '/nope/video.mp4'],
      { encoding: 'utf8' },
      (error, _out, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, err: stderr }));
  });
  assert.equal(code, 1);
  assert.match(err, /video not found/);
  assert.ok(!/Unknown option/.test(err), 'the flag must parse, not be rejected');
});
import {
  removeBackground, probeDurationSec, freeRouteProblem, FreeRouteRefused, FAL_BG_REMOVAL_FAST_PRICE_NOTE,
  FAL_BG_REMOVAL_FAST_MODEL, FAL_BG_REMOVAL_MODEL, usage,
} from '../src/commands/background-removal.ts';
import { rememberedWorkspace } from '../src/veed/workspace-store.ts';

const readVideoBytes = async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4', extension: 'mp4' });

function tmpRunDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- fake VEED transport, default (live route) mode -------------------------------------------------

function makeVeedFake(opts: { statuses?: string[]; resultUrl?: string } = {}) {
  const calls: string[] = [];
  const statuses = opts.statuses ?? ['COMPLETED'];
  const resultUrl = opts.resultUrl ?? 'https://fal-cdn.example/live-result.mp4';
  let assetGets = 0;
  let statusGets = 0;
  const http: VeedHttp = {
    async getJson<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      if (path === '/workspace') return [{ id: 'ws1', name: 'Solo' }] as T;
      if (path === '/usage-events/report') return {} as T;
      if (path === '/workspace/ws1/space/default') return { id: 'space1' } as T;
      if (path.startsWith('/remove-background/status')) {
        // The health check names a placeholder project; it is not one of the job's own polls.
        if (path.includes('projectId=00000000-')) return { statuses: [] } as T;
        const status = statuses[Math.min(statusGets, statuses.length - 1)];
        statusGets++;
        if (status === 'PENDING_EMPTY') return { statuses: [] } as T;
        return { statuses: [{ workflowId: 'wf1', projectId: 'proj1', status, result: status === 'COMPLETED' ? { url: resultUrl } : undefined }] } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      calls.push(`GET ${path}`);
      if (path.startsWith('/asset/')) {
        assetGets++;
        return { id: 'asset1', uploadState: 'UPLOADED', cdnUrl: 'https://cdn.veed/x.mp4' } as T;
      }
      throw new Error(`unexpected getJsonOrNull ${path}`);
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path}`);
      if (path === '/project') return { id: 'proj1' } as T;
      if (path === '/asset') return { asset: { id: 'asset1' }, url: 'https://gcs/upload-session' } as T;
      if (path === '/remove-background') return { workflowId: 'wf1' } as T;
      throw new Error(`unexpected POST ${path} ${JSON.stringify(body)}`);
    },
    async putBytes(absoluteUrl: string): Promise<void> {
      calls.push(`PUT ${absoluteUrl}`);
    },
  };
  return { http, calls };
}

// --- fake fal transport, shared by --fast (submit/poll/download) and the default route's own
// final download (the live route's result URL is fal's own too) ------------------------------------

function makeFalFake(opts: { status?: string; resultUrl?: string } = {}) {
  const calls: string[] = [];
  const status = opts.status ?? 'COMPLETED';
  const resultUrl = opts.resultUrl ?? 'https://fal-cdn.example/fast-result.mp4';
  const http: FalHttp = async (url, init) => {
    calls.push(`${init.method} ${url} ${init.body ?? ''}`);
    if (url === 'https://queue.fal.run/veed/video-background-removal/fast') {
      return {
        status: 200,
        json: async () => ({
          request_id: 'req1',
          status_url: 'https://queue.fal.run/veed/video-background-removal/fast/requests/req1/status',
          response_url: 'https://queue.fal.run/veed/video-background-removal/fast/requests/req1',
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (url.endsWith('/status')) {
      return { status: 200, json: async () => ({ status }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url === 'https://queue.fal.run/veed/video-background-removal/fast/requests/req1') {
      return { status: 200, json: async () => ({ video: [{ url: resultUrl }] }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url === resultUrl) {
      return { status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer };
    }
    throw new Error(`unexpected fal call ${init.method} ${url}`);
  };
  return { http, calls };
}

const failIfCalled: VeedHttp = {
  async getJson() { throw new Error('http must not be called'); },
  async getJsonOrNull() { throw new Error('http must not be called'); },
  async postJson() { throw new Error('http must not be called'); },
  async putBytes() { throw new Error('http must not be called'); },
};

await test('--fast: uploads unscoped, submits to fal, downloads the result, and discloses cost up front', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake();
  const runDir = tmpRunDir('bg-fast-');
  const outPath = join(runDir, 'out.mp4');
  const logs: string[] = [];

  await removeBackground(
    { http: veed.http, readVideoBytes, sleep: async () => {}, log: (m) => logs.push(m), falHttp: fal.http, runDir },
    { videoPath: 'v.mp4', outPath, fast: true, falKey: 'test-key' },
  );

  assert.ok(existsSync(outPath));
  assert.deepEqual([...readFileSync(outPath)], [9, 9, 9]);
  // no workspace/project resolution at all — the fal call is unscoped
  assert.deepEqual(veed.calls, ['POST /asset', 'PUT https://gcs/upload-session', 'GET /asset/asset1']);
  assert.ok(logs.some((l) => l.includes(FAL_BG_REMOVAL_FAST_PRICE_NOTE)), 'the fal price must be disclosed before the call runs');
  assert.ok(logs.some((l) => l.includes('YOUR OWN fal account')), 'must state plainly this is not VEED billing');
});

await test('--mask-only --fast is rejected before any call is made', async () => {
  await assert.rejects(
    removeBackground(
      { http: failIfCalled, readVideoBytes, sleep: async () => {} },
      { videoPath: 'v.mp4', outPath: '/dev/null', fast: true, maskOnly: true },
    ),
    /--mask-only has no equivalent on the fast fal model/,
  );
});

await test('--fast --workspace <id> is rejected before any call is made', async () => {
  await assert.rejects(
    removeBackground(
      { http: failIfCalled, readVideoBytes, sleep: async () => {} },
      { videoPath: 'v.mp4', outPath: '/dev/null', fast: true, workspaceId: 'ws1' },
    ),
    /--workspace has no effect on the fast fal model/,
  );
});

await test('--fast --no-refine reaches fal as refine_foreground_edges:false and discloses the cheaper rate', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake();
  const runDir = tmpRunDir('bg-norefine-');
  const outPath = join(runDir, 'out.mp4');
  const logs: string[] = [];

  await removeBackground(
    { http: veed.http, readVideoBytes, sleep: async () => {}, log: (m) => logs.push(m), falHttp: fal.http, runDir },
    { videoPath: 'v.mp4', outPath, fast: true, falKey: 'test-key', refineForegroundEdges: false },
  );

  const submitCall = fal.calls.find((c) => c.startsWith('POST') && c.includes(FAL_BG_REMOVAL_FAST_MODEL));
  assert.ok(submitCall?.includes('"refine_foreground_edges":false'), 'the fal request body must carry the flag');
  assert.ok(logs.some((l) => l.includes('refine=false')), 'the disclosure must name the run\'s actual refine setting');
  assert.ok(logs.some((l) => l.includes('$0.008')), 'the cheaper refine-off rate must be named');
});

await test('default: resolves the sole workspace, scopes the upload to a new project, and hits the live free route', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake({ resultUrl: 'https://fal-cdn.example/live-result.mp4' });
  const outPath = join(tmpRunDir('bg-live-'), 'out.mp4');
  const logs: string[] = [];

  await removeBackground(
    { http: veed.http, readVideoBytes, sleep: async () => {}, log: (m) => logs.push(m), falHttp: fal.http },
    { videoPath: 'v.mp4', outPath },
  );

  assert.ok(existsSync(outPath));
  assert.deepEqual(veed.calls, [
    'GET /remove-background/status?projectId=00000000-0000-0000-0000-000000000000',
    'GET /workspace',
    'GET /workspace/ws1/space/default',
    'POST /project',
    'POST /asset',
    'PUT https://gcs/upload-session',
    'GET /asset/asset1',
    'POST /remove-background',
    'GET /remove-background/status?workflowId=wf1&projectId=proj1',
  ]);
  assert.ok(logs.some((l) => l.includes('no VEED credits were charged')));
  assert.ok(logs.some((l) => /workspace Solo \(ws1\): the only workspace on this account\. .*bills nothing/.test(l)));
});

await test('no route carries its own /v1: the API base already ends in it, and the doubled path is a 404', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake({ resultUrl: 'https://fal-cdn.example/live-result.mp4' });
  await removeBackground(
    { http: veed.http, readVideoBytes, sleep: async () => {}, falHttp: fal.http },
    { videoPath: 'v.mp4', outPath: join(tmpRunDir('bg-v1-'), 'out.mp4') },
  );
  assert.deepEqual(veed.calls.filter((c) => / \/v1\//.test(c)), []);
});

await test('several workspaces and none named: the remembered one is used, else the first, and the pick is stated', async () => {
  const veed = makeVeedFake();
  const http: VeedHttp = {
    ...veed.http,
    async getJson<T>(path: string): Promise<T> {
      if (path === '/workspace') return [{ id: 'ws1', name: 'Solo' }, { id: 'ws2', name: 'Team' }] as T;
      if (path === '/workspace/ws2/space/default') return { id: 'space2' } as T;
      return veed.http.getJson(path);
    },
  };
  const fal = makeFalFake({ resultUrl: 'https://fal-cdn.example/live-result.mp4' });
  const logs: string[] = [];
  await removeBackground(
    { http, readVideoBytes, sleep: async () => {}, falHttp: fal.http, log: (m) => logs.push(m), rememberedWorkspace: () => 'ws2' },
    { videoPath: 'v.mp4', outPath: join(tmpRunDir('bg-ws-'), 'out.mp4') },
  );
  assert.ok(logs.some((l) => l.startsWith('workspace Team (ws2): the workspace remembered from an earlier choice')));

  const firstLogs: string[] = [];
  await removeBackground(
    { http, readVideoBytes, sleep: async () => {}, falHttp: fal.http, log: (m) => firstLogs.push(m) },
    { videoPath: 'v.mp4', outPath: join(tmpRunDir('bg-ws-'), 'out.mp4') },
  );
  assert.ok(firstLogs.some((l) => l.startsWith('workspace Solo (ws1): the first of 2 workspaces this account lists.')));

  const goneLogs: string[] = [];
  await removeBackground(
    { http, readVideoBytes, sleep: async () => {}, falHttp: fal.http, log: (m) => goneLogs.push(m), rememberedWorkspace: () => 'ws-gone' },
    { videoPath: 'v.mp4', outPath: join(tmpRunDir('bg-ws-'), 'out.mp4') },
  );
  assert.ok(goneLogs.some((l) => l.startsWith("workspace Solo (ws1): the first of 2 workspaces this account lists (the remembered workspace ws-gone is not on this account's list)")));
});

for (const status of ['FAILED', 'CANCELED', 'UNKNOWN']) {
  await test(`default: a terminal ${status} status throws rather than downloading anything, and never turns to fal`, async () => {
    const veed = makeVeedFake({ statuses: [status] });
    const falCalls: string[] = [];
    await assert.rejects(
      removeBackground(
        { http: veed.http, readVideoBytes, sleep: async () => {}, falHttp: async (url) => { falCalls.push(url); throw new Error('no fal here'); } },
        { videoPath: 'v.mp4', outPath: '/dev/null' },
      ),
      new RegExp(`ended as ${status}`),
    );
    assert.deepEqual(falCalls, []);
  });
}

await test('default: an empty statuses[] is treated as still-pending, not an error', async () => {
  const veed = makeVeedFake({ statuses: ['PENDING_EMPTY', 'PENDING_EMPTY', 'COMPLETED'] });
  const fal = makeFalFake({ resultUrl: 'https://fal-cdn.example/live-result.mp4' });
  const outPath = join(tmpRunDir('bg-pending-'), 'out.mp4');
  const sleeps: number[] = [];

  await removeBackground(
    { http: veed.http, readVideoBytes, sleep: async (ms) => { sleeps.push(ms); }, falHttp: fal.http },
    { videoPath: 'v.mp4', outPath },
  );

  assert.ok(existsSync(outPath));
  assert.ok(sleeps.length >= 2, 'must have waited through the empty responses');
});

await test('ffprobe failing (missing binary, unreadable file) is swallowed as "no duration", not thrown', () => {
  assert.equal(probeDurationSec('/no/such/video.mp4'), undefined);
});

await test('a missing duration (undefined from the probe) does not block the call', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake();
  const runDir = tmpRunDir('bg-noprobe-');
  const outPath = join(runDir, 'out.mp4');

  await removeBackground(
    {
      http: veed.http, readVideoBytes, sleep: async () => {}, falHttp: fal.http, runDir,
      probeDuration: () => undefined,
    },
    { videoPath: 'v.mp4', outPath, fast: true, falKey: 'test-key' },
  );
  assert.ok(existsSync(outPath));
});


// --- the free route unavailable: the health check, the refusal, and --fal ---------------------------

/** fal's full model, plus the pricing and billing reads --fal makes; every call lands in `events`. */
function makeFullFalFake(events: string[], opts: { videos?: { url: string; file_name?: string }[]; download?: number; listed?: number; pricing?: 'error'; submitStatus?: number; history?: unknown[] } = {}) {
  const videos = opts.videos ?? [{ url: 'https://fal-cdn.example/output.webm', file_name: 'output.webm' }];
  let submits = 0;
  const http: FalHttp = async (url, init) => {
    events.push(`fal ${init.method} ${url.split('?')[0]}${init.method === 'POST' ? ` ${init.body}` : ''}`);
    const ok = (body: unknown, bytes = new Uint8Array()) => ({ status: 200, json: async () => body, arrayBuffer: async () => bytes.buffer as ArrayBuffer });
    if (url.startsWith('https://api.fal.ai/v1/models/pricing') && opts.pricing === 'error') return { ...ok({ detail: 'down' }), status: 503 };
    if (url.startsWith('https://api.fal.ai/v1/models/pricing')) return ok({ prices: [{ endpoint_id: FAL_BG_REMOVAL_MODEL, unit_price: opts.listed ?? 0.015, unit: '30 frames', currency: 'USD' }] });
    if (url.startsWith('https://api.fal.ai/v1/models/billing-events')) return { ...ok({}), status: 403 };
    if (url.startsWith('https://api.fal.ai/v1/models/requests/by-endpoint')) return ok({ items: (opts.history ?? []).map((json_input) => ({ request_id: 'full1', json_input })), next_cursor: null });
    if (url === `https://queue.fal.run/${FAL_BG_REMOVAL_MODEL}` && init.method === 'POST') {
      submits++;
      if (opts.submitStatus) return { ...ok({ detail: 'bad gateway' }), status: opts.submitStatus };
      return ok({ request_id: 'full1', status_url: 'https://queue.fal.run/veed/video-background-removal/requests/full1/status', response_url: 'https://queue.fal.run/veed/video-background-removal/requests/full1' });
    }
    if (url.endsWith('/status')) return ok({ status: 'COMPLETED' });
    if (url === 'https://queue.fal.run/veed/video-background-removal/requests/full1') return ok({ video: videos });
    if (videos.some((v) => v.url === url)) return { ...ok({}, new TextEncoder().encode(url)), status: opts.download ?? 200 };
    throw new Error(`unexpected fal call ${init.method} ${url}`);
  };
  return { http, submits: () => submits };
}

function anonymousVeed(events: string[], opts: { failAt?: 'health' | 'start'; startError?: string } = {}): VeedHttp {
  const failAt = opts.failAt ?? 'health';
  const refuse = (path: string) => new Error(`GET ${path} -> 403 {"errors":[{"message":"Anonymous users not allowed","cause":"UNAUTHORIZED"}]}`);
  const inner = makeVeedFake().http;
  return {
    async getJson<T>(path: string): Promise<T> {
      events.push(`veed GET ${path}`);
      if (failAt === 'health' && path.startsWith('/remove-background/status')) throw refuse(path);
      return inner.getJson<T>(path);
    },
    async getJsonOrNull<T>(path: string) { events.push(`veed GET ${path}`); return inner.getJsonOrNull<T>(path); },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      events.push(`veed POST ${path}`);
      if (failAt === 'start' && path === '/remove-background') throw new Error(opts.startError ?? `POST ${path} -> 403 {"errors":[{"message":"Anonymous users not allowed"}]}`);
      return inner.postJson<T>(path, body);
    },
    async putBytes(u: string, b: Uint8Array, t: string) { events.push(`veed PUT ${u}`); return inner.putBytes(u, b, t); },
  };
}

const fallbackDeps = (events: string[], logs: string[], fal: ReturnType<typeof makeFullFalFake>, runDir: string) => ({
  readVideoBytes, sleep: async () => {}, runDir, falHttp: fal.http, probeFrames: () => 60,
  log: (m: string) => { logs.push(m); events.push(`log ${m}`); },
  uploadToFal: async (path: string) => { events.push(`fal upload ${path}`); return 'https://fal-storage.example/v.mp4'; },
});

await test('the route classifier tells a refused login and a missing route from an ordinary refusal', () => {
  assert.match(freeRouteProblem(new Error('GET /x -> 403 {"errors":[{"message":"Anonymous users not allowed"}]}')) ?? '', /does not accept this CLI login/);
  assert.match(freeRouteProblem(new Error('POST /v1/remove-background -> 404 fault filter abort')) ?? '', /not reachable/);
  assert.match(freeRouteProblem(new Error('GET /x -> 503 upstream')) ?? '', /not answering/);
  assert.equal(freeRouteProblem(new Error('GET /x -> 404 {"message":"project not found"}')), undefined, 'the placeholder project missing means the login got through');
  assert.equal(freeRouteProblem(new Error('GET /x -> 403 {"message":"no access to this project"}')), undefined);
});

await test('a free route that refuses the login stops having bought nothing, and hands back the --fal command with its cost', async () => {
  const events: string[] = [];
  const fal = makeFullFalFake(events);
  const runDir = tmpRunDir('bg-refuse-');
  const outPath = join(runDir, 'my out.mp4');
  await assert.rejects(
    removeBackground({ http: anonymousVeed(events), ...fallbackDeps(events, [], fal, runDir) },
      { videoPath: '/clips/v.mp4', outPath, maskOnly: true, refineForegroundEdges: false, falKey: 'test-key' }),
    (e: Error) => {
      assert.ok(e instanceof FreeRouteRefused);
      assert.match(e.message, /^VEED: the free route does not accept this CLI login yet .*Nothing was bought\./);
      assert.match(e.message, /YOUR OWN fal account .*FAL_KEY\. Cost: about \$0\.0300 \(an estimate: 60 frames at \$0\.015 per 30 frames, edge refinement off/);
      const command = `npx @veedstudio/openedit-cli background-removal /clips/v.mp4 --fal --mask-only --no-refine --out '${outPath}'`;
      assert.ok(e.message.endsWith(`\n  ${command}`), `the exact command, flags carried over and the path quoted:\n${e.message}`);
      return true;
    },
  );
  assert.deepEqual(events.filter((e) => e.startsWith('fal ')), [], 'no fal call of any kind, not even a price lookup');
  assert.deepEqual(events.filter((e) => e.startsWith('veed')), ['veed GET /remove-background/status?projectId=00000000-0000-0000-0000-000000000000'],
    'nothing is created or uploaded on VEED once the route is known to be unusable');
  assert.equal(fal.submits(), 0);
});

await test('the same refusal follows when the check passes but the start is refused, or there is no login at all', async () => {
  const late: string[] = [];
  const fal = makeFullFalFake(late);
  await assert.rejects(
    removeBackground({ http: anonymousVeed(late, { failAt: 'start' }), ...fallbackDeps(late, [], fal, tmpRunDir('bg-late-')) },
      { videoPath: 'v.mp4', outPath: '/tmp/o.mp4' }),
    // The command carries the output as an absolute path, so on Windows it arrives drive-qualified and quoted.
    (e: Error) => e instanceof FreeRouteRefused && /does not accept this CLI login[\s\S]*--fal --out '?\S*o\.mp4'?$/.test(e.message)
      && !/may have started anyway/.test(e.message),
  );

  const none: string[] = [];
  await assert.rejects(
    removeBackground({ ...fallbackDeps(none, [], fal, tmpRunDir('bg-nologin-')) }, { videoPath: 'v.mp4', outPath: '/tmp/o.mp4' }),
    (e: Error) => e instanceof FreeRouteRefused && /there is no VEED login on this machine\. Nothing was bought\./.test(e.message),
  );
  assert.deepEqual([...late, ...none].filter((e) => e.startsWith('fal ')), []);
  assert.equal(fal.submits(), 0);
});

await test('the refusal needs no fal key: it names FAL_KEY instead of failing on its absence', async () => {
  const saved = { FAL_KEY: process.env.FAL_KEY, FAL_API_KEY: process.env.FAL_API_KEY, OPEN_EDIT_FAL_KEY_FILE: process.env.OPEN_EDIT_FAL_KEY_FILE };
  delete process.env.FAL_KEY; delete process.env.FAL_API_KEY; delete process.env.OPEN_EDIT_FAL_KEY_FILE;
  try {
    const events: string[] = [];
    await assert.rejects(
      removeBackground({ http: anonymousVeed(events), ...fallbackDeps(events, [], makeFullFalFake(events), tmpRunDir('bg-nokey-')) },
        { videoPath: 'v.mp4', outPath: '/tmp/o.mp4' }),
      (e: Error) => e instanceof FreeRouteRefused && /needing FAL_KEY/.test(e.message),
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

await test('--fal buys fal\'s full model, stating the cost before the purchase, and a re-run resumes instead of re-buying', async () => {
  const events: string[] = [];
  const logs: string[] = [];
  const fal = makeFullFalFake(events);
  const runDir = tmpRunDir('bg-fal-');
  const out = await removeBackground(
    { ...fallbackDeps(events, logs, fal, runDir) },
    { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' },
  );

  assert.equal(out, join(runDir, 'out.webm'), 'the file takes the extension of what fal returned (VP9 with alpha)');
  assert.ok(existsSync(out));
  const costAt = events.findIndex((e) => e.includes('Cost: about $0.0450 (an estimate: 60 frames at $0.0225 per 30 frames, edge refinement on'));
  const submitAt = events.findIndex((e) => e.startsWith(`fal POST https://queue.fal.run/${FAL_BG_REMOVAL_MODEL}`));
  assert.ok(costAt >= 0 && submitAt > costAt, 'the cost is stated before the purchase');
  assert.ok(logs.some((l) => l.includes('YOUR OWN fal account, not any VEED workspace')));
  assert.match(events[submitAt], /"video_url":"https:\/\/fal-storage\.example\/v\.mp4"/);
  assert.match(events[submitAt], /"output_codec":"vp9"/);
  assert.ok(logs.some((l) => l.includes('charged: unknown (this key may not read fal billing records)')), 'no figure is claimed that fal did not give');
  assert.ok(!logs.some((l) => l.includes('pricing API now lists')), 'the listed rate agrees with the constant, so no staleness note');

  const again: string[] = [];
  await removeBackground(
    { ...fallbackDeps(again, [], fal, runDir) },
    { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' },
  );
  assert.equal(fal.submits(), 1);
  assert.ok(!again.some((e) => e.startsWith('fal upload')));
  assert.ok(!again.some((e) => /billing-events|charged:/.test(e)), 'the run that bought it reported the charge; a resume does not report it again');
});

await test('--fal reports the charge of a request an earlier attempt sent and never saw accepted', async () => {
  const runDir = tmpRunDir('bg-fal-recovered-');
  const opts = { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' };
  const lost = makeFullFalFake([], { submitStatus: 502 });
  await assert.rejects(removeBackground({ ...fallbackDeps([], [], lost, runDir) }, opts),
    (e: Error) => /with 502.*fal may have accepted it.*a re-run looks for it on fal's request history/s.test(e.message));

  const events: string[] = [];
  const logs: string[] = [];
  const found = makeFullFalFake(events, { history: [{ video_url: 'https://fal-storage.example/v.mp4', output_codec: 'vp9', refine_foreground_edges: true }] });
  await removeBackground({ ...fallbackDeps(events, logs, found, runDir) }, opts);
  assert.equal(found.submits(), 0, 'found on the history, not bought again');
  assert.ok(logs.some((l) => l.includes("found on fal's request history as full1")), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('charged: unknown (this key may not read fal billing records); the estimate above stands as an estimate (request full1)')),
    'no earlier run could report this charge, so this one does');
});

await test('--fal reports, once, the charge of a purchase whose buyer was killed before it could', async () => {
  const runDir = tmpRunDir('bg-fal-killed-');
  const identity = { video_url: `file:sha256:${createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex')}`, output_codec: 'vp9', refine_foreground_edges: true };
  const key = jobKey(FAL_BG_REMOVAL_MODEL, identity);
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const now = new Date().toISOString();
  const accepted: Attempt = {
    key, model: FAL_BG_REMOVAL_MODEL, n: 0, attempt: 'killed', state: 'accepted', pid: dead, host: hostname(), claimedAt: now, leaseUntil: 0,
    requestId: 'full1', statusUrl: 'https://queue.fal.run/veed/video-background-removal/requests/full1/status',
    responseUrl: 'https://queue.fal.run/veed/video-background-removal/requests/full1', submittedAt: now,
  };
  mkdirSync(join(ledgerDir(runDir), key), { recursive: true });
  writeFileSync(join(ledgerDir(runDir), key, 'attempt-0.json'), JSON.stringify(accepted));
  const opts = { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' };
  for (const reports of [true, false]) {
    const logs: string[] = [];
    const fal = makeFullFalFake([]);
    await removeBackground({ ...fallbackDeps([], logs, fal, runDir) }, opts);
    assert.equal(fal.submits(), 0, 'resumed, not bought again');
    const line = '[fal] charged: unknown (this key may not read fal billing records); the estimate above stands as an estimate (request full1); bought by an earlier run that never reported it';
    assert.equal(logs.includes(line), reports, logs.join('\n'));
    if (!reports) assert.ok(!logs.some((l) => l.includes('charged:')), 'reported by the first resume, so not by the next');
  }
});

await test('--fal reports a charge whose claimant died before printing it, and leaves one a live run is printing', async () => {
  const runDir = tmpRunDir('bg-fal-unprinted-');
  const identity = { video_url: `file:sha256:${createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex')}`, output_codec: 'vp9', refine_foreground_edges: true };
  const key = jobKey(FAL_BG_REMOVAL_MODEL, identity);
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const now = new Date().toISOString();
  const accepted: Attempt = {
    key, model: FAL_BG_REMOVAL_MODEL, n: 0, attempt: 'killed', state: 'accepted', pid: dead, host: hostname(), claimedAt: now, leaseUntil: 0,
    requestId: 'full1', statusUrl: 'https://queue.fal.run/veed/video-background-removal/requests/full1/status',
    responseUrl: 'https://queue.fal.run/veed/video-background-removal/requests/full1', submittedAt: now,
  };
  mkdirSync(join(ledgerDir(runDir), key), { recursive: true });
  writeFileSync(join(ledgerDir(runDir), key, 'attempt-0.json'), JSON.stringify(accepted));
  const marker = join(ledgerDir(runDir), key, 'charged-full1.json');
  const opts = { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' };
  const line = '[fal] charged: unknown (this key may not read fal billing records); the estimate above stands as an estimate (request full1); bought by an earlier run that never reported it';
  // A claimant still running prints the line itself; one killed during the billing lookup never will.
  for (const [claimant, reports] of [[process.pid, false], [dead, true], [undefined, false]] as const) {
    if (claimant !== undefined) writeFileSync(marker, JSON.stringify({ at: now, pid: claimant, host: hostname(), reported: false }));
    const logs: string[] = [];
    const fal = makeFullFalFake([]);
    await removeBackground({ ...fallbackDeps([], logs, fal, runDir) }, opts);
    assert.equal(fal.submits(), 0, 'resumed, not bought again');
    assert.equal(logs.includes(line), reports, logs.join('\n'));
    if (!reports) assert.ok(!logs.some((l) => l.includes('charged:')), logs.join('\n'));
  }
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).reported, true, 'once printed, no later run takes it for unreported');
});

await test('--fal reports the charge of a job fal accepted even when its output cannot be fetched', async () => {
  const events: string[] = [];
  const logs: string[] = [];
  const fal = makeFullFalFake(events, { download: 500 });
  const runDir = tmpRunDir('bg-fal-lost-');
  await assert.rejects(
    removeBackground({ ...fallbackDeps(events, logs, fal, runDir) }, { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' }),
    /download failed \(500\)/,
  );
  assert.equal(fal.submits(), 1);
  assert.ok(logs.some((l) => l.includes('charged: unknown (this key may not read fal billing records); the estimate above stands as an estimate (request full1)')), logs.join('\n'));
});

await test('--no-fallback is an unknown flag', async () => {
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const { code, err } = await new Promise<{ code: number; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, 'background-removal', '--no-fallback', '/nope/video.mp4'], { encoding: 'utf8' },
      (error, _out, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, err: stderr }));
  });
  assert.notEqual(code, 0);
  assert.match(err, /Unknown option '--no-fallback'/);
});

await test('--fal --mask-only asks for the two-file output and keeps only the alpha', async () => {
  const events: string[] = [];
  const fal = makeFullFalFake(events, { videos: [
    { url: 'https://fal-cdn.example/a_color.mp4', file_name: 'color.mp4' },
    { url: 'https://fal-cdn.example/b_alpha.mp4', file_name: 'alpha.mp4' },
  ] });
  const runDir = tmpRunDir('bg-mask-');
  const out = await removeBackground({ ...fallbackDeps(events, [], fal, runDir) },
    { videoPath: 'v.mp4', outPath: join(runDir, 'mask.mp4'), fal: true, maskOnly: true, falKey: 'test-key' });
  assert.equal(readFileSync(out, 'utf8'), 'https://fal-cdn.example/b_alpha.mp4');
  assert.ok(events.some((e) => e.includes('"output_codec":"h264"')));
});

await test('--fal and --workspace, or --fal and --fast, are refused before any call', async () => {
  await assert.rejects(removeBackground({ http: failIfCalled, readVideoBytes }, { videoPath: 'v.mp4', outPath: '/dev/null', fal: true, workspaceId: 'ws1' }), /--workspace has no effect/);
  await assert.rejects(removeBackground({ http: failIfCalled, readVideoBytes }, { videoPath: 'v.mp4', outPath: '/dev/null', fal: true, fast: true }), /two different fal models/);
});

await test('the --fal help names --fast as a spend too', () => {
  assert.match(usage.flags.fal.help, /without --fal or --fast nothing is bought/);
  assert.match(usage.summary, /--fal or --fast buys/);
});

await test('a start that failed server-side says the free workflow may have started anyway, and where', async () => {
  const events: string[] = [];
  const fal = makeFullFalFake(events);
  await assert.rejects(
    removeBackground({ http: anonymousVeed(events, { failAt: 'start', startError: 'POST /remove-background -> 503 upstream' }), ...fallbackDeps(events, [], fal, tmpRunDir('bg-503-')) },
      { videoPath: 'v.mp4', outPath: '/tmp/o.mp4' }),
    (e: Error) => e instanceof FreeRouteRefused && /not answering .*; the free workflow may have started anyway, in project \S+\. Nothing was bought\./.test(e.message),
  );
  assert.equal(fal.submits(), 0);
});

await test('a listed rate that parts from the constant is flagged, and a file with no frame count gets no estimate', async () => {
  const events: string[] = [];
  const logs: string[] = [];
  const runDir = tmpRunDir('bg-stale-');
  await removeBackground({ ...fallbackDeps(events, logs, makeFullFalFake(events, { listed: 0.02 }), runDir) },
    { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' });
  assert.ok(logs.some((l) => l.includes("note: fal's pricing API now lists $0.02 per 30 frames, which differs from the rate above; the estimate may be stale")));

  const none: string[] = [];
  await assert.rejects(
    removeBackground({ http: anonymousVeed(none), ...fallbackDeps(none, [], makeFullFalFake(none), tmpRunDir('bg-noframes-')), probeFrames: () => undefined },
      { videoPath: 'v.mp4', outPath: '/tmp/o.mp4' }),
    (e: Error) => e instanceof FreeRouteRefused && /Cost: the frame count could not be read, so there is no estimate\./.test(e.message),
  );
});

await test('a --fast job fal reports failed names the ledger record that has to go before it is bought again', async () => {
  const runDir = tmpRunDir('bg-fast-failed-');
  await assert.rejects(
    removeBackground({ http: makeVeedFake().http, readVideoBytes, sleep: async () => {}, falHttp: makeFalFake({ status: 'FAILED' }).http, runDir },
      { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fast: true, falKey: 'test-key' }),
    (e: Error) => e.message.includes(`, ${join(runDir, 'assets', 'jobs')}`) && !e.message.includes('<key>'),
  );
});

await test('a remembered workspace choice that cannot be used is named, not silently passed over', () => {
  const dir = tmpRunDir('bg-ws-');
  const path = join(dir, 'workspace.json');
  writeFileSync(path, '{not json');
  const said: string[] = [];
  assert.equal(rememberedWorkspace(path, (m) => said.push(m)), undefined);
  assert.match(said.join('\n'), /the remembered workspace choice at \S+workspace\.json holds no workspace id it can use; it is not used/);

  const none: string[] = [];
  assert.equal(rememberedWorkspace(join(dir, 'absent.json'), (m) => none.push(m)), undefined);
  assert.deepEqual(none, [], 'no file is no choice, which is nothing to report');
  writeFileSync(path, JSON.stringify({ workspaceId: 'ws-9' }));
  assert.equal(rememberedWorkspace(path, () => { throw new Error('a usable choice is not reported'); }), 'ws-9');
});

await test('--fal says when its rate could not be checked against the list fal publishes', async () => {
  const events: string[] = [];
  const logs: string[] = [];
  const runDir = tmpRunDir('bg-rate-unread-');
  await removeBackground({ ...fallbackDeps(events, logs, makeFullFalFake(events, { pricing: 'error' }), runDir) },
    { videoPath: 'v.mp4', outPath: join(runDir, 'out.mp4'), fal: true, falKey: 'test-key' });
  assert.ok(logs.some((l) => l.startsWith("[fal] note: the rate above could not be checked against fal's list (the pricing API answered 503")), logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes('pricing API now lists')));
});
