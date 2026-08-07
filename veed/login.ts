// Interactive "log in with VEED": opens a browser, catches the redirect on a
// localhost loopback, exchanges the code (PKCE) for tokens, and stores them at
// veed/.veed-token.json for go.ts to use.
//
//   Run:  node --import tsx veed/login.ts
//   Env:  VEED_ORIGIN optionally overrides the default https://www.veed.io origin.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { VEED_ORIGIN as ORIGIN } from './api.ts';
import { loginSuccessPage } from './login-page.ts';
import { buildAuthorizeUrl, makePkcePair, OAUTH_SCOPE } from './oauth.ts';
import { DEFAULT_TOKEN_PATH as TOKEN_PATH, writeTokenFileAtomically } from './token-store.ts';

const CLIENT_PATH = join(REPO_ROOT, 'veed', '.veed-client.json');
const LOOPBACK_PORT = 8977;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

async function discover(): Promise<Discovery> {
  const res = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  return (await res.json()) as Discovery;
}

// Register this client once (Dynamic Client Registration) and cache the id,
// keyed by origin: a client registered on prod is meaningless on dev.
async function getClientId(discovery: Discovery): Promise<string> {
  try {
    const cached = JSON.parse(await readFile(CLIENT_PATH, 'utf8')) as {
      clientId?: string;
      origin?: string;
    };
    if (cached.clientId && cached.origin === ORIGIN) return cached.clientId;
  } catch {
    /* not registered yet */
  }
  const res = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'open-editor (local)',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`client registration failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const reg = (await res.json()) as { client_id: string };
  await writeFile(CLIENT_PATH, JSON.stringify({ clientId: reg.client_id, origin: ORIGIN }, null, 2));
  return reg.client_id;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;

// Serve one redirect: resolve with the auth code once VEED sends the user back.
function catchRedirect(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('login timed out after 5 minutes; re-run veed/login.ts'));
    }, LOGIN_TIMEOUT_MS);
    // Don't let the pending timer keep the process alive after a successful login.
    timer.unref();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Login failed; return to the terminal.');
        server.close();
        reject(new Error('login redirect missing code or state mismatch'));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(await loginSuccessPage());
      server.close();
      resolve(code);
    });
    server.listen(LOOPBACK_PORT, '127.0.0.1');
    server.on('error', reject);
  });
}

// Manual mode: no browser + no loopback. Print the URL, take the redirect
// pasted back (full localhost URL or the bare ?code=...). Lets an agent drive
// the flow with its own browser, or a human log in on another device.
async function readCodeFromStdin(expectedState: string): Promise<string> {
  console.log(
    'Open the URL above (any browser logged into VEED). It will redirect to a\n' +
      'localhost address that will not load — that is expected. Copy that final\n' +
      'redirected URL (or just the code=... value) and paste it here:',
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('> ')).trim();
  rl.close();
  let code: string | null = null;
  let state: string | null = expectedState;
  try {
    const u = new URL(answer);
    code = u.searchParams.get('code');
    state = u.searchParams.get('state');
  } catch {
    // Not a URL: treat the whole line as the bare code, trust the state.
    code = answer.replace(/^code=/, '') || null;
  }
  if (!code || state !== expectedState) {
    throw new Error('pasted redirect is missing a code or the state did not match');
  }
  return code;
}

async function main(): Promise<void> {
  const discovery = await discover();
  const clientId = await getClientId(discovery);
  const { verifier, challenge } = makePkcePair();
  const state = randomBytes(16).toString('base64url');

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: discovery.authorization_endpoint,
    clientId,
    redirectUri: REDIRECT_URI,
    challenge,
    state,
  });

  // VEED_LOGIN_MANUAL=1 is the no-reachable-browser fallback: print the URL, no
  // browser auto-open, no loopback; complete via a pasted redirect.
  const manual = process.env.VEED_LOGIN_MANUAL === '1';
  console.log(`Log in with VEED:\n  ${authorizeUrl}\n`);
  let code: string;
  if (manual) {
    code = await readCodeFromStdin(state);
  } else {
    console.log('Opening your browser (set VEED_LOGIN_MANUAL=1 to paste the redirect instead)...');
    execFile('open', [authorizeUrl], () => {});
    code = await catchRedirect(state);
  }
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  await writeTokenFileAtomically(TOKEN_PATH, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Date.now() + token.expires_in * 1000,
    origin: ORIGIN,
    clientId,
    tokenEndpoint: discovery.token_endpoint,
  });
  console.log(`Logged in. Token stored at ${TOKEN_PATH}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
