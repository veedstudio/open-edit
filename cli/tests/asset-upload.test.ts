// Tests the shared local-file upload primitive against a fake VeedHttp (no network). Proves the
// createUploadableAsset -> putBytes -> poll(getAsset) sequence, that scoped vs unscoped owner keys reach
// the request correctly, and the two failure modes (FAILED state, poll exhaustion).
// Run:  node --import tsx tests/asset-upload.test.ts
import assert from 'node:assert/strict';
import type { VeedHttp } from '../src/veed/api.ts';
import { test } from 'node:test';
import { uploadLocalAsset } from '../src/veed/asset-upload.ts';

const args = {
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'video/mp4',
  extension: 'mp4',
  assetType: 'VIDEO',
  group: 'srcVideo',
};

function makeFake(uploadStates: Array<'wait' | 'uploaded' | 'failed'>) {
  const calls: string[] = [];
  let assetGets = 0;
  let postedBody: Record<string, unknown> | null = null;
  const http: VeedHttp = {
    async getJson<T>(): Promise<T> {
      throw new Error('unexpected getJson');
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      calls.push(`GET ${path}`);
      const state = uploadStates[Math.min(assetGets, uploadStates.length - 1)];
      assetGets++;
      if (state === 'wait') return null;
      if (state === 'failed') return { id: 'asset1', uploadState: 'FAILED' } as T;
      return { id: 'asset1', uploadState: 'UPLOADED', cdnUrl: 'https://cdn.veed/x.mp4' } as T;
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path}`);
      postedBody = body as Record<string, unknown>;
      return { asset: { id: 'asset1' }, url: 'https://gcs/upload-session' } as T;
    },
    async putBytes(absoluteUrl: string): Promise<void> {
      calls.push(`PUT ${absoluteUrl}`);
    },
  };
  return { http, calls, body: () => postedBody };
}

await test('uploads bytes, polls until UPLOADED, and returns the assetId + cdnUrl', async () => {
  const fake = makeFake(['wait', 'wait', 'uploaded']);
  const sleeps: number[] = [];
  const out = await uploadLocalAsset({ http: fake.http, sleep: async (ms) => { sleeps.push(ms); } }, args);
  assert.deepEqual(out, { assetId: 'asset1', cdnUrl: 'https://cdn.veed/x.mp4' });
  assert.deepEqual(fake.calls, [
    'POST /asset',
    'PUT https://gcs/upload-session',
    'GET /asset/asset1',
    'GET /asset/asset1',
    'GET /asset/asset1',
  ]);
  assert.deepEqual(sleeps, [1000, 1000]);
});

await test('a FAILED upload state throws, naming the asset id', async () => {
  const fake = makeFake(['failed']);
  await assert.rejects(
    uploadLocalAsset({ http: fake.http, sleep: async () => {} }, args),
    /VEED: asset asset1 upload failed \(state=FAILED\)/,
  );
});

await test('poll exhaustion throws a clear timeout naming the asset id', async () => {
  const fake = makeFake(['wait']);
  await assert.rejects(
    uploadLocalAsset({ http: fake.http, sleep: async () => {} }, args),
    /VEED: asset asset1 upload did not finish after 60 polls/,
  );
});

await test('scoped upload (workspaceId + projectId) reaches the request; unscoped omits both', async () => {
  const scoped = makeFake(['uploaded']);
  await uploadLocalAsset({ http: scoped.http, sleep: async () => {} }, { ...args, workspaceId: 'ws1', projectId: 'proj1' });
  assert.equal(scoped.body()?.workspaceId, 'ws1');
  assert.equal(scoped.body()?.projectId, 'proj1');

  const unscoped = makeFake(['uploaded']);
  await uploadLocalAsset({ http: unscoped.http, sleep: async () => {} }, args);
  assert.equal('workspaceId' in (unscoped.body() ?? {}), false);
  assert.equal('projectId' in (unscoped.body() ?? {}), false);
});

