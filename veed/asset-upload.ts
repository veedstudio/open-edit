// The createUploadableAsset -> putBytes -> poll(getAsset) sequence, extracted once. It already exists
// twice, slightly differently: fabric.ts:314-334 (scoped, IMAGE) and orchestrate.ts:75-97 (unscoped,
// VIDEO). Neither is refactored onto this — both already work — but a third local-file upload (video
// background removal / lipsync, scoped OR unscoped depending on caller) reuses this instead of growing
// its own copy.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { type VeedHttp, createUploadableAsset, getAsset } from './api.ts';
import { poll } from './poll.ts';

// orchestrate.ts's existing convention for asset-upload readiness: fast and bounded, unlike the
// long-running generation polls this asset then feeds (VEED remove-background, fal background-removal
// or lipsync), which need their own much longer budgets.
const UPLOAD_POLL_INTERVAL_MS = 1000;
const UPLOAD_MAX_ATTEMPTS = 60;

export interface UploadLocalAssetDeps {
  http: VeedHttp;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadLocalAssetArgs {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  assetType: string;
  group: string;
  // Pass both or neither — createUploadableAsset only forwards owner keys as a pair (see api.ts).
  workspaceId?: string;
  projectId?: string;
}

export interface UploadedAsset {
  assetId: string;
  cdnUrl: string;
}

export async function uploadLocalAsset(deps: UploadLocalAssetDeps, args: UploadLocalAssetArgs): Promise<UploadedAsset> {
  const { http } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const uploadable = await createUploadableAsset(http, {
    assetType: args.assetType,
    mimeType: args.mimeType,
    extension: args.extension,
    group: args.group,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
  });
  await http.putBytes(uploadable.url, args.bytes, args.mimeType);

  // GET /asset/:id 404s (null) until GCS finalizes the upload, so null means "keep waiting" — the same
  // read orchestrate.ts and fabric.ts both already do.
  const asset = await poll({
    fetch: () => getAsset(http, uploadable.asset.id),
    decide: (a) =>
      a === null ? 'wait' : a.uploadState === 'FAILED' ? 'failed' : a.uploadState === 'UPLOADED' && a.cdnUrl ? 'done' : 'wait',
    label: `asset ${uploadable.asset.id} upload`,
    failMessage: (a) => `VEED: asset ${uploadable.asset.id} upload failed (state=${a?.uploadState ?? 'unknown'})`,
    sleep,
    intervalMs: UPLOAD_POLL_INTERVAL_MS,
    maxAttempts: UPLOAD_MAX_ATTEMPTS,
  });

  const cdnUrl = asset?.cdnUrl;
  if (!cdnUrl) throw new Error(`VEED: asset ${uploadable.asset.id} is UPLOADED but has no cdnUrl`);
  return { assetId: uploadable.asset.id, cdnUrl };
}

// Shared by background-removal.ts's and lipsync.ts's local-video inputs — both read a video file off
// disk the same way before handing its bytes to uploadLocalAsset above.
export async function readVideoBytes(videoPath: string): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const bytes = await readFile(videoPath);
  const ext = (extname(videoPath).slice(1) || 'mp4').toLowerCase();
  const mimeType = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  return { bytes, mimeType, extension: ext };
}
