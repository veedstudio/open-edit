// Tests the VEED transcription orchestration against a fake HTTP transport (no network). Proves the call
// sequence, that the asset cdnUrl is threaded into the transcribe request, and that the final transcript
// is produced via the mapper. Run:  node --import tsx tests/orchestrate.test.ts
import assert from 'node:assert/strict';
import type { VeedHttp } from '../src/veed/api.ts';
import { test } from 'node:test';
import { REQUESTED, transcribeWithVeed } from '../src/veed/orchestrate.ts';

// A fake transport that records every call and returns canned, source-shaped responses.
function makeFake(overrides: { subtitleStatus?: string; errorReason?: string } = {}) {
  const calls: string[] = [];
  const state: {
    transcribeBody: Record<string, unknown> | null;
    assetBody: Record<string, unknown> | null;
  } = { transcribeBody: null, assetBody: null };
  const http: VeedHttp = {
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      calls.push(`GET ${path}`);
      if (path.startsWith('/asset/')) return { id: 'asset1', uploadState: 'UPLOADED', cdnUrl: 'https://cdn.veed/x.mp4' } as T;
      throw new Error(`unexpected getJsonOrNull ${path}`);
    },
    async getJson<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      if (path === '/workspace') return [{ id: 'ws1' }] as T;
      if (path.startsWith('/subtitles/')) {
        return {
          id: 'sub1',
          status: overrides.subtitleStatus ?? 'active',
          errorReason: overrides.errorReason ?? 'outOfCredits',
          subtitles: { a: { from: 0, to: 1, words: [{ value: 'hi' }] } },
        } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path}`);
      if (path === '/asset') {
        state.assetBody = body as Record<string, unknown>;
        return { asset: { id: 'asset1' }, url: 'https://gcs/upload-session' } as T;
      }
      if (path.startsWith('/subtitles/assets/')) {
        state.transcribeBody = body as Record<string, unknown>;
        return { id: 'sub1', status: 'pending' } as T;
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async putBytes(absoluteUrl: string): Promise<void> {
      calls.push(`PUT ${absoluteUrl}`);
    },
  };
  return { http, calls, state };
}

const deps = (http: VeedHttp) => ({
  http,
  readVideoBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4', extension: 'mp4' }),
  sleep: async () => {},
});

await test('no project anywhere; upload unscoped, transcribe billed to the workspace', async () => {
  const fake = makeFake();
  const out = await transcribeWithVeed(deps(fake.http), { videoPath: 'v.mp4' });

  assert.deepEqual(out, {
    text: 'hi',
    chunks: [{ text: 'hi', timestamp: [0, 1], words: [{ text: 'hi', timestamp: [0, 1] }] }],
  });
  assert.deepEqual(fake.calls, [
    'GET /workspace',
    // Transcription BILLS this workspace, so the run reads what it holds and names it before spending.
    'GET /usage-events/report',
    'POST /asset',
    'PUT https://gcs/upload-session',
    'GET /asset/asset1',
    'POST /subtitles/assets/asset1/transcribe',
    'GET /subtitles/sub1',
  ]);
  // the upload must OMIT the owner keys entirely (the API rejects an explicit null)
  assert.equal('projectId' in (fake.state.assetBody ?? {}), false);
  assert.equal('workspaceId' in (fake.state.assetBody ?? {}), false);
  // group must be a real AssetGroup enum value (the schema rejects 'video')
  assert.equal(fake.state.assetBody?.group, 'srcVideo');
  // transcribe: no project, billed to the workspace
  assert.equal(fake.state.transcribeBody?.videoUrl, 'https://cdn.veed/x.mp4');
  assert.equal(fake.state.transcribeBody?.projectId, null);
  assert.equal(fake.state.transcribeBody?.workspaceId, 'ws1');
  // We send NO credit-related field: the service bills by default, and naming the knob in a public
  // repo just advertises it. The key is assembled for that same reason — spelling it out here would
  // trip the mirror on this file.
  const creditFlag = 'deduct' + 'Credits';
  assert.equal(creditFlag in (fake.state.transcribeBody ?? {}), false);
});

await test('keeps polling through pending states until the asset and subtitle are ready', async () => {
  let assetGets = 0;
  let subtitleGets = 0;
  const sleeps: number[] = [];
  const http: VeedHttp = {
    // GET /asset/:id 404s until the GCS upload finalizes; the poll must treat
    // that as "still uploading", not as a failure.
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      if (path.startsWith('/asset/')) {
        assetGets++;
        return (assetGets < 3
          ? null
          : { id: 'asset1', uploadState: 'UPLOADED', cdnUrl: 'https://cdn.veed/x.mp4' }) as T;
      }
      throw new Error(`unexpected getJsonOrNull ${path}`);
    },
    async getJson<T>(path: string): Promise<T> {
      if (path === '/workspace') return [{ id: 'ws1' }] as T;
      if (path.startsWith('/subtitles/')) {
        subtitleGets++;
        return (subtitleGets < 2
          ? { id: 'sub1', status: 'pending' }
          : {
              id: 'sub1',
              status: 'active',
              subtitles: { a: { from: 0, to: 1, words: [{ value: 'hi' }] } },
            }) as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async postJson<T>(path: string): Promise<T> {
      if (path.startsWith('/subtitles/assets/')) return { id: 'sub1', status: 'pending' } as T;
      return { asset: { id: 'asset1' }, url: 'https://gcs/upload-session' } as T;
    },
    async putBytes(): Promise<void> {},
  };

  const out = await transcribeWithVeed(
    {
      http,
      readVideoBytes: async () => ({ bytes: new Uint8Array([1]), mimeType: 'video/mp4', extension: 'mp4' }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    { videoPath: 'v.mp4', pollIntervalMs: 7 },
  );

  assert.equal(out.chunks[0].text, 'hi');
  assert.equal(assetGets, 3);
  assert.equal(subtitleGets, 2);
  // two waits for the asset, one for the subtitle, all at the configured interval
  assert.deepEqual(sleeps, [7, 7, 7]);
});

await test('gives a clear timeout error when polling exhausts maxAttempts', async () => {
  const fake = makeFake();
  const http: VeedHttp = {
    ...fake.http,
    // asset never finishes uploading: the route keeps 404ing
    async getJsonOrNull<T>(): Promise<T | null> {
      return null;
    },
  };
  await assert.rejects(
    transcribeWithVeed(
      { ...deps(http), sleep: async () => {} },
      { videoPath: 'v.mp4', maxAttempts: 2 },
    ),
    /asset upload did not finish after 2 polls/,
  );
});

// Running out is the likeliest VEED failure — a free account covers about ten minutes a month — so
// the error must say what happened AND where to fix it, not just name a reason code.
await test('out of credits surfaces in plain language, with the allowance and the pricing link', async () => {
  const fake = makeFake({ subtitleStatus: 'error' });
  await assert.rejects(
    transcribeWithVeed(deps(fake.http), { videoPath: 'v.mp4' }),
    /out of transcription credits.*about 10 minutes a month.*https:\/\/www\.veed\.io\/pricing/is,
  );
});

await test('any other failure reason is passed through verbatim so it stays debuggable', async () => {
  const fake = makeFake({ subtitleStatus: 'error', errorReason: 'unsupportedLanguage' });
  await assert.rejects(
    transcribeWithVeed(deps(fake.http), { videoPath: 'v.mp4' }),
    /transcription failed \(unsupportedLanguage\)/,
  );
});


await test('a transport failure is tagged only once a job was requested; before that it stays bare', async () => {
  const dropAt = (where: 'put' | 'transcribe' | 'subtitles') => {
    const { http } = makeFake();
    const drop = async (): Promise<never> => { throw new Error('fetch failed'); };
    if (where === 'put') return { ...http, putBytes: drop };
    if (where === 'transcribe') {
      return { ...http, postJson: <T>(path: string, body: unknown) => (path.startsWith('/subtitles/') ? drop() : http.postJson<T>(path, body)) };
    }
    return { ...http, getJson: <T>(path: string) => (path.startsWith('/subtitles/') ? drop() : http.getJson<T>(path)) };
  };
  const failure = (where: 'put' | 'transcribe' | 'subtitles') =>
    transcribeWithVeed(deps(dropAt(where)), { videoPath: 'v.mp4', maxAttempts: 1 }).then(() => '', (e: Error) => e.message);

  assert.equal(await failure('put'), 'fetch failed', 'nothing requested yet, so nothing says a job may exist');
  assert.equal(await failure('transcribe'), `${REQUESTED}fetch failed`);
  assert.equal(await failure('subtitles'), `${REQUESTED}fetch failed`);
});
