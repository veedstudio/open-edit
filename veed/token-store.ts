// Token store for the VEED login: resolves the access token (env wins, then
// the stored login, refreshed when stale) and persists refreshes owner-only.
import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

// One refresh per token file at a time. A long run resolves the token repeatedly rather than closing over
// one — an upload or a poll can outlive an access token — and those calls overlap, so without this every
// overlapping caller POSTs the SAME refresh token: with rotation the first rotates it and the rest 401,
// and their writes then race on the store.
// Keyed by token path, and dropped as soon as the refresh settles so the NEXT expiry refreshes again.
//
// In-PROCESS only. Two separate commands refreshing at the same instant still both POST, and with
// rotation one of them ends up holding a revoked refresh token — recoverable by logging in again. The
// atomic write below is what keeps that case from also corrupting the store; a lock file would be the
// fix if it ever bites, and it has not.
const inFlightRefreshes = new Map<string, Promise<string | null>>();

// The ONE way the token store is written, by login and by refresh alike — two writers with two sets of
// guarantees is how one of them ends up weaker, and this file is a login nobody wants to repeat.
//
// The store must never be observed half-written: a writer that crashes mid-truncate costs the user that
// browser login. Write a sibling temp file, then rename —
// rename within a directory is atomic, so a reader sees the whole old file or the whole new one. Sibling,
// not /tmp: rename is only atomic within one filesystem.
//
// `wx` makes this a CREATE, never an overwrite: a leftover temp file is then an error rather than
// something to silently reuse, and `mode` is only consulted when the file is actually created.
//
// The chmod is NOT redundant, however tempting that reads. Creation mode is masked by the process umask,
// and a umask that strips OWNER bits leaves the store unreadable by the process that just wrote it
// (measured: umask 0400 creates 0200, umask 0600 creates 0000). chmod is not masked, so it is what makes
// 0600 the outcome rather than the request. Never a LOOSER file — umask only removes bits — but a token
// nobody can read costs the login this whole design exists to protect.
//
// 0600 is POSIX. On Windows only the write permission is manipulable, so owner-only there would mean
// ACLs — out of scope while preflight refuses anything but macOS-arm64.
export async function writeTokenFileAtomically(path: string, token: TokenFile): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// The refresh itself, deduped across concurrent callers of resolveToken for the same token file. The
// map is read and written synchronously (no await between the get and the set) so two callers cannot both
// decide they are first.
function refreshStoredToken(
  tokenPath: string,
  stored: TokenFile & { refreshToken: string },
  fetchFn: typeof fetch,
  now: () => number,
): Promise<string | null> {
  const existing = inFlightRefreshes.get(tokenPath);
  if (existing) return existing;

  const pending = (async (): Promise<string | null> => {
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
    await writeTokenFileAtomically(tokenPath, next);
    return next.accessToken;
  })().finally(() => {
    inFlightRefreshes.delete(tokenPath);
  });

  inFlightRefreshes.set(tokenPath, pending);
  return pending;
}

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

  return refreshStoredToken(
    opts.tokenPath,
    stored as TokenFile & { refreshToken: string },
    fetchFn,
    now,
  );
}
