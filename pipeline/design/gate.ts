// The gate that reads a run's authored documents back against its own design system.
//
// The LIBRARY half: no CLI, no imports outside pipeline/, so it loads in-process from a packaged
// install (as gate.js) and from a checkout (as gate.ts) through the same path. The runnable script
// is pipeline/scripts/design-gate.ts.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSystem, assertGrounded, check, checkLadder, checkFonts, checkDeclaredUsed, type DesignSystem, type Finding } from './system.ts';

// The content tree this gate ships inside — a checkout's root, or the installed package's. Resolved
// from the module rather than an env var so the donor check reads the same index the run drew from.
const CONTENT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every `.wv` under the run, or under one chapter of it, in a stable order. */
export function documentsIn(runDir: string, doc?: string): string[] {
  const root = doc ? join(runDir, doc) : runDir;
  return walkFor(root);
}

/**
 * The wcag pass writes `template.draft.wv`, `template.final.wv` and `template.draft.wcag-remediated.wv`
 * beside the document it is remediating, and on promotion `template.wv` IS the remediated content. A
 * walk that took every `.wv` therefore gated four documents on a one-document run the second time it
 * ran, and reported findings against drafts that ship nowhere.
 */
const INTERMEDIATE = /\.(draft|final)\.wv$|\.wcag-remediated\.wv$/i;

function walkFor(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'qa' && !name.startsWith('.')) walk(p); }
      else if (name.endsWith('.wv') && !INTERMEDIATE.test(name)) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/**
 * Donors must be real. The point of the field is that "I used the recipes" stops being a sentence in
 * a report and becomes a claim that can be false — a run once said it took its motion mechanics from
 * the bank while two of the four named mechanics existed in no sheet at all.
 */
export function checkDonors(sys: DesignSystem): Finding[] {
  const indexPath = join(CONTENT_ROOT, 'refs', 'tags.json');
  if (!existsSync(indexPath)) return [];
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { refs?: { id: string }[] } | { id: string }[];
  const ids = new Set((Array.isArray(index) ? index : index.refs ?? []).map((r) => r.id));
  return sys.donors
    .filter((d) => !ids.has(d))
    .map((d) => ({ rule: 'donor-not-in-index', severity: 'error' as const, message: `donor "${d}" is not a ref in refs/tags.json — a system cannot be seeded from something that does not exist` }));
}

/**
 * `doc` gates ONE chapter of a longer piece.
 *
 * It also turns off the declared-but-unused check, which is a statement about the whole piece: a film
 * is authored a chapter at a time, so every rung and family that first appears in a later chapter
 * would be an error until the last document existed. Chapter one could not pass until the film was
 * finished, and the only way past was to disable the design gate entirely.
 */
export function gate(runDir: string, opts: { doc?: string } = {}): { findings: (Finding & { file?: string })[]; documents: number } {
  const sys = readSystem(runDir);
  if (!sys) {
    return {
      documents: 0,
      findings: [{
        rule: 'no-design-system',
        severity: 'error',
        message: `${join(runDir, 'design', 'system.json')} does not exist — author the system before the documents, from the run's own content`,
      }],
    };
  }
  const findings: (Finding & { file?: string })[] = [];
  try {
    assertGrounded(runDir, sys);
  } catch (e) {
    findings.push({ rule: 'system-not-grounded', severity: 'error', message: (e as Error).message });
  }
  findings.push(...checkLadder(sys));
  findings.push(...checkFonts(sys));
  findings.push(...checkDonors(sys));

  const docs = documentsIn(runDir, opts.doc);
  if (!docs.length) {
    findings.push({
      rule: 'no-documents',
      severity: 'error',
      message: opts.doc
        ? `no .wv under ${opts.doc} — check the --doc path; a gate that reads nothing is not a gate that passed`
        : 'no .wv anywhere under the run — nothing was gated',
    });
  }
  const texts: string[] = [];
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    texts.push(text);
    for (const f of check(text, sys)) {
      findings.push({ ...f, file: relative(runDir, doc) });
    }
  }
  // Both directions, and only once the WHOLE run is read: a rung used in the outro alone is used.
  if (docs.length && !opts.doc) findings.push(...checkDeclaredUsed(texts, sys));
  return { findings, documents: docs.length };
}
