// The runnable design gate: a run's authored documents read back against its own design system.
//
//   node --import tsx pipeline/scripts/design-gate.ts <run-dir> [--doc <subdir>] [--json]
//
// Exits 1 on any error-severity finding. Run it before the render, not after: every finding here is
// a string in a document, and fixing one after a 12-minute encode costs three minutes of machine
// time to learn what a regex knew instantly.
//
// The checks themselves live in pipeline/design/gate.ts, which the CLI loads in-process; this file
// is only the command line around them.
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { gate } from '../design/gate.ts';
import type { Finding } from '../design/system.ts';

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
