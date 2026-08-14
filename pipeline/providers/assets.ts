// The asset seam.
//
// `runs/<key>/transcript.json` is the only seam transcription has: anything that writes that shape is
// a valid provider and nothing downstream can tell which one ran. Generated assets get the same
// treatment — `runs/<key>/assets/manifest.json` is the seam, and a document that places an image does
// not care whether it came from VEED, from the user's own key, or off their disk.
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
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type AssetKind = 'image' | 'video' | 'speech' | 'sfx' | 'music' | 'upscale';

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
  /** The price the RESPONSE carried. `null` means it carried none — not that none is published. */
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
  /** Set when the file on disk could not be parsed; the caller must not write over it. */
  corrupt?: boolean;
}

export function manifestPath(runDir: string): string {
  return join(runDir, 'assets', 'manifest.json');
}

export function readManifest(runDir: string, runKey = ''): AssetManifest {
  const p = manifestPath(runDir);
  if (!existsSync(p)) return { runKey, assets: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AssetManifest;
  } catch {
    // Reading through a corrupt manifest is honest — the files are still on disk. Writing through it
    // is not, and `record()` refuses to, because the empty fallback would erase the account of every
    // asset already paid for.
    return { runKey, assets: [], corrupt: true };
  }
}

/** Move a manifest we could not parse aside, so the next write starts clean without destroying it. */
function quarantine(p: string): string {
  let dest = p.replace(/\.json$/, '.corrupt.json');
  let n = 1;
  while (existsSync(dest)) dest = p.replace(/\.json$/, `.corrupt.${n++}.json`);
  renameSync(p, dest);
  return dest;
}

export function record(runDir: string, asset: AssetRecord, runKey?: string): AssetManifest {
  const m = readManifest(runDir, runKey ?? '');
  if (m.corrupt) {
    // Never write the empty fallback over a file we could not read: that is how 39 priced records
    // were reproduced away in review. Keep the bytes, start a fresh account, and say so.
    const kept = quarantine(manifestPath(runDir));
    delete m.corrupt;
    process.stderr.write(`[assets] the manifest could not be parsed and was kept at ${kept}; starting a new one\n`);
  }
  // The run key is only knowable from the caller; a default of '' would pin it empty on first write.
  if (runKey && !m.runKey) m.runKey = runKey;
  // APPEND, never replace. Regenerating an asset under the same id is a second billed call, and
  // overwriting the first one made the manifest under-report a real film's spend by at least 27
  // calls — the account of what was paid for cannot be the account of what survived.
  const prior = m.assets.filter((a) => a.id === asset.id && !a.supersededBy);
  for (const p of prior) p.supersededBy = asset.createdAt;
  m.assets.push(asset);
  const p = manifestPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  return m;
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
  if (m.corrupt) throw new Error(`the asset manifest at ${manifestPath(runDir)} could not be read — do not treat this run as having no assets`);
  return m.assets.filter((a) => !a.supersededBy);
}

/**
 * What this run has spent. `unpriced` is reported separately and never folded into the total: a
 * provider that returns no price makes the figure a lower bound, and saying so is the difference
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
  if (!s.priced) return `${s.calls} generated assets (${kinds}) — the provider returned no price, so this run has no cost figure`;
  const tail = s.unpriced ? `, and ${s.unpriced} call(s) the provider did not price — so this is a lower bound` : '';
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
