// Tests background removal's two modes against fake transports (no network): the live VEED route
// (default) and the fal-BYOK --fast route. Both share the upload primitive, tested separately in
// tests/asset-upload.test.ts — this file proves the orchestration and routing around it.
// Run:  node --import tsx tests/background-removal.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VeedHttp } from '../src/veed/api.ts';
import type { Http as FalHttp } from '../src/providers/fal.ts';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
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
  removeBackground, probeDurationSec, FAL_BG_REMOVAL_FAST_PRICE_NOTE,
  FAL_BG_REMOVAL_FAST_MODEL,
} from '../src/commands/background-removal.ts';

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
      if (path.startsWith('/v1/remove-background/status')) {
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
      if (path === '/v1/remove-background') return { workflowId: 'wf1' } as T;
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
    'GET /workspace',
    'GET /usage-events/report',
    'GET /workspace/ws1/space/default',
    'POST /project',
    'POST /asset',
    'PUT https://gcs/upload-session',
    'GET /asset/asset1',
    'POST /v1/remove-background',
    'GET /v1/remove-background/status?workflowId=wf1&projectId=proj1',
  ]);
  assert.ok(logs.some((l) => l.includes('no VEED credits were charged')));
});

await test('several workspaces and no --workspace flag refuses to guess', async () => {
  const veed = makeVeedFake();
  const http: VeedHttp = {
    ...veed.http,
    async getJson<T>(path: string): Promise<T> {
      if (path === '/workspace') return [{ id: 'ws1', name: 'Solo' }, { id: 'ws2', name: 'Team' }] as T;
      return veed.http.getJson(path);
    },
  };
  await assert.rejects(
    removeBackground({ http, readVideoBytes, sleep: async () => {} }, { videoPath: 'v.mp4', outPath: '/dev/null' }),
    /this account has several workspaces/,
  );
});

for (const status of ['FAILED', 'CANCELED', 'UNKNOWN']) {
  await test(`default: a terminal ${status} status throws rather than downloading anything`, async () => {
    const veed = makeVeedFake({ statuses: [status] });
    await assert.rejects(
      removeBackground(
        { http: veed.http, readVideoBytes, sleep: async () => {} },
        { videoPath: 'v.mp4', outPath: '/dev/null' },
      ),
      new RegExp(`ended as ${status}`),
    );
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

