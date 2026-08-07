// Deterministic style selection for the fast path — facet-scored, seeded, aspect-matched. No model.
// Pool = refs/tags.json v3 — the RUNTIME INDEX, recipes only: {version:3, taxonomy, refs:[{id, wv?,
// facets:{type,device,layout,motion,energy,fit}}]}. Every entry MUST ship its sheet (recipe.md) AND its
// compiled module (recipe.ts, run by generate-recipe.ts) — integrity-checked below, fail-loud. Raw
// prefabs and excluded refs are not in the runtime index and have no runtime path; CUT refs are
// deleted outright and live on only in git history.
// `fit` comes from the CURATED facets (the sheet's declared aspect is the SOT) — never
// re-derived from prefab CSS at selection.
//
// Selection = facet scoring (transcript energy → preferred energy facets) + seeded weighted-random
// among eligible candidates: fit for the video, plus reproducible variety (same run key → same pick;
// different videos roll different styles).
// HARD FILTER: once an aspect has >= SHEET_THRESHOLD recipes, the draw runs ONLY over recipe'd refs
// (a DEFAULT run never silently pays the from-scratch path). Below the threshold style.json carries
// `coverage.filtered:false` and the SKILL asks the user instead of deciding for them.
// Overrides:
//   --seed <n>       draw with an explicit seed (browse alternatives deterministically)
//   --style <id>     force a specific ref id (bypasses the draw AND the hard filter, still validated
//                    against the index — an id outside it is rejected)
//   --recipes-only   restrict the pool to compiled refs (kept for compatibility; a no-op while the
//                    index is 100% compiled — the hard filter already does this)
// Writes runs/<key>/style.json — see StylePick.
//   node --import tsx pipeline/scripts/sample-style.ts --run <runDir> [--seed N] [--style <id>] [--recipes-only]
import { parseFlags } from '../../veed/args.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../config.ts';
import { generatorRelPath } from '../recipes/lib.ts';

// Draw-exclusion by tag. Empty since the engine --verify occlusion false-positive
// (rendering-bugs/2026-07-09-verify-occlusion-ignores-cue-opacity-gate.md) was confirmed fixed in the
// published 0.6.0 release — the doc's minimal repro and the hook-015 workload both verify clean.
const EXCLUDED_TAGS = new Set<string>([]);

// An aspect is "covered" once this many of its pool refs ship recipes — then the hard filter engages.
// Main's pool is 100% compiled (28/28), so the filter is always on; the threshold keeps the coverage
// story honest if curation ever shrinks an aspect.
export const SHEET_THRESHOLD = 5;

export interface Facets {
  type: string[]; device: string[]; layout: string[]; motion: string[]; energy: string[]; fit: string[];
}

interface TagEntryV3 { id: string; wv?: string; facets: Facets; excluded?: boolean }

export interface Candidate { id: string; refPath: string; facets: Facets; hasRecipe: boolean }

export interface Coverage { aspect: '9:16' | '16:9'; sheets: number; threshold: number; filtered: boolean }

export interface StylePick {
  refId: string;
  refPath: string;
  facets: Facets;
  hasRecipe: boolean;
  seed: number;
  energy: 'high' | 'mid' | 'low';
  coverage: Coverage;
  // The next-best aspect-matched ids by weight (pick excluded) — a ready shortlist for the creative
  // pass, never the orchestrator's memory. It is a SHORTLIST, not the boundary: the skeleton donor
  // must share this aspect, but type/palette and device donors may be any sheet in the index
  // (see director-brief.md, CROSS-ASPECT DONORS).
  alternates: string[];
}

// FNV-1a → deterministic seed from the run key.
export function seedFromKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// mulberry32 — tiny deterministic PRNG.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- transcript energy ----------

export interface TranscriptStats {
  wordsPerSec: number;
  exclamationDensity: number; // '!' per word
  capsRatio: number;          // fully-uppercase words (2+ letters) per word
}

interface VeedChunk { text: string; timestamp: [number, number]; words?: { text: string; timestamp: [number, number] }[] }

export function transcriptStats(chunks: VeedChunk[]): TranscriptStats {
  const words: { text: string; start: number; end: number }[] = [];
  for (const c of chunks) {
    if (Array.isArray(c.words) && c.words.length > 0) {
      for (const w of c.words) words.push({ text: w.text.trim(), start: w.timestamp[0], end: w.timestamp[1] });
    } else if (Array.isArray(c.timestamp)) {
      // no per-word data: spread the chunk's tokens across its window for the rate estimate
      for (const t of c.text.trim().split(/\s+/).filter(Boolean)) words.push({ text: t, start: c.timestamp[0], end: c.timestamp[1] });
    }
  }
  const w = words.filter((x) => x.text);
  if (w.length === 0) return { wordsPerSec: 0, exclamationDensity: 0, capsRatio: 0 };
  const span = w[w.length - 1].end - w[0].start || 1;
  const excl = w.filter((x) => x.text.includes('!')).length;
  const caps = w.filter((x) => /^[^a-z]*[A-Z]{2,}[^a-z]*$/.test(x.text)).length;
  return { wordsPerSec: w.length / span, exclamationDensity: excl / w.length, capsRatio: caps / w.length };
}

// Speech energy → preferred energy facets. Thresholds from short-form practice: conversational speech
// runs ~2-2.5 w/s; hype delivery pushes past ~2.8; calm/asmr sits under ~1.8.
export function energyOf(stats: TranscriptStats): 'high' | 'low' | 'mid' {
  if (stats.wordsPerSec > 2.8 || stats.exclamationDensity > 0.12 || stats.capsRatio > 0.3) return 'high';
  if (stats.wordsPerSec < 1.8 && stats.wordsPerSec > 0) return 'low';
  return 'mid';
}

const ENERGY_FACETS: Record<'high' | 'low' | 'mid', string[]> = {
  high: ['hype', 'loud', 'punchy'],
  low: ['calm', 'elegant', 'premium', 'clean'],
  mid: ['clean', 'loud', 'playful'],
};

// ---------- pool ----------

function readIndex(repoRoot: string): TagEntryV3[] {
  const data = JSON.parse(readFileSync(join(repoRoot, 'refs/tags.json'), 'utf8')) as { version?: number; refs?: TagEntryV3[] };
  if (data.version !== 3 || !Array.isArray(data.refs)) throw new Error('refs/tags.json is not the v3 runtime index ({version:3, refs:[…]})');
  return data.refs;
}

// All refs a run could use: v3 runtime-index entry, no excluded tag, aspect fit, prefab present.
// Stable order → stable draw. The index is recipes-only BY CONTRACT — an entry missing ANY of its
// three files (template.wv, recipe.md, recipe.ts) is an integrity error, never a silent downgrade.
// A cut deletes the whole refs/html/<id>/ folder, so a half-applied cut takes out all three at once:
// the prefab check has to throw like the other two, or the pool silently shrinks by one.
export function candidatesFor(repoRoot: string, aspect: '9:16' | '16:9'): Candidate[] {
  const out: Candidate[] = [];
  for (const e of readIndex(repoRoot)) {
    if (e.excluded) continue;
    if (Object.values(e.facets).flat().some((t) => EXCLUDED_TAGS.has(t))) continue;
    if (!e.facets.fit.includes(aspect)) continue;
    const refPath = e.wv ? join(repoRoot, e.wv) : join(repoRoot, 'refs/html', e.id, 'template.wv');
    if (!existsSync(refPath)) {
      throw new Error(`runtime index integrity: "${e.id}" is listed in refs/tags.json but has no template.wv prefab — a cut must remove the index row too; restore the folder or drop the row`);
    }
    if (!existsSync(join(dirname(refPath), 'recipe.md'))) {
      throw new Error(`runtime index integrity: "${e.id}" is listed in refs/tags.json but has no recipe.md sheet — the index is recipes-only (every entry ships its sheet + compiled module)`);
    }
    const hasRecipe = existsSync(join(repoRoot, generatorRelPath(e.id)));
    if (!hasRecipe) {
      throw new Error(`runtime index integrity: "${e.id}" is listed in refs/tags.json but has no compiled recipe.ts — the index is recipes-only (every entry ships its compiled module)`);
    }
    out.push({ id: e.id, refPath, facets: e.facets, hasRecipe });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- scoring + draw ----------

function scoreOf(c: Candidate, wanted: string[]): number {
  return c.facets.energy.filter((e) => wanted.includes(e)).length * 2;
}

// Weighted seeded sample: every eligible candidate stays reachable; energy matches raise the odds.
function weightedDraw(pool: Candidate[], wanted: string[], seed: number): Candidate {
  const weights = pool.map((c) => 1 + scoreOf(c, wanted) * 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = mulberry32(seed)() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function sampleStyle(runDir: string, opts: { seed?: number; style?: string; recipesOnly?: boolean } = {}): StylePick {
  const repoRoot = REPO_ROOT;
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as { key?: string; width: number; height: number };
  const aspect: '9:16' | '16:9' = meta.height >= meta.width ? '9:16' : '16:9';
  const key = meta.key ?? basename(runDir);

  const cands = candidatesFor(repoRoot, aspect);
  if (!cands.length) throw new Error(`no ${aspect} refs available`);

  // vibe from the transcript when present (it should be — prep needs it); neutral 'mid' otherwise
  let energy: 'high' | 'mid' | 'low' = 'mid';
  const tPath = join(runDir, 'transcript.json');
  if (existsSync(tPath)) {
    const t = JSON.parse(readFileSync(tPath, 'utf8')) as { chunks?: VeedChunk[] };
    if (Array.isArray(t.chunks) && t.chunks.length) energy = energyOf(transcriptStats(t.chunks));
  }
  const wanted = ENERGY_FACETS[energy];

  // HARD FILTER: with enough compiled recipes, the default draw never leaves the recipe'd set.
  // (--recipes-only kept as an explicit restrict for compatibility; redundant while coverage holds.)
  const sheets = cands.filter((c) => c.hasRecipe);
  const filtered = sheets.length >= SHEET_THRESHOLD || opts.recipesOnly === true;
  const pool = filtered ? sheets : cands;
  if (!pool.length) throw new Error(`no ${aspect} refs available with a recipe`);
  const coverage: Coverage = { aspect, sheets: sheets.length, threshold: SHEET_THRESHOLD, filtered };

  const seed = opts.seed ?? seedFromKey(key);
  let pick: Candidate;
  if (opts.style) {
    const forced = cands.find((c) => c.id === opts.style);
    // RECIPES ARE THE PRODUCT: the runtime index IS the whole runtime universe — an id outside it
    // (raw prefab, benched or excluded sheet) is not in the runtime index, never a runtime pick, even by
    // explicit ask; only recipe-backed refs are stylable.
    if (!forced) throw new Error(`--style "${opts.style}" is not a valid ${aspect} candidate (recipes-only index; ${cands.length} available: ${cands.map((c) => c.id).slice(0, 8).join(', ')}…)`);
    pick = forced;
  } else {
    pick = weightedDraw(pool, wanted, seed);
  }

  // Next-best RECIPE'D aspect-matched ids by weight (stable tie-break by id), pick excluded — the
  // creative-pass mixing pool is validated recipes only (raw prefabs never surface at runtime).
  const alternates = cands
    .filter((c) => c.id !== pick.id && c.hasRecipe)
    .map((c) => ({ id: c.id, w: 1 + scoreOf(c, wanted) * 2 }))
    .sort((a, b) => b.w - a.w || a.id.localeCompare(b.id))
    .slice(0, 4)
    .map((x) => x.id);

  const style: StylePick = {
    refId: pick.id, refPath: pick.refPath, facets: pick.facets, hasRecipe: pick.hasRecipe,
    seed, energy, coverage, alternates,
  };
  writeFileSync(join(runDir, 'style.json'), JSON.stringify(style, null, 2));
  return style;
}

// Canonical reader for runs/<key>/style.json. hasRecipe defaults to FALSE unless the file says
// exactly `true` — a missing/legacy/malformed field must route to the from-scratch variant, never
// to generate-recipe.ts (which would chase a nonexistent generator module).
// refId is validated against the runtime index, exactly as --style is on the way in: this is a file
// on disk, and its refId becomes an import()ed module path in generate-recipe.ts. Membership, not
// eligibility — aspect and exclusions are the draw's business, containment is this one's.
export function readStylePick(runDir: string): Pick<StylePick, 'refId' | 'refPath' | 'hasRecipe' | 'seed'> & { facets?: Facets } {
  const raw = JSON.parse(readFileSync(join(runDir, 'style.json'), 'utf8')) as Partial<StylePick>;
  if (!raw.refId || !raw.refPath) throw new Error(`style.json in ${runDir} is missing refId/refPath`);
  const known = new Set(readIndex(REPO_ROOT).map((e) => e.id));
  if (!known.has(raw.refId)) {
    throw new Error(`style.json in ${runDir} names refId ${JSON.stringify(raw.refId)}, which is not in the runtime index (refs/tags.json) — re-run sample-style.ts for this run`);
  }
  return {
    refId: raw.refId,
    refPath: raw.refPath,
    hasRecipe: raw.hasRecipe === true,
    seed: typeof raw.seed === 'number' ? raw.seed : 0,
    ...(raw.facets ? { facets: raw.facets } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Strict: an unknown flag is an error. A typo here silently redraws the style someone thought they
  // were overriding, and the run then renders the wrong pick while reporting the wrong id.
  const { values } = parseFlags({
    args: process.argv.slice(2),
    options: {
      run: { type: 'string' },
      seed: { type: 'string' },
      style: { type: 'string' },
      'recipes-only': { type: 'boolean' },
    },
  });
  const run = values.run;
  if (!run) { console.error('usage: node --import tsx pipeline/scripts/sample-style.ts --run <runDir> [--seed N] [--style <id>] [--recipes-only]'); process.exit(2); }
  let seed: number | undefined;
  if (values.seed !== undefined) {
    seed = Number(values.seed);
    if (!Number.isFinite(seed)) { console.error(`--seed must be a number, got "${values.seed}"`); process.exit(2); }
  }
  const s = sampleStyle(run, { seed, style: values.style, recipesOnly: values['recipes-only'] ?? false });
  const cov = s.coverage.filtered ? 'recipes-only pool' : `COVERAGE MODE (${s.coverage.sheets}/${s.coverage.threshold} sheets)`;
  console.log(`[sample-style] ${s.refId} seed=${s.seed} recipe=${s.hasRecipe ? 'yes' : 'no'} energy=${s.energy} ${cov}`);
  console.log(`  alternates: ${s.alternates.join(', ')}`);
  console.log(`  wrote ${join(run, 'style.json')}`);
}
