import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_RELEASES_REPO, resolveLatestEngineTag } from '../src/engine-release.ts';

const API = `https://api.github.com/repos/${ENGINE_RELEASES_REPO}/releases/latest`;
const REDIRECT = `https://github.com/${ENGINE_RELEASES_REPO}/releases/latest`;

const headers = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
});

// The 302 github.com answers with, and the API's JSON — the two routes to the same tag.
const redirected = (tag: string) => ({
  status: 302,
  ok: false,
  headers: headers({ location: `https://github.com/${ENGINE_RELEASES_REPO}/releases/tag/${tag}` }),
});
const apiJson = (tag: string) => ({ status: 200, ok: true, headers: headers({}), json: async () => ({ tag_name: tag }) });
const rateLimited = () => ({
  status: 403,
  ok: false,
  headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60' }),
  json: async () => ({}),
});

const recording = (routes: Record<string, () => unknown>) => {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  };
  return { seen, fetchImpl };
};

test('the latest tag comes from the github.com redirect, leaving the metered API untouched', async () => {
  const { seen, fetchImpl } = recording({ [REDIRECT]: () => redirected('weave-v0.10.2') });
  const { tag, failures } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, 'weave-v0.10.2');
  assert.deepEqual(failures, []);
  assert.deepEqual(seen, [REDIRECT]);
});

test('a failed redirect route falls back to the release API', async () => {
  const { seen, fetchImpl } = recording({
    [REDIRECT]: () => ({ status: 500, ok: false, headers: headers({}) }),
    [API]: () => apiJson('weave-v0.10.2'),
  });
  const { tag } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, 'weave-v0.10.2');
  assert.deepEqual(seen, [REDIRECT, API]);
});

// A response object without headers is what init's injected fetch and some proxies hand back;
// it must fall through rather than throw.
test('a response carrying no headers falls through to the API', async () => {
  const { fetchImpl } = recording({
    [REDIRECT]: () => ({ ok: true }),
    [API]: () => ({ ok: true, json: async () => ({ tag_name: 'weave-v1.0.0' }) }),
  });
  const { tag } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, 'weave-v1.0.0');
});

test('a route that failed is still reported when the fallback answered', async () => {
  const { fetchImpl } = recording({
    [REDIRECT]: () => ({ status: 403, ok: false, headers: headers({}) }),
    [API]: () => apiJson('weave-v0.10.2'),
  });
  const { tag, failures } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, 'weave-v0.10.2');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /github\.com.+HTTP 403/);
});

// A network that blackholes packets used to cost the caller one full timeout PER route.
test('the routes share one budget rather than each taking their own', async () => {
  const seen: string[] = [];
  const hangs = async (url: string, init: any) => {
    seen.push(url);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  };
  // AbortSignal.timeout's own timer does not hold the event loop open, so with nothing else pending
  // the runner drains and cancels the file before a single abort fires.
  const keepAlive = setInterval(() => {}, 25);
  try {
    const started = Date.now();
    const { tag, failures } = await resolveLatestEngineTag(hangs, 300);
    const elapsed = Date.now() - started;
    assert.equal(tag, '');
    assert.equal(seen.length, 2);          // both routes were tried
    assert.equal(failures.length, 2);
    assert.ok(elapsed < 1200, `both routes took ${elapsed}ms, past the shared 300ms budget`);
  } finally {
    clearInterval(keepAlive);
  }
});

test('an exhausted API rate limit is reported as such, not as being offline', async () => {
  const { fetchImpl } = recording({
    [REDIRECT]: () => ({ status: 500, ok: false, headers: headers({}) }),
    [API]: () => rateLimited(),
  });
  const { tag, failures } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, '');
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /HTTP 500/);
  assert.match(failures[1]!, /HTTP 403/);
  assert.match(failures[1]!, /rate limit/i);
});

test('a network failure is reported with the error the route actually raised', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); };
  const { tag, failures } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, '');
  assert.equal(failures.length, 2);
  for (const failure of failures) assert.match(failure, /ENOTFOUND/);
});

test('a redirect that does not land on a tag is not read as one', async () => {
  const { fetchImpl } = recording({
    [REDIRECT]: () => ({ status: 302, ok: false, headers: headers({ location: `https://github.com/${ENGINE_RELEASES_REPO}/releases` }) }),
    [API]: () => apiJson('weave-v0.10.2'),
  });
  const { tag } = await resolveLatestEngineTag(fetchImpl);
  assert.equal(tag, 'weave-v0.10.2');
});
