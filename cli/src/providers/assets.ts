// The asset seam.
//
// `runs/<key>/transcript.json` is the only seam transcription has: anything that writes that shape is
// a valid provider and nothing downstream can tell which one ran. Generated assets get the same
// treatment — the asset manifest (`readManifest`, over `runs/<key>/assets/records/`) is the seam, and a
// document that places an image does not care whether it came from VEED, from the user's own key, or
// off their disk.
//
// PROVENANCE IS PART OF THE ASSET. A 12-minute film shipped with 78.0% real footage and a per-shot
// account of where every second came from, because the number was asked for and had to be defended.
// An asset with no record of its origin cannot be defended, and cannot be swapped when a licence
// question lands later.
//
// SPEND IS RECORDED EVEN WHEN THE PROVIDER WILL NOT PRICE IT. The documentary session landed 99 asset
// records and every one of them carries `cost: null`, because fal prices nothing in its response. Its
// postmortem could only say "cost not measured". Every call here lands a record whether or not a price
// comes back with it, so at least the CALLS are countable.
import { readFileSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createExclusive, writeAtomic } from './exclusive-files.ts';

/** `audio` and `other` are for a generic call (fal run) that cannot tell voice from music, or has no file. */
export type AssetKind = 'image' | 'video' | 'speech' | 'sfx' | 'music' | 'upscale' | 'audio' | 'other';

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  /** Where the bytes landed, relative to the run dir. */
  path: string;
  provider: string;
  /** The provider's own model/endpoint id — the thing that actually decides the look. */
  model: string;
  /** What was asked for. A plate nobody can re-request is a plate nobody can revise. */
  prompt?: string;
  /** For image-to-video and upscales: the asset this one was derived from. */
  from?: string;
  createdAt: string;
  /** What the call cost, from its response or the provider's billing record; `null` means neither gave a figure. */
  cost: number | null;
  currency?: string;
  /** Free-form provider echo (job id, seed, resolution) so a result can be reproduced or disputed. */
  meta?: Record<string, unknown>;
  /** Set when a later call replaced this one under the same id. It was still billed. */
  supersededBy?: string;
}

export interface AssetManifest {
  runKey: string;
  assets: AssetRecord[];
  /** Set when a record on disk could not be read: `assets` is then empty rather than a partial account. */
  corrupt?: boolean;
}

/** Where runs recorded before per-row files kept their whole manifest: still read, never written. */
export function manifestPath(runDir: string): string {
  return join(runDir, 'assets', 'manifest.json');
}

// --- storage ------------------------------------------------------------------------------------
//
// Several processes record into one run (parallel `fal run`s, several agents), so no two of them ever
// write the same file and none waits on another. A plain record is one file under a name nobody else
// can pick. A provider request's row is a series of versions keyed by its request id, each created
// exclusively: a writer whose read went stale cannot create the version it computed, so it re-reads and
// applies its change again, and no fill-in is lost.

/** One file per row: `row-<stamp>.json` for a plain record, `request-<id>.<n>.json` for a request's versions. */
export function recordsDir(runDir: string): string {
  return join(runDir, 'assets', 'records');
}

interface RowFile {
  /** Write order, which is the row's place in the manifest and so decides what supersedes what. */
  stamp: string;
  runKey?: string;
  asset: AssetRecord;
}

const ROW = /^row-[\w-]+\.json$/;
const VERSION = /^request-([\w-]+)\.(\d+)\.json$/;
/** How long an unreadable file is taken for one still being written (the no-hard-link fallback). */
const TORN_GRACE_MS = 5_000;

let written = 0;
/** Sorts in write order: the clock, then this process's own count for writes in one millisecond. */
const newStamp = () => `${String(Date.now()).padStart(15, '0')}-${String(written++).padStart(6, '0')}-${process.pid}-${randomBytes(3).toString('hex')}`;

const requestKey = (requestId: string) => (/^[\w-]{1,128}$/.test(requestId) ? requestId : `h${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`);

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readRow(path: string): RowFile | 'unread' | 'damaged' {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as RowFile;
    if (typeof v?.stamp !== 'string' || typeof v.asset?.id !== 'string') throw new Error('not a record');
    return v;
  } catch {
    // Young, it is still being written; gone, another writer set it aside.
    try { return Date.now() - statSync(path).mtimeMs < TORN_GRACE_MS ? 'unread' : 'damaged'; } catch { return 'unread'; }
  }
}

function readLegacy(runDir: string): AssetManifest | 'damaged' | undefined {
  const p = manifestPath(runDir);
  if (!existsSync(p)) return undefined;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as AssetManifest;
    if (!Array.isArray(m?.assets)) throw new Error('not a manifest');
    return m;
  } catch {
    return 'damaged';
  }
}

interface Versions { top: number; latest?: RowFile; latestN: number; pending: boolean }

interface Stored { rows: RowFile[]; requests: Map<string, Versions>; damaged: string[] }

/** Every row file, or with `only` the versions of that one request. */
function readStored(runDir: string, only?: string): Stored {
  const dir = recordsDir(runDir);
  const out: Stored = { rows: [], requests: new Map(), damaged: [] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const v = VERSION.exec(name);
    if (only !== undefined ? v?.[1] !== only : !v && !ROW.test(name)) continue;
    const path = join(dir, name);
    const got = readRow(path);
    if (got === 'damaged') out.damaged.push(path);
    if (!v) {
      if (typeof got === 'object') out.rows.push(got);
      continue;
    }
    const n = Number(v[2]);
    const r = out.requests.get(v[1]) ?? { top: -1, latestN: -1, pending: false };
    r.top = Math.max(r.top, n);
    if (typeof got === 'object' && n > r.latestN) Object.assign(r, { latest: got, latestN: n });
    if (got === 'unread') r.pending = true;
    out.requests.set(v[1], r);
  }
  return out;
}

const inOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function readManifest(runDir: string, runKey = ''): AssetManifest {
  let legacy: ReturnType<typeof readLegacy>;
  let stored: Stored;
  try {
    legacy = readLegacy(runDir);
    stored = readStored(runDir);
  } catch {
    return { runKey, assets: [], corrupt: true };
  }
  // Reading past an unparseable record would present part of the account as the whole of it.
  if (legacy === 'damaged' || stored.damaged.length) return { runKey, assets: [], corrupt: true };

  const rows = [...stored.rows].sort((a, b) => inOrder(a.stamp, b.stamp));
  // The legacy file was written first; a plain row's place is its stamp.
  const entries = [
    ...(legacy?.assets ?? []).map((asset, i) => ({ at: `0-${String(i).padStart(9, '0')}`, asset })),
    ...rows.map((r) => ({ at: `1-${r.stamp}`, asset: r.asset })),
  ];
  // A request's latest version stands in for the row it already had, wherever that was written, so it stays one row.
  const requests = [...stored.requests.values()].flatMap((r) => (r.latest ? [r.latest] : [])).sort((a, b) => inOrder(a.stamp, b.stamp));
  for (const v of requests) {
    const i = entries.findLastIndex((e) => e.asset.meta?.requestId === v.asset.meta?.requestId);
    if (i < 0) entries.push({ at: `1-${v.stamp}`, asset: v.asset });
    else entries[i] = { at: entries[i].at, asset: entries[i].asset.supersededBy ? { ...v.asset, supersededBy: entries[i].asset.supersededBy } : v.asset };
  }
  entries.sort((a, b) => inOrder(a.at, b.at));

  // A later record under the same id replaces the earlier one as the live asset; both were billed.
  const assets = entries.map((e) => e.asset);
  const later = new Map<string, string>();
  for (let i = assets.length - 1; i >= 0; i--) {
    const by = later.get(assets[i].id);
    if (by !== undefined && !assets[i].supersededBy) assets[i] = { ...assets[i], supersededBy: by };
    later.set(assets[i].id, assets[i].createdAt);
  }
  return { runKey: (legacy && legacy.runKey) || rows.find((r) => r.runKey)?.runKey || runKey, assets };
}

/** Moves a file we could not parse aside, keeping its bytes. */
function quarantine(p: string): string | undefined {
  let dest = p.replace(/\.json$/, '.corrupt.json');
  let n = 1;
  while (existsSync(dest)) dest = p.replace(/\.json$/, `.corrupt.${n++}.json`);
  try {
    renameSync(p, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // another writer moved it first
    throw e;
  }
  return dest;
}

/** An unparseable file makes every reader refuse the account, so a writer sets it aside and says so. */
function setAsideDamaged(runDir: string): void {
  const damaged = readStored(runDir).damaged;
  if (readLegacy(runDir) === 'damaged') damaged.push(manifestPath(runDir));
  for (const p of damaged) {
    const kept = quarantine(p);
    if (kept) process.stderr.write(`[assets] ${p} could not be parsed and was kept at ${kept}; the account goes on without it\n`);
  }
}

export function record(runDir: string, asset: AssetRecord, runKey?: string): AssetRecord {
  setAsideDamaged(runDir);
  // Manifest paths are POSIX whichever OS wrote them — enforced here so no caller can regress it.
  asset = { ...asset, path: asset.path.split('\\').join('/') };
  // APPEND, never replace: regenerating under the same id is a second billed call, and the account of
  // what was paid for cannot be the account of what survived.
  const stamp = newStamp();
  writeAtomic(join(recordsDir(runDir), `row-${stamp}.json`), { stamp, ...(runKey ? { runKey } : {}), asset } satisfies RowFile);
  return asset;
}

/** The record of one provider request, by the request id its provider gave (`meta.requestId`). */
export function findRequest(runDir: string, requestId: string): AssetRecord | undefined {
  return readManifest(runDir).assets.findLast((a) => a.meta?.requestId === requestId);
}

/**
 * Writes the one record a provider request has: `fill` gets the record it already has, if any, and
 * returns the record to keep. A purchase is written when it is made and filled in when its charge and
 * files are known, by whichever run gets that far, and stays one row, so spend counts it once. `fill`
 * may run more than once: a writer that lost a race applies it again to the newer version.
 */
export function recordRequest(runDir: string, requestId: string, fill: (prior: AssetRecord | undefined) => AssetRecord): { record: AssetRecord; created: boolean } {
  setAsideDamaged(runDir);
  const key = requestKey(requestId);
  for (;;) {
    const v = readStored(runDir, key).requests.get(key) ?? { top: -1, latestN: -1, pending: false };
    // A version still being written may hold what this fill has to build on.
    if (v.pending) { sleepSync(20); continue; }
    const prior = v.latest?.asset ?? findRequest(runDir, requestId);
    const { supersededBy: _derived, ...next } = fill(prior);
    const asset: AssetRecord = { ...next, path: next.path.split('\\').join('/'), meta: { ...next.meta, requestId } };
    if (createExclusive(join(recordsDir(runDir), `request-${key}.${v.top + 1}.json`), { stamp: v.latest?.stamp ?? newStamp(), asset } satisfies RowFile)) {
      return { record: asset, created: !prior };
    }
  }
}

export interface SpendSummary {
  calls: number;
  priced: number;
  unpriced: number;
  total: number;
  byKind: Record<string, { calls: number; total: number }>;
}

/** The assets that survived — the id-keyed view, which is what a document places. */
export function current(runDir: string): AssetRecord[] {
  const m = readManifest(runDir);
  if (m.corrupt) throw new Error(`the asset manifest of ${runDir} could not be read — do not treat this run as having no assets`);
  return m.assets.filter((a) => !a.supersededBy);
}

/**
 * What this run has spent. `unpriced` is reported separately and never folded into the total: a
 * call with no cost figure makes the total a lower bound, and saying so is the difference
 * between a number and a guess.
 *
 * Superseded records COUNT. A regenerated plate was paid for twice however many survive.
 */
export function spend(runDir: string): SpendSummary {
  const m = readManifest(runDir);
  const out: SpendSummary = { calls: 0, priced: 0, unpriced: 0, total: 0, byKind: {} };
  for (const a of m.assets) {
    out.calls++;
    const k = (out.byKind[a.kind] ??= { calls: 0, total: 0 });
    k.calls++;
    if (typeof a.cost === 'number') {
      out.priced++;
      out.total += a.cost;
      k.total += a.cost;
    } else {
      out.unpriced++;
    }
  }
  out.total = Number(out.total.toFixed(4));
  for (const k of Object.values(out.byKind)) k.total = Number(k.total.toFixed(4));
  return out;
}

/** One line the user can read, honest about what is not priced. */
export function spendLine(runDir: string, currency = 'USD'): string {
  // "nothing generated" is the one answer that must never come from a file we could not read.
  if (readManifest(runDir).corrupt) return 'the asset manifest could not be read — this run has no usable spend figure';
  const s = spend(runDir);
  if (!s.calls) return 'nothing generated for this run';
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${v.calls} ${k}`).join(', ');
  const why = 'no price came back with the call and no billing record for it was read';
  if (!s.priced) return `${s.calls} generated assets (${kinds}) — none has a cost figure (${why}), so this run has no cost figure`;
  const tail = s.unpriced ? `, and ${s.unpriced} call(s) with no cost figure (${why}) — so this is a lower bound` : '';
  return `${s.calls} generated assets (${kinds}) — ${s.total} ${currency}${tail}`;
}

/**
 * Screen time by origin, which is what makes "how much of this is real footage?" answerable. The
 * documentary session was asked exactly that and could answer because the cut planner kept the
 * account; the first balanced cut had the film's own footage at 19.5% and nobody knew until it was
 * counted.
 */
export function provenanceShare(entries: { origin: string; seconds: number }[]): Record<string, number> {
  for (const e of entries) {
    if (!Number.isFinite(e.seconds) || e.seconds < 0) {
      throw new Error(`provenanceShare: "${e.origin}" has ${e.seconds} seconds — a share cannot be computed from that`);
    }
  }
  // Sum first, divide once. The previous version fed each entry back through the ROUNDED percentage of
  // the entries before it, so a repeated origin drifted downward: 300 one-second shots of one source
  // reported 90%. This is the number that answers "how much of this is real footage?".
  const seconds = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    seconds.set(e.origin, (seconds.get(e.origin) ?? 0) + e.seconds);
    total += e.seconds;
  }
  const out: Record<string, number> = {};
  if (!total) return out;
  for (const [origin, s] of seconds) out[origin] = Number(((s / total) * 100).toFixed(1));
  return out;
}
