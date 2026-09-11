import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFlags } from "../args.ts";
import { contentRoot } from "../config.ts";
import { loadLintGate, type RenderFacts } from "../gates/content-gates.ts";

// The mechanical engine-limit gate, run against the content tree this CLI ships with. The rules are
// content — they change with the substrate they police — so they are loaded, never reimplemented here.
export async function lint(argv: string[]): Promise<number> {
  const { values, positionals } = parseFlags({ args: argv, options: { json: { type: "boolean" } }, allowPositionals: true });
  const [file] = positionals;
  if (!file) {
    console.error("usage: openedit lint <template.wv> [--json]");
    return 2;
  }

  // The manifest sits next to the document; without it the timing rules cannot run.
  let render: RenderFacts | undefined;
  try {
    const manifest = join(dirname(file), "manifest.json");
    if (existsSync(manifest)) render = JSON.parse(readFileSync(manifest, "utf8")).render;
  } catch { /* a malformed manifest is the renderer's error to report, not this gate's */ }

  const lintTemplate = await loadLintGate(contentRoot());
  const findings = lintTemplate(readFileSync(file, "utf8"), render);
  const errors = findings.filter((f) => f.severity === "error").length;
  if (values.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const f of findings) console.log(`${f.severity.toUpperCase()}[${f.rule}] ${f.message}`);
    console.log(errors ? `lint: ${errors} error(s), ${findings.length - errors} warning(s)` : `lint: clean (${findings.length} warning(s))`);
  }
  return errors ? 1 : 0;
}
