// The raw VEED public REST routes that Fabric generation needs (www.veed.io/api/v1) — one thin,
// typed wrapper per route and nothing else. fabric.ts composes these into the operations the rest of
// the code calls; keeping the two apart is what makes the composite chain readable.
//
// HTTP is injected (VeedHttp, shared with the transcription client) so the orchestration is testable
// offline. Response envelopes are normalised by unwrap().
import { randomUUID } from 'node:crypto';
import { type VeedHttp, unwrap } from './api.ts';

export const FABRIC_MODEL = 'veed/fabric-one-lipsync';

export interface Space {
  id: string;
}

export interface Project {
  id: string;
}

export interface Voice {
  id: string;
  name: string;
  locale: string;
  localeLabel?: string;
  gender: 'Female' | 'Male' | 'Neutral';
  provider?: string;
  description?: string;
  previewAudioUrl: string;
}

export interface SpeechGeneration {
  id: string;
  status: 'pending' | 'active' | 'error' | string;
  errorReason?: string;
  duration?: number;
}

export interface Generation {
  // Normalised: the route's 'queued' reads as pending, and 'error'/'timedOut' both read as failed.
  status: 'pending' | 'processing' | 'done' | 'failed' | string;
  assetId?: string;
  errorMessage?: string;
  errorCode?: string;
  // 'error' and 'timedOut' both normalise to failed, but only a timeout may already have been billed.
  timedOut?: boolean;
}

export async function getDefaultSpace(http: VeedHttp, workspaceId: string): Promise<string> {
  const space = unwrap<Space>(await http.getJson(`/workspace/${workspaceId}/space/default`));
  return space.id;
}

export async function createProject(
  http: VeedHttp,
  args: { name: string; workspaceId: string; spaceId: string },
): Promise<string> {
  // folderId and spaceId both carry the space; the route treats them as separate optional fields
  // rather than aliases, so both are sent.
  //
  // privacy is lowercase ('public' | 'private') — an uppercase spelling is a 400. We choose
  // 'private': this client downloads the finished mp4 and never needs a shareable link, so there is
  // no reason to make a user's project world-readable.
  const project = unwrap<Project>(
    await http.postJson('/project', {
      name: args.name,
      workspaceId: args.workspaceId,
      spaceId: args.spaceId,
      folderId: args.spaceId,
      privacy: 'private',
    }),
  );
  return project.id;
}

// Server-side fetch of a public URL into an asset: VEED pulls the image itself, so the bytes never
// pass through this process.
export async function transloadAsset(
  http: VeedHttp,
  args: {
    sourceUrl: string;
    extension: string;
    assetType: 'IMAGE' | 'AUDIO' | 'VIDEO';
    workspaceId: string;
    projectId: string;
  },
): Promise<string> {
  const res = unwrap<{ id?: string; asset?: { id: string } }>(
    await http.postJson('/asset/transload', {
      sourceUrl: args.sourceUrl,
      extension: args.extension,
      // Idempotency key for the transload job; a fresh one per call.
      taskId: randomUUID(),
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      assetType: args.assetType,
      requestedProcesses: [],
    }),
  );
  const id = res.asset?.id ?? res.id;
  if (!id) throw new Error('VEED: transload returned no asset id');
  return id;
}

// gender arrives from the route as a numeric string.
const VOICE_GENDER: Record<string, Voice['gender']> = { '0': 'Female', '1': 'Male', '2': 'Neutral' };

export async function listVoices(
  http: VeedHttp,
  filters: { locale?: string; gender?: Voice['gender'] } = {},
  origin = 'https://www.veed.io',
): Promise<Voice[]> {
  const raw = unwrap<Array<Record<string, unknown>>>(
    await http.getJson('/subtitles/synthesize/listVoices'),
  );
  let voices = raw.map((v) => ({
    id: String(v.id),
    name: String(v.name),
    locale: String(v.locale),
    localeLabel: v.localeLabel as string | undefined,
    gender: VOICE_GENDER[String(v.gender)] ?? 'Neutral',
    provider: v.provider as string | undefined,
    description: v.description as string | undefined,
    // The route returns no preview URL, so it is constructed from the voice and locale.
    previewAudioUrl:
      `${origin}/api/v1/subtitles/synthesize/preview` +
      `?voice=${encodeURIComponent(String(v.id))}&rate=1&locale=${encodeURIComponent(String(v.locale))}`,
  }));
  // Both filters are client-side — the route offers none.
  if (filters.locale) {
    const want = filters.locale.toLowerCase();
    voices = voices.filter((v) => v.locale.toLowerCase().startsWith(want));
  }
  if (filters.gender) voices = voices.filter((v) => v.gender === filters.gender);
  return voices;
}

// Hands the signed upload URL of an EMPTY audio asset to the TTS route, which renders the mp3 into
// it server-side. This client never uploads audio bytes.
export async function synthesizeSpeech(
  http: VeedHttp,
  args: {
    workspaceId: string;
    projectId: string;
    assetId: string;
    text: string;
    voice: string;
    uploadUrl: string;
  },
): Promise<string> {
  const started = unwrap<{ id: string }>(
    await http.postJson('/subtitles/synthesize/generate', {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      assetId: args.assetId,
      text: args.text,
      voice: args.voice,
      uploadUrl: args.uploadUrl,
    }),
  );
  return started.id;
}

export async function getSpeechGeneration(http: VeedHttp, id: string): Promise<SpeechGeneration> {
  return unwrap<SpeechGeneration>(await http.getJson(`/subtitles/synthesize/generate/${id}`));
}

export async function createGeneration(
  http: VeedHttp,
  args: {
    prompt: string;
    assetId: string;
    audioAssetId: string;
    projectId: string;
    workspaceId: string;
  },
): Promise<string> {
  const job = unwrap<{ id: string }>(
    await http.postJson('/ai-playground', {
      type: 'video',
      model: FABRIC_MODEL,
      prompt: args.prompt,
      assetId: args.assetId,
      audioAssetId: args.audioAssetId,
      projectId: args.projectId,
      workspaceId: args.workspaceId,
    }),
  );
  return job.id;
}

export async function getGeneration(http: VeedHttp, jobId: string): Promise<Generation> {
  const job = unwrap<{
    status?: string;
    error?: { message?: string; code?: string };
    output?: { assetId?: string };
  }>(await http.getJson(`/ai-playground/${jobId}`));

  if (job.status === 'error' || job.status === 'timedOut' || job.status === 'failed') {
    return {
      status: 'failed',
      errorMessage: job.error?.message,
      errorCode: job.error?.code,
      timedOut: job.status === 'timedOut',
    };
  }
  const raw = job.status || 'pending';
  return { status: raw === 'queued' ? 'pending' : raw, assetId: job.output?.assetId };
}
