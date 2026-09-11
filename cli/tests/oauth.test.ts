// Tests for the pure parts of the "log in with VEED" OAuth flow (PKCE, URL
// building, token expiry). The network/browser parts are exercised live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAuthorizeUrl, isTokenExpired, makePkcePair } from '../src/veed/oauth.ts';

test('makePkcePair produces a base64url verifier whose S256 hash is the challenge', () => {
  const { verifier, challenge } = makePkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('makePkcePair is not deterministic', () => {
  assert.notEqual(makePkcePair().verifier, makePkcePair().verifier);
});

test('buildAuthorizeUrl carries the exact PKCE, client, redirect and scope params', () => {
  const url = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: 'https://www.veed.io/api/v1/oauth2/auth',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:8977/callback',
      challenge: 'CHAL',
      state: 'STATE',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.veed.io/api/v1/oauth2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8977/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'STATE');
  assert.equal(url.searchParams.get('scope'), 'mcp:read offline_access');
});

test('isTokenExpired treats a token inside the skew window as expired', () => {
  const now = 1_000_000_000_000;
  assert.equal(isTokenExpired({ expiresAt: now + 120_000 }, now, 60_000), false);
  assert.equal(isTokenExpired({ expiresAt: now + 30_000 }, now, 60_000), true);
  assert.equal(isTokenExpired({ expiresAt: now - 1 }, now, 60_000), true);
});
