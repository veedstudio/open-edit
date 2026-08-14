// The record of what has already been asked for, so it is never paid for twice.
//
// A generation queue takes the money when it ACCEPTS a request, not when it returns one. The
// documentary run submitted the same 8-second opening clip a second time while the first was still
// running, then lost both job ids when the status poll failed and recovered them by hand with curl.
// Two charges and sixteen minutes, for one clip.
//
// The ledger keys a job by what was asked for, not by when. Two identical requests are the same
// request, and a request whose id was written down survives a lost connection — which is the whole
// reason the id is written down before the first poll.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

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

export function ledgerPath(runDir: string): string {
  return join(runDir, 'assets', 'jobs.json');
}

/**
 * A stable identity for a request. Object keys are sorted, so two callers that build the same input
 * in a different order still collide — which is the point.
 */
export function jobKey(model: string, input: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    }
    return v;
  };
  return createHash('sha256').update(`${model}\n${JSON.stringify(canonical(input))}`).digest('hex').slice(0, 16);
}

export function readLedger(runDir: string): LedgerEntry[] {
  const p = ledgerPath(runDir);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    // Valid JSON of the wrong shape is as unreadable as a truncated file, and returning [] for it put
    // the next write straight through: two accepted job ids gone, no quarantine, no warning.
    if (!Array.isArray(v) || v.some((e) => !e || typeof e.key !== 'string' || typeof e.requestId !== 'string')) {
      throw new Error('the ledger is not a list of job records');
    }
    return v as LedgerEntry[];
  } catch {
    // The same rule the asset manifest follows: a file that cannot be read is kept, never written
    // through. Losing this one means paying for every job in it again.
    let dest = p.replace(/\.json$/, '.corrupt.json');
    let n = 1;
    while (existsSync(dest)) dest = p.replace(/\.json$/, `.corrupt.${n++}.json`);
    renameSync(p, dest);
    process.stderr.write(`[queue] the job ledger could not be parsed and was kept at ${dest}; starting a new one\n`);
    return [];
  }
}

export function findJob(runDir: string, key: string): LedgerEntry | undefined {
  return readLedger(runDir).find((e) => e.key === key);
}

export function recordJob(runDir: string, entry: LedgerEntry): void {
  const all = readLedger(runDir);
  const i = all.findIndex((e) => e.key === entry.key);
  if (i >= 0) all[i] = { ...all[i], ...entry };
  else all.push(entry);
  const p = ledgerPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
}

/** Jobs that were accepted and never seen to finish — what a resume has to pick up. */
export function inFlight(runDir: string): LedgerEntry[] {
  return readLedger(runDir).filter((e) => !e.completedAt);
}
