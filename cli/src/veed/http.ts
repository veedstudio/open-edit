// The real VeedHttp implementation: Bearer-authed fetch against the public
// edge, with timeouts so a hung request can't stall the poll loop forever.
import { VEED_API_BASE, VEED_ORIGIN, type VeedHttp } from './api.ts';

const JSON_TIMEOUT_MS = 30_000;
// The GCS PUT carries the whole video; give it room.
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

// A Fabric run polls for up to 15 minutes, which outlives an access token. This resolves the token
// per REQUEST rather than closing over one, so a refresh mid-run is picked up automatically and a
// paid job is never lost to an expiry between the charge and the download.
export function refreshingHttp(getToken: () => Promise<string>): VeedHttp {
  const at = <T,>(fn: (http: VeedHttp) => Promise<T>): Promise<T> => getToken().then((t) => fn(realHttp(t)));
  return {
    getJson: (path, headers) => at((h) => h.getJson(path, headers)),
    getJsonOrNull: (path) => at((h) => h.getJsonOrNull(path)),
    postJson: (path, body) => at((h) => h.postJson(path, body)),
    putBytes: (url, bytes, contentType) => at((h) => h.putBytes(url, bytes, contentType)),
  };
}

export function realHttp(token: string): VeedHttp {
  // Origin is hard-required by the upload-URL endpoint (it also
  // seeds the GCS resumable session); Node's fetch doesn't add one itself.
  const base = { authorization: `Bearer ${token}`, origin: VEED_ORIGIN };
  return {
    async getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
      const res = await fetch(VEED_API_BASE + path, {
        headers: { ...base, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return res.json() as Promise<T>;
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      const res = await fetch(VEED_API_BASE + path, {
        headers: { ...base, accept: 'application/json' },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return res.json() as Promise<T>;
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      const res = await fetch(VEED_API_BASE + path, {
        method: 'POST',
        headers: { ...base, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return res.json() as Promise<T>;
    },
    async putBytes(absoluteUrl: string, bytes: Uint8Array, contentType: string): Promise<void> {
      // A single PUT to the signed GCS session URL. If a response ever hands back a session that
      // requires the full resumable protocol, this is the place to implement it.
      const res = await fetch(absoluteUrl, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`PUT (gcs upload) -> ${res.status}`);
    },
  };
}
