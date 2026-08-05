// The VEED-native transcription orchestration: workspace -> upload -> poll-ready -> transcribe ->
// poll-active -> map to the editor's transcript shape. HTTP + file reading + sleep are
// injected so the call sequence is testable offline (see orchestrate.test.ts). go.ts wires the real ones.
import type { VeedHttp } from './api.ts';
import {
  listWorkspaces,
  createUploadableAsset,
  getAsset,
  startTranscription,
  getSubtitle,
} from './api.ts';
import { mapVeedTranscript } from './transcript-mapper.ts';
import type { Transcript } from './transcript-mapper.ts';

export interface TranscribeDeps {
  http: VeedHttp;
  readVideoBytes: (videoPath: string) => Promise<{ bytes: Uint8Array; mimeType: string; extension: string }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface TranscribeOptions {
  videoPath: string;
  workspaceId?: string;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export async function transcribeWithVeed(deps: TranscribeDeps, opts: TranscribeOptions): Promise<Transcript> {
  const { http, readVideoBytes } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 60;

  async function poll<T>(
    fetchFn: () => Promise<T>,
    decide: (v: T) => 'done' | 'failed' | 'wait',
    label: string,
    failMessage: (v: T) => string,
  ): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const value = await fetchFn();
      const state = decide(value);
      if (state === 'failed') throw new Error(failMessage(value));
      if (state === 'done') return value;
      await sleep(pollIntervalMs);
    }
    throw new Error(`VEED: ${label} did not finish after ${maxAttempts} polls (${pollIntervalMs}ms each)`);
  }

  // 1. resolve a workspace (the asset + transcription need a real owner)
  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    const workspaces = await listWorkspaces(http);
    if (workspaces.length === 0) throw new Error('VEED: account has no workspace to own the asset');
    workspaceId = workspaces[0].id;
  }
  log(`workspace ${workspaceId}`);

  // 2. mint a signed upload URL, then PUT the bytes to GCS. The upload is UNSCOPED: the asset is
  // owned by its creator, and no project is involved anywhere in this flow. The transcribe route
  // authorizes on asset ownership + workspace billing.
  const { bytes, mimeType, extension } = await readVideoBytes(opts.videoPath);
  const uploadable = await createUploadableAsset(http, { mimeType, extension });
  await http.putBytes(uploadable.url, bytes, mimeType);
  log(`uploading asset ${uploadable.asset.id}`);

  // 3. wait for the asset to finish uploading. GET /asset/:id 404s (null)
  // until GCS finalizes the upload, so null means "keep waiting".
  const asset = await poll(
    () => getAsset(http, uploadable.asset.id),
    (a) =>
      a === null
        ? 'wait'
        : a.uploadState === 'FAILED'
          ? 'failed'
          : a.uploadState === 'UPLOADED' && a.cdnUrl
            ? 'done'
            : 'wait',
    'asset upload',
    (a) => `VEED: asset upload failed (state=${a?.uploadState})`,
  );
  const cdnUrl = asset?.cdnUrl;
  if (!cdnUrl) throw new Error('VEED: asset is UPLOADED but has no cdnUrl to transcribe');
  log(`asset ready ${cdnUrl}`);

  // 4. start transcription, billed to the workspace resolved above.
  const started = await startTranscription(http, {
    assetId: uploadable.asset.id,
    workspaceId,
    videoUrl: cdnUrl,
  });
  log(`transcription ${started.id} (${started.status})`);

  // 5. poll until the transcript is ready
  const subtitle = await poll(
    () => getSubtitle(http, started.id),
    (s) => (s.status === 'error' ? 'failed' : s.status === 'active' ? 'done' : 'wait'),
    'transcription',
    (s) =>
      // The likeliest failure by far, so it carries the allowance and the fix rather than a reason code.
      s.errorReason === 'outOfCredits'
        ? 'VEED: this workspace is out of transcription credits. A free account covers about 2 minutes '
          + 'a month; more needs a plan — https://www.veed.io/pricing. Or transcribe locally instead: '
          + 'node --import tsx prep/transcribe.ts <video.mp4>'
        : `VEED: transcription failed (${s.errorReason ?? 'unknown'})`,
  );
  if (!subtitle.subtitles) throw new Error('VEED: transcription active but returned no subtitles track');

  // 6. map to the editor's on-disk transcript shape
  return mapVeedTranscript(subtitle.subtitles);
}
