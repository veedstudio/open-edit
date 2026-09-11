// Tests for the token store: env precedence, stored-token reuse, and the
// refresh path (fake fetch, real fs against a temp dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToken, type TokenFile } from '../src/veed/token-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'veed-token-'));
const NOW = 1_700_000_000_000;

function writeToken(name: string, overrides: Partial<TokenFile>): string {
  const path = join(dir, name);
  const token: TokenFile = {
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    expiresAt: NOW + 3_600_000,
    origin: 'https://www.veed.example',
    clientId: 'client-1',
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(token));
  return path;
}

const fetchNever: typeof fetch = () => {
  throw new Error('fetch must not be called');
};

test('an explicit env token wins without touching the store', async () => {
  const token = await resolveToken({
    envToken: 'env-token',
    tokenPath: join(dir, 'missing.json'),
    fetchFn: fetchNever,
    now: () => NOW,
  });
  assert.equal(token, 'env-token');
});

test('returns null when there is no env token and no stored login', async () => {
  const token = await resolveToken({
    tokenPath: join(dir, 'missing.json'),
    fetchFn: fetchNever,
    now: () => NOW,
  });
  assert.equal(token, null);
});

test('returns the stored token while it is still fresh', async () => {
  const path = writeToken('fresh.json', {});
  const token = await resolveToken({ tokenPath: path, fetchFn: fetchNever, now: () => NOW });
  assert.equal(token, 'stored-access');
});

test('refuses a stored login that belongs to a different origin', async () => {
  const path = writeToken('wrong-origin.json', {});
  const token = await resolveToken({
    tokenPath: path,
    fetchFn: fetchNever,
    now: () => NOW,
    expectedOrigin: 'https://studio.veed.example',
  });
  assert.equal(token, null);
});

test('accepts the stored login when the expected origin matches', async () => {
  const path = writeToken('right-origin.json', {});
  const token = await resolveToken({
    tokenPath: path,
    fetchFn: fetchNever,
    now: () => NOW,
    expectedOrigin: 'https://www.veed.example',
  });
  assert.equal(token, 'stored-access');
});

test('refreshes against the stored token endpoint when one was recorded at login', async () => {
  const path = writeToken('custom-endpoint.json', {
    expiresAt: NOW - 1,
    tokenEndpoint: 'https://auth.veed.example/custom/token',
  });
  const urls: string[] = [];
  const fetchFake = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;

  const token = await resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW });

  assert.equal(token, 'new-access');
  assert.deepEqual(urls, ['https://auth.veed.example/custom/token']);
});

test('returns null for an expired token with no refresh token', async () => {
  const path = writeToken('expired-no-refresh.json', { expiresAt: NOW - 1, refreshToken: null });
  const token = await resolveToken({ tokenPath: path, fetchFn: fetchNever, now: () => NOW });
  assert.equal(token, null);
});

test('refreshes an expired token and rewrites the store with owner-only permissions', async () => {
  const path = writeToken('expired.json', { expiresAt: NOW - 1 });
  const requests: Array<{ url: string; body: string }> = [];
  const fetchFake = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body) });
    return new Response(
      JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;

  const token = await resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW });

  assert.equal(token, 'new-access');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://www.veed.example/api/v1/oauth2/token');
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.match(requests[0].body, /refresh_token=stored-refresh/);
  assert.match(requests[0].body, /client_id=client-1/);

  const rewritten = JSON.parse(readFileSync(path, 'utf8')) as TokenFile;
  assert.equal(rewritten.accessToken, 'new-access');
  assert.equal(rewritten.refreshToken, 'new-refresh');
  assert.equal(rewritten.expiresAt, NOW + 3_600_000);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

// The store is 0600 whatever the umask, which is a stronger claim than "we asked for 0600": creation
// mode is masked by umask, chmod is not. Without the chmod a umask that strips owner bits writes a token
// the next run cannot read — never a looser file, but a lost login either way. This test exists because
// the chmod looks redundant next to the mode argument, and was once deleted for exactly that reason.
test('the store is owner-only even under a umask that would strip those bits', { skip: process.platform === 'win32' && 'Windows has no mode bits or umask; the store inherits its directory ACL' }, async () => {
  const path = writeToken('hostile-umask.json', { expiresAt: NOW - 1 });
  const previous = process.umask(0o400); // masks OWNER read: creation alone would leave 0200
  try {
    const fetchFake = (async () => new Response(
      JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
      { status: 200 },
    )) as typeof fetch;
    const token = await resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW });
    assert.equal(token, 'new-access', 'the refresh still lands');
    assert.equal(statSync(path).mode & 0o777, 0o600, 'chmod is what makes 0600 the outcome, not the request');
  } finally {
    process.umask(previous);
  }
});

// --- concurrent callers must not race: a long run resolves the token per request, and anything that
// fans requests out with Promise.all resolves it several times at once ---

test('concurrent resolveToken calls against an expired token make exactly ONE refresh request', async () => {
  // With refresh-token rotation, N simultaneous POSTs all send the SAME refresh token: the first rotates
  // it and the losers 401, and their interleaved writes can leave the store holding a revoked token.
  const path = writeToken('concurrent.json', { expiresAt: NOW - 1 });
  let requests = 0;
  const fetchFake = (async () => {
    requests += 1;
    // Yield twice so the callers really overlap rather than resolving in lockstep.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return new Response(
      JSON.stringify({ access_token: `new-access-${requests}`, refresh_token: `rotated-${requests}`, expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;

  const tokens = await Promise.all(
    Array.from({ length: 5 }, () => resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW })),
  );

  assert.equal(requests, 1, `expected one refresh for five concurrent callers, got ${requests}`);
  assert.deepEqual(tokens, Array.from({ length: 5 }, () => 'new-access-1'));

  // The store must hold exactly one complete record — never a half-written or superseded one.
  const stored = JSON.parse(readFileSync(path, 'utf8')) as TokenFile;
  assert.equal(stored.accessToken, 'new-access-1');
  assert.equal(stored.refreshToken, 'rotated-1');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith('concurrent.json') && f !== 'concurrent.json'),
    [],
    'the atomic write must leave no temp file behind',
  );
});

test('a later resolveToken refreshes again rather than replaying the deduped promise', async () => {
  // The dedupe covers callers that overlap, not the next expiry: a stale cached promise would hand back a
  // token that has since expired.
  const path = writeToken('sequential.json', { expiresAt: NOW - 1 });
  let requests = 0;
  const fetchFake = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ access_token: `access-${requests}`, expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;

  assert.equal(await resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW }), 'access-1');
  // The clock has moved past the token just written, so this is a genuinely stale token again.
  assert.equal(await resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW + 7_200_000 }), 'access-2');
  assert.equal(requests, 2);
});

test('returns null when the refresh request is rejected', async () => {
  const path = writeToken('refresh-fails.json', { expiresAt: NOW - 1 });
  const fetchFake = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  const token = await resolveToken({ tokenPath: path, fetchFn: fetchFake, now: () => NOW });
  assert.equal(token, null);
});
