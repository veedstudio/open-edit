// The gate that reads a run's authored documents back against its own design system.
//
//   node --import tsx pipeline/scripts/design-gate.ts <run-dir> [--doc <subdir>] [--json]
//
// Exits 1 on any error-severity finding. Run it before the render, not after: every finding here is
// a string in a document, and fixing one after a 12-minute encode costs three minutes of machine
// time to learn what a regex knew instantly.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { REPO_ROOT } from '../../config.ts';
import { readSystem, assertGrounded, check, checkLadder, checkFonts, checkDeclaredUsed, type DesignSystem, type Finding } from '../design/system.ts';

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
  const indexPath = join(REPO_ROOT, 'refs', 'tags.json');
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
        message: `${relative(REPO_ROOT, join(runDir, 'design', 'system.json'))} does not exist — author the system before the documents, from the run's own content`,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { json: { type: 'boolean' }, doc: { type: 'string' } },
    allowPositionals: true,
  });
  const [runDir] = positionals;
  if (!runDir) { console.error('usage: design-gate.ts <run-dir> [--doc <subdir>] [--json]'); process.exit(2); }

  const { findings, documents } = gate(runDir, { doc: values.doc });
  const errors = findings.filter((f) => f.severity === 'error').length;
  if (values.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    // Findings repeat across documents; one line per distinct message with a count reads better than
    // the same tracking error printed 217 times.
    const seen = new Map<string, { f: Finding & { file?: string }; n: number }>();
    for (const f of findings) {
      const k = `${f.rule}|${f.message}`;
      const e = seen.get(k);
      if (e) e.n++;
      else seen.set(k, { f, n: 1 });
    }
    for (const { f, n } of seen.values()) {
      const where = f.file ? ` (${f.file}${n > 1 ? ` +${n - 1} more` : ''})` : '';
      console.log(`${f.severity.toUpperCase()}[${f.rule}] ${f.message}${where}`);
    }
    console.log(errors
      ? `design-gate: ${errors} error(s) across ${documents} document(s)`
      : `design-gate: clean (${documents} document(s), ${findings.length} warning(s))`);
  }
  if (errors) process.exit(1);
}
