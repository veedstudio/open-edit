// Fabric talking-head generation, driven straight through VEED's public REST edge (see
// fabric-routes.ts for the individual routes). Every operation the rest of the code calls lives here,
// with the same names and shapes it has always had — only the transport underneath changed.
//
// THERE IS NO SERVER-SIDE PER-JOB PRICE. Pricing sits behind a service with no public route, and the
// per-event usage list is not readable with a user token, so estimateTotalCredits() below is the figure
// this code reports and it is OURS, not VEED's. Two controls are real, and the gates rest on them: the
// affordability check runs against the REAL workspace balance, and the balance is measured either side
// of the spend. Never let a report call the estimate a VEED quote.
import { type VeedHttp, getAsset, listWorkspaces } from './api.ts';
import { FABRIC_CHARACTERS } from './fabric-characters.ts';
import { describeValue } from './args.ts';
import {
  createGeneration,
  createProject,
  getDefaultSpace,
  getGeneration,
  getSpeechGeneration,
  listVoices as listVoicesRoute,
  synthesizeSpeech,
  transloadAsset,
} from './fabric-routes.ts';
import { createUploadableAsset } from './api.ts';
import { poll } from './poll.ts';

export interface FabricCharacter {
  id: string;
  name: string;
  thumbnail: string;
  gender: 'male' | 'female';
}

export interface FabricVoice {
  id: string;
  name: string;
  locale: string;
  localeLabel: string;
  gender: string;
  previewAudioUrl: string;
}

export interface FabricVoicePage {
  voices: FabricVoice[];
  totalCount: number;
  currentPage: number;
  totalPages: number;
  nextCursor?: string;
}

export interface FabricWorkspace {
  id: string;
  name: string;
}

// Where the speaking still comes from. A preset is a curated URL with a default voice; a URL or a local
// file is the user's own. Nothing downstream distinguishes them — the model takes an image asset id.
export type ImageSource =
  | { kind: 'character'; id: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string };

export interface VideoRequest {
  script: string;
  voiceId: string;
  // A preset id. Ignored when `image` names something else; kept so existing callers are unchanged.
  characterId: string;
  // The user's own still, when they brought one.
  image?: ImageSource;
  workspaceId?: string;
  // Supplied when the caller has already resolved it, which saves confirmVideo a second listing of
  // workspaces it would only read a name out of. Purely a label: it never decides which one is billed.
  workspaceName?: string;
  // How fast THIS voice speaks, when the caller knows. The estimate is a duration priced per second, so
  // the rate is what turns the script into money — see veed/voice-rates.ts. Left off, the module default
  // applies, which is only right for a caller that has no rate data at all.
  charsPerSecond?: number;
}

export interface FabricConfirmation extends VideoRequest {
  voiceName: string;
  characterName: string;
  workspaceName: string;
  estimatedCredits: number;
}

export interface FabricJob {
  jobId: string;
  // Optional because it is cosmetic: a create response has ALREADY charged the workspace by the time it is
  // read, so a run must never be failed over a field nothing depends on.
  status?: string;
  durationSeconds?: number;
}

export interface FabricStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  url: string | null;
  // The server's account of WHY a job failed, so the caller can log it and decide whether a re-submit is
  // worth it (a transient error is; an out-of-credits one is not). Absent on any non-failed status.
  errorReason?: string;
  errorCode?: string;
  timedOut?: boolean;
}

// Portrait framing is a property of the character, not a parameter: these ids carry a `_P_` marker in
// their thumbnail path, and character-15 verifiably rendered 480x864. Undocumented — re-check if Fabric
// adds real aspect control.
export const PORTRAIT_CHARACTER_IDS = [
  'character-1', 'character-6', 'character-11', 'character-14', 'character-15', 'character-17',
] as const;

// The same `_P_` marker, read off the listing instead of the frozen list above, so a character VEED
// adds tomorrow classifies itself. Query strings are ignored: only the asset path carries the marker.
export function isPortraitThumbnail(thumbnail: string): boolean {
  return thumbnail.split(/[?#]/)[0].includes('_P_');
}

// The one rule for reading a preset's shape, so the confirmation and anything that proposes a presenter
// cannot answer "what shape is this video?" differently.
export function framingOf(character: FabricCharacter): 'portrait' | 'landscape' {
  return isPortraitThumbnail(character.thumbnail) ? 'portrait' : 'landscape';
}

// Cost is priced per SECOND, not per character, and generating draws AI Playground credits TWICE — the
// speech is synthesized first, then Fabric One Lipsync generates the clip from it. Both debits land on
// the SAME credit allowance (speech used to bill a separate seconds allowance and no longer does), so
// the estimate a user approves is their SUM.
//
//   LIPSYNC  credits = floor(videoSeconds x rate), and NOT multiplied by resolution — the multiplier
//            VEED computes alongside it applies to its dollar estimate, not to credits. rate = 4.
//   SPEECH   credits = ceil(audioMinutes) x 2 — two credits per minute of generated audio, rounded UP to
//            the whole minute, so a 10-second read and a 59-second read both cost 2.
//
// floor(seconds x 4) reproduces every measured LIPSYNC run exactly across a 20x range: 1.36s->5,
// 1.60s->6, 4.86s->19, 6.00s->24, 29.56s->118. It is MEASURED rather than read: VEED's own configuration
// carries several different figures for this model, and none is what the workspace was actually charged.
// Take the formula from the service, the rate from the charges.
//
// The speech rate is the product's stated billing rule, not yet corroborated against a charge in
// isolation — the two debits share one allowance, so a balance delta cannot separate them. The full
// derivation, with the file and symbol each rule comes from, is kept internally — service names cannot
// appear in this file, which is published. Re-derive there if an estimate stops matching what runs are
// charged; veed/generate.ts prints the measured rate on every paid run so a drift shows.
//
// We hold only the SCRIPT before the spend, so duration is estimated from its length and then priced.
// Keeping the rates apart matters: the speaking rate is a property of the VOICE and will move, while the
// prices are VEED's and will move independently. Measured: 18.0 chars/second.
export const CHARS_PER_SECOND = 18;
export const CREDITS_PER_SECOND = 4;
export const TTS_CREDITS_PER_MINUTE = 2;

// The LIPSYNC credits alone — the Fabric One Lipsync generation, priced from the video duration. Kept
// apart from the speech charge so each rate stays correctable on its own evidence; anything quoting a
// TOTAL to a user wants estimateTotalCredits. The rate is the caller's to supply, because it belongs to
// the VOICE — see veed/voice-rates.ts.
export function estimateCredits(script: string, charsPerSecond: number = CHARS_PER_SECOND): number {
  return Math.floor((script.length / charsPerSecond) * CREDITS_PER_SECOND);
}

// Seconds of generated audio a script will draw, at a given rate. What the speech charge is priced from.
export function estimateSpeechSeconds(script: string, charsPerSecond: number = CHARS_PER_SECOND): number {
  return Math.ceil(script.length / charsPerSecond);
}

// The SPEECH credits — the text-to-speech synthesis, now billed from AI Playground credits rather than a
// separate seconds allowance. Two credits per minute of audio, rounded UP to the whole minute, so any
// read up to a minute costs 2. Priced from the SAME inferred duration the lipsync charge uses.
export function estimateSpeechCredits(script: string, charsPerSecond: number = CHARS_PER_SECOND): number {
  return Math.ceil(estimateSpeechSeconds(script, charsPerSecond) / 60) * TTS_CREDITS_PER_MINUTE;
}

// The whole AI-credit cost of one clip: the lipsync generation PLUS the speech synthesis, both drawn
// from the one credit allowance. This is the figure a user approves and is charged.
export function estimateTotalCredits(script: string, charsPerSecond: number = CHARS_PER_SECOND): number {
  return estimateCredits(script, charsPerSecond) + estimateSpeechCredits(script, charsPerSecond);
}

// What a script could cost across a spread of speaking rates, speech included. Quoted whenever the voice
// has never been measured, because one number there would be a guess wearing the clothes of a
// measurement. Slower speech makes a longer video, so the SLOW rate produces the HIGH figure.
export function estimateRange(script: string, rates: { slow: number; fast: number }): { low: number; high: number } {
  return {
    low: estimateTotalCredits(script, rates.fast),
    high: estimateTotalCredits(script, rates.slow),
  };
}

// The character list is a compiled-in constant on VEED's side too — listing characters there is a filter
// over the same hardcoded array, with no request behind it. See fabric-characters.ts.
export async function listCharacters(_http: VeedHttp, gender?: 'male' | 'female'): Promise<FabricCharacter[]> {
  const all = FABRIC_CHARACTERS.map((c) => ({ id: c.id, name: c.name, thumbnail: c.thumbnail, gender: c.gender }));
  return gender ? all.filter((c) => c.gender === gender) : all;
}

// The route returns every voice in one response, so the page shape is preserved by slicing locally —
// callers that page through a cursor keep working, and one that ignores it now sees everything at once.
const VOICE_PAGE_SIZE = 50;

export async function listVoices(
  http: VeedHttp,
  opts: { locale: string; gender?: 'Female' | 'Male' | 'Neutral'; cursor?: string },
): Promise<FabricVoicePage> {
  const all = await listVoicesRoute(http, { locale: opts.locale, gender: opts.gender });
  const voices: FabricVoice[] = all.map((v) => ({
    id: v.id,
    name: v.name,
    locale: v.locale,
    localeLabel: v.localeLabel ?? v.locale,
    gender: v.gender,
    previewAudioUrl: v.previewAudioUrl,
  }));
  // A cursor is the zero-based offset of the page to return; anything unparseable starts at the top
  // rather than throwing, because a bad cursor must not cost a caller its listing.
  const offset = Number.parseInt(opts.cursor ?? '0', 10);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const page = voices.slice(start, start + VOICE_PAGE_SIZE);
  const next = start + VOICE_PAGE_SIZE;
  return {
    voices: page,
    totalCount: voices.length,
    currentPage: Math.floor(start / VOICE_PAGE_SIZE) + 1,
    totalPages: Math.max(1, Math.ceil(voices.length / VOICE_PAGE_SIZE)),
    ...(next < voices.length ? { nextCursor: String(next) } : {}),
  };
}

// Named apart from api.ts's listWorkspaces on purpose: a different shape, and the two are one import
// away from colliding in a file that touches both flows.
export async function listFabricWorkspaces(http: VeedHttp): Promise<FabricWorkspace[]> {
  const workspaces = await listWorkspaces(http);
  return workspaces.map((w) => ({ id: w.id, name: w.name ?? w.id }));
}

// A workspace's AI Playground credit balance — the one allowance a generation now draws on. Read before
// a spend to check affordability, and either side of it to observe what moved.
export { getAllowances, type Allowances } from './allowances.ts';

// --- what comes back from VEED is a claim, not a type ---
//
// The server is a separate system that can rename, drop or re-type a field without this repo hearing about
// it. That is survivable for a listing and fatal for a spend, so the shapes that gate money are proved
// here rather than in generate.ts, and every caller inherits the check.

function badResponse(operation: string, detail: string): never {
  throw new Error(
    `${operation} answered with a payload that cannot be trusted: ${detail}. Nothing spent.\n` +
    'This is the server changing shape under us, not a mistake in the request — retry, and if it persists ' +
    'the contract has moved.',
  );
}

// Resolves the workspace a request bills, by the same rule as before: an explicit id wins, a single
// workspace is taken, and several without a choice is refused rather than guessed at.
async function resolveWorkspace(http: VeedHttp, req: VideoRequest): Promise<FabricWorkspace> {
  const workspaces = await listFabricWorkspaces(http);
  if (workspaces.length === 0) throw new Error('no VEED workspaces on this account');
  if (req.workspaceId) {
    // An id the caller named is taken as given. generate.ts owns the choice of workspace — it lists them,
    // shows the balances and makes the user name one — so re-deciding here would only mean a second,
    // stricter opinion about a question already answered. An id that is genuinely wrong fails at the
    // first scoped call, with the server's own message.
    const named = workspaces.find((w) => w.id === req.workspaceId);
    return named ?? { id: req.workspaceId, name: req.workspaceId };
  }
  if (workspaces.length > 1) {
    throw new Error('several workspaces on this account — name the one to bill rather than letting it be guessed');
  }
  return workspaces[0];
}

// The image a request will speak from, defaulting to the preset when none was brought. Kept in one place
// so confirmVideo and createVideo can never disagree about what is about to be generated.
export function imageSourceOf(req: VideoRequest): ImageSource {
  return req.image ?? { kind: 'character', id: req.characterId };
}

// What the approval block calls the presenter. A preset has a name; the user's own still is named by
// where it came from, because there is nothing else honest to call it.
function describePresenter(operation: string, req: VideoRequest): string {
  const source = imageSourceOf(req);
  if (source.kind === 'character') {
    const character = FABRIC_CHARACTERS.find((c) => c.id === source.id);
    if (!character) badResponse(operation, `characterId ${describeValue(source.id)} is not a known character`);
    return character.name;
  }
  if (source.kind === 'url') return `your image (${source.url})`;
  return `your image (${source.path})`;
}

// Turns whichever source into an image asset id. A URL is fetched by VEED itself; a local file is the
// only case where bytes leave this machine, and it waits for the upload to finalize before the id is
// used — an asset that is still UPLOADING would fail the generation after the money had moved.
async function resolveImageAsset(
  http: VeedHttp, deps: FabricDeps, req: VideoRequest, workspaceId: string, projectId: string,
): Promise<string> {
  const source = imageSourceOf(req);
  if (source.kind === 'character') {
    const character = FABRIC_CHARACTERS.find((c) => c.id === source.id)!;
    return transloadAsset(http, {
      sourceUrl: character.thumbnail,
      // 'png' for every preset regardless of the thumbnail's real suffix — the shape known to work end
      // to end. Do not "fix" it to match the URL without re-testing a generation.
      extension: 'png',
      assetType: 'IMAGE',
      workspaceId,
      projectId,
    });
  }
  if (source.kind === 'url') {
    return transloadAsset(http, {
      sourceUrl: source.url,
      extension: extensionOf(source.url),
      assetType: 'IMAGE',
      workspaceId,
      projectId,
    });
  }

  if (!deps.readFileBytes) {
    throw new Error('a local --image needs a file reader; pass readFileBytes to generate a video from one');
  }
  const extension = extensionOf(source.path);
  const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  const bytes = await deps.readFileBytes(source.path);
  const uploadable = await createUploadableAsset(http, {
    assetType: 'IMAGE', group: 'image', mimeType, extension, workspaceId, projectId,
  });
  await http.putBytes(uploadable.url, bytes, mimeType);
  // GET /asset/:id 404s (null) until the upload finalizes, so null means "keep waiting".
  await poll({
    fetch: () => getAsset(http, uploadable.asset.id),
    decide: (a) => (a === null ? 'wait' : a.uploadState === 'FAILED' ? 'failed' : a.uploadState === 'UPLOADED' ? 'done' : 'wait'),
    label: 'image upload',
    failMessage: (a) => `VEED: image upload failed (state=${a?.uploadState})`,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
    intervalMs: SPEECH_INTERVAL_MS,
    maxAttempts: SPEECH_MAX_ATTEMPTS,
  });
  return uploadable.asset.id;
}

// Lowercase, no dot, query strings ignored. Defaults to jpg rather than guessing wrong on a bare URL.
function extensionOf(ref: string): string {
  const path = ref.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg';
}

// Everything createVideo needs from the outside world. Optional so the preset path, which touches no
// local file, keeps working with no deps at all.
export interface FabricDeps {
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
}

// Spends nothing: it resolves the names the user needs to see and prices the script locally. The figure
// is OUR estimate — there is no per-job quote to ask for — so callers must not present it as VEED's.
export async function confirmVideo(http: VeedHttp, req: VideoRequest): Promise<FabricConfirmation> {
  const operation = 'confirm';
  if (!req.script.trim()) badResponse(operation, 'the script is empty, so there is nothing to price');

  const presenter = describePresenter(operation, req);

  const workspace = req.workspaceId && req.workspaceName
    ? { id: req.workspaceId, name: req.workspaceName }
    : await resolveWorkspace(http, req);
  // A voice id that does not exist would fail at synthesis, AFTER the project and assets are made, so it
  // is checked here while nothing has been spent.
  const voices = await listVoicesRoute(http, {});
  const voice = voices.find((v) => v.id === req.voiceId);
  if (!voice) badResponse(operation, `voiceId ${describeValue(req.voiceId)} is not a known voice`);

  const credits = estimateTotalCredits(req.script, req.charsPerSecond ?? CHARS_PER_SECOND);
  if (!Number.isFinite(credits) || credits < 0) {
    badResponse(operation, `the estimate came out as ${describeValue(credits)}, not a finite credit figure`);
  }
  return {
    ...req,
    workspaceId: workspace.id,
    voiceName: voice.name,
    characterName: presenter,
    workspaceName: workspace.name,
    estimatedCredits: credits,
  };
}

const SPEECH_INTERVAL_MS = 1000;
const SPEECH_MAX_ATTEMPTS = 60;

// THIS IS THE CALL THAT SPENDS. It is several requests rather than one, and the money moves partway
// through: synthesis bills first, the generation bills second. So everything before it must already be
// recoverable — veed/generate.ts writes its charge record before calling this, which is exactly right.
export async function createVideo(http: VeedHttp, req: VideoRequest, deps: FabricDeps = {}): Promise<FabricJob> {
  const operation = 'createVideo';
  describePresenter(operation, req);
  // Only the id is needed here — the NAME is a confirmation concern — so a workspace the caller already
  // named costs no request. That matters: generate.ts reads the balance immediately before this call, and
  // an extra round trip in between would put time, and any other billing, inside the measurement.
  const workspaceId = req.workspaceId ?? (await resolveWorkspace(http, req)).id;

  const spaceId = await getDefaultSpace(http, workspaceId);
  const projectId = await createProject(http, {
    name: `${req.script.slice(0, 40)}...`,
    workspaceId,
    spaceId,
  });

  const imageAssetId = await resolveImageAsset(http, deps, req, workspaceId, projectId);

  // An EMPTY audio asset plus a signed URL: the TTS route renders the mp3 into that URL server-side, so
  // no audio bytes are uploaded from here either.
  const tts = await createUploadableAsset(http, {
    assetType: 'AUDIO',
    group: 'TTS',
    assetSubType: 'TTS',
    mimeType: 'audio/mpeg',
    extension: 'mp3',
    storage: 'PERMANENT',
    workspaceId,
    projectId,
  });

  const speechId = await synthesizeSpeech(http, {
    workspaceId,
    projectId,
    assetId: tts.asset.id,
    text: req.script,
    voice: req.voiceId,
    uploadUrl: tts.url,
  });
  const speech = await poll({
    fetch: () => getSpeechGeneration(http, speechId),
    decide: (s) => (s.status === 'error' ? 'failed' : s.status === 'active' ? 'done' : 'wait'),
    label: 'speech synthesis',
    failMessage: (s) =>
      s.errorReason === 'outOfCredits'
        ? 'VEED: this workspace is out of AI Playground credits. Nothing further was spent.'
        : `VEED: speech synthesis failed (${s.errorReason ?? 'unknown'})`,
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    intervalMs: SPEECH_INTERVAL_MS,
    maxAttempts: SPEECH_MAX_ATTEMPTS,
  });

  const jobId = await createGeneration(http, {
    prompt: req.script,
    assetId: imageAssetId,
    audioAssetId: tts.asset.id,
    projectId,
    workspaceId,
  });
  if (typeof jobId !== 'string' || jobId === '') {
    badResponse(operation, `jobId is ${describeValue(jobId)}, not the id this run needs to collect the video`);
  }
  const duration = speech.duration;
  return {
    jobId,
    status: 'pending',
    durationSeconds: typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined,
  };
}

export async function getStatus(http: VeedHttp, jobId: string): Promise<FabricStatus> {
  const job = await getGeneration(http, jobId);
  const status: FabricStatus['status'] =
    job.status === 'failed' ? 'failed'
      : job.status === 'done' ? 'done'
        : job.status === 'processing' ? 'processing' : 'pending';
  // Only a finished job has an output asset to resolve, and the download URL lives on the asset rather
  // than on the job.
  if (status !== 'done' || !job.assetId) {
    const result: FabricStatus = { jobId, status, url: null };
    if (job.errorMessage !== undefined) result.errorReason = job.errorMessage;
    if (job.errorCode !== undefined) result.errorCode = job.errorCode;
    if (job.timedOut) result.timedOut = true;
    return result;
  }
  const asset = await getAsset(http, job.assetId);
  return { jobId, status, url: asset?.sourceUrl || asset?.cdnUrl || null };
}

export interface AwaitVideoDeps {
  sleep: (ms: number) => Promise<void>;
  onProgress?: (attempt: number, status: string) => void;
  // Defaults to the real clock so the deadline below always applies; tests inject a fake one.
  now?: () => number;
}

// Observed: a 12.7s clip took ~5 minutes, so the interval widens rather than hammering: 5s, 15s, then 30s.
const POLL_SCHEDULE_MS = [5_000, 15_000];
const POLL_STEADY_MS = 30_000;
// Exported because the charge lease is derived from it: a lease shorter than this deadline would declare a
// healthy, still-polling run dead and let a second charge through.
export const POLL_DEADLINE_MS = 15 * 60_000;
// By the time this polls, createVideo has already charged the workspace, so a transport blip (a 502, a
// timeout) must NOT throw the paid job away. Tolerate three CONSECUTIVE failures and reset on any answer;
// a run of four is a real outage, and the job id is on disk by then (see veed/generate.ts) so `--resume`
// can still collect the video without paying again.
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

// The server's verdict, told apart from a poll that merely gave up. They are opposite outcomes: a failed job
// is terminal and was not charged, so it can be re-submitted; a timeout may still be finishing server-side
// and must stay resumable rather than re-submitted. The caller cannot tell them apart from a message, hence
// the dedicated type — and it carries the server's reason so a retry can skip a cause no re-submit would fix.
export class FabricJobFailedError extends Error {
  readonly jobId: string;
  readonly reason?: string;
  readonly code?: string;
  readonly timedOut: boolean;
  constructor(jobId: string, reason?: string, code?: string, timedOut = false) {
    super(`Fabric job ${jobId} ${timedOut ? 'timed out server-side' : 'failed'}${reason ? `: ${reason}` : ''}`);
    this.name = 'FabricJobFailedError';
    this.jobId = jobId;
    this.reason = reason;
    this.code = code;
    this.timedOut = timedOut;
  }
}

export async function awaitVideo(http: VeedHttp, jobId: string, deps: AwaitVideoDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  const started = now();
  let consecutiveFailures = 0;

  for (let attempt = 0; ; attempt++) {
    let status: FabricStatus | null = null;
    try {
      status = await getStatus(http, jobId);
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures += 1;
      const detail = e instanceof Error ? e.message : String(e);
      if (consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(
          `Fabric job ${jobId}: status check failed ${consecutiveFailures} times in a row (${detail}). ` +
          'The job is already paid for and may still be running — retry with --resume rather than regenerating.',
        );
      }
      deps.onProgress?.(attempt, `status check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}), retrying: ${detail}`);
    }

    // Only a real answer is terminal: `failed` is the server's verdict, not a blip, so it aborts at once
    // instead of burning the retries above.
    if (status) {
      const outcome = status.status === 'failed' && status.timedOut ? 'timed out server-side' : status.status;
      const detail = status.status === 'failed' && status.errorReason
        ? `${outcome}: ${status.errorReason}`
        : outcome;
      deps.onProgress?.(attempt, detail);
      if (status.status === 'done') {
        if (!status.url) throw new Error(`Fabric job ${jobId} reported done with no url`);
        return status.url;
      }
      if (status.status === 'failed') {
        throw new FabricJobFailedError(jobId, status.errorReason, status.errorCode, status.timedOut);
      }
    }

    if (now() - started >= POLL_DEADLINE_MS) {
      throw new Error(`Fabric job ${jobId} timed out after ${Math.round(POLL_DEADLINE_MS / 60_000)} minutes (last status: ${status?.status ?? 'unavailable'})`);
    }
    await deps.sleep(POLL_SCHEDULE_MS[attempt] ?? POLL_STEADY_MS);
  }
}
