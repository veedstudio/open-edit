// fal, as the user's-own-key asset provider.
//
// This is the second half of the pattern transcription already has: VEED first because it is hosted
// and billed to a workspace we can quote, then the user's own key for everything VEED does not make.
// No credential passes through here in a log line, an error message or a manifest — the key is read,
// used as a header, and never written down.
//
// The command that reaches any endpoint is `openedit fal run` (commands/fal.ts); what an endpoint
// accepts and returns is `openedit fal schema <model>`, read before the first call.
//
// A JOB THAT WAS ACCEPTED HAS BEEN PAID FOR. The queue takes the money when it accepts the request,
// so a submit that times out or 502s may still have cost something. The job id is written down before
// the first poll, so a lost connection is recoverable instead of being paid for twice.
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jobKey, ledgerDir, markDone, claimJob, canonicalJson, type Attempt, type ClaimOptions, type LedgerEntry, type Recovery } from './queue-ledger.ts';
import { errorText } from '../proxy.ts';

export interface FalJob {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

/** fal prices nothing in a result; what a request cost comes from `billedCost`. */
export interface FalResult {
  requestId: string;
  /** Whatever the endpoint returned; callers pick the url they need out of it. */
  payload: Record<string, unknown>;
}

/** Injected so the queue logic is testable without a key, a network or a bill. */
export interface Http {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }): Promise<{
    status: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    /** Absent on fakes; a multipart part answers with its ETag here. */
    header?(name: string): string | null;
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
  /** The job's record in the run's job ledger (submitOnce's `ledgerRecord`): what a failed job's message says to remove to buy it again. */
  ledgerRecord?: string;
  sleep?: (ms: number) => Promise<void>;
}

const QUEUE = 'https://queue.fal.run';
const PLATFORM = 'https://api.fal.ai/v1';

/**
 * Status and result live under the app (owner/alias), not under the full endpoint path: a model id
 * with a sub-path such as `fal-ai/flux/dev/image-to-image` polls at `fal-ai/flux/requests/<id>`.
 */
export function queueUrls(model: string, requestId: string): { statusUrl: string; responseUrl: string } {
  const parts = model.split('/');
  const app = (['workflows', 'comfy'].includes(parts[0]) ? parts.slice(0, 3) : parts.slice(0, 2)).join('/');
  return { statusUrl: `${QUEUE}/${app}/requests/${requestId}/status`, responseUrl: `${QUEUE}/${app}/requests/${requestId}` };
}

/**
 * No request carried a timeout, so a hung socket stalled the poll loop until the wall-clock deadline —
 * fifteen minutes of nothing, for one dropped connection. Adapting `fetch` once also removes the three
 * `as unknown as Http` casts that hid the omission.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export function realHttp(timeoutMs: number): Http {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: res.status,
      json: () => res.json(),
      arrayBuffer: () => res.arrayBuffer(),
      header: (name: string) => res.headers.get(name),
    };
  };
}

/**
 * Statuses that cannot turn into a success by waiting: a revoked key, a request id that does not
 * exist, an input the endpoint refused. Retrying these three times and then telling the user a re-run
 * resumes the request points them at a job that was never queued.
 */
const TERMINAL_STATUS = new Set([400, 401, 403, 404, 422]);

export function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
}

/** Never let a key reach a message: fal echoes the Authorization header in some error bodies. */
export function scrub(text: string, key: string): string {
  return key ? text.split(key).join('«key»') : text;
}

/** The error body, best-effort. An unparseable one must not erase the status that explains it. */
export async function snippet(res: { json(): Promise<unknown> }): Promise<string> {
  try {
    return JSON.stringify(await res.json()).slice(0, 400);
  } catch {
    return '(body was not JSON)';
  }
}

/** The queue refused the request outright, so nothing was bought and a corrected retry is safe. */
export class Refused extends Error {}

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
    // A 4xx is the queue saying no before taking anything; a 5xx or a proxy page says nothing about
    // whether the request got in, so it must not be read as a refusal a retry could safely follow.
    if (res.status < 500) throw new Refused(scrub(`fal rejected the ${model} request (${res.status}): ${await snippet(res)}`, opts.key));
    throw new Error(scrub(`fal's queue answered the ${model} request with ${res.status}: ${await snippet(res)}`, opts.key));
  }
  const body = (await res.json()) as Record<string, unknown>;
  const requestId = String(body.request_id ?? '');
  if (!requestId) throw new Error(`fal accepted the ${model} request but returned no request_id`);
  const fallback = queueUrls(model, requestId);
  const job: FalJob = {
    requestId,
    statusUrl: String(body.status_url ?? fallback.statusUrl),
    responseUrl: String(body.response_url ?? fallback.responseUrl),
  };
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
        throw new Error(scrub(`fal status checks failed ${failures} times in a row for ${job.requestId}; the job may still complete. ${RESUMES(job)}`, opts.key));
      }
      await sleep(2000);
      continue;
    }

    if (status === 'COMPLETED') {
      const res = await http(job.responseUrl, { method: 'GET', headers: authHeaders(opts.key) });
      if (res.status >= 300) throw new Error(scrub(`fal returned ${res.status} for a completed job: ${await snippet(res)}`, opts.key));
      const payload = (await res.json()) as Record<string, unknown>;
      return { requestId: job.requestId, payload };
    }
    if (status === 'FAILED') {
      // Do not retry here. A retry is a second charge, and the caller must decide to make it.
      throw new JobFailed(
        `fal job ${job.requestId} failed after fal accepted it, so it has been paid for. Re-running the same command ` +
        "resumes this failed request rather than buying a new one; buying it again is a second charge, made by removing " +
        `its record from the run's job ledger${opts.ledgerRecord ? `, ${opts.ledgerRecord},` : ''} first.`,
      );
    }
    await sleep(1500);
  }
  throw new Error(`fal job ${job.requestId} did not finish within the deadline; it may still complete. ${RESUMES(job)}`);
}

const RESUMES = (job: FalJob) => `Re-running the same command resumes request ${job.requestId}; it does not buy it again.`;

/** fal ran a job it had accepted and reported it failed: paid for, and re-running only finds it again. */
export class JobFailed extends Error {}

/**
 * The ledger holds a request as possibly bought, so a re-run looks for it on fal's request history
 * instead of buying it again. `sent`: it left and no answer said whether fal took it. Otherwise fal
 * refused it or it never left, so nothing was bought, and only the record of that could not be written.
 */
export class PossiblyBought extends Error {
  constructor(message: string, readonly sent: boolean, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * The first url in a fal payload: enough for an endpoint that returns a single file, or as the fallback
 * once picking by name found nothing. A multi-file output needs its files picked by name.
 */
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
export function redactUrl(url: string): string {
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

export interface SubmitOnceOptions extends FalOptions {
  /**
   * What makes two requests the same job, when it differs from the body sent: a local file is known by
   * its content hash before it is uploaded, while the url it uploads to is new every time.
   */
  identity?: unknown;
  /** Builds the body once this caller holds the claim (uploads happen here, never for a reused job). */
  prepare?: () => Promise<Record<string, unknown>>;
  ledger?: Omit<ClaimOptions, 'recover'>;
}

export interface SubmitOnceResult {
  job: FalJob;
  reused: boolean;
  /**
   * Found on fal's request history for an attempt whose acceptance never reached the ledger, so its
   * charge may never have been reported; a caller that keeps its own record of charges checks it first.
   * Only the caller that adopted it hears this.
   */
  recovered: boolean;
  /** The job's record in the ledger: removing it is what makes a re-run buy the request again. */
  ledgerRecord: string;
}

/**
 * Submit unless this exact request is already in the ledger.
 *
 * Identical input is the same job, and the queue charges on acceptance, so a retry after a lost
 * status poll must resume the job that exists rather than buy a second one, and N callers asking for
 * it at once buy it once. The claim is taken before anything is sent (see queue-ledger.ts); an attempt
 * that may have been accepted without its id being written is looked up on the queue, not re-bought.
 */
export async function submitOnce(runDir: string, model: string, input: Record<string, unknown>, opts: SubmitOnceOptions): Promise<SubmitOnceResult> {
  const key = jobKey(model, opts.identity ?? input);
  const ledgerRecord = join(ledgerDir(runDir), key);
  const outcome = await claimJob(runDir, key, model, {
    ...opts.ledger,
    sleep: opts.ledger?.sleep ?? opts.sleep,
    recover: (attempt) => findSubmitted(model, attempt, opts),
  });
  if (outcome.kind === 'reuse') return { job: jobOf(outcome.entry), reused: true, recovered: outcome.recovered === true, ledgerRecord };

  const { claim } = outcome;
  let body: Record<string, unknown>;
  try {
    body = opts.prepare ? await opts.prepare() : input;
    claim.submitting(body);
  } catch (e) {
    claim.abandon(e instanceof Error ? e.message : String(e));
    throw e;
  }
  let heard: FalJob | undefined;
  let unwritten: Error | undefined;
  try {
    const job = await submit(model, body, {
      ...opts,
      onAccepted: async (j) => {
        heard = j;
        // Written down before the caller's own hook, so a hook that throws cannot lose the id. A write
        // that fails must not lose it either: the caller still hears it, and so does the error.
        try {
          claim.accepted(j);
        } catch (e) {
          await opts.onAccepted?.(j);
          unwritten = new Error(`fal accepted the ${model} request as ${j.requestId}, so it is bought, but recording that failed: ${errorText(e)}`);
          throw unwritten;
        }
        await opts.onAccepted?.(j);
      },
    });
    return { job, reused: false, recovered: false, ledgerRecord };
  } catch (e) {
    if (claim.state !== 'submitting') throw e;
    const why = errorText(e);
    if (heard) {
      // fal's acceptance was seen, so this is bought, not possibly bought; the ledger gets whatever can still be written.
      try {
        claim.accepted(heard);
        // The failed write was all that went wrong, and it is in the ledger now: the job goes on. A hook's own error still propagates.
        if (e === unwritten) return { job: heard, reused: false, recovered: false, ledgerRecord };
      } catch {
        try { claim.uncertain(why); } catch { /* left sending, it reads as possibly sent once its lease runs out */ }
      }
      throw e;
    }
    const lookedUp = "so the ledger holds it as possibly bought: a re-run looks for it on fal's request history instead of buying it";
    if (e instanceof Refused || neverSent(e)) {
      try {
        claim.refused(why);
      } catch (w) {
        // Left `submitting`, the attempt reads as possibly sent once its lease runs out.
        throw new PossiblyBought(`${why}. Nothing was bought, but recording that it never got in failed (${errorText(w)}), ${lookedUp}`, false, { cause: e });
      }
      throw e;
    }
    let unrecorded = '';
    try {
      claim.uncertain(why);
    } catch (w) {
      unrecorded = `; recording that failed too (${errorText(w)}), and the attempt reads the same way once its lease runs out`;
    }
    throw new PossiblyBought(`${why}. fal may have accepted it before the answer was lost, ${lookedUp} again${unrecorded}`, true, { cause: e });
  }
}

/** Failures before a byte of the request left this machine, so the queue cannot have taken it. */
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

function neverSent(e: unknown): boolean {
  for (let c = (e as { cause?: unknown } | undefined)?.cause, depth = 0; c && typeof c === 'object' && depth < 5; c = (c as { cause?: unknown }).cause, depth++) {
    const { code, message } = c as { code?: unknown; message?: unknown };
    if (NEVER_SENT.has(String(code))) return true;
    // A proxy that refused the CONNECT tunnel never passed the request on; undici says so only in prose.
    if (code === 'UND_ERR_ABORTED' && /when HTTP Tunneling/.test(String(message))) return true;
  }
  return false;
}

function jobOf(e: Pick<LedgerEntry, 'requestId' | 'statusUrl' | 'responseUrl'>): FalJob {
  return { requestId: e.requestId, statusUrl: e.statusUrl, responseUrl: e.responseUrl };
}

const HISTORY_PAGES = 10;

/**
 * Finds, on the queue's own request history, the request an interrupted attempt sent: same endpoint,
 * same body, sent after that attempt began. A request still waiting in the queue may not be listed
 * yet, which is why "not listed" leaves the job unresolved rather than free to buy; a history that
 * could not be read says so, because telling the user it was searched would be false.
 */
export async function findSubmitted(model: string, attempt: Attempt, opts: Pick<FalOptions, 'key' | 'http'>): Promise<Recovery> {
  if (attempt.body === undefined) return { kind: 'unsearched', why: 'the attempt record holds no request body to match', lasting: true };
  const http = opts.http ?? realHttp(REQUEST_TIMEOUT_MS);
  // A minute of slack before the recorded send covers clock skew between here and the queue.
  const since = new Date(Date.parse(attempt.submittingAt ?? attempt.claimedAt) - 60_000).toISOString();
  const want = canonicalJson(attempt.body);
  let cursor: string | undefined;
  try {
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const q = new URLSearchParams({ endpoint_id: model, start: since, expand: 'payloads', limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const res = await http(`${PLATFORM}/models/requests/by-endpoint?${q}`, { method: 'GET', headers: authHeaders(opts.key) });
      if (res.status >= 300) return { kind: 'unsearched', why: scrub(`the history answered ${res.status}: ${await snippet(res)}`, opts.key) };
      const body = (await res.json()) as { items?: { request_id?: string; json_input?: unknown }[]; next_cursor?: string | null };
      const hit = (body.items ?? []).find((i) => i.request_id && canonicalJson(i.json_input) === want);
      if (hit?.request_id) return { kind: 'found', job: { requestId: hit.request_id, ...queueUrls(model, hit.request_id) } };
      if (!body.next_cursor) return { kind: 'not-listed' };
      cursor = body.next_cursor;
    }
  } catch (e) {
    return { kind: 'unsearched', why: scrub(`the history could not be read: ${errorText(e)}`, opts.key) };
  }
  // The window starts at the attempt, so it only grows: a re-run cannot get further than this one did.
  return { kind: 'unsearched', why: `the history since ${since} runs past ${HISTORY_PAGES} pages of 100 requests, where the search stops`, lasting: true };
}

/** A unit price as fal's pricing API states it: a rate, never a job's cost. */
export interface ListedPrice {
  unitPrice: number;
  unit: string;
  currency: string;
}

export function describePrice(p: ListedPrice): string {
  const amount = p.currency === 'USD' ? `$${p.unitPrice}` : `${p.unitPrice} ${p.currency}`;
  return `${amount} per ${p.unit}`;
}

/** fal's listed prices, and why the pricing API could not be read when it could not. */
export interface PriceList {
  prices: Map<string, ListedPrice>;
  unread?: string;
}

/**
 * fal's listed unit price per endpoint. A model the API does not price is simply absent; a call that
 * failed says so in `unread`, so "not listed" is never claimed for a list nobody read.
 */
export async function listedPrices(models: string[], opts: Pick<FalOptions, 'key' | 'http'>): Promise<PriceList> {
  const prices = new Map<string, ListedPrice>();
  if (!models.length) return { prices };
  try {
    const http = opts.http ?? realHttp(REQUEST_TIMEOUT_MS);
    const q = new URLSearchParams({ endpoint_id: [...new Set(models)].join(',') });
    const res = await http(`${PLATFORM}/models/pricing?${q}`, { method: 'GET', headers: authHeaders(opts.key) });
    if (res.status >= 300) return { prices, unread: scrub(`the pricing API answered ${res.status}: ${await snippet(res)}`, opts.key) };
    const body = (await res.json()) as { prices?: { endpoint_id?: string; unit_price?: number; unit?: string; currency?: string }[] };
    for (const p of body.prices ?? []) {
      if (p.endpoint_id && typeof p.unit_price === 'number' && p.unit) {
        prices.set(p.endpoint_id, { unitPrice: p.unit_price, unit: p.unit, currency: p.currency ?? 'USD' });
      }
    }
  } catch (e) {
    return { prices, unread: scrub(`the pricing API could not be read: ${errorText(e)}`, opts.key) };
  }
  return { prices };
}

/** One model's listing as a phrase: its rate, that fal lists none, or that the list could not be read. */
export function describeListing(model: string, list: PriceList): string {
  const p = list.prices.get(model);
  if (p) return `fal lists ${describePrice(p)}`;
  return list.unread ? `fal's listed price is unknown (${list.unread})` : 'fal lists no unit price';
}

/**
 * What fal actually charged for one request, from its billing record. Reading billing needs an
 * admin-scoped key; an ordinary key is refused, and that is reported as such, not as a zero. `absent`:
 * the records were read and hold no charge for it yet. `unread`: they could not be read at all.
 */
export type Billed =
  | { kind: 'billed'; costUsd: number; units: number | null }
  | { kind: 'forbidden' }
  | { kind: 'absent' }
  | { kind: 'unread'; why: string };

export async function billedCost(requestId: string, opts: Pick<FalOptions, 'key' | 'http' | 'sleep'> & { attempts?: number }): Promise<Billed> {
  const http = opts.http ?? realHttp(REQUEST_TIMEOUT_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 2;
  let unread: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(3000);
    try {
      const q = new URLSearchParams({ request_id: requestId, limit: '1' });
      const res = await http(`${PLATFORM}/models/billing-events?${q}`, { method: 'GET', headers: authHeaders(opts.key) });
      if (res.status === 401 || res.status === 403) return { kind: 'forbidden' };
      if (res.status >= 300) {
        unread = scrub(`the billing API answered ${res.status}: ${await snippet(res)}`, opts.key);
        continue;
      }
      const body = (await res.json()) as { billing_events?: { request_id?: string; cost_total?: number; output_units?: number | null }[] };
      const hit = (body.billing_events ?? []).find((e) => e.request_id === requestId && typeof e.cost_total === 'number');
      if (hit) return { kind: 'billed', costUsd: hit.cost_total!, units: hit.output_units ?? null };
      // The record lands a little after the result, so an empty answer is asked once more.
      unread = undefined;
    } catch (e) {
      unread = scrub(`the billing API could not be read: ${errorText(e)}`, opts.key);
    }
  }
  return unread ? { kind: 'unread', why: unread } : { kind: 'absent' };
}

/** A charge as a phrase: fal's own figure, or why there is none, next to the listed rate when known. */
export function describeBilled(b: Billed, listed?: ListedPrice): string {
  const rate = listed ? `; fal lists ${describePrice(listed)}` : '';
  switch (b.kind) {
    case 'billed': return `$${b.costUsd.toFixed(4)} (fal billing record${b.units !== null ? `, ${b.units} units` : ''})`;
    case 'forbidden': return `unknown (this key may not read fal billing records${rate})`;
    case 'absent': return `unknown (fal has not recorded the charge yet${rate})`;
    case 'unread': return `unknown (${b.why}${rate})`;
  }
}

/** Close a ledger entry, so a resume knows this one does not need picking up. */
export function completeJob(runDir: string, model: string, input: unknown): void {
  markDone(runDir, jobKey(model, input));
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
