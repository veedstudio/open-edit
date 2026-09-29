// Any fal model, on the user's own key, without writing a client first.
//
//   openedit fal run <model> --input <json|@file> [--out <dir>] [--run <dir>]
//   openedit fal run --batch <jobs.json> [--out <dir>] [--concurrency N] [--run <dir>]
//   openedit fal schema <model> [--json]
//
// A local path anywhere in the input is uploaded to fal's storage (multipart when large), every output
// file is downloaded into --out, requests go through the environment's proxy, and identical requests
// in one ledger (--run) are bought once however many callers ask (see providers/queue-ledger.ts).
//
// Cost: printed per job from fal's own billing record when the key may read it; otherwise the line
// says the cost is unknown, next to the unit price fal lists. Never a figure computed here. A purchase
// is recorded in the run's asset manifest the moment fal accepts it and filled in with its charge and
// files when the job ends; a later run that resumes a purchase nobody finished recording records it.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUsage, renderUsage, numberFlag, type Usage } from '../args.ts';
import { runsDir } from '../config.ts';
import {
  JobFailed, PossiblyBought, await_, billedCost, completeJob, describeBilled, describeListing, download, falKey, listedPrices, realHttp,
  redactUrl, submitOnce, type Billed, type Http, type ListedPrice, type PriceList,
} from '../providers/fal.ts';
import { fileDigest, uploadFile } from '../providers/fal-storage.ts';
import { errorText } from '../proxy.ts';
import { buyerRunning, jobKey, ledgerDir } from '../providers/queue-ledger.ts';
import { findRequest, recordRequest, recordsDir, type AssetKind, type AssetRecord } from '../providers/assets.ts';

export interface FalJobSpec {
  model: string;
  input: Record<string, unknown>;
  /** Names the job's output folder under --out in a batch. */
  name: string;
  /** Where relative paths in the input are looked for, in order. */
  bases: string[];
  outDir: string;
}

export interface JobOutcome {
  name: string;
  model: string;
  requestId?: string;
  reused?: boolean;
  /** Found on fal's request history for an earlier attempt whose acceptance never reached the ledger. */
  recovered?: boolean;
  files?: string[];
  /** For a charge this run reported: USD from fal's billing record, or null when there is no figure. Unset when another job or run accounts for it. */
  costUsd?: number | null;
  /** Bought by an earlier run whose charge was not on the books; this run looked it up and recorded it. */
  recordedLate?: boolean;
  /** Sent, and no answer said whether fal took it: the ledger holds it as possibly bought. */
  possiblyBought?: boolean;
  /** Refused or never sent, so not bought, but the ledger could not record that and holds it as possibly bought. */
  refusalUnrecorded?: boolean;
  /** Why the purchase is missing from the asset manifest, or short there; the job itself may have finished. */
  unrecorded?: string;
  error?: string;
}

export interface FalRunContext {
  key: string;
  /** The run whose job ledger records these purchases. */
  ledgerRoot: string;
  timeoutMs: number;
  http?: Http;
  log?: (line: string) => void;
  /** Test seam for waits between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const MODEL_ID = /^[A-Za-z0-9][\w.-]*(\/[\w.-]+)+$/;

// --- local files in an input -------------------------------------------------------------

/** A string in an input that names a readable local file, resolved; undefined for anything else. */
export function localFile(value: string, bases: string[]): string | undefined {
  if (value.length > 1024 || /[\r\n]/.test(value)) return undefined;
  let p = value;
  if (p.startsWith('file://')) {
    try { p = fileURLToPath(p); } catch { return undefined; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-z]:[\\/]/i.test(p)) {
    return undefined;
  }
  // Prose is not a path: only something shaped like one is looked up on disk.
  if (!/[\\/]/.test(p) && !/\.[A-Za-z0-9]{1,5}$/.test(p)) return undefined;
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  for (const base of isAbsolute(p) ? [''] : bases) {
    const abs = resolve(base, p);
    try {
      if (statSync(abs).isFile()) return abs;
    } catch { /* not here */ }
  }
  return undefined;
}

function mapStrings(v: unknown, fn: (s: string) => unknown): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

/**
 * A string that can only mean a local file. One that names no file is a typo, and sent on as text it
 * reaches a paid call as a url the endpoint cannot fetch.
 */
function clearlyAPath(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  if (/^(\.{1,2}[\\/]|~\/|file:\/\/)/.test(value)) return true;
  if (!isAbsolute(value) || !/\.[A-Za-z0-9]{1,5}$/.test(value)) return false;
  if (!/\s/.test(value)) return true;
  // With a space it may be prose ("/imagine a cat.png"); a real folder to hold it makes it a mistyped file name.
  const folder = dirname(value);
  if (folder === parse(value).root) return false;
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The local files an input names, and its identity with each file standing as its content hash. */
export async function describeInput(input: Record<string, unknown>, bases: string[]): Promise<{ files: string[]; identity: Record<string, unknown> }> {
  const files = new Set<string>();
  mapStrings(input, (s) => {
    const f = localFile(s, bases);
    if (f) files.add(f);
    else if (clearlyAPath(s)) {
      const where = /^\.{1,2}[\\/]/.test(s) ? ` (looked in ${bases.join(', ')})` : '';
      throw new Error(`input: "${s}" looks like a local path, but there is no file at it${where}`);
    }
    return s;
  });
  const digests = new Map<string, string>();
  for (const f of files) digests.set(f, await fileDigest(f));
  const identity = mapStrings(input, (s) => { const f = localFile(s, bases); return f ? `file:${digests.get(f)}` : s; }) as Record<string, unknown>;
  return { files: [...files], identity };
}

// --- outputs --------------------------------------------------------------------------------

interface OutputFile { url: string; name?: string }

/**
 * fal returns every file as an object carrying a `url`; those are the outputs, wherever they sit. Only
 * https ones are fetched (`files`): any endpoint, a third party's included, chooses these urls, and a
 * plain-http one is the easy way to point this machine at a local or metadata address. That is all the
 * check does: hosts are not restricted and redirects are followed. A `data:` url carries its file inline
 * and reaches no host, so it is saved too. The rest are `skipped`, to be named.
 */
export function outputFiles(payload: unknown): { files: OutputFile[]; skipped: string[] } {
  const files: OutputFile[] = [];
  const skipped: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.url === 'string') {
      if (/^(https:\/\/|data:[^,]*,)/i.test(o.url)) files.push({ url: o.url, name: typeof o.file_name === 'string' ? o.file_name : undefined });
      else skipped.push(o.url);
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(payload);
  return { files, skipped };
}

/** A url as a message may show it: never a signed query string, and never an unbounded one. */
function nameUrl(url: string): string {
  const shown = redactUrl(url);
  return shown.length > 120 ? `${shown.slice(0, 100)}… (${url.length} characters)` : shown;
}

function safeName(raw: string, fallback: string): string {
  const clean = basename(raw).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return clean || fallback;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4',
  'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'text/plain': 'txt', 'application/json': 'json',
};

/** The bytes a `data:<type>[;base64],<data>` url carries, and the extension its media type names. */
function inlineFile(url: string): { bytes: Buffer; extension: string } {
  const comma = url.indexOf(',');
  const header = url.slice('data:'.length, comma);
  const data = url.slice(comma + 1);
  let bytes: Buffer;
  if (/;base64$/i.test(header)) bytes = Buffer.from(data, 'base64');
  else {
    try { bytes = Buffer.from(decodeURIComponent(data)); } catch { bytes = Buffer.from(data); }
  }
  return { bytes, extension: EXTENSION_BY_TYPE[header.split(';')[0].trim().toLowerCase()] ?? 'bin' };
}

async function downloadOutputs(payload: unknown, outDir: string, http?: Http): Promise<{ written: string[]; skipped: string[] }> {
  mkdirSync(outDir, { recursive: true });
  const taken = new Set<string>();
  const written: string[] = [];
  const { files, skipped } = outputFiles(payload);
  for (const [i, f] of files.entries()) {
    const inline = /^data:/i.test(f.url) ? inlineFile(f.url) : undefined;
    const fromUrl = inline ? `output-${i + 1}.${inline.extension}` : new URL(f.url).pathname.split('/').pop() ?? '';
    let name = safeName(f.name ?? fromUrl, `output-${i + 1}`);
    const dot = name.lastIndexOf('.');
    for (let n = 2; taken.has(name); n++) name = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
    taken.add(name);
    const dest = join(outDir, name);
    if (inline) writeFileSync(dest, inline.bytes);
    else await download(f.url, dest, http);
    written.push(dest);
  }
  return { written, skipped };
}

// --- running ------------------------------------------------------------------------------

/**
 * The cost line for a purchase this run accounts for, whether or not its job then finished: fal took the
 * money when it accepted the request, so a failure afterwards changes nothing about the charge.
 */
async function reportCharge(outcome: JobOutcome, ctx: FalRunContext, listed: ListedPrice | undefined, canReadBilling: { value: boolean }, log: (m: string) => void, origin = ''): Promise<void> {
  let billed: Billed = { kind: 'forbidden' };
  if (canReadBilling.value) {
    billed = await billedCost(outcome.requestId!, { key: ctx.key, http: ctx.http, sleep: ctx.sleep });
    if (billed.kind === 'forbidden') canReadBilling.value = false;
  }
  outcome.costUsd = billed.kind === 'billed' ? billed.costUsd : null;
  log(`cost: ${describeBilled(billed, listed)}${origin ? `; ${origin}` : ''}`);
}

/** Uploads each distinct local file once per invocation, however many jobs name it. */
function uploader(ctx: FalRunContext, log: (line: string) => void): (path: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (path) => {
    let p = cache.get(path);
    if (!p) {
      p = uploadFile(path, { key: ctx.key, http: ctx.http }).then((url) => {
        const bytes = statSync(path).size;
        const size = bytes < 1e6 ? `${Math.ceil(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
        log(`[fal] uploaded ${path} (${size}) -> ${url}`);
        return url;
      });
      cache.set(path, p);
    }
    return p;
  };
}

/**
 * Which job of this invocation accounts for each request id. A duplicate in the same batch resumes the
 * same purchase, and must not report or record it a second time.
 */
type Accountable = Map<string, string>;

async function runOne(job: FalJobSpec, ctx: FalRunContext, upload: (p: string) => Promise<string>, listed: PriceList, canReadBilling: { value: boolean }, accountable: Accountable): Promise<JobOutcome> {
  const log = (m: string) => (ctx.log ?? console.log)(`[${job.name}] ${m}`);
  const outcome: JobOutcome = { name: job.name, model: job.model };
  let key: string | undefined;
  try {
    const { files, identity } = await describeInput(job.input, job.bases);
    key = jobKey(job.model, identity);
    const prepare = async () => {
      const urls = new Map<string, string>();
      for (const f of files) urls.set(f, await upload(f));
      return mapStrings(job.input, (s) => { const f = localFile(s, job.bases); return f ? urls.get(f)! : s; }) as Record<string, unknown>;
    };
    const { job: queued, reused, recovered, ledgerRecord } = await submitOnce(ctx.ledgerRoot, job.model, job.input, {
      key: ctx.key, http: ctx.http, identity, prepare, sleep: ctx.sleep,
      onAccepted: (j) => {
        // Noted the moment fal takes the money, so a failure anywhere after it still counts as bought.
        outcome.requestId = j.requestId;
        outcome.reused = false;
        accountable.set(j.requestId, job.name);
        log(`accepted by fal as ${j.requestId}`);
        // On the books now, so a run killed while the job runs still leaves the purchase in the manifest.
        try {
          recordRequest(ctx.ledgerRoot, j.requestId, (prior) => prior ?? purchaseRecord(job, outcome, ctx.ledgerRoot));
        } catch (e) {
          log(`could not record ${j.requestId} in ${recordsDir(ctx.ledgerRoot)} yet (${errorText(e)}); tried again when the job ends`);
        }
      },
    });
    outcome.requestId = queued.requestId;
    outcome.reused = reused;
    outcome.recovered = recovered;
    if (recovered) {
      // Claimed at once: a duplicate in this batch resumes the same request and may reach account() first.
      accountable.set(queued.requestId, job.name);
      log(`found on fal's request history as ${queued.requestId}: an earlier attempt sent this exact request and its acceptance never reached the ledger; resuming it, not buying it again`);
    }
    else if (reused) log(`this exact request is already bought (${queued.requestId}): resuming it, not buying it again`);
    const started = Date.now();
    const result = await await_(queued, { key: ctx.key, http: ctx.http, timeoutMs: ctx.timeoutMs, sleep: ctx.sleep, ledgerRecord });
    const { written, skipped } = await downloadOutputs(result.payload, job.outDir, ctx.http);
    outcome.files = written;
    const kept = join(job.outDir, 'fal-result.json');
    writeFileSync(kept, JSON.stringify({
      model: job.model, requestId: queued.requestId, reused, input: job.input, outputs: outcome.files, response: result.payload,
    }, null, 2) + '\n');
    completeJob(ctx.ledgerRoot, job.model, identity);
    const unfetched = skipped.length ? `${skipped.length} output url(s) not fetched because they are not https (${skipped.map(nameUrl).join(', ')}); the response is kept in ${kept}` : '';
    // A paid job with nothing on disk needs someone to look, even though fal finished it.
    if (!written.length && unfetched) throw new Error(unfetched);
    log(`done in ${Math.round((Date.now() - started) / 1000)}s -> ${written.length ? written.join(', ') : `no {url} file object in the response; it is kept in ${kept}`}`);
    if (unfetched) log(unfetched);
  } catch (e) {
    outcome.error = errorText(e);
    // A request whose id this job heard is bought, whatever the ledger could record.
    if (e instanceof PossiblyBought && !outcome.requestId) {
      if (e.sent) outcome.possiblyBought = true;
      else outcome.refusalUnrecorded = true;
    }
    const bought = outcome.requestId && !outcome.reused ? ` after fal accepted it as ${outcome.requestId}, so it was bought`
      : outcome.possiblyBought ? ', possibly bought' : '';
    log(`FAILED${bought}: ${outcome.error}`);
    if (e instanceof JobFailed && key) log(`to buy it again, a second charge: remove ${join(ledgerDir(ctx.ledgerRoot), key)} and re-run`);
  }
  if (outcome.requestId && key) await account(job, outcome, key, ctx, listed.prices.get(job.model), canReadBilling, accountable, log);
  return outcome;
}

/**
 * Reports and records the charge of the request a job ended with, once per purchase. A reuse, a
 * recovered one included, is left to whoever accounts for it: another job in this batch, a buyer still
 * running, or the record of a charge already reported. One whose charge is not on the books (its buyer
 * was killed, its acceptance never reached the ledger, or the record failed to write) is looked up and
 * recorded here.
 */
async function account(job: FalJobSpec, outcome: JobOutcome, key: string, ctx: FalRunContext, listed: ListedPrice | undefined,
  canReadBilling: { value: boolean }, accountable: Accountable, log: (m: string) => void): Promise<void> {
  const requestId = outcome.requestId!;
  const runDir = ctx.ledgerRoot;
  let origin = '';
  if (outcome.reused) {
    const sibling = accountable.get(requestId);
    // The job that recovered a request claims it before it runs, so its own claim is no sibling.
    if (sibling && sibling !== job.name) return log(`cost: nothing new (request ${requestId} is counted under job ${sibling})`);
    const buyer = buyerRunning(runDir, key, requestId);
    if (buyer) return log(`cost: nothing new (request ${requestId} is being bought by pid ${buyer.pid}, which records it)`);
    const prior = findRequest(runDir, requestId);
    if (prior && typeof prior.cost === 'number') {
      log(`cost: nothing new (request ${requestId} was bought earlier and is recorded)`);
      // A resume that came back can land the files the buyer never did, or clear the error it recorded;
      // the charge stays as the buyer recorded it.
      if (outcome.files && ((outcome.files.length && !priorFiles(prior).length) || prior.meta?.error)) writeRecord(job, outcome, runDir, log);
      return;
    }
    origin = outcome.recovered ? 'bought by an earlier attempt whose acceptance never reached the ledger' : 'bought in an earlier run';
  }
  // Taken before the first await, so a duplicate later in this batch sees it is accounted for.
  accountable.set(requestId, job.name);
  await reportCharge(outcome, ctx, listed, canReadBilling, log, origin);
  const written = writeRecord(job, outcome, runDir, log);
  if (origin && written) outcome.recordedLate = written.created || (written.priorCost === null && typeof outcome.costUsd === 'number');
}

function writeRecord(job: FalJobSpec, outcome: JobOutcome, runDir: string, log: (m: string) => void): { created: boolean; priorCost?: number | null } | undefined {
  let priorCost: number | null | undefined;
  try {
    const { created } = recordRequest(runDir, outcome.requestId!, (prior) => {
      priorCost = prior?.cost;
      return purchaseRecord(job, outcome, runDir, prior);
    });
    return { created, priorCost };
  } catch (e) {
    outcome.unrecorded = `${recordsDir(runDir)} could not be written: ${errorText(e)}`;
    log(`not recorded: request ${outcome.requestId} is bought, but ${outcome.unrecorded}; a re-run records it without buying it again`);
    return undefined;
  }
}

const KIND_BY_EXTENSION: [RegExp, AssetKind][] = [
  [/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i, 'image'],
  [/\.(mp4|mov|webm|m4v|mkv)$/i, 'video'],
  [/\.(mp3|wav|m4a|aac|ogg|flac)$/i, 'audio'],
];

const priorFiles = (a: AssetRecord | undefined): unknown[] => (Array.isArray(a?.meta?.files) ? a.meta.files : []);

/**
 * A purchase's manifest record, the one row its request id has: what this job learned laid over what an
 * earlier writer of the row already put there, so a run that got less far never erases what one before
 * it recorded.
 */
function purchaseRecord(job: FalJobSpec, outcome: JobOutcome, runDir: string, prior?: AssetRecord): AssetRecord {
  const landed = (outcome.files ?? []).map((f) => relative(runDir, f).split('\\').join('/'));
  const fill = landed.length > 0 && !priorFiles(prior).length;
  const first = outcome.files?.[0];
  const cost = typeof outcome.costUsd === 'number' ? outcome.costUsd : prior?.cost ?? null;
  // An error is this job's when it had one; a job that came back, files or not, clears an earlier one.
  const error = outcome.error ?? (outcome.files ? undefined : prior?.meta?.error);
  const { error: _dropped, ...priorMeta } = prior?.meta ?? {};
  return {
    id: prior?.id ?? basename(job.outDir),
    kind: fill ? (first && KIND_BY_EXTENSION.find(([re]) => re.test(first))?.[1]) || 'other' : prior?.kind ?? 'other',
    path: fill ? landed[0] : prior?.path ?? relative(runDir, job.outDir),
    provider: 'fal',
    model: job.model,
    prompt: prior ? prior.prompt : typeof job.input.prompt === 'string' ? job.input.prompt : undefined,
    createdAt: prior?.createdAt ?? new Date().toISOString(),
    cost,
    ...(typeof cost === 'number' ? { currency: 'USD' } : {}),
    meta: { ...priorMeta, requestId: outcome.requestId, files: fill ? landed : priorFiles(prior), ...(error ? { error } : {}) },
  };
}

/** Runs every job, at most `concurrency` at once, and reports each; one failure never stops the rest. */
export async function runFalJobs(jobs: FalJobSpec[], ctx: FalRunContext, concurrency = 4): Promise<JobOutcome[]> {
  const say = ctx.log ?? console.log;
  const models = [...new Set(jobs.map((j) => j.model))];
  const listed = await listedPrices(models, { key: ctx.key, http: ctx.http });
  say(`[fal] ${jobs.length} job${jobs.length === 1 ? '' : 's'}, bills your own fal account (never a VEED workspace)`);
  for (const m of models) say(`[fal] ${m}: ${describeListing(m, listed)}`);

  const upload = uploader(ctx, say);
  const canReadBilling = { value: true };
  const accountable: Accountable = new Map();
  const outcomes: JobOutcome[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      outcomes[i] = await runOne(jobs[i], ctx, upload, listed, canReadBilling, accountable);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));

  const failed = outcomes.filter((o) => o.error);
  // Bought means accepted by fal in this run, finished or not.
  const bought = outcomes.filter((o) => o.requestId && !o.reused);
  const lostAfterBuying = bought.filter((o) => o.error);
  const possibly = outcomes.filter((o) => o.possiblyBought);
  const heldRefusals = outcomes.filter((o) => o.refusalUnrecorded);
  const late = outcomes.filter((o) => o.recordedLate);
  const unrecorded = outcomes.filter((o) => o.unrecorded);
  const names = (list: JobOutcome[]) => list.map((o) => o.name).join(', ');
  const charges = (list: JobOutcome[]) => {
    const billed = list.filter((o) => typeof o.costUsd === 'number');
    const unknown = list.length - billed.length;
    return `${billed.length ? `$${billed.reduce((s, o) => s + (o.costUsd ?? 0), 0).toFixed(4)} billed` : 'no billed figure'}${unknown ? `, ${unknown} at unknown cost` : ''}`;
  };
  say(`[fal] ${outcomes.length - failed.length}/${outcomes.length} done; ${bought.length} bought this run` +
    `${lostAfterBuying.length ? ` (${lostAfterBuying.length} failed after fal accepted it: ${lostAfterBuying.map((o) => `${o.name} as ${o.requestId}`).join(', ')})` : ''}, ` +
    charges(bought) +
    `${possibly.length ? `; ${possibly.length} possibly bought (sent, and fal's answer was lost: ${names(possibly)}; a re-run looks for it instead of buying it again)` : ''}` +
    `${heldRefusals.length ? `; ${heldRefusals.length} not bought but held as possibly bought (refused or never sent, and recording that failed: ${names(heldRefusals)}; a re-run looks for it instead of buying it)` : ''}` +
    `${late.length ? `; ${late.length} recorded from an earlier run (${names(late)}), ${charges(late)}` : ''}` +
    `${unrecorded.length ? `; ${unrecorded.length} bought but not recorded in ${recordsDir(ctx.ledgerRoot)} (${names(unrecorded)}; a re-run records it)` : ''}` +
    `${failed.length ? `; failed: ${names(failed)}` : ''}`);
  return outcomes;
}

// --- schema --------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function deref(node: unknown, schemas: Json, depth = 0): unknown {
  if (depth > 6 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => deref(n, schemas, depth + 1));
  const o = node as Json;
  if (typeof o.$ref === 'string') {
    const name = o.$ref.split('/').pop()!;
    return deref(schemas[name], schemas, depth + 1);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deref(v, schemas, depth + 1)]));
}

/** The endpoint's input and output schemas, references resolved, out of fal's queue OpenAPI document. */
export function schemaOf(doc: Json, model: string): { input?: Json; output?: Json; meta: Json } {
  const paths = (doc.paths ?? {}) as Record<string, Json>;
  const schemas = ((doc.components as Json | undefined)?.schemas ?? {}) as Json;
  const pick = (op: Json | undefined, at: string[]): Json | undefined => {
    let v: unknown = op;
    for (const k of at) v = (v as Json | undefined)?.[k];
    return v ? (deref(v, schemas) as Json) : undefined;
  };
  const post = Object.entries(paths).find(([, v]) => v.post)?.[1]?.post as Json | undefined;
  const result = Object.entries(paths).find(([p, v]) => /\/requests\/\{request_id\}$/.test(p) && v.get)?.[1]?.get as Json | undefined;
  return {
    input: pick(post, ['requestBody', 'content', 'application/json', 'schema']),
    output: pick(result, ['responses', '200', 'content', 'application/json', 'schema']),
    meta: ((doc.info as Json | undefined)?.['x-fal-metadata'] ?? { endpointId: model }) as Json,
  };
}

function typeOf(s: Json): string {
  if (Array.isArray(s.enum)) return (s.enum as unknown[]).map(String).join('|');
  if (Array.isArray(s.anyOf)) return (s.anyOf as Json[]).map(typeOf).filter((t) => t !== 'null').join(' | ') || 'null';
  if (s.type === 'array') return `array<${s.items ? typeOf(s.items as Json) : 'any'}>`;
  if (s.type === 'object' || s.properties) {
    const keys = Object.keys((s.properties ?? {}) as Json);
    return keys.length ? `{${keys.join(', ')}}` : 'object';
  }
  return String(s.type ?? s.format ?? 'any');
}

/**
 * The price line of `fal schema`. Only a missing key goes unasked quietly: a key setting that is there
 * but broken is shown now, rather than on the first paid run.
 */
export async function schemaListing(model: string, env: NodeJS.ProcessEnv = process.env, http?: Http): Promise<string> {
  let key: string;
  try {
    key = falKey(env);
  } catch (e) {
    const why = errorText(e);
    return /^no fal key/.test(why) ? 'not asked (no fal key; set FAL_KEY to see what fal lists)' : `not asked: ${why}`;
  }
  return describeListing(model, await listedPrices([model], { key, http }));
}

/** `listing` is the price phrase, from schemaListing. */
export function renderSchema(model: string, s: ReturnType<typeof schemaOf>, listing: string): string {
  const lines = [`${model}${s.meta.category ? `  (${s.meta.category})` : ''}`];
  if (s.meta.documentationUrl) lines.push(`docs: ${s.meta.documentationUrl}`);
  lines.push(`price: ${listing}`);
  for (const [label, schema] of [['input', s.input], ['output', s.output]] as const) {
    lines.push('', `${label}:`);
    const props = ((schema?.properties ?? {}) as Record<string, Json>);
    const required = new Set((schema?.required ?? []) as string[]);
    if (!Object.keys(props).length) { lines.push('  (not described)'); continue; }
    // fal states the order its own playground shows the fields in; the required ones lead there.
    const order = (schema?.['x-fal-order-properties'] ?? []) as string[];
    const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
    for (const [name, p] of Object.entries(props).sort(([a], [b]) => rank(a) - rank(b))) {
      const bits = [typeOf(p)];
      if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
      if (typeof p.minimum === 'number' || typeof p.maximum === 'number') bits.push(`range ${p.minimum ?? ''}..${p.maximum ?? ''}`);
      const desc = typeof p.description === 'string' ? `  ${p.description.replace(/\s+/g, ' ').slice(0, 160)}` : '';
      lines.push(`  ${required.has(name) ? '*' : ' '}${name}  ${bits.join(', ')}${desc}`);
    }
  }
  lines.push('', '* required');
  return lines.join('\n');
}

export async function fetchSchema(model: string, http?: Http): Promise<Json> {
  const get = http ?? realHttp(30_000);
  const res = await get(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(model)}`, { method: 'GET', headers: {} });
  const doc = res.status < 300 ? ((await res.json()) as Json | null) : null;
  if (!doc || !doc.paths) throw new Error(`fal has no public schema for ${model} (${res.status}); check the endpoint id on fal.ai/models`);
  return doc;
}

// --- the command ------------------------------------------------------------------------------

export const usage = {
  summary: "Run any fal model on your own FAL_KEY (uploads local files, downloads outputs), or print its schema",
  positionals: 'run <model> | run --batch <jobs.json> | schema <model>',
  flags: {
    input: { type: 'string', value: '<json|@file>', help: 'run: the model input, inline JSON or @path to a JSON file; local paths in it are uploaded' },
    batch: { type: 'string', value: '<jobs.json>', help: 'run: a JSON list of {"model", "input", "name"?} jobs' },
    out: { type: 'string', value: '<dir>', help: 'run: where outputs are downloaded (default <run-dir>/assets/fal; one job gets <model>-<id> there, a batch job <name>, or job-<n>-<id> unnamed)' },
    concurrency: { type: 'string', value: 'N', help: 'run --batch: jobs in flight at once (default 4)' },
    run: { type: 'string', value: '<run-dir>', help: 'run: the run whose job ledger and asset manifest record these purchases (default <workspace>/runs/fal)' },
    timeout: { type: 'string', value: '<minutes>', help: 'run: give up waiting on a job after this long; it is resumed, not re-bought, next time (default 15)' },
    json: { type: 'boolean', help: 'schema: print the input and output schemas as JSON' },
  },
  notes: 'Identical requests in one ledger (the same --run) are bought once: a repeat, or a parallel duplicate, resumes the first by its request id.\n'
    + 'The key is FAL_KEY (or OPEN_EDIT_FAL_KEY_FILE); calls bill that fal account, never a VEED workspace.\n'
    + 'A cost line follows each job: fal\'s billing record when the key may read it, otherwise "cost: unknown".',
} satisfies Usage;

function parseJsonArg(raw: string, what: string): { value: unknown; base?: string } {
  if (raw.startsWith('@')) {
    const path = resolve(raw.slice(1));
    if (!existsSync(path)) throw new Error(`${what}: no file at ${path}`);
    try {
      return { value: JSON.parse(readFileSync(path, 'utf8')), base: dirname(path) };
    } catch (e) {
      throw new Error(`${what}: ${path} is not JSON (${(e as Error).message})`);
    }
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`${what}: not JSON (${(e as Error).message}); pass inline JSON or @path/to/file.json`);
  }
}

function assertModel(model: unknown, where: string): string {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new Error(`${where}: "${String(model)}" is not a fal endpoint id (owner/model[/path], e.g. fal-ai/flux/schnell)`);
  }
  return model;
}

function slug(model: string): string {
  return model.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Test seams for `fal run`: the network, the key, the log and the waits, so the command runs end to end without a bill. */
export interface FalCommandSeams { http?: Http; key?: string; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> }

export async function falCommand(argv: string[], seams: FalCommandSeams = {}): Promise<number> {
  const { values, positionals } = parseUsage('fal', usage, argv);
  const [verb, model, ...extra] = positionals;

  if (verb === 'schema') {
    if (!model || extra.length) { console.error(renderUsage('fal', usage)); return 2; }
    assertModel(model, 'schema');
    const s = schemaOf(await fetchSchema(model), model);
    if (values.json) {
      console.log(JSON.stringify({ model, input: s.input, output: s.output }, null, 2));
      return 0;
    }
    console.log(renderSchema(model, s, await schemaListing(model)));
    return 0;
  }

  if (verb !== 'run' || extra.length) { console.error(renderUsage('fal', usage)); return 2; }
  if (values.batch && (values.input || model)) throw new Error('fal run: --batch carries its own models and inputs; drop the model and --input');
  const concurrency = numberFlag('concurrency', values.concurrency, 4, (n) => Number.isInteger(n) && n >= 1 && n <= 16, 'a whole number from 1 to 16');
  const timeoutMin = numberFlag('timeout', values.timeout, 15, (n) => n > 0, 'a positive number of minutes');
  const cwd = process.cwd();
  const ledgerRoot = values.run ? resolve(values.run) : join(runsDir(), 'fal');
  // Inside the run by default, so outputs sit beside the manifest that records them wherever the command is run from.
  const outRoot = values.out ? resolve(values.out) : join(ledgerRoot, 'assets', 'fal');
  let jobs: FalJobSpec[];

  if (values.batch) {
    const { value, base } = parseJsonArg(values.batch.startsWith('@') ? values.batch : `@${values.batch}`, '--batch');
    const list = Array.isArray(value) ? value : (value as { jobs?: unknown })?.jobs;
    if (!Array.isArray(list) || !list.length) throw new Error('--batch: expected a non-empty JSON list of {"model", "input", "name"?} (or {"jobs": [...]})');
    const names = new Set<string>();
    const bases = [cwd, ...(base ? [base] : [])];
    jobs = [];
    for (const [i, j] of list.entries()) {
      const spec = j as { model?: unknown; input?: unknown; name?: unknown };
      const m = assertModel(spec.model, `--batch job ${i + 1}`);
      if (!spec.input || typeof spec.input !== 'object' || Array.isArray(spec.input)) throw new Error(`--batch job ${i + 1}: "input" must be a JSON object`);
      const input = spec.input as Record<string, unknown>;
      let name = spec.name === undefined ? `job-${String(i + 1).padStart(2, '0')}` : String(spec.name);
      if (spec.name === undefined) {
        // Named for what it asks, so an unnamed job of a later batch never shares its folder or its manifest id.
        try {
          name += `-${jobKey(m, (await describeInput(input, bases)).identity).slice(0, 8)}`;
        } catch { /* an input that cannot be described fails its own job, before anything is bought */ }
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error(`--batch job ${i + 1}: name "${name}" must be letters, digits, dot, dash or underscore (it names a folder)`);
      if (names.has(name)) throw new Error(`--batch: two jobs are named "${name}"; each writes its own folder`);
      names.add(name);
      jobs.push({ model: m, input, name, bases, outDir: join(outRoot, name) });
    }
  } else {
    if (!model || !values.input) { console.error(renderUsage('fal', usage)); return 2; }
    assertModel(model, 'run');
    const { value, base } = parseJsonArg(values.input, '--input');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--input must be a JSON object');
    const input = value as Record<string, unknown>;
    const bases = [cwd, ...(base ? [base] : [])];
    // Without --out, a job gets a folder named for what it is, so two different runs never mix outputs.
    const outDir = values.out ? outRoot : join(outRoot, `${slug(model)}-${jobKey(model, (await describeInput(input, bases)).identity).slice(0, 8)}`);
    jobs = [{ model, input, name: slug(model), bases, outDir }];
  }

  const outcomes = await runFalJobs(jobs, {
    key: seams.key ?? falKey(),
    ledgerRoot,
    timeoutMs: timeoutMin * 60_000,
    http: seams.http, log: seams.log, sleep: seams.sleep,
  }, concurrency);
  // A purchase missing from the manifest leaves the run's spend short until a re-run records it.
  return outcomes.some((o) => o.error || o.unrecorded) ? 1 : 0;
}
