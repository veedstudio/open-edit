// Every network call the CLI makes goes through Node's global fetch, which ignores HTTPS_PROXY and
// HTTP_PROXY on its own. Behind a proxy (a sandboxed agent, a corporate egress) each call then fails as
// a bare "fetch failed" with nothing naming the cause, so the dispatcher is swapped once, at entry. A
// browser the CLI launches is handed the same proxy by browserProxy().
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** The proxy the environment names, in the precedence undici itself applies; empty values count as unset. */
function pick(env: NodeJS.ProcessEnv, lower: string, upper: string): string | undefined {
  return [env[lower], env[upper]].find((v) => v !== undefined && v.trim() !== '')?.trim();
}

/**
 * Routes every fetch through the proxy the environment names, honouring NO_PROXY. Returns false and
 * leaves Node's own dispatcher alone when no proxy is set, so a direct connection keeps Node's defaults.
 */
export function installEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  const httpProxy = pick(env, 'http_proxy', 'HTTP_PROXY');
  const httpsProxy = pick(env, 'https_proxy', 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return false;
  // Every value is passed explicitly (an empty string for "none"), because undici falls back to
  // process.env for any option left undefined and the env this was handed must be the only authority.
  // The https fallback to HTTP_PROXY is undici's own rule, kept.
  setGlobalDispatcher(new EnvHttpProxyAgent({
    httpProxy: httpProxy ?? '',
    httpsProxy: httpsProxy ?? httpProxy ?? '',
    noProxy: pick(env, 'no_proxy', 'NO_PROXY') ?? '',
  }));
  return true;
}

/**
 * An error's message with its root cause: Node's fetch throws a bare "fetch failed" and keeps what went
 * wrong (a refused tunnel, DNS, TLS, a refused connection) on `cause`, sometimes nested, where a message
 * never shows it.
 */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  let root: { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let c = e.cause, depth = 0; c && typeof c === 'object' && depth < 5; c = (c as { cause?: unknown }).cause, depth++) {
    root = c as typeof root;
  }
  if (!root) return e.message;
  const code = typeof root.code === 'string' ? root.code : '';
  const text = typeof root.message === 'string' && root.message ? root.message : code;
  if (!text || e.message.includes(text)) return e.message;
  return `${e.message} (${code && !text.includes(code) ? `${code}: ${text}` : text})`;
}

/**
 * The same proxy in the form the browser driver takes, or undefined for a direct connection. Chrome
 * keeps one server for every scheme, so HTTPS_PROXY wins over HTTP_PROXY. Credentials in the URL are
 * never passed on: the driver answers every auth challenge, from any server a page's scripts reach,
 * with the credentials it holds. Behind an authenticated proxy the page's remote loads fail instead,
 * and are listed as failed loads.
 */
export function browserProxy(env: NodeJS.ProcessEnv = process.env): { server: string; bypass?: string } | undefined {
  let server = pick(env, 'https_proxy', 'HTTPS_PROXY') ?? pick(env, 'http_proxy', 'HTTP_PROXY');
  if (!server) return undefined;
  const url = URL.canParse(server) ? new URL(server) : null;
  if (url && (url.username || url.password)) {
    url.username = '';
    url.password = '';
    server = url.href.replace(/\/$/, '');
  }
  const bypass = pick(env, 'no_proxy', 'NO_PROXY');
  return bypass ? { server, bypass } : { server };
}
