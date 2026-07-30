// Token store for the VEED login: resolves the access token (env wins, then
// the stored login, refreshed when stale) and persists refreshes owner-only.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { isTokenExpired } from './oauth.ts';

// The one place the token file location is defined; login/go/readiness import it.
export const DEFAULT_TOKEN_PATH = join(REPO_ROOT, 'veed', '.veed-token.json');

export interface TokenFile {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  origin: string;
  clientId: string;
  // Recorded from OAuth discovery at login; refresh prefers it over the
  // conventional path so a moved token endpoint cannot break refresh.
  tokenEndpoint?: string;
}

const EXPIRY_SKEW_MS = 60_000;

export async function resolveToken(opts: {
  envToken?: string;
  tokenPath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  // When set, a stored login minted for a different origin is refused instead
  // of silently sending (say) a dev token to prod.
  expectedOrigin?: string;
}): Promise<string | null> {
  const envToken = opts.envToken?.trim();
  if (envToken) return envToken;

  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;

  let stored: TokenFile;
  try {
    stored = JSON.parse(await readFile(opts.tokenPath, 'utf8')) as TokenFile;
  } catch {
    return null;
  }

  if (opts.expectedOrigin && stored.origin !== opts.expectedOrigin) {
    console.error(
      `stored login is for ${stored.origin}, not ${opts.expectedOrigin}; run: VEED_ORIGIN=${opts.expectedOrigin} node --import tsx veed/login.ts`,
    );
    return null;
  }

  if (!isTokenExpired({ expiresAt: stored.expiresAt }, now(), EXPIRY_SKEW_MS)) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) return null;

  const res = await fetchFn(stored.tokenEndpoint ?? `${stored.origin}/api/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: stored.clientId,
    }),
  });
  if (!res.ok) {
    console.error(`token refresh failed (${res.status}); run: node --import tsx veed/login.ts`);
    return null;
  }
  const refreshed = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const next: TokenFile = {
    ...stored,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    expiresAt: now() + refreshed.expires_in * 1000,
  };
  await writeFile(opts.tokenPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  // writeFile's mode only applies on creation; tighten pre-existing files too.
  await chmod(opts.tokenPath, 0o600);
  return next.accessToken;
}
