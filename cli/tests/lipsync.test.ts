// Tests lipsync (fal-BYOK only — no live VEED route exists for this model) against fake transports.
// Run:  node --import tsx tests/lipsync.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VeedHttp } from '../src/veed/api.ts';
import type { Http as FalHttp } from '../src/providers/fal.ts';
import { test } from 'node:test';
import { runLipsync, FAL_LIPSYNC_V2_MODEL } from '../src/commands/lipsync.ts';
import { assertConverted, hdr10Data, hdrClip, lumaOf } from './helpers/hdr.ts';
import { probeStream, scratchDir } from './helpers/synth.ts';

const readVideoBytes = async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4', extension: 'mp4' });
const readAudioBytes = async () => ({ bytes: new Uint8Array([4, 5, 6]), mimeType: 'audio/mpeg', extension: 'mp3' });

function tmpRunDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeVeedFake(opts: { failUpload?: 'video' | 'audio'; hostTag?: string } = {}) {
  const calls: string[] = [];
  let assetSeq = 0;
  const http: VeedHttp = {
    async getJson<T>(): Promise<T> {
      throw new Error('unexpected getJson');
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      calls.push(`GET ${path}`);
      if (path === '/asset/asset1') {
        return (opts.failUpload === 'video' ? { id: 'asset1', uploadState: 'FAILED' } : { id: 'asset1', uploadState: 'UPLOADED', cdnUrl: `https://cdn.veed/video${opts.hostTag ?? ''}.mp4` }) as T;
      }
      if (path === '/asset/asset2') {
        return (opts.failUpload === 'audio' ? { id: 'asset2', uploadState: 'FAILED' } : { id: 'asset2', uploadState: 'UPLOADED', cdnUrl: `https://cdn.veed/audio${opts.hostTag ?? ''}.mp3` }) as T;
      }
      throw new Error(`unexpected getJsonOrNull ${path}`);
    },
    async postJson<T>(path: string): Promise<T> {
      calls.push(`POST ${path}`);
      assetSeq++;
      return { asset: { id: `asset${assetSeq}` }, url: `https://gcs/upload-session-${assetSeq}` } as T;
    },
    async putBytes(absoluteUrl: string): Promise<void> {
      calls.push(`PUT ${absoluteUrl}`);
    },
  };
  return { http, calls };
}

function makeFalFake(opts: { status?: string; resultUrl?: string } = {}) {
  const calls: string[] = [];
  const status = opts.status ?? 'COMPLETED';
  const resultUrl = opts.resultUrl ?? 'https://fal-cdn.example/lipsync-result.mp4';
  const http: FalHttp = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url === 'https://queue.fal.run/veed/lipsync/v2') {
      return {
        status: 200,
        json: async () => ({
          request_id: 'req1',
          status_url: 'https://queue.fal.run/veed/lipsync/v2/requests/req1/status',
          response_url: 'https://queue.fal.run/veed/lipsync/v2/requests/req1',
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (url.endsWith('/status')) {
      return { status: 200, json: async () => ({ status }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url === 'https://queue.fal.run/veed/lipsync/v2/requests/req1') {
      return { status: 200, json: async () => ({ video: { url: resultUrl } }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url === resultUrl) {
      return { status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array([7, 7, 7]).buffer };
    }
    throw new Error(`unexpected fal call ${init.method} ${url}`);
  };
  return { http, calls };
}

await test('happy path: uploads video + audio unscoped, submits to fal, downloads the result', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake();
  const runDir = tmpRunDir('lipsync-');
  const outPath = join(runDir, 'out.mp4');
  const logs: string[] = [];

  await runLipsync(
    { http: veed.http, readVideoBytes, readAudioBytes, sleep: async () => {}, log: (m) => logs.push(m), falHttp: fal.http, runDir },
    { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath, falKey: 'test-key' },
  );

  assert.ok(existsSync(outPath));
  assert.deepEqual([...readFileSync(outPath)], [7, 7, 7]);
  // Concurrent uploads (Promise.all): both POSTs fire before either PUT, both PUTs before either GET —
  // see "video and audio uploads are started concurrently" below for the test that pins this directly.
  assert.deepEqual(veed.calls, [
    'POST /asset', 'POST /asset',
    'PUT https://gcs/upload-session-1', 'PUT https://gcs/upload-session-2',
    'GET /asset/asset1', 'GET /asset/asset2',
  ]);
  const submitCall = fal.calls.find((c) => c.startsWith('POST'));
  assert.ok(submitCall?.includes(FAL_LIPSYNC_V2_MODEL));
});

await test('the cost disclosure names the per-second rate and states it bills the user, before the fal call runs', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake();
  const runDir = tmpRunDir('lipsync-');
  const logs: string[] = [];

  await runLipsync(
    {
      http: veed.http, readVideoBytes, readAudioBytes, sleep: async () => {}, log: (m) => logs.push(m), falHttp: fal.http, runDir,
    },
    { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath: join(runDir, 'out.mp4'), falKey: 'test-key' },
  );

  assert.ok(logs[0].includes('$0.07 per second of output video'));
  assert.ok(logs[0].includes('YOUR OWN fal account'));
});

await test('video and audio uploads are started concurrently, not one after the other', async () => {
  const order: string[] = [];
  let postSeq = 0;
  const http: VeedHttp = {
    async getJson<T>(): Promise<T> { throw new Error('unexpected getJson'); },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      order.push(`GET ${path}`);
      if (path === '/asset/asset1') return { id: 'asset1', uploadState: 'UPLOADED', cdnUrl: 'https://cdn.veed/video.mp4' } as T;
      if (path === '/asset/asset2') return { id: 'asset2', uploadState: 'UPLOADED', cdnUrl: 'https://cdn.veed/audio.mp3' } as T;
      throw new Error(`unexpected getJsonOrNull ${path}`);
    },
    async postJson<T>(): Promise<T> {
      postSeq++;
      order.push(`POST asset${postSeq}`);
      return { asset: { id: `asset${postSeq}` }, url: `https://gcs/upload-session-${postSeq}` } as T;
    },
    async putBytes(absoluteUrl: string): Promise<void> { order.push(`PUT ${absoluteUrl}`); },
  };
  const fal = makeFalFake();
  const runDir = tmpRunDir('lipsync-concurrency-');

  await runLipsync(
    { http, readVideoBytes, readAudioBytes, sleep: async () => {}, falHttp: fal.http, runDir },
    { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath: join(runDir, 'out.mp4'), falKey: 'test-key' },
  );

  const firstGetIndex = order.findIndex((c) => c.startsWith('GET'));
  const postIndexes = order.map((c, i) => (c.startsWith('POST') ? i : -1)).filter((i) => i >= 0);
  assert.equal(postIndexes.length, 2, 'both uploads must have posted');
  assert.ok(
    postIndexes[1] < firstGetIndex,
    `the second upload's POST must fire before the first upload's poll begins — sequential uploads would ` +
    `finish upload #1's whole chain (including its GET) before upload #2 ever posts. order: ${order.join(', ')}`,
  );
});

await test('a video upload failure propagates and no fal call is made', async () => {
  const veed = makeVeedFake({ failUpload: 'video' });
  const fal = makeFalFake();
  const runDir = tmpRunDir('lipsync-');

  await assert.rejects(
    runLipsync(
      { http: veed.http, readVideoBytes, readAudioBytes, sleep: async () => {}, falHttp: fal.http, runDir },
      { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath: join(runDir, 'out.mp4'), falKey: 'test-key' },
    ),
    /VEED: asset asset1 upload failed/,
  );
  assert.equal(fal.calls.length, 0);
});

await test('a fal job that ends FAILED propagates the error', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake({ status: 'FAILED' });
  const runDir = tmpRunDir('lipsync-');

  await assert.rejects(
    runLipsync(
      { http: veed.http, readVideoBytes, readAudioBytes, sleep: async () => {}, falHttp: fal.http, runDir },
      { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath: join(runDir, 'out.mp4'), falKey: 'test-key' },
    ),
    /fal job req1 failed/,
  );
});

await test('a fal job that never leaves the deadline propagates the timeout', async () => {
  const veed = makeVeedFake();
  const fal = makeFalFake({ status: 'IN_PROGRESS' });
  const runDir = tmpRunDir('lipsync-');

  await assert.rejects(
    runLipsync(
      {
        http: veed.http, readVideoBytes, readAudioBytes, sleep: async () => {}, falHttp: fal.http, runDir,
        falTimeoutMs: 5,
      },
      { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath: join(runDir, 'out.mp4'), falKey: 'test-key' },
    ),
    /did not finish within the deadline/,
  );
});

await test('a re-run of the same video and audio resumes the bought job: no second upload, no second submission', async () => {
  // Real hosting gives every upload a new url, so the job must be keyed by file content for a re-run to find it.
  const fal = makeFalFake();
  const runDir = tmpRunDir('lipsync-rerun-');
  const first = makeVeedFake({ hostTag: '-first' });
  const second = makeVeedFake({ hostTag: '-second' });
  const logs: string[] = [];
  for (const veed of [first, second]) {
    await runLipsync(
      { http: veed.http, readVideoBytes, readAudioBytes, sleep: async () => {}, falHttp: fal.http, runDir, log: (m) => logs.push(m) },
      { videoPath: 'v.mp4', audioPath: 'a.mp3', outPath: join(runDir, 'out.mp4'), falKey: 'test-key' },
    );
  }
  assert.equal(fal.calls.filter((c) => c === 'POST https://queue.fal.run/veed/lipsync/v2').length, 1, 'one submission, one charge');
  assert.deepEqual(second.calls, [], 'the second run hosts nothing');
  assert.ok(logs.some((l) => l.includes('already in the ledger as req1')));

  // Different audio is a different job.
  await runLipsync(
    { http: makeVeedFake().http, readVideoBytes, readAudioBytes: async () => ({ bytes: new Uint8Array([9]), mimeType: 'audio/mpeg', extension: 'mp3' }), sleep: async () => {}, falHttp: fal.http, runDir },
    { videoPath: 'v.mp4', audioPath: 'b.mp3', outPath: join(runDir, 'out2.mp4'), falKey: 'test-key' },
  );
  assert.equal(fal.calls.filter((c) => c === 'POST https://queue.fal.run/veed/lipsync/v2').length, 2);
});

await test('an HDR video is sent as its SDR copy, the picture a render over it gets, and the run says so', async () => {
  const dir = scratchDir('lipsync-hdr');
  const pq = hdrClip(dir, 'pq.mp4', { transfer: 'smpte2084', hdr10: true });
  const read: string[] = [];
  const logs: string[] = [];
  await runLipsync(
    {
      http: makeVeedFake().http, readVideoBytes: async (path: string) => { read.push(path); return readVideoBytes(); }, readAudioBytes,
      sleep: async () => {}, log: (m) => logs.push(m), falHttp: makeFalFake().http, runDir: dir,
    },
    { videoPath: pq, audioPath: 'a.mp3', outPath: join(dir, 'out.mp4'), falKey: 'test-key' },
  );
  assert.equal(read.length, 1);
  assert.notEqual(read[0], pq);
  assert.deepEqual(probeStream(read[0], 'v:0', 'color_primaries,color_transfer,color_space'), { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
  // The source's HDR10 boxes stay behind, on every ffmpeg: the copy is made through a graph with two sources.
  assert.deepEqual([hdr10Data(read[0], 'stream'), hdr10Data(read[0], 'frame')], [[], []]);
  assertConverted(pq, 5, lumaOf(read[0], 5, 'video'), { transfer: 'smpte2084', width: 320, tolerance: 1.5, what: 'the copy sent' });
  assert.ok(logs.some((l) => /^pq\.mp4 is HDR \(PQ, /.test(l)), logs.join('\n'));
});
