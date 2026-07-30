// Typed thin wrappers over VEED's public REST edge (www.veed.io/api/v1) for the asset + transcription
// path. Every endpoint here is reachable from an external client with an OIDC Bearer JWT. HTTP is
// injected (VeedHttp) so the orchestration is testable offline. Response envelopes (some routes wrap
// payloads in { data }) are normalised by unwrap().

// VEED_ORIGIN switches login and API together. VEED_API_BASE still wins if set explicitly.
export const VEED_ORIGIN = (process.env.VEED_ORIGIN ?? 'https://www.veed.io').replace(/\/$/, '');
export const VEED_API_BASE = (process.env.VEED_API_BASE ?? `${VEED_ORIGIN}/api/v1`).replace(/\/$/, '');

export interface VeedHttp {
  getJson<T>(path: string): Promise<T>;
  // Like getJson but resolves null on a 404, for routes where 404 is a state
  // (GET /asset/:id only serves UPLOADED assets), not an error.
  getJsonOrNull<T>(path: string): Promise<T | null>;
  postJson<T>(path: string, body: unknown): Promise<T>;
  // PUT raw bytes to a full URL (the resumable GCS session URL is absolute, not under the API base).
  putBytes(absoluteUrl: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

// Some VEED routes return the payload directly, others wrap it in { data }. Normalise both.
export function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    return (raw as { data: T }).data;
  }
  return raw as T;
}

export interface Workspace {
  id: string;
  name?: string;
}

export interface UploadableAsset {
  asset: { id: string };
  url: string; // resumable GCS session URL
  contentLength?: string;
}

export interface Asset {
  id: string;
  uploadState: 'UPLOADING' | 'UPLOADED' | 'FAILED';
  cdnUrl?: string | null;
}

export interface StartedTranscription {
  id: string;
  status: 'pending' | 'active' | 'error';
}

export interface Subtitle {
  id: string;
  status: 'pending' | 'active' | 'error';
  // Record<itemId, { from, to, words:[{ value }] }> when active; see transcript-mapper.ts.
  subtitles?: Record<string, { from: number; to: number; words: Array<{ value: string }> }>;
  errorReason?: string;
}

export async function listWorkspaces(http: VeedHttp): Promise<Workspace[]> {
  // Returns the caller's workspaces, bare or wrapped in { data }; unwrap() normalises both.
  return unwrap<Workspace[]>(await http.getJson('/workspace'));
}

export async function createUploadableAsset(
  http: VeedHttp,
  args: { mimeType: string; extension: string },
): Promise<UploadableAsset> {
  // The upload carries NO owner keys. They must be omitted rather than sent as null (the schema
  // rejects explicit null), and a workspaceId-only upload is refused by a permission check anyway.
  // Unscoped upload + workspace-billed transcribe is the only shape this client uses.
  return unwrap<UploadableAsset>(
    await http.postJson('/asset', {
      assetType: 'VIDEO',
      mimeType: args.mimeType,
      extension: args.extension,
      // Must be a real AssetGroup enum value; source uploads are 'srcVideo'.
      group: 'srcVideo',
    }),
  );
}

// Null until the upload finalizes: the route 404s for non-UPLOADED assets.
export async function getAsset(http: VeedHttp, assetId: string): Promise<Asset | null> {
  const raw = await http.getJsonOrNull(`/asset/${assetId}`);
  return raw === null ? null : unwrap<Asset>(raw);
}

export async function startTranscription(
  http: VeedHttp,
  args: { assetId: string; workspaceId: string; videoUrl: string },
): Promise<StartedTranscription> {
  return unwrap<StartedTranscription>(
    await http.postJson(`/subtitles/assets/${args.assetId}/transcribe`, {
      // Always null, and deliberately not a parameter: the no-project route is the only one this
      // client takes, and it is the only one the service holds to always-bill.
      projectId: null,
      workspaceId: args.workspaceId,
      videoUrl: args.videoUrl,
      language: null,
    }),
  );
}

export async function getSubtitle(http: VeedHttp, subtitleId: string): Promise<Subtitle> {
  return unwrap<Subtitle>(await http.getJson(`/subtitles/${subtitleId}`));
}
