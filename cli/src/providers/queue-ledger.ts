// The record of what has already been asked for, so it is never paid for twice.
//
// A generation queue takes the money when it ACCEPTS a request, not when it returns one. The
// documentary run submitted the same 8-second opening clip a second time while the first was still
// running, then lost both job ids when the status poll failed and recovered them by hand with curl.
// Two charges and sixteen minutes, for one clip.
//
// The ledger keys a job by what was asked for, not by when. Two identical requests are the same
// request, and a request whose id was written down survives a lost connection.
//
// Parallel callers are the normal case (a batch, several agents in one run), so the whole lifecycle is
// coordinated, not only the write: CLAIM, then SUBMIT, then RECORD. Each attempt owns one state file,
// `assets/jobs/<key>/attempt-<n>.json`, created exclusively, so exactly one caller holds attempt n and
// no two callers ever rewrite the same file. The claim carries a lease its owner renews; a caller that
// finds a claim whose lease ran out (or whose process is gone) takes over with attempt n+1. The claim
// moves to `submitting`, with the exact body, BEFORE the request leaves; so an owner that dies between
// the queue accepting and the id being written leaves a record that says "possibly bought", which is
// resolved by finding the request on the queue, never by buying it again.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createExclusive, processAlive, writeAtomic } from './exclusive-files.ts';

export interface LedgerEntry {
  key: string;
  model: string;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  submittedAt: string;
  /** Set when the job returned; an entry without it is in flight or was lost mid-poll. */
  completedAt?: string;
}

/**
 * `claimed`: someone intends to buy and nothing has left yet. `submitting`: the request is on its way
 * or was sent; the queue may have accepted it. `uncertain`: the send failed in a way that does not say
 * whether it was accepted. `accepted`: the queue returned an id. `refused`: the queue said no, or the
 * request never left this machine, so nothing was bought. `abandoned`: the owner gave up before sending.
 */
export type AttemptState = 'claimed' | 'submitting' | 'uncertain' | 'accepted' | 'refused' | 'abandoned';

export interface Attempt {
  key: string;
  model: string;
  n: number;
  attempt: string;
  state: AttemptState;
  pid: number;
  host: string;
  claimedAt: string;
  /** Epoch ms. Past it, a claim nobody renewed may be taken over. */
  leaseUntil: number;
  /** Exactly what was sent, kept so an acceptance nobody recorded can be matched on the queue. */
  body?: unknown;
  submittingAt?: string;
  requestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  submittedAt?: string;
  /** How a request id reached this attempt when this attempt did not submit it. */
  recoveredFrom?: string;
  reason?: string;
}

export function ledgerDir(runDir: string): string {
  return join(runDir, 'assets', 'jobs');
}

/** The single-file ledger earlier versions wrote. Still read, so a job they recorded is never bought again. */
export function legacyLedgerPath(runDir: string): string {
  return join(runDir, 'assets', 'jobs.json');
}

/**
 * A stable identity for a request. Object keys are sorted, so two callers that build the same input
 * in a different order still collide — which is the point.
 */
export function canonicalJson(v: unknown): string {
  const canonical = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canonical);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, canonical(y)]));
    }
    return x;
  };
  return JSON.stringify(canonical(v));
}

export function jobKey(model: string, input: unknown): string {
  return createHash('sha256').update(`${model}\n${canonicalJson(input)}`).digest('hex').slice(0, 16);
}

// --- files ------------------------------------------------------------------------

const attemptPath = (runDir: string, key: string, n: number) => join(ledgerDir(runDir), key, `attempt-${n}.json`);
const donePath = (runDir: string, key: string, tag: string) => join(ledgerDir(runDir), key, `done-${tag}.json`);

/** How long an unreadable attempt file is taken for one still being written. */
const TORN_GRACE_MS = 5_000;

export function readAttempts(runDir: string, key: string): Attempt[] {
  const dir = join(ledgerDir(runDir), key);
  if (!existsSync(dir)) return [];
  const out: Attempt[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^attempt-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    const n = Number(m[1]);
    try {
      const a = JSON.parse(readFileSync(path, 'utf8')) as Attempt;
      if (typeof a?.state !== 'string' || typeof a.attempt !== 'string') throw new Error('not an attempt record');
      out.push({ ...a, n });
    } catch {
      // Unreadable: still being written (the no-hard-link fallback), or damaged. Young, it is a live
      // claim; old, it may have held an accepted id, so it is treated as possibly bought.
      let age: number;
      try { age = Date.now() - statSync(path).mtimeMs; } catch { continue; }
      out.push({
        key, model: '', n, attempt: `unreadable-${n}`, pid: 0, host: '', claimedAt: '',
        state: age < TORN_GRACE_MS ? 'claimed' : 'uncertain',
        leaseUntil: age < TORN_GRACE_MS ? Date.now() + TORN_GRACE_MS : 0,
        reason: `${path} could not be read`,
      });
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

function readDone(runDir: string, key: string): string | undefined {
  const dir = join(ledgerDir(runDir), key);
  if (!existsSync(dir)) return undefined;
  const done = readdirSync(dir).filter((n) => /^done-.*\.json$/.test(n)).sort();
  for (const name of done) {
    try {
      return (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { completedAt: string }).completedAt;
    } catch { /* a torn marker is no marker */ }
  }
  return undefined;
}

function readLegacy(runDir: string): LedgerEntry[] {
  const p = legacyLedgerPath(runDir);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    // Valid JSON of the wrong shape is as unreadable as a truncated file.
    if (!Array.isArray(v) || v.some((e) => !e || typeof e.key !== 'string' || typeof e.requestId !== 'string')) {
      throw new Error('the ledger is not a list of job records');
    }
    return v as LedgerEntry[];
  } catch {
    // A file that cannot be read is kept, never written through: losing it means paying for every job
    // in it again. Two readers may race to move it; the loser finds it already gone.
    let dest = p.replace(/\.json$/, '.corrupt.json');
    let n = 1;
    while (existsSync(dest)) dest = p.replace(/\.json$/, `.corrupt.${n++}.json`);
    try {
      renameSync(p, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Left in place, its jobs could not be told from new ones, so reading on would buy them again.
      throw new Error(
        `the job ledger at ${p} could not be parsed, and moving it aside to ${dest} failed ` +
        `(${e instanceof Error ? e.message : String(e)}). Nothing is bought while it is there: move or repair it, then re-run.`,
      );
    }
    process.stderr.write(`[queue] the job ledger could not be parsed and was kept at ${dest}\n`);
    return [];
  }
}

function entryOf(a: Attempt, completedAt: string | undefined): LedgerEntry {
  return {
    key: a.key, model: a.model, requestId: a.requestId!, statusUrl: a.statusUrl ?? '', responseUrl: a.responseUrl ?? '',
    submittedAt: a.submittedAt ?? a.claimedAt, ...(completedAt ? { completedAt } : {}),
  };
}

export function findJob(runDir: string, key: string, attempts = readAttempts(runDir, key)): LedgerEntry | undefined {
  const held = attempts.find((a) => a.requestId);
  if (held) return entryOf(held, readDone(runDir, key));
  const legacy = readLegacy(runDir).find((e) => e.key === key);
  if (legacy) return { ...legacy, completedAt: legacy.completedAt ?? readDone(runDir, key) };
  return undefined;
}

export function readLedger(runDir: string): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  for (const e of readLegacy(runDir)) byKey.set(e.key, e);
  const dir = ledgerDir(runDir);
  if (existsSync(dir)) {
    for (const key of readdirSync(dir)) {
      const held = readAttempts(runDir, key).find((a) => a.requestId);
      if (held) byKey.set(key, entryOf(held, readDone(runDir, key)));
      else if (byKey.has(key)) {
        const completedAt = readDone(runDir, key);
        if (completedAt) byKey.set(key, { ...byKey.get(key)!, completedAt });
      }
    }
  }
  return [...byKey.values()];
}

/** Record an accepted job from outside a claim (a job bought elsewhere and handed to this run). */
export function recordJob(runDir: string, entry: LedgerEntry): void {
  const prior = findJob(runDir, entry.key);
  if (!prior || prior.requestId !== entry.requestId) {
    for (let n = nextN(runDir, entry.key); ; n++) {
      const a: Attempt = {
        key: entry.key, model: entry.model, n, attempt: newAttemptId(), state: 'accepted', pid: process.pid, host: hostname(),
        claimedAt: entry.submittedAt, leaseUntil: 0, requestId: entry.requestId, statusUrl: entry.statusUrl,
        responseUrl: entry.responseUrl, submittedAt: entry.submittedAt, recoveredFrom: 'recorded',
      };
      if (createExclusive(attemptPath(runDir, entry.key, n), a)) break;
    }
  }
  if (entry.completedAt) markDone(runDir, entry.key, entry.completedAt);
}

/** Close a job, so a resume knows it does not need picking up. One marker per closing attempt. */
export function markDone(runDir: string, key: string, completedAt = new Date().toISOString()): void {
  writeAtomic(donePath(runDir, key, newAttemptId()), { completedAt });
}

/**
 * The process that took `requestId` into the ledger, when it is another one still running on this
 * machine: that process records the purchase itself when it finishes. One on another machine cannot be
 * seen, so it reads as gone.
 */
export function buyerRunning(runDir: string, key: string, requestId: string): { pid: number } | undefined {
  const a = readAttempts(runDir, key).find((x) => x.requestId === requestId);
  if (!a || a.host !== hostname() || a.pid <= 0 || a.pid === process.pid) return undefined;
  return processAlive(a.pid) ? { pid: a.pid } : undefined;
}

/** Jobs that were accepted and never seen to finish — what a resume has to pick up. */
export function inFlight(runDir: string): LedgerEntry[] {
  return readLedger(runDir).filter((e) => !e.completedAt);
}

// --- the claim ---------------------------------------------------------------------

function newAttemptId(): string {
  return `${Date.now().toString(36)}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

function nextN(runDir: string, key: string): number {
  const all = readAttempts(runDir, key);
  return all.length ? all[all.length - 1].n + 1 : 0;
}

/** A claim is live while its lease runs and, on this machine, while its process exists. */
export function isLive(a: Attempt, now = Date.now()): boolean {
  if (a.leaseUntil <= now) return false;
  if (a.host === hostname() && a.pid > 0 && a.pid !== process.pid && !processAlive(a.pid)) return false;
  return true;
}

export interface ClaimOptions {
  /** How long a claim holds without renewal. Renewed every third of it while its owner works. */
  leaseMs?: number;
  /** How often a waiting caller re-reads the claim it is waiting on. */
  pollMs?: number;
  /** How long to wait on a live claim held by someone else before giving up and saying who holds it. */
  waitTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Asked, when an attempt may have been accepted but no id was written, to find that request on the
   * queue. Anything but `found` leaves the job unresolved: it is reported, never bought again.
   */
  recover?: (attempt: Attempt) => Promise<Recovery>;
}

/**
 * What a search of the queue's request history said about an attempt. `not-listed`: the history was
 * read to its end and does not list the request. `unsearched`: it was not searched, or not to the end,
 * so nothing is known either way; the reason says why, and `lasting` marks a cause a re-run cannot clear.
 */
export type Recovery =
  | { kind: 'found'; job: Pick<LedgerEntry, 'requestId' | 'statusUrl' | 'responseUrl'> }
  | { kind: 'not-listed' }
  | { kind: 'unsearched'; why: string; lasting?: boolean };

export const DEFAULT_LEASE_MS = 30_000;

/** A request may already have been bought and nothing here can say which: never resolved by buying again. */
export class AmbiguousAcceptance extends Error {
  constructor(readonly attempt: Attempt, runDir: string, readonly lookup: Exclude<Recovery, { kind: 'found' }>) {
    const since = attempt.submittingAt ? ` since ${attempt.submittingAt}` : '';
    const reason = attempt.reason ? `; ${attempt.reason}` : '';
    // readAttempts stands an unreadable file in as a record with no id: whether it held one is unknown.
    const unread = attempt.model === '' && attempt.attempt.startsWith('unreadable-');
    super(
      `a previous attempt at this exact request (${attempt.attempt}, ${attempt.state}${since}${reason}) may have been ` +
      `accepted, but ${unread ? 'its record could not be read, so whether it holds a request id is unknown' : 'no request id was recorded for it'}. ` +
      (lookup.kind === 'not-listed'
        ? "The queue's request history does not list it yet. It is not bought again. Re-run later to look for it once more; "
        : lookup.lasting
          ? `The queue's request history cannot be searched for it (${lookup.why}), and a re-run will not get further. It is not bought again; `
          : `The queue's request history could not be searched for it (${lookup.why}), so whether it was bought is unknown. ` +
            'It is not bought again. A re-run searches again, which helps only once that cause is gone; ') +
      `if you are certain it never reached the queue, remove ${attemptPath(runDir, attempt.key, attempt.n)} and re-run, which buys it.`,
    );
  }
}

/** This caller's claim was taken over while it was not looking (a pause longer than the lease). */
export class LostClaim extends Error {}

export type ClaimResult =
  | { kind: 'reuse'; entry: LedgerEntry; recovered?: boolean }
  | { kind: 'won'; claim: Claim };

export class Claim {
  private attemptRec: Attempt;
  private timer: NodeJS.Timeout | undefined;
  /** Why the last lease renewal failed, so a claim that lapses because of it says so. */
  private renewError: string | undefined;

  constructor(private readonly runDir: string, attempt: Attempt, private readonly leaseMs: number) {
    this.attemptRec = attempt;
    this.timer = setInterval(() => this.renew(), Math.max(1, Math.floor(leaseMs / 3)));
    this.timer.unref();
  }

  get state(): AttemptState { return this.attemptRec.state; }
  get attempt(): Attempt { return this.attemptRec; }

  private path(): string { return attemptPath(this.runDir, this.attemptRec.key, this.attemptRec.n); }

  private superseded(): boolean {
    return existsSync(attemptPath(this.runDir, this.attemptRec.key, this.attemptRec.n + 1));
  }

  // Memory follows the disk, never leads it: a lease this process believes renewed must be one other
  // callers can read.
  private write(patch: Partial<Attempt>): void {
    const next = { ...this.attemptRec, ...patch };
    writeAtomic(this.path(), next);
    this.attemptRec = next;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private renew(): void {
    if (this.state !== 'claimed' && this.state !== 'submitting') return this.stop();
    // A claim someone already took over is not renewed back to life.
    if (this.superseded() || this.attemptRec.leaseUntil <= Date.now()) return this.stop();
    try {
      this.write({ leaseUntil: Date.now() + this.leaseMs });
      this.renewError = undefined;
    } catch (e) {
      // The next tick retries; until then the lease runs down, which is what submitting() checks.
      this.renewError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Marks the request as on its way, with the exact body, before it is sent. Refuses when the lease has
   * run low or someone took over, because sending then could buy what the new owner is buying.
   */
  submitting(body: unknown): void {
    if (this.state !== 'claimed') throw new Error(`cannot submit from ${this.state}`);
    const superseded = this.superseded();
    if (superseded || this.attemptRec.leaseUntil - Date.now() < this.leaseMs / 3) {
      this.stop();
      throw new LostClaim(superseded
        ? `another caller took over the claim on ${this.attemptRec.key} before this one sent it`
        : `the claim on ${this.attemptRec.key} ran low on its lease before sending` +
          `${this.renewError ? ` (renewing it failed: ${this.renewError})` : ''}, so another caller may take it over`);
    }
    this.write({ state: 'submitting', body, submittingAt: new Date().toISOString(), leaseUntil: Date.now() + this.leaseMs });
    // A pause between the check and the write can outlast the lease. Whoever took over in it checks this
    // attempt again after claiming, and this one checks for them after writing, so one of the two backs off.
    if (this.superseded()) {
      this.stop();
      try {
        this.write({ state: 'abandoned', reason: 'taken over before it was sent' });
      } catch { /* left sending, it reads as possibly sent once its lease runs out, and is looked up, not bought */ }
      throw new LostClaim(`another caller took over the claim on ${this.attemptRec.key} before this one sent it`);
    }
  }

  accepted(job: Pick<LedgerEntry, 'requestId' | 'statusUrl' | 'responseUrl'>): void {
    this.stop();
    this.write({ state: 'accepted', ...job, submittedAt: new Date().toISOString() });
  }

  refused(reason: string): void {
    this.stop();
    this.write({ state: 'refused', reason });
  }

  uncertain(reason: string): void {
    this.stop();
    this.write({ state: 'uncertain', reason });
  }

  abandon(reason: string): void {
    this.stop();
    if (this.state === 'claimed') this.write({ state: 'abandoned', reason });
  }
}

/**
 * Claim the right to buy `key`, or learn who already did.
 *
 * `reuse`: an accepted job exists (recorded, or found on the queue by `recover`). `won`: this caller
 * owns attempt n and must move it through submitting to accepted, refused, uncertain or abandoned.
 * A live claim held elsewhere is waited on; a dead `claimed` one is taken over; a dead `submitting` or
 * an `uncertain` one is resolved through `recover`, and throws AmbiguousAcceptance when it cannot be.
 */
export async function claimJob(runDir: string, key: string, model: string, opts: ClaimOptions = {}): Promise<ClaimResult> {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + (opts.waitTimeoutMs ?? 30 * 60_000);

  for (;;) {
    // One read decides the pass: an acceptance recorded between two reads would reach neither branch
    // below and be bought again.
    const attempts = readAttempts(runDir, key);
    const known = findJob(runDir, key, attempts);
    if (known) return { kind: 'reuse', entry: known };

    const top = attempts.at(-1);
    if (top && (top.state === 'claimed' || top.state === 'submitting') && isLive(top)) {
      if (Date.now() > deadline) {
        throw new Error(`another caller (pid ${top.pid} on ${top.host || 'unknown host'}) has held this exact request since ${top.claimedAt}; re-run when it finishes`);
      }
      await sleep(pollMs);
      continue;
    }
    if (top && (top.state === 'submitting' || top.state === 'uncertain')) {
      const found: Recovery = opts.recover ? await opts.recover(top) : { kind: 'unsearched', why: 'no queue lookup is available here', lasting: true };
      if (found.kind !== 'found') throw new AmbiguousAcceptance(top, runDir, found);
      const adopted: Attempt = {
        key, model, n: top.n + 1, attempt: newAttemptId(), state: 'accepted', pid: process.pid, host: hostname(),
        claimedAt: new Date().toISOString(), leaseUntil: 0, ...found.job, submittedAt: top.submittingAt ?? top.claimedAt,
        recoveredFrom: `attempt ${top.attempt}`,
      };
      if (createExclusive(attemptPath(runDir, key, top.n + 1), adopted)) {
        return { kind: 'reuse', entry: entryOf(adopted, readDone(runDir, key)), recovered: true };
      }
      continue;
    }

    // Nothing yet, or the last attempt was refused, abandoned, or claimed by a caller that is gone.
    const n = top ? top.n + 1 : 0;
    const mine: Attempt = {
      key, model, n, attempt: newAttemptId(), state: 'claimed', pid: process.pid, host: hostname(),
      claimedAt: new Date().toISOString(), leaseUntil: Date.now() + leaseMs,
    };
    if (!createExclusive(attemptPath(runDir, key, n), mine)) continue;
    // A claim that moved since it was read belongs to an owner that was only paused and may be sending.
    if (top?.state === 'claimed') {
      const again = readAttempts(runDir, key).find((a) => a.n === top.n);
      if (again?.state !== top.state || again.leaseUntil !== top.leaseUntil) {
        unlinkSync(attemptPath(runDir, key, n));
        continue;
      }
    }
    return { kind: 'won', claim: new Claim(runDir, mine, leaseMs) };
  }
}
