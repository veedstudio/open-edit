// Tests src/proxy.ts against a real local proxy: the requests either cross it or, under NO_PROXY, do
// not. The last case drives the CLI entry itself, so a command's own fetch is what is proven to obey
// HTTPS_PROXY, with no network beyond loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';
import { browserProxy, errorText, installEnvProxy } from '../src/proxy.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Seen { method: string; target: string; auth?: string }

/** A CONNECT-capable forward proxy that records every request it is asked to carry. */
async function startProxy(opts: { refuse?: boolean } = {}): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', target: req.url ?? '', auth: req.headers['proxy-authorization'] });
    res.writeHead(502).end();
  });
  server.on('connect', (req, client, head) => {
    seen.push({ method: 'CONNECT', target: req.url ?? '', auth: req.headers['proxy-authorization'] });
    if (opts.refuse) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

async function startTarget(): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => res.end('through'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`, server };
}

function stop(...servers: Server[]): void {
  for (const s of servers) { s.closeAllConnections(); s.close(); }
}

await test('no proxy in the environment leaves Node\'s own dispatcher in place', () => {
  assert.equal(installEnvProxy({}), false);
  assert.equal(installEnvProxy({ HTTPS_PROXY: '  ', http_proxy: '' }), false);
});

await test('HTTP_PROXY carries a fetch through the proxy, credentials included', async () => {
  const proxy = await startProxy();
  const target = await startTarget();
  try {
    const withCreds = proxy.url.replace('http://', 'http://agent:s%40cret@');
    assert.equal(installEnvProxy({ HTTP_PROXY: withCreds, NO_PROXY: '' }), true);
    const res = await fetch(target.url);
    assert.equal(await res.text(), 'through');
    const hit = proxy.seen.find((s) => s.target.includes(new URL(target.url).port));
    assert.ok(hit, `the proxy never saw the request: ${JSON.stringify(proxy.seen)}`);
    assert.equal(hit.auth, `Basic ${Buffer.from('agent:s@cret').toString('base64')}`);
  } finally {
    setGlobalDispatcher(new Agent());
    stop(proxy.server, target.server);
  }
});

await test('NO_PROXY keeps a listed host off the proxy', async () => {
  const proxy = await startProxy();
  const target = await startTarget();
  try {
    installEnvProxy({ HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' });
    assert.equal(await (await fetch(target.url)).text(), 'through');
    assert.deepEqual(proxy.seen, []);
  } finally {
    setGlobalDispatcher(new Agent());
    stop(proxy.server, target.server);
  }
});

await test('the CLI entry sends a command\'s own https call through HTTPS_PROXY', async () => {
  // The proxy refuses the tunnel, so the command fails without touching the internet; what matters is
  // that its request reached the proxy at all instead of dialling out directly.
  const proxy = await startProxy({ refuse: true });
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HTTPS_PROXY: proxy.url, https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '',
    };
    let stderr = '';
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'stills', 'search', 'lighthouse'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', resolve);
    });
    assert.notEqual(code, 0);
    assert.deepEqual(proxy.seen.map((s) => `${s.method} ${s.target}`), ['CONNECT commons.wikimedia.org:443']);
    assert.match(stderr, /fetch failed \(.*403/, `the refusal is named, not only "fetch failed": ${stderr}`);
  } finally {
    stop(proxy.server);
  }
});

await test('an https call falls back to HTTP_PROXY, and a lowercase variable wins over its uppercase twin', async () => {
  const lower = await startProxy({ refuse: true });
  const upper = await startProxy({ refuse: true });
  try {
    installEnvProxy({ HTTP_PROXY: upper.url, NO_PROXY: '' });
    await fetch('https://only-http-proxy.invalid/').catch(() => {});
    assert.deepEqual(upper.seen.map((s) => s.target), ['only-http-proxy.invalid:443']);

    installEnvProxy({ https_proxy: lower.url, HTTPS_PROXY: upper.url, NO_PROXY: '' });
    await fetch('https://both-set.invalid/').catch(() => {});
    assert.deepEqual(lower.seen.map((s) => s.target), ['both-set.invalid:443']);
    assert.equal(upper.seen.length, 1, 'the uppercase proxy saw nothing more');
  } finally {
    setGlobalDispatcher(new Agent());
    stop(lower.server, upper.server);
  }
});

await test('a network error names its cause instead of a bare "fetch failed"', () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
  assert.equal(errorText(refused), 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)');
  assert.equal(errorText(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), 'fetch failed (ENOTFOUND)');
  const tunnel = new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }) }) });
  assert.equal(errorText(tunnel), 'fetch failed (UND_ERR_ABORTED: Proxy response (403) !== 200 when HTTP Tunneling)', 'the root of a nested cause');
  assert.equal(errorText(new Error('plain')), 'plain');
  assert.equal(errorText('text'), 'text');
});

test('a launched browser gets the same proxy, HTTPS_PROXY first, with NO_PROXY as its bypass list', () => {
  assert.equal(browserProxy({}), undefined);
  assert.deepEqual(browserProxy({ HTTP_PROXY: 'http://a:1' }), { server: 'http://a:1' });
  assert.deepEqual(browserProxy({ HTTP_PROXY: 'http://a:1', https_proxy: 'http://b:2', NO_PROXY: '.corp,localhost' }), { server: 'http://b:2', bypass: '.corp,localhost' });
  assert.equal(browserProxy({ HTTPS_PROXY: ' ' }), undefined, 'an empty value counts as unset');
  assert.deepEqual(browserProxy({ HTTPS_PROXY: 'http://u%40corp:p%3Ass@proxy.corp:3128' }), { server: 'http://proxy.corp:3128' },
    'no credentials: the driver would answer any server\'s auth challenge with them');
  assert.deepEqual(browserProxy({ HTTPS_PROXY: 'socks5://u:p@gw:1080' }), { server: 'socks5://gw:1080' });
});
