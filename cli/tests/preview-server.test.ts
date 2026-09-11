import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewServer } from '../src/commands/preview.ts';
import type { PreviewState } from '../src/preview/state.ts';

// Shared scaffold: a run dir with a tiny known video, a transcript with the given chunks,
// and the minimal meta.json the state derivation actually reads.
const STORY_CHUNK = {
  text: 'Hey quick story', timestamp: [0, 1.2],
  words: [
    { text: 'Hey', timestamp: [0, 0.3] },
    { text: 'quick', timestamp: [0.3, 0.7] },
    { text: 'story', timestamp: [0.7, 1.2] },
  ],
};

async function makeRun(): Promise<{ dir: string; videoPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'preview-server-'));
  const videoPath = join(dir, 'source-not-a-real.mp4');
  await writeFile(videoPath, Buffer.from(Array.from({ length: 100 }, (_, i) => i))); // 100 known bytes
  await writeFile(join(dir, 'transcript.json'), JSON.stringify({ text: '', chunks: [STORY_CHUNK] }));
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    key: 'demo', file: 'demo.mp4', videoPath, width: 736, height: 1312, fps: 25, durationSec: 8,
  }));
  return { dir, videoPath };
}

test('preview server end to end', async (t) => {
  const { dir } = await makeRun();
  const srv = await createPreviewServer(dir, { port: 0, openBrowser: false });
  t.after(() => srv.close());

  await t.test('serves the page and assets', async () => {
    const page = await fetch(`${srv.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /OpenEdit preview/);
    assert.equal((await fetch(`${srv.url}/app.js`)).status, 200);
    assert.equal((await fetch(`${srv.url}/style.css`)).status, 200);
    assert.equal((await fetch(`${srv.url}/helpers.mjs`)).status, 200);
  });

  await t.test('nothing is cacheable: run-dir contents change under stable urls', async () => {
    for (const path of ['/', '/app.js', '/api/state', '/video']) {
      const r = await fetch(`${srv.url}${path}`);
      assert.equal(r.headers.get('cache-control'), 'no-store', `${path} must be no-store`);
    }
  });

  await t.test('state endpoint reports cooking', async () => {
    const s = (await (await fetch(`${srv.url}/api/state`)).json()) as PreviewState;
    assert.equal(s.stage, 'cooking');
    assert.equal(s.chunks?.length, 1);
  });

  await t.test('media honours range requests', async () => {
    const r = await fetch(`${srv.url}/video`, { headers: { range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/100');
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.length, 10);
    assert.equal(body[0], 10);
    assert.equal(body[9], 19);
  });

  await t.test('render 404s before a render exists', async () => {
    assert.equal((await fetch(`${srv.url}/render`)).status, 404);
  });

  await t.test('render swap: dropping final/out.mp4 flips stage on the events stream', async () => {
    const es = await fetch(`${srv.url}/api/events`, { headers: { accept: 'text/event-stream' } });
    assert.equal(es.status, 200);
    assert.match(es.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = es.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function nextFrame(): Promise<PreviewState> {
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          return JSON.parse(frame.replace(/^data: /, '')) as PreviewState;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('sse stream ended early');
        buffer += decoder.decode(value, { stream: true });
      }
    }
    const first = await nextFrame(); // join frame
    assert.equal(first.stage, 'cooking');
    await mkdir(join(dir, 'final'), { recursive: true });
    await writeFile(join(dir, 'final', 'out.mp4'), Buffer.alloc(64, 7));
    const next = await nextFrame(); // watcher-driven
    assert.equal(next.stage, 'rendered');
    await reader.cancel();
    const rendered = await fetch(`${srv.url}/render`);
    assert.equal(rendered.status, 200);
    assert.equal(rendered.headers.get('accept-ranges'), 'bytes');
  });

  await t.test('unknown paths 404 without leaking files', async () => {
    assert.equal((await fetch(`${srv.url}/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${srv.url}/../package.json`)).status, 404);
  });
});

test('missing run dir rejects', async () => {
  await assert.rejects(createPreviewServer('/nonexistent/run/dir', { port: 0, openBrowser: false }));
});

test('a non-local Host header is rejected (dns rebinding)', async (t) => {
  const { dir } = await makeRun();
  const srv = await createPreviewServer(dir, { port: 0, openBrowser: false });
  t.after(() => srv.close());
  // raw http.get: fetch silently drops a custom Host header
  const status = await new Promise<number>((resolve, reject) => {
    get({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { host: 'evil.example.com' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('a media stream error kills that response, never the server', async (t) => {
  const { dir, videoPath } = await makeRun();
  await chmod(videoPath, 0o000); // stat (size) still works; the stream's open() then fails with EACCES
  const srv = await createPreviewServer(dir, { port: 0, openBrowser: false });
  t.after(() => srv.close());
  await fetch(`${srv.url}/video`).then((r) => r.arrayBuffer()).catch(() => undefined); // this response may die
  assert.equal((await fetch(`${srv.url}/api/state`)).status, 200, 'server must survive a failed media stream');
});
