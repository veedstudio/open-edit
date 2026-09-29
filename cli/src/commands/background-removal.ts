// Video background removal, three ways:
//
//   default   the live VEED route (POST /remove-background): free, no credits are deducted, authorized
//             by a project's CAN_WRITE permission. The route is checked before any work; when it cannot
//             be used, the run stops having spent nothing and prints what --fal would cost and how to run it.
//   --fal     the public fal model veed/video-background-removal, on the user's own key. The local file
//             goes to fal's own storage, so no VEED login is needed for it. Only this flag ever buys it.
//   --fast    the public fal model veed/video-background-removal/fast, on the user's own key. The live
//             route has no fast variant. VEED login still hosts the local file (so fal has a URL to
//             fetch); the GENERATION call bills fal, not VEED.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { type VeedHttp, unwrap } from '../veed/api.ts';
import { getDefaultSpace, createProject } from '../veed/fabric-routes.ts';
import { uploadLocalAsset, readVideoBytes } from '../veed/asset-upload.ts';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { resolveVideoArg, runKeyOf } from '../resolve-video.ts';
import { FFPROBE, runsDir } from '../config.ts';
import {
  submitOnce, await_, download, firstUrl, falKey, completeJob, billedCost, listedPrices, describePrice, describeBilled,
  type Http as FalHttp,
} from '../providers/fal.ts';
import { uploadFile } from '../providers/fal-storage.ts';
import { createExclusive, processAlive, writeAtomic } from '../providers/exclusive-files.ts';
import { buyerRunning, jobKey } from '../providers/queue-ledger.ts';
import { refreshingHttp } from '../veed/http.ts';
import { resolveVeedToken } from '../veed/resolve-token.ts';
import { DEFAULT_WORKSPACE_PATH, rememberedWorkspace } from '../veed/workspace-store.ts';
import { pickProjectWorkspace } from '../veed/workspace.ts';

export const FAL_BG_REMOVAL_FAST_MODEL = 'veed/video-background-removal/fast';
export const FAL_BG_REMOVAL_MODEL = 'veed/video-background-removal';

// fal's own listed rate for this model (fal.ai/models/veed/video-background-removal/fast, fetched
// 2026-08-19) — relayed as-is, not a VEED-derived constant, and not turned into a per-run dollar
// estimate (fal prices by OUTPUT frame count, which isn't known until the job finishes).
export const FAL_BG_REMOVAL_FAST_PRICE_NOTE =
  '$0.012 per 30 frames with edge refinement on (default) / $0.008 per 30 frames with it off';

// fal's listed rates for the full model, per 30 OUTPUT frames. Output frames equal input frames for this
// model, so the estimate is the input's frame count at the rate for the run's setting.
export const FAL_BG_REMOVAL_RATE_PER_30_FRAMES = { refine: 0.0225, plain: 0.015 } as const;

export interface RemoveBackgroundStatusEntry {
  workflowId: string;
  projectId: string;
  workspaceId?: string;
  status: string;
  result?: { url: string };
}

// The API base already ends in /api/v1; a route written with its own /v1 prefix lands on a path the
// edge answers with a bare 404.
export async function startRemoveBackground(
  http: VeedHttp,
  args: { videoUrl: string; projectId: string; workspaceId?: string; duration?: number; maskOnly?: boolean },
): Promise<{ workflowId: string }> {
  return unwrap(
    await http.postJson('/remove-background', {
      videoUrl: args.videoUrl,
      projectId: args.projectId,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.duration !== undefined ? { duration: args.duration } : {}),
      ...(args.maskOnly !== undefined ? { maskOnly: args.maskOnly } : {}),
    }),
  );
}

// Empty statuses[] is a valid "not found yet" response, not an error — the caller (pollRemoveBackground
// below) treats "no matching entry" the same as any other still-pending state.
export async function getRemoveBackgroundStatus(
  http: VeedHttp,
  args: { workflowId?: string; projectId?: string },
): Promise<RemoveBackgroundStatusEntry | undefined> {
  const q = new URLSearchParams();
  if (args.workflowId) q.set('workflowId', args.workflowId);
  if (args.projectId) q.set('projectId', args.projectId);
  const res = unwrap<{ statuses: RemoveBackgroundStatusEntry[] }>(
    await http.getJson(`/remove-background/status?${q.toString()}`),
  );
  return res.statuses.find((s) => !args.workflowId || s.workflowId === args.workflowId);
}

/**
 * Why the free route cannot be used, or undefined when it can. A project-scoped status read makes the
 * route resolve the caller: a login it does not recognise comes back as "anonymous", a missing route as
 * the edge's own 404, and a 5xx or a failed connection means the route is not answering. Any other 4xx
 * (the placeholder project refused or not found) means the login got through, so the route is taken to
 * be usable.
 */
export function freeRouteProblem(error: unknown): string | undefined {
  const msg = error instanceof Error ? error.message : String(error);
  if (/-> 40[13]\b/.test(msg) && /anonymous/i.test(msg)) {
    return 'the free route does not accept this CLI login yet (it reads the token as anonymous)';
  }
  if (/-> 404\b/.test(msg) && /fault filter abort|Route [A-Z]+:\S+ not found/i.test(msg)) {
    return 'the free route is not reachable (404 from the edge)';
  }
  if (/-> 5\d\d\b/.test(msg) || /fetch failed|timed? ?out|ECONN|ENOTFOUND/i.test(msg)) {
    return `the free route is not answering (${msg.split('\n')[0].slice(0, 120)})`;
  }
  return undefined;
}

const PLACEHOLDER_PROJECT = '00000000-0000-0000-0000-000000000000';

export async function checkFreeRoute(http: VeedHttp): Promise<string | undefined> {
  try {
    await http.getJson(`/remove-background/status?projectId=${PLACEHOLDER_PROJECT}`);
    return undefined;
  } catch (e) {
    return freeRouteProblem(e);
  }
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'UNKNOWN']);

// This poll is a different animal from asset-upload's: a real video-processing job whose duration
// scales with the source, so it mirrors fal.ts's await_() convention (a wall-clock deadline, a few
// seconds between checks) rather than veed/poll.ts's fixed-interval convention.
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = 15 * 60_000;

async function pollRemoveBackground(
  http: VeedHttp,
  args: { workflowId: string; projectId?: string },
  sleep: (ms: number) => Promise<void>,
): Promise<RemoveBackgroundStatusEntry> {
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const entry = await getRemoveBackgroundStatus(http, args);
    if (entry && TERMINAL_STATUSES.has(entry.status)) return entry;
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
  throw new Error(
    `VEED: remove-background workflow ${args.workflowId} did not finish within ${STATUS_POLL_TIMEOUT_MS / 60_000} minutes`,
  );
}

// Best-effort: ffprobe missing or the file being unreadable must not block the call. Duration is
// reported to the route in default mode only — lipsync.ts reuses this same function.
export function probeDurationSec(videoPath: string): number | undefined {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    const dur = Number(out);
    return Number.isFinite(dur) ? dur : undefined;
  } catch {
    return undefined;
  }
}

/** Frames in the first video stream: the unit fal bills this model in. Best-effort, like the duration. */
export function probeFrameCount(videoPath: string): number | undefined {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,r_frame_rate,duration', '-of', 'json', videoPath],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    const s = (JSON.parse(out) as { streams?: { nb_frames?: string; r_frame_rate?: string; duration?: string }[] }).streams?.[0];
    const counted = Number(s?.nb_frames);
    if (Number.isFinite(counted) && counted > 0) return counted;
    const [n, d] = String(s?.r_frame_rate ?? '').split('/').map(Number);
    const frames = Number(s?.duration) * (d ? n / d : n);
    return Number.isFinite(frames) && frames > 0 ? Math.round(frames) : undefined;
  } catch {
    return undefined;
  }
}

export interface RemoveBackgroundDeps {
  /** Absent when there is no VEED login: the free route is then unavailable and fal is the only way. */
  http?: VeedHttp;
  readVideoBytes: (videoPath: string) => Promise<{ bytes: Uint8Array; mimeType: string; extension: string }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  probeDuration?: (videoPath: string) => number | undefined;
  probeFrames?: (videoPath: string) => number | undefined;
  falHttp?: FalHttp;
  /** Puts a local file on fal's storage for the full model; defaults to fal-storage's uploader. */
  uploadToFal?: (videoPath: string, key: string) => Promise<string>;
  /** The remembered workspace choice, if any; the free route prefers it when nobody names one. */
  rememberedWorkspace?: () => string | undefined;
  // The fal job ledger's directory. Defaults to runs/<key derived from videoPath> (main() below); tests
  // override it so they never write into this repo's own runs/ tree.
  runDir?: string;
  // Overrides fal.ts's await_() default (15 minutes) — tests use a short one rather than waiting out
  // the real deadline.
  falTimeoutMs?: number;
}

export interface RemoveBackgroundOptions {
  videoPath: string;
  outPath: string;
  workspaceId?: string;
  maskOnly?: boolean;
  fast?: boolean;
  /** fal's full model, bought on the user's own key; the only way this command spends on it. */
  fal?: boolean;
  refineForegroundEdges?: boolean;
  falKey?: string;
}

/** The output keeps the name asked for but takes the extension of what was actually returned. */
function withExtensionOf(outPath: string, url: string): string {
  const got = extname(new URL(url).pathname).toLowerCase();
  const want = extname(outPath).toLowerCase();
  return got && got !== want ? `${outPath.slice(0, outPath.length - want.length)}${got}` : outPath;
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function removeWithVeed(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions, http: VeedHttp): Promise<string> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const probeDuration = deps.probeDuration ?? probeDurationSec;

  // The route is free, so no workspace is billed: the pick only decides where its project is created,
  // which is why it is made for the caller and stated rather than asked.
  const ws = await pickProjectWorkspace(http, opts.workspaceId, deps.rememberedWorkspace?.(), 'background-removal project');
  log(`workspace ${ws.name} (${ws.id}): ${ws.why}. Background removal is free on this route, so this bills nothing; ` +
    'the workspace only holds the project it runs in.');

  const { bytes, mimeType, extension } = await deps.readVideoBytes(opts.videoPath);
  const duration = probeDuration(opts.videoPath);
  const spaceId = await getDefaultSpace(http, ws.id);
  const projectId = await createProject(http, { name: `background-removal-${runKeyOf(opts.videoPath)}`, workspaceId: ws.id, spaceId });

  const uploaded = await uploadLocalAsset({ http, sleep }, {
    bytes, mimeType, extension, assetType: 'VIDEO', group: 'srcVideo', workspaceId: ws.id, projectId,
  });
  log(`uploaded ${uploaded.assetId}`);

  let started: { workflowId: string };
  try {
    started = await startRemoveBackground(http, {
      videoUrl: uploaded.cdnUrl, projectId, workspaceId: ws.id, duration, maskOnly: opts.maskOnly,
    });
  } catch (e) {
    const problem = freeRouteProblem(e);
    if (!problem) throw e;
    // A start that timed out or failed server-side may still have begun the workflow; it bills nothing,
    // but whoever approves the paid route should know a free result may yet land.
    const maybe = /not answering/.test(problem) ? `; the free workflow may have started anyway, in project ${projectId}` : '';
    throw refusal(deps, opts, `${problem}${maybe}`);
  }
  log(`remove-background workflow ${started.workflowId} — no VEED credits were charged for this run`);

  const final = await pollRemoveBackground(http, { workflowId: started.workflowId, projectId }, sleep);
  if (final.status !== 'COMPLETED' || !final.result?.url) {
    throw new Error(
      `VEED: remove-background workflow ${started.workflowId} ended as ${final.status}. ` +
      "--fal runs fal's own model instead (bills your own fal account, not VEED).",
    );
  }

  // The result URL may be short-lived, so it is downloaded immediately.
  const out = withExtensionOf(opts.outPath, final.result.url);
  await download(final.result.url, out, deps.falHttp);
  log(`wrote ${out}`);
  return out;
}

/** What fal's full model would cost for this file: an estimate from the frame count, never a charge. */
function falEstimate(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions): string {
  const refine = opts.refineForegroundEdges ?? true;
  const frames = (deps.probeFrames ?? probeFrameCount)(opts.videoPath);
  const rate = refine ? FAL_BG_REMOVAL_RATE_PER_30_FRAMES.refine : FAL_BG_REMOVAL_RATE_PER_30_FRAMES.plain;
  return frames === undefined
    ? 'the frame count could not be read, so there is no estimate'
    : `about $${((frames / 30) * rate).toFixed(4)} (an estimate: ${frames} frames at $${rate} per 30 frames, edge refinement ${refine ? 'on' : 'off'}; fal bills by output frames)`;
}

const shellArg = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** The command that buys this same removal on fal, flags carried over, ready to paste. */
export function falCommandFor(opts: RemoveBackgroundOptions): string {
  const args = ['background-removal', opts.videoPath, '--fal'];
  if (opts.maskOnly) args.push('--mask-only');
  if (opts.refineForegroundEdges === false) args.push('--no-refine');
  // Absolute, so the command means the same thing from wherever it is pasted.
  args.push('--out', resolve(opts.outPath));
  return `npx @veedstudio/openedit-cli ${args.map(shellArg).join(' ')}`;
}

/**
 * The free route cannot run and nothing was bought. A command already running cannot ask anyone before
 * spending, so the paid alternative is handed back as a separate command for someone to approve.
 */
export class FreeRouteRefused extends Error {}

function refusal(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions, problem: string): FreeRouteRefused {
  return new FreeRouteRefused([
    `VEED: ${problem}. Nothing was bought.`,
    `The paid alternative is fal's ${FAL_BG_REMOVAL_MODEL}, billed to YOUR OWN fal account (not any VEED workspace), ` +
      `needing FAL_KEY. Cost: ${falEstimate(deps, opts)}.`,
    'Once that spend is approved, run:',
    `  ${falCommandFor(opts)}`,
  ].join('\n'));
}

/** fal's full model on the user's own key, with its cost stated before anything is bought. */
async function removeWithFal(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions): Promise<string> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const refine = opts.refineForegroundEdges ?? true;
  const key = opts.falKey ?? falKey();

  log(`[fal] ${FAL_BG_REMOVAL_MODEL} bills YOUR OWN fal account, not any VEED workspace. Cost: ${falEstimate(deps, opts)}.`);
  // Where the constant can be checked against what fal lists today, it is, so a stale rate shows up here.
  // fal's pricing API lists only the refinement-off rate, so that is the one compared.
  const listing = await listedPrices([FAL_BG_REMOVAL_MODEL], { key, http: deps.falHttp });
  const listed = listing.prices.get(FAL_BG_REMOVAL_MODEL);
  if (listed && !(listed.unit === '30 frames' && listed.unitPrice === FAL_BG_REMOVAL_RATE_PER_30_FRAMES.plain)) {
    log(`[fal] note: fal's pricing API now lists ${describePrice(listed)}, which differs from the rate above; the estimate may be stale.`);
  } else if (listing.unread) {
    log(`[fal] note: the rate above could not be checked against fal's list (${listing.unread}).`);
  }

  const { bytes } = await deps.readVideoBytes(opts.videoPath);
  const runDir = deps.runDir ?? join(runsDir(), runKeyOf(opts.videoPath));
  // One file with alpha by default; the mask alone comes as the alpha half of the two-file h264 output.
  const settings = { output_codec: opts.maskOnly ? 'h264' : 'vp9', refine_foreground_edges: refine };
  const identity = { video_url: `file:${digestOf(bytes)}`, ...settings };
  const upload = deps.uploadToFal ?? ((path: string, k: string) => uploadFile(path, { key: k, http: deps.falHttp }));
  const { job, reused, recovered, ledgerRecord } = await submitOnce(runDir, FAL_BG_REMOVAL_MODEL, identity, {
    key, http: deps.falHttp, sleep, identity,
    prepare: async () => {
      const url = await upload(opts.videoPath, key);
      log(`uploaded to fal storage for this job: ${url}`);
      return { video_url: url, ...settings };
    },
  });
  if (recovered) log(`[fal] found on fal's request history as ${job.requestId}: an earlier attempt sent this exact request and its acceptance never reached the ledger — resuming it rather than buying it again`);
  else if (reused) log(`[fal] this exact request is already in the ledger as ${job.requestId} — resuming it rather than buying it again`);
  try {
    const result = await await_(job, { key, http: deps.falHttp, sleep, timeoutMs: deps.falTimeoutMs, ledgerRecord });
    const videos = ((result.payload.video ?? []) as { url?: string; file_name?: string }[]).filter((v) => v.url);
    const pick = opts.maskOnly ? videos.find((v) => /alpha/i.test(v.file_name ?? v.url ?? '')) : videos[0];
    const url = pick?.url ?? (opts.maskOnly ? undefined : firstUrl(result.payload));
    if (!url) throw new Error(`fal returned no ${opts.maskOnly ? 'alpha video' : 'video'} for ${job.requestId}`);
    const out = withExtensionOf(opts.outPath, url);
    await download(url, out, deps.falHttp);
    completeJob(runDir, FAL_BG_REMOVAL_MODEL, identity);
    log(`wrote ${out}`);
    return out;
  } finally {
    // fal took the money on acceptance, so the charge is reported whether or not the job then finished,
    // once: by the run that bought it, or by the first run to resume it once that buyer is gone.
    const unreported = reused && !recovered && !buyerRunning(runDir, jobKey(FAL_BG_REMOVAL_MODEL, identity), job.requestId);
    const marker = join(ledgerRecord, `charged-${job.requestId.replace(/[^\w-]/g, '_')}.json`);
    if ((!reused || recovered || unreported) && claimChargeLine(marker)) {
      const origin = recovered ? '; bought by an earlier attempt whose acceptance never reached the ledger'
        : unreported ? '; bought by an earlier run that never reported it' : '';
      const billed = await billedCost(job.requestId, { key, http: deps.falHttp, sleep });
      log(`[fal] charged: ${describeBilled(billed)}${billed.kind === 'billed' ? '' : '; the estimate above stands as an estimate'} (request ${job.requestId})${origin}`);
      try {
        writeAtomic(marker, { at: new Date().toISOString(), pid: process.pid, host: hostname(), reported: true });
      } catch { /* left unreported, a later resume may print it again */ }
    }
  }
}

/**
 * Whether this run prints a request's charge line: the first to claim it does, and so does a later run
 * on this machine once that claimant died before printing it (the billing lookup can take minutes). A
 * claim that cannot be written or read still prints, because a charge reported twice beats one never reported.
 */
function claimChargeLine(marker: string): boolean {
  const mine = { at: new Date().toISOString(), pid: process.pid, host: hostname(), reported: false };
  try {
    if (createExclusive(marker, mine)) return true;
    const held = JSON.parse(readFileSync(marker, 'utf8')) as { pid?: unknown; host?: unknown; reported?: unknown };
    if (held.reported !== false || held.host !== hostname() || typeof held.pid !== 'number' || processAlive(held.pid)) return false;
    writeAtomic(marker, mine);
    return true;
  } catch {
    return true;
  }
}

async function removeFast(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions): Promise<string> {
  const http = deps.http;
  if (!http) throw new Error('--fast hosts the local file through the VEED login, and there is none; log in, or use --fal');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const refine = opts.refineForegroundEdges ?? true;
  // No per-run dollar estimate: fal prices by OUTPUT frame count, not known until the job finishes.
  log(
    `[fal] ${FAL_BG_REMOVAL_FAST_MODEL} bills YOUR OWN fal account, not any VEED workspace. ` +
    `fal's listed rate: ${FAL_BG_REMOVAL_FAST_PRICE_NOTE}. This run: refine=${refine}.`,
  );

  const { bytes, mimeType, extension } = await deps.readVideoBytes(opts.videoPath);
  const key = opts.falKey ?? falKey();
  const runDir = deps.runDir ?? join(runsDir(), runKeyOf(opts.videoPath));
  // The hosted url is new on every upload, so the job is known by the file's content: a re-run of the
  // same file resumes the job it already bought instead of hosting it again and buying it twice.
  const identity = { video_url: `file:${digestOf(bytes)}`, refine_foreground_edges: refine };
  const { job, reused, ledgerRecord } = await submitOnce(runDir, FAL_BG_REMOVAL_FAST_MODEL, identity, {
    key, http: deps.falHttp, sleep, identity,
    prepare: async () => {
      // Unscoped: fal's own key authorizes the paid call, not a VEED project permission — VEED hosts the
      // file so fal has a URL to fetch, and that hosting step is not billed either way.
      const uploaded = await uploadLocalAsset({ http, sleep }, { bytes, mimeType, extension, assetType: 'VIDEO', group: 'srcVideo' });
      log(`uploaded ${uploaded.assetId} for hosting only`);
      return { video_url: uploaded.cdnUrl, refine_foreground_edges: refine };
    },
  });
  if (reused) log(`[fal] this exact request is already in the ledger as ${job.requestId} — resuming it rather than buying it again`);
  const result = await await_(job, { key, http: deps.falHttp, sleep, timeoutMs: deps.falTimeoutMs, ledgerRecord });
  const url = firstUrl(result.payload);
  if (!url) throw new Error(`fal returned no url for ${job.requestId}`);
  const out = withExtensionOf(opts.outPath, url);
  await download(url, out, deps.falHttp);
  completeJob(runDir, FAL_BG_REMOVAL_FAST_MODEL, identity);
  log(`wrote ${out}`);
  return out;
}

export async function removeBackground(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions): Promise<string> {
  if (opts.fast && opts.fal) throw new Error('--fast and --fal name two different fal models — drop one flag');
  if (opts.maskOnly && opts.fast) {
    throw new Error('--mask-only has no equivalent on the fast fal model (veed/video-background-removal/fast) — drop one flag');
  }
  if (opts.workspaceId && (opts.fast || opts.fal)) {
    throw new Error(
      `--workspace has no effect on the ${opts.fast ? 'fast ' : ''}fal model — the fal call is unscoped, billed to your ` +
      'own fal account, not a VEED workspace; drop one flag',
    );
  }

  if (opts.fal) return removeWithFal(deps, opts);
  if (opts.fast) return removeFast(deps, opts);

  const problem = deps.http ? await checkFreeRoute(deps.http) : 'there is no VEED login on this machine';
  if (problem) throw refusal(deps, opts, problem);
  return removeWithVeed(deps, opts, deps.http!);
}

function noTokenHelp(): void {
  console.error(
    [
      'No VEED login found. Log in with VEED:',
      '',
      '  npx @veedstudio/openedit-cli login',
      '',
      'then re-run this command. The same login covers transcription, Fabric, and background removal',
      '(--fast still uses it to host the local file, though the removal itself bills fal).',
    ].join('\n'),
  );
}

export const usage = {
  summary: "Remove a video's background (free VEED route by default; --fal or --fast buys a fal model on your own key)",
  positionals: '<video.mp4>',
  flags: {
    'mask-only': { type: 'boolean', help: 'Write the alpha mask only, not the composited video' },
    fal: { type: 'boolean', help: "Buy fal's full model on your own fal key (cost stated before it runs); without --fal or --fast nothing is bought" },
    fast: { type: 'boolean', help: "fal's fast model instead of the free VEED route; bills your own fal key" },
    'no-refine': { type: 'boolean', help: 'Skip the edge refinement pass' },
    out: { type: 'string', value: '<path>', help: 'Output file (default runs/<key>/background-removed.mp4; the extension follows what is returned)' },
    workspace: { type: 'string', value: '<id>', help: "VEED workspace to hold the free route's project (default: remembered, else the first; bills nothing)" },
  },
} satisfies Usage;

export async function backgroundRemoval(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('background-removal', usage, argv);
  const [videoArg] = positionals;
  if (!videoArg) {
    console.error(usageLine('background-removal', usage));
    return 1;
  }
  const videoPath = resolveVideoArg(videoArg);
  if (!existsSync(videoPath)) {
    console.error(`video not found: ${videoPath}`);
    return 1;
  }
  const outPath = values.out ?? join(runsDir(), runKeyOf(videoPath), 'background-removed.mp4');

  const token = await resolveVeedToken();
  if (!token && values.fast) {
    noTokenHelp();
    return 1;
  }
  const http = token
    ? refreshingHttp(async () => {
      const t = await resolveVeedToken();
      if (!t) throw new Error('VEED login expired mid-run — re-run: npx @veedstudio/openedit-cli login');
      return t;
    })
    : undefined;

  await removeBackground(
    { http, readVideoBytes, rememberedWorkspace: () => rememberedWorkspace(DEFAULT_WORKSPACE_PATH, (m) => console.error(`[bg-removal] ${m}`)), log: (m) => console.log(`[bg-removal] ${m}`) },
    {
      videoPath, outPath, workspaceId: values.workspace, maskOnly: values['mask-only'], fast: values.fast,
      fal: values.fal,
      refineForegroundEdges: values['no-refine'] ? false : undefined,
    },
  );
  return 0;
}
