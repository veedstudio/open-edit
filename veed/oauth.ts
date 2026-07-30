// "Log in with VEED": OAuth 2.1 authorization-code + PKCE against VEED's OIDC
// provider (the same one fabric-mcp clients use). The pure pieces (PKCE, URL
// building, expiry) are tested; the interactive pieces (loopback server,
// browser, token exchange) are exercised live by login.ts.
import { createHash, randomBytes } from 'node:crypto';

// Requested at registration AND on every authorize call; the two must stay in
// lockstep or the authorize request gets rejected/narrowed. offline_access is
// the one that buys a refresh token, so the user logs in roughly monthly rather
// than hourly.
export const OAUTH_SCOPE = 'mcp:read offline_access';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function makePkcePair(): PkcePair {
  // 32 random bytes -> 43-char base64url verifier (RFC 7636 length bounds).
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(args: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('code_challenge', args.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', args.state);
  // offline_access asks for a refresh token so the user logs in ~monthly.
  url.searchParams.set('scope', OAUTH_SCOPE);
  return url.toString();
}

export interface StoredToken {
  expiresAt: number;
}

export function isTokenExpired(token: StoredToken, nowMs: number, skewMs: number): boolean {
  return token.expiresAt - skewMs <= nowMs;
}
