// fal, as the user's-own-key asset provider.
//
// This is the second half of the pattern transcription already has: VEED first because it is hosted
// and billed to a workspace we can quote, then the user's own key for everything VEED does not make.
// No credential passes through here in a log line, an error message or a manifest — the key is read,
// used as a header, and never written down.
//
// The endpoints below are DEFAULTS a 12-minute documentary reached for, not a catalogue. `--model`
// reaches any endpoint on the queue, and what one accepts, returns, costs and caps is on its own page
// — read that before the first call rather than inferring it from this list. That film's manifest
// records 66 voice takes, 11 sound effects, 10 image plates, 6 image-to-video clips and 6 music cues —
// 99 assets, of which the queue priced none.
//
// A JOB THAT WAS ACCEPTED HAS BEEN PAID FOR. The queue takes the money when it accepts the request,
// so a submit that times out or 502s may still have cost something. The job id is written down before
// the first poll, so a lost connection is recoverable instead of being paid for twice.
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { record } from './assets.ts';
import { dirname } from 'node:path';
import type { AssetKind } from './assets.ts';
import { jobKey, findJob, recordJob } from './queue-ledger.ts';

// The image and video defaults are the endpoints a 12-minute film verified against fal's live
// catalogue and then actually used — 10 stills at native 1920x1080 and 6 clips — rather than the
// newest ids anybody had heard of. Override with --model when a run wants something else.
//
// The audio kinds have NO default on purpose. Which voice, which effect bank and which music model a
// piece wants are choices with prices and licences attached, and the catalogue moves faster than a
// constant does — so `--model` is required there and the endpoint's own page is the thing to read.
export const FAL_MODELS = {
  image: 'fal-ai/recraft/v4.1/pro/text-to-image',
  video: 'fal-ai/bytedance/seedance-2.5/image-to-video',
} as const satisfies Partial<Record<AssetKind, string>>;

export interface FalJob {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

export interface FalResult {
  requestId: string;
  /** Whatever the endpoint returned; callers pick the url they need out of it. */
  payload: Record<string, unknown>;
  /** fal does not price a call in its response, so this is null and the manifest says so. */
  cost: number | null;
}

/** Injected so the queue logic is testable without a key, a network or a bill. */
export interface Http {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    status: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface FalOptions {
  key: string;
  http?: Http;
  /** Called with the job id the moment the queue accepts it — write it down before polling. */
  onAccepted?: (job: FalJob) => void | Promise<void>;
  /** Wall-clock ceiling. The documentary's own client gave up at 15 minutes. */
  timeoutMs?: number;
  /** Consecutive status failures tolerated before giving up; the job may still land server-side. */
  maxStatusFailures?: number;
  sleep?: (ms: number) => Promise<void>;
}

const QUEUE = 'https://queue.fal.run';

/**
 * No request carried a timeout, so a hung socket stalled the poll loop until the wall-clock deadline —
 * fifteen minutes of nothing, for one dropped connection. Adapting `fetch` once also removes the three
 * `as unknown as Http` casts that hid the omission.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function realHttp(timeoutMs: number): Http {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: () => res.json(), arrayBuffer: () => res.arrayBuffer() };
  };
}

/**
 * Statuses that cannot turn into a success by waiting: a revoked key, a request id that does not
 * exist, an input the endpoint refused. Retrying these three times and then telling the user to
 * "resume by request id" points them at a job that was never queued.
 */
const TERMINAL_STATUS = new Set([400, 401, 403, 404, 422]);

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
}

/** Never let a key reach a message: fal echoes the Authorization header in some error bodies. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join('«key»') : text;
}

/** The error body, best-effort. An unparseable one must not erase the status that explains it. */
async function snippet(res: { json(): Promise<unknown> }): Promise<string> {
  try {
    return JSON.stringify(await res.json()).slice(0, 400);
  } catch {
    return '(body was not JSON)';
  }
}

export async function submit(model: string, input: Record<string, unknown>, opts: FalOptions): Promise<FalJob> {
  const http = opts.http ?? realHttp(REQUEST_TIMEOUT_MS);
  const res = await http(`${QUEUE}/${model}`, {
    method: 'POST',
    headers: authHeaders(opts.key),
    body: JSON.stringify(input),
  });
  // The status is read BEFORE the body is parsed. A proxy's HTML 502 makes `res.json()` throw a
  // SyntaxError carrying a slice of that HTML — which replaced the real status with a parse error, and
  // (per `scrub` above) could carry the echoed Authorization header out with it.
  if (res.status >= 300) {
    throw new Error(scrub(`fal rejected the ${model} request (${res.status}): ${await snippet(res)}`, opts.key));
  }
  const body = (await res.json()) as Record<string, unknown>;
  const job: FalJob = {
    requestId: String(body.request_id ?? ''),
    statusUrl: String(body.status_url ?? `${QUEUE}/${model}/requests/${body.request_id}/status`),
    responseUrl: String(body.response_url ?? `${QUEUE}/${model}/requests/${body.request_id}`),
  };
  if (!job.requestId) throw new Error(`fal accepted the ${model} request but returned no request_id`);
  // Written down BEFORE the first poll: the queue has already taken the money.
  await opts.onAccepted?.(job);
  return job;
}

/** A refusal, not a blip — carried past the retry catch so it is not counted as one of three attempts. */
class Terminal extends Error {}

export async function await_(job: FalJob, opts: FalOptions): Promise<FalResult> {
  const http = opts.http ?? realHttp(REQUEST_TIMEOUT_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60 * 1000);
  const maxFailures = opts.maxStatusFailures ?? 3;
  let failures = 0;

  while (Date.now() < deadline) {
    let status: string | undefined;
    try {
      const res = await http(job.statusUrl, { method: 'GET', headers: authHeaders(opts.key) });
      if (TERMINAL_STATUS.has(res.status)) {
        throw new Terminal(scrub(`fal refused the status check for ${job.requestId} (${res.status}): ${await snippet(res)}`, opts.key));
      }
      if (res.status >= 300) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      failures = 0;
      status = String(body.status ?? '');
    } catch (e) {
      if (e instanceof Terminal) throw e;
      // A blip is not a failed job: the work continues server-side and is already paid for.
      if (++failures > maxFailures) {
        throw new Error(scrub(`fal status checks failed ${failures} times in a row for ${job.requestId}; the job may still complete — resume by request id rather than re-submitting`, opts.key));
      }
      await sleep(2000);
      continue;
    }

    if (status === 'COMPLETED') {
      const res = await http(job.responseUrl, { method: 'GET', headers: authHeaders(opts.key) });
      if (res.status >= 300) throw new Error(scrub(`fal returned ${res.status} for a completed job: ${await snippet(res)}`, opts.key));
      const payload = (await res.json()) as Record<string, unknown>;
      return { requestId: job.requestId, payload, cost: null };
    }
    if (status === 'FAILED') {
      // Do not retry here. A retry is a second charge, and the caller must decide to make it.
      throw new Error(`fal job ${job.requestId} failed; it has been paid for, so decide before re-submitting`);
    }
    await sleep(1500);
  }
  throw new Error(`fal job ${job.requestId} did not finish within the deadline; it may still complete — resume by request id`);
}

/** The first url in a fal payload, which is where every one of these endpoints puts its output. */
export function firstUrl(payload: Record<string, unknown>): string | undefined {
  const seen: unknown[] = [payload];
  while (seen.length) {
    const v = seen.shift();
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
    if (Array.isArray(v)) seen.push(...v);
    else if (v && typeof v === 'object') seen.push(...Object.values(v));
  }
  return undefined;
}

/** A signed URL's query string is a bearer credential with a clock on it; the path identifies the file. */
function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : `${url.slice(0, q)}?…`;
}

export async function download(url: string, dest: string, http?: Http): Promise<void> {
  const get = http ?? realHttp(DOWNLOAD_TIMEOUT_MS);
  const res = await get(url, { method: 'GET', headers: {} });
  if (res.status >= 300) throw new Error(`download failed (${res.status}) for ${redactUrl(url)}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Submit unless this exact request is already in the ledger.
 *
 * Identical input is the same job, and the queue charges on acceptance — so a retry after a lost
 * status poll must resume the job that exists rather than buy a second one. The run that motivated
 * this submitted an 8-second clip twice while the first was still running.
 */
export async function submitOnce(runDir: string, model: string, input: Record<string, unknown>, opts: FalOptions): Promise<{ job: FalJob; reused: boolean }> {
  const key = jobKey(model, input);
  const prior = findJob(runDir, key);
  if (prior) {
    return { job: { requestId: prior.requestId, statusUrl: prior.statusUrl, responseUrl: prior.responseUrl }, reused: true };
  }
  const job = await submit(model, input, {
    ...opts,
    onAccepted: async (j) => {
      // Written down before the caller's own hook, so a hook that throws cannot lose the id.
      recordJob(runDir, { key, model, requestId: j.requestId, statusUrl: j.statusUrl, responseUrl: j.responseUrl, submittedAt: new Date().toISOString() });
      await opts.onAccepted?.(j);
    },
  });
  return { job, reused: false };
}

/** Close a ledger entry, so a resume knows this one does not need picking up. */
export function completeJob(runDir: string, model: string, input: Record<string, unknown>): void {
  const key = jobKey(model, input);
  const prior = findJob(runDir, key);
  if (prior) recordJob(runDir, { ...prior, completedAt: new Date().toISOString() });
}

/**
 * The key, from the environment or from a file the user points at.
 *
 * There was no way to get one: `FalOptions.key` is required and nothing in the repository read an
 * environment variable or named a place to put it, so the first thing a run needing a generated asset
 * had to do was write its own client — and once it had one, every module here became a competitor to
 * code it had just written. That is how 1526 lines of one-off tooling happen.
 *
 * The key is read and returned. It is never printed, never written to a manifest, and never lands in
 * an error message: `scrub` exists because fal echoes the Authorization header in some error bodies.
 */
export function falKey(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.FAL_KEY ?? env.FAL_API_KEY;
  if (direct?.trim()) return direct.trim();

  const file = env.OPEN_EDIT_FAL_KEY_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`OPEN_EDIT_FAL_KEY_FILE points at ${file}, which does not exist`);
    // A key kept in a notes file sits among prose; take the first line that looks like a key and
    // nothing else, so the caller never has to paste the secret itself to make this work.
    const line = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_:-]{20,}$/.test(l));
    if (!line) throw new Error(`no key found in ${file} — expected a line of at least 20 key characters`);
    return line;
  }

  throw new Error(
    'no fal key: set FAL_KEY, or set OPEN_EDIT_FAL_KEY_FILE to a file holding it. ' +
    'Ask the user rather than guessing, and never echo the value back to them.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: {
      run: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' },
      prompt: { type: 'string' }, model: { type: 'string' }, from: { type: 'string' },
      input: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [verb] = positionals;

  if (verb === 'models') {
    for (const [kind, model] of Object.entries(FAL_MODELS)) console.log(`${kind.padEnd(7)} ${model}`);
    process.exit(0);
  }

  if (verb === 'generate') {
    const runDir = values.run;
    const id = values.id;
    const KINDS: AssetKind[] = ['image', 'video', 'speech', 'sfx', 'music', 'upscale'];
    const kind = values.kind as AssetKind | undefined;
    if (!runDir || !id || !kind) { console.error(`generate needs --run <dir> --id <asset-id> --kind <${KINDS.join('|')}>`); process.exit(2); }
    // A cast is not a check. `--kind speach --model …` submitted, was billed, downloaded, and wrote a
    // manifest row whose kind no consumer can route — and the missing-default guard below never fired
    // because a model WAS given.
    if (!KINDS.includes(kind)) { console.error(`unknown --kind "${kind}" — one of ${KINDS.join(', ')}`); process.exit(2); }
    const model = values.model ?? (FAL_MODELS as Record<string, string>)[kind];
    if (!model) {
      console.error(`kind "${kind}" has no default endpoint — pass --model <id>. fal's catalogue is on its own ` +
        `site; read the endpoint's page for its inputs, its ceilings and its price before you call it.`);
      process.exit(2);
    }

    // `--input` carries whatever the endpoint wants; `--prompt` is the one field every one of them
    // shares, so the common case needs no JSON.
    const input: Record<string, unknown> = values.input ? JSON.parse(values.input) : {};
    if (values.prompt) input.prompt = values.prompt;
    if (values.from) input.image_url = values.from;
    if (!Object.keys(input).length) { console.error('nothing to generate: pass --prompt or --input <json>'); process.exit(2); }

    const key = falKey();
    const { job, reused } = await submitOnce(runDir, model, input, { key });
    if (reused) console.log(`[fal] this exact request is already in the ledger as ${job.requestId} — resuming it rather than buying it again`);
    const result = await await_(job, { key });
    const url = firstUrl(result.payload);
    if (!url) { console.error(`fal returned no url for ${job.requestId}`); process.exit(1); }

    const ext = url.match(/\.(png|jpe?g|webp|mp4|mp3|wav|m4a)(?:$|\?)/i)?.[1]?.toLowerCase()
      ?? (kind === 'video' ? 'mp4' : kind === 'image' ? 'png' : 'mp3');
    const rel = `assets/${id}.${ext}`;
    await download(url, `${runDir}/${rel}`);
    completeJob(runDir, model, input);
    record(runDir, {
      id, kind, path: rel, provider: 'fal', model,
      prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
      from: values.from,
      createdAt: new Date().toISOString(),
      // fal prices nothing in its response, and a guessed figure is worse than none.
      cost: null,
      meta: { requestId: job.requestId },
    });
    console.log(`${rel} — ${model}`);
    process.exit(0);
  }

  console.error(
    'usage:\n' +
    '  fal.ts models\n' +
    '  fal.ts generate --run <dir> --id <asset-id> --kind <image|video|speech|sfx|music>\n' +
    '                  [--prompt "…"] [--model <endpoint>] [--from <image-url>] [--input \'{"…":…}\']\n' +
    'key: FAL_KEY, or OPEN_EDIT_FAL_KEY_FILE pointing at a file that holds it',
  );
  process.exit(2);
}
