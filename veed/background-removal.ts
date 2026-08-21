// Video background removal, two ways:
//
//   default   the live VEED route (POST /v1/remove-background) — free (VEED's own tracking on it is
//             non-blocking internal telemetry, not a credit deduction), authorized by a project's
//             CAN_WRITE permission.
//   --fast    the public fal model veed/video-background-removal/fast, reached the same way every other
//             generated asset in this repo reaches fal — the user's own key (pipeline/providers/fal.ts).
//             The live route has no fast variant, so this is the only way to get it. VEED login still
//             hosts the local file (so fal has a URL to fetch); the GENERATION call bills fal, not VEED.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type VeedHttp, unwrap, VEED_ORIGIN } from './api.ts';
import { getDefaultSpace, createProject } from './fabric-routes.ts';
import { describeWorkspaceChoice, formatWorkspaceTable, resolveWorkspace } from './workspace.ts';
import { uploadLocalAsset, readVideoBytes } from './asset-upload.ts';
import { parseFlags } from './args.ts';
import { resolveVideoArg, runKeyOf } from '../pipeline/scripts/resolve-video.ts';
import { FFPROBE, REPO_ROOT } from '../config.ts';
import { submitOnce, await_, download, firstUrl, falKey, completeJob, type Http as FalHttp } from '../pipeline/providers/fal.ts';
import { refreshingHttp } from './http.ts';
import { DEFAULT_TOKEN_PATH, resolveToken } from './token-store.ts';

export const FAL_BG_REMOVAL_FAST_MODEL = 'veed/video-background-removal/fast';

// fal's own listed rate for this model (fal.ai/models/veed/video-background-removal/fast, fetched
// 2026-08-19) — relayed as-is, not a VEED-derived constant, and not turned into a per-run dollar
// estimate (fal prices by OUTPUT frame count, which isn't known until the job finishes).
export const FAL_BG_REMOVAL_FAST_PRICE_NOTE =
  '$0.012 per 30 frames with edge refinement on (default) / $0.008 per 30 frames with it off';

export interface RemoveBackgroundStatusEntry {
  workflowId: string;
  projectId: string;
  workspaceId?: string;
  status: string;
  result?: { url: string };
}

export async function startRemoveBackground(
  http: VeedHttp,
  args: { videoUrl: string; projectId: string; workspaceId?: string; duration?: number; maskOnly?: boolean },
): Promise<{ workflowId: string }> {
  return unwrap(
    await http.postJson('/v1/remove-background', {
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
    await http.getJson(`/v1/remove-background/status?${q.toString()}`),
  );
  return res.statuses.find((s) => !args.workflowId || s.workflowId === args.workflowId);
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

// Best-effort: ffprobe missing or the file being unreadable must not block the call. Duration feeds
// VEED's cost telemetry (default mode only) — lipsync.ts reuses this same function.
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

export interface RemoveBackgroundDeps {
  http: VeedHttp;
  readVideoBytes: (videoPath: string) => Promise<{ bytes: Uint8Array; mimeType: string; extension: string }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  probeDuration?: (videoPath: string) => number | undefined;
  falHttp?: FalHttp;
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
  refineForegroundEdges?: boolean;
  falKey?: string;
}

export async function removeBackground(deps: RemoveBackgroundDeps, opts: RemoveBackgroundOptions): Promise<void> {
  if (opts.maskOnly && opts.fast) {
    throw new Error('--mask-only has no equivalent on the fast fal model (veed/video-background-removal/fast) — drop one flag');
  }
  if (opts.workspaceId && opts.fast) {
    throw new Error(
      '--workspace has no effect on the fast fal model (veed/video-background-removal/fast) — the fal ' +
      'call is unscoped, billed to your own fal account, not a VEED workspace; drop one flag',
    );
  }

  const { http } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const probeDuration = deps.probeDuration ?? probeDurationSec;

  const { bytes, mimeType, extension } = await deps.readVideoBytes(opts.videoPath);

  if (opts.fast) {
    const refine = opts.refineForegroundEdges ?? true;
    // No per-run dollar estimate: fal prices by OUTPUT frame count, not known until the job finishes.
    log(
      `[fal] ${FAL_BG_REMOVAL_FAST_MODEL} bills YOUR OWN fal account, not any VEED workspace. ` +
      `fal's listed rate: ${FAL_BG_REMOVAL_FAST_PRICE_NOTE}. This run: refine=${refine}.`,
    );

    // Unscoped: fal's own key authorizes the paid call, not a VEED project permission — VEED hosts the
    // file so fal has a URL to fetch, and that hosting step is not billed either way.
    const uploaded = await uploadLocalAsset({ http, sleep }, { bytes, mimeType, extension, assetType: 'VIDEO', group: 'srcVideo' });
    log(`uploaded ${uploaded.assetId} for hosting only`);

    const key = opts.falKey ?? falKey();
    const runDir = deps.runDir ?? join(REPO_ROOT, 'runs', runKeyOf(opts.videoPath));
    const input: Record<string, unknown> = { video_url: uploaded.cdnUrl, refine_foreground_edges: refine };
    const { job, reused } = await submitOnce(runDir, FAL_BG_REMOVAL_FAST_MODEL, input, { key, http: deps.falHttp, sleep });
    if (reused) log(`[fal] this exact request is already in the ledger as ${job.requestId} — resuming it rather than buying it again`);
    const result = await await_(job, { key, http: deps.falHttp, sleep, timeoutMs: deps.falTimeoutMs });
    const url = firstUrl(result.payload);
    if (!url) throw new Error(`fal returned no url for ${job.requestId}`);
    await download(url, opts.outPath, deps.falHttp);
    completeJob(runDir, FAL_BG_REMOVAL_FAST_MODEL, input);
    log(`wrote ${opts.outPath}`);
    return;
  }

  // default: the live, free VEED route. Scoped upload, because the route's own authorization is a
  // project's CAN_WRITE permission — there is no billing workspace to protect from an unscoped call, but
  // the project is what grants the request in the first place.
  const duration = probeDuration(opts.videoPath);
  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    const resolution = await resolveWorkspace({ http });
    if (resolution.kind === 'must-choose') {
      throw new Error(
        'VEED: this account has several workspaces — background removal runs inside a project scoped to ' +
        `one of them, so it will not be picked for you. Re-run naming it, for example --workspace ${resolution.workspaces[0].id}:\n` +
        `${formatWorkspaceTable(resolution.workspaces)}`,
      );
    }
    workspaceId = resolution.workspace.id;
    log(describeWorkspaceChoice(resolution.workspace, resolution.source));
  }
  const billedWorkspaceId: string = workspaceId;

  const spaceId = await getDefaultSpace(http, billedWorkspaceId);
  const projectId = await createProject(http, {
    name: `background-removal-${runKeyOf(opts.videoPath)}`,
    workspaceId: billedWorkspaceId,
    spaceId,
  });

  const uploaded = await uploadLocalAsset({ http, sleep }, {
    bytes, mimeType, extension, assetType: 'VIDEO', group: 'srcVideo', workspaceId: billedWorkspaceId, projectId,
  });
  log(`uploaded ${uploaded.assetId}`);

  const started = await startRemoveBackground(http, {
    videoUrl: uploaded.cdnUrl, projectId, workspaceId: billedWorkspaceId, duration, maskOnly: opts.maskOnly,
  });
  log(`remove-background workflow ${started.workflowId} — no VEED credits were charged for this run`);

  const final = await pollRemoveBackground(http, { workflowId: started.workflowId, projectId }, sleep);
  if (final.status !== 'COMPLETED' || !final.result?.url) {
    throw new Error(`VEED: remove-background workflow ${started.workflowId} ended as ${final.status}`);
  }

  // The result URL is fal's own (the live route runs on private fal apps under the hood) and may be
  // short-lived, so it is downloaded immediately.
  await download(final.result.url, opts.outPath, deps.falHttp);
  log(`wrote ${opts.outPath}`);
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
      'then re-run this command. The same login covers transcription, Fabric, and background removal',
      '(both modes — --fast still uses it to host the local file, though the removal itself bills fal).',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: {
      'mask-only': { type: 'boolean' },
      fast: { type: 'boolean' },
      'no-refine': { type: 'boolean' },
      out: { type: 'string' },
      workspace: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [videoArg] = positionals;
  if (!videoArg) {
    console.error('usage: node --import tsx veed/background-removal.ts <video.mp4> [--mask-only] [--fast] [--no-refine] [--out <path>] [--workspace <id>]');
    process.exit(1);
  }
  const videoPath = resolveVideoArg(videoArg);
  if (!existsSync(videoPath)) {
    console.error(`video not found: ${videoPath}`);
    process.exit(1);
  }
  const outPath = values.out ?? join(REPO_ROOT, 'runs', runKeyOf(videoPath), 'background-removed.mp4');

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

  await removeBackground(
    { http, readVideoBytes, log: (m) => console.log(`[bg-removal] ${m}`) },
    {
      videoPath, outPath, workspaceId: values.workspace, maskOnly: values['mask-only'], fast: values.fast,
      refineForegroundEdges: values['no-refine'] ? false : undefined,
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
