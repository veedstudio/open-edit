// Typed thin wrappers over VEED's public REST edge (www.veed.io/api/v1) for the asset + transcription
// path. Every endpoint here is reachable from an external client with an OIDC Bearer JWT. HTTP is
// injected (VeedHttp) so the orchestration is testable offline. Response envelopes (some routes wrap
// payloads in { data }) are normalised by unwrap().

// VEED_ORIGIN switches login and API together. VEED_API_BASE still wins if set explicitly.
export const VEED_ORIGIN = (process.env.VEED_ORIGIN ?? 'https://www.veed.io').replace(/\/$/, '');
export const VEED_API_BASE = (process.env.VEED_API_BASE ?? `${VEED_ORIGIN}/api/v1`).replace(/\/$/, '');

export interface VeedHttp {
  // `headers` is for the few routes that take a scope out-of-band rather than in the path or body —
  // the usage report reads the workspace from a header rather than the path or body.
  getJson<T>(path: string, headers?: Record<string, string>): Promise<T>;
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
  // Set on generated assets (a Fabric render); the transcription path only ever reads cdnUrl.
  sourceUrl?: string | null;
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
  args: {
    mimeType: string;
    extension: string;
    // Defaults reproduce the transcription upload; the Fabric TTS asset overrides them.
    assetType?: string;
    // Must be a real AssetGroup enum value; source uploads are 'srcVideo', TTS audio is 'TTS'.
    group?: string;
    assetSubType?: string;
    storage?: string;
    // Owner keys. Omitted entirely when absent — the schema rejects an explicit null, and a
    // workspaceId-ONLY upload is refused by a permission check, so pass both or neither.
    // Transcription uploads unscoped and lets the transcribe call carry the billing workspace;
    // the Fabric TTS asset is scoped to the project it is synthesized into.
    workspaceId?: string;
    projectId?: string;
  },
): Promise<UploadableAsset> {
  return unwrap<UploadableAsset>(
    await http.postJson('/asset', {
      assetType: args.assetType ?? 'VIDEO',
      mimeType: args.mimeType,
      extension: args.extension,
      group: args.group ?? 'srcVideo',
      ...(args.assetSubType ? { assetSubType: args.assetSubType } : {}),
      ...(args.storage ? { storage: args.storage } : {}),
      ...(args.workspaceId && args.projectId
        ? { workspaceId: args.workspaceId, projectId: args.projectId }
        : {}),
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
