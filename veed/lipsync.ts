// Lipsync (video + new audio -> re-lipsynced video), via the public fal model veed/lipsync/v2 — the
// user's own key, the same rail every other generated asset in this repo reaches fal through
// (pipeline/providers/fal.ts). There is no live VEED route for this model to fall back to (unlike
// background-removal.ts's default mode): the only VEED-side path is /ai-playground, and that is
// currently blocked. VEED login still hosts the local video + audio (so fal has URLs to fetch); the
// GENERATION call bills fal, not VEED.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type VeedHttp, VEED_ORIGIN } from './api.ts';
import { uploadLocalAsset, readVideoBytes } from './asset-upload.ts';
import { parseFlags } from './args.ts';
import { resolveVideoArg, runKeyOf } from '../pipeline/scripts/resolve-video.ts';
import { REPO_ROOT } from '../config.ts';
import { submitOnce, await_, download, firstUrl, falKey, completeJob, type Http as FalHttp } from '../pipeline/providers/fal.ts';
import { refreshingHttp } from './http.ts';
import { DEFAULT_TOKEN_PATH, resolveToken } from './token-store.ts';

export const FAL_LIPSYNC_V2_MODEL = 'veed/lipsync/v2';

// fal's own listed rate for this model (fal.ai/models/veed/lipsync/v2, fetched 2026-08-19) — relayed
// as-is, not a VEED-derived constant, and not turned into a per-run dollar estimate (fal prices by
// OUTPUT seconds, not known until the job finishes).
export const FAL_LIPSYNC_V2_PRICE_PER_SECOND = 0.07;

export interface LipsyncDeps {
  http: VeedHttp;
  readVideoBytes: (videoPath: string) => Promise<{ bytes: Uint8Array; mimeType: string; extension: string }>;
  readAudioBytes: (audioPath: string) => Promise<{ bytes: Uint8Array; mimeType: string; extension: string }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  falHttp?: FalHttp;
  runDir?: string;
  // Overrides fal.ts's await_() default (15 minutes) — tests use a short one rather than waiting out
  // the real deadline.
  falTimeoutMs?: number;
}

export interface LipsyncOptions {
  videoPath: string;
  audioPath: string;
  outPath: string;
  falKey?: string;
}

export async function runLipsync(deps: LipsyncDeps, opts: LipsyncOptions): Promise<void> {
  const { http } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  // No per-run dollar estimate: fal prices by OUTPUT seconds, not known until the job finishes.
  log(`[fal] ${FAL_LIPSYNC_V2_MODEL} bills YOUR OWN fal account, not any VEED workspace. fal's listed rate: $${FAL_LIPSYNC_V2_PRICE_PER_SECOND} per second of output video.`);

  const [video, audio] = await Promise.all([deps.readVideoBytes(opts.videoPath), deps.readAudioBytes(opts.audioPath)]);

  // Unscoped: fal's own key authorizes the paid call, not a VEED project permission — VEED hosts the
  // files so fal has URLs to fetch, and that hosting step is not billed either way. Concurrent: the two
  // uploads are independent, so there is no reason to pay for one's poll loop before starting the other.
  const [uploadedVideo, uploadedAudio] = await Promise.all([
    uploadLocalAsset({ http, sleep }, { bytes: video.bytes, mimeType: video.mimeType, extension: video.extension, assetType: 'VIDEO', group: 'srcVideo' }),
    uploadLocalAsset({ http, sleep }, { bytes: audio.bytes, mimeType: audio.mimeType, extension: audio.extension, assetType: 'AUDIO', group: 'srcVideo' }),
  ]);
  log(`uploaded video ${uploadedVideo.assetId} and audio ${uploadedAudio.assetId} for hosting only`);

  const key = opts.falKey ?? falKey();
  const runDir = deps.runDir ?? join(REPO_ROOT, 'runs', runKeyOf(opts.videoPath));
  const input: Record<string, unknown> = { video_url: uploadedVideo.cdnUrl, audio_url: uploadedAudio.cdnUrl };
  const { job, reused } = await submitOnce(runDir, FAL_LIPSYNC_V2_MODEL, input, { key, http: deps.falHttp, sleep });
  if (reused) log(`[fal] this exact request is already in the ledger as ${job.requestId} — resuming it rather than buying it again`);
  const result = await await_(job, { key, http: deps.falHttp, sleep, timeoutMs: deps.falTimeoutMs });
  const url = firstUrl(result.payload);
  if (!url) throw new Error(`fal returned no url for ${job.requestId}`);
  await download(url, opts.outPath, deps.falHttp);
  completeJob(runDir, FAL_LIPSYNC_V2_MODEL, input);
  log(`wrote ${opts.outPath}`);
}

async function readAudioBytes(audioPath: string): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const bytes = await readFile(audioPath);
  const ext = (extname(audioPath).slice(1) || 'mp3').toLowerCase();
  const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
  return { bytes, mimeType, extension: ext };
}

function resolveVeedToken(): Promise<string | null> {
  return resolveToken({ envToken: process.env.VEED_ACCESS_TOKEN, tokenPath: DEFAULT_TOKEN_PATH, expectedOrigin: VEED_ORIGIN });
}

function noTokenHelp(): void {
  console.error(
    [
      'No VEED login found. Log in with VEED:',
      '',
      '  node --import tsx veed/login.ts',
      '',
      'then re-run this command. The login only hosts the local video/audio; lipsync itself bills fal.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });
  const [videoArg, audioArg] = positionals;
  if (!videoArg || !audioArg) {
    console.error('usage: node --import tsx veed/lipsync.ts <video.mp4> <audio.mp3|wav|m4a> [--out <path>]');
    process.exit(1);
  }
  const videoPath = resolveVideoArg(videoArg);
  const audioPath = resolveVideoArg(audioArg);
  const missing = [videoPath, audioPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    console.error(missing.map((p) => `not found: ${p}`).join('\n'));
    process.exit(1);
  }
  const outPath = values.out ?? join(REPO_ROOT, 'runs', runKeyOf(videoPath), 'lipsync.mp4');

  const token = await resolveVeedToken();
  if (!token) {
    noTokenHelp();
    process.exit(1);
  }
  const http = refreshingHttp(async () => {
    const t = await resolveVeedToken();
    if (!t) throw new Error('VEED login expired mid-run — re-run: node --import tsx veed/login.ts');
    return t;
  });

  await runLipsync(
    { http, readVideoBytes, readAudioBytes, log: (m) => console.log(`[lipsync] ${m}`) },
    { videoPath, audioPath, outPath },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
