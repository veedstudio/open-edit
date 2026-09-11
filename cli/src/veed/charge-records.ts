// Who is allowed to charge this run, decided from the records the other attempts left behind.
//
// Concurrent runs of the same key are a normal workflow, so there is no lock here and no exclusive file:
// every attempt writes its OWN record, named for the session that wrote it, and the only question left is
// what the records it can see mean. That question is this module — pure, so every row of the table below is
// testable without a filesystem, a clock or a second process. veed/generate.ts does the IO around it.
//
//   resolved  the attempt finished (or was abandoned); it constrains nothing
//   charging  a charge is in flight right now; a second one would buy the same script twice
//   paid      the charge landed and the job id is on record; the video is one --resume away
//   orphaned  a charge was started by a process that is gone, and no job id was ever recorded, so whether
//             the money moved is genuinely unknown
import { POLL_DEADLINE_MS } from './fabric.ts';

export type ChargePhase = 'charging' | 'charged';

// One attempt at charging, written BEFORE create_fabric_video is called: a record that only appears on
// success is missing at exactly the moment it matters — when the response never came back.
export interface ChargeRecord {
  sessionId: string;
  pid: number;
  host: string;
  startedAt: number;
  phase: ChargePhase;
  // Set with `charged`: the id of the job the workspace has now paid for.
  jobId?: string;
  resolvedAt?: number;
}

export type ChargeState = 'resolved' | 'charging' | 'paid' | 'orphaned';

export interface ChargeVerdict extends ChargeRecord {
  state: ChargeState;
}

export interface ChargeContext {
  host: string;
  now: number;
  isAlive: (pid: number) => boolean;
}

const CHARGE_PREFIX = '.fabric-charge-';
const CHARGE_SUFFIX = '.json';
// A pid on another machine cannot be probed, so its record is trusted for a bounded time instead. The bound
// is the poll deadline plus a margin: anything shorter would declare a perfectly healthy run dead and let a
// second charge through.
const LEASE_MARGIN_MS = 5 * 60_000;
export const CHARGE_LEASE_MS = POLL_DEADLINE_MS + LEASE_MARGIN_MS;

export function chargeFileName(sessionId: string): string {
  return `${CHARGE_PREFIX}${sessionId}${CHARGE_SUFFIX}`;
}

// Null for every other file a run directory holds, so a scan can read the session id straight off the name.
export function sessionIdOfChargeFile(fileName: string): string | null {
  if (!fileName.startsWith(CHARGE_PREFIX) || !fileName.endsWith(CHARGE_SUFFIX)) return null;
  const id = fileName.slice(CHARGE_PREFIX.length, fileName.length - CHARGE_SUFFIX.length);
  return id === '' ? null : id;
}

// `typeof x === 'number'` is not proof of a usable number: 1e999 is legal JSON that parses back as
// Infinity, and an infinite resolvedAt would read as a finished attempt — which is exactly the reading that
// clears the way to charge a second time.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Null rather than a partial record: the caller refuses on null, because guessing a missing phase is
// guessing whether money moved.
export function parseChargeRecord(raw: string): ChargeRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.sessionId !== 'string' || r.sessionId === '') return null;
  if (r.phase !== 'charging' && r.phase !== 'charged') return null;
  if (!isFiniteNumber(r.pid) || typeof r.host !== 'string' || r.host === '' || !isFiniteNumber(r.startedAt)) return null;
  // A charge that landed is only useful if it names the job it bought; a `charged` record without one says
  // money moved and offers no way to collect what it bought, so it is refused rather than believed in part.
  if (r.phase === 'charged' && (typeof r.jobId !== 'string' || r.jobId === '')) return null;
  if (r.jobId !== undefined && typeof r.jobId !== 'string') return null;
  if (r.resolvedAt !== undefined && !isFiniteNumber(r.resolvedAt)) return null;
  return value as ChargeRecord;
}

export function classifyChargeRecords(records: ChargeRecord[], ctx: ChargeContext): ChargeVerdict[] {
  return records.map((record) => ({ ...record, state: stateOf(record, ctx) }));
}

function stateOf(record: ChargeRecord, ctx: ChargeContext): ChargeState {
  if (record.resolvedAt !== undefined) return 'resolved';
  // Liveness is deliberately not consulted: the money is gone and the job id is recorded, so a dead owner
  // changes nothing about what the next run may do.
  if (record.phase === 'charged') return 'paid';
  return ownerLives(record, ctx) ? 'charging' : 'orphaned';
}

function ownerLives(record: ChargeRecord, ctx: ChargeContext): boolean {
  if (record.host !== ctx.host) return ctx.now - record.startedAt < CHARGE_LEASE_MS;
  return ctx.isAlive(record.pid);
}
