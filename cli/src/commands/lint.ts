import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseUsage, usageLine, type Usage } from "../args.ts";
import { contentRoot, engineDocPath } from "../config.ts";
import { loadEngineDoc, loadLintGate, type RenderFacts } from "../gates/content-gates.ts";

export const usage = {
  summary: "Check how one document is built, with the installed engine's own limits applied",
  positionals: "<template.wv>",
  flags: {
    json: { type: "boolean", help: "Print the findings as JSON" },
  },
} satisfies Usage;

// The mechanical gate on how a document is built, run against the content tree this CLI ships with. The rules are
// content — they change with the substrate they police — so they are loaded, never reimplemented here.
export async function lint(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage("lint", usage, argv);
  const [file] = positionals;
  if (!file) {
    console.error(usageLine("lint", usage));
    return 2;
  }

  // The manifest sits next to the document; without it the timing rules cannot run.
  let render: RenderFacts | undefined;
  try {
    const manifest = join(dirname(file), "manifest.json");
    if (existsSync(manifest)) render = JSON.parse(readFileSync(manifest, "utf8")).render;
  } catch { /* a malformed manifest is the renderer's error to report, not this gate's */ }

  const lintTemplate = await loadLintGate(contentRoot());
  const engine = await loadEngineDoc(contentRoot(), engineDocPath());
  if (!engine && !values.json) console.log("lint: no engine installed, so its own limits (feature-support.md) were not applied");
  const findings = lintTemplate(readFileSync(file, "utf8"), render, engine);
  const errors = findings.filter((f) => f.severity === "error").length;
  if (values.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const f of findings) console.log(`${f.severity.toUpperCase()}[${f.rule}] ${f.message}`);
    console.log(errors ? `lint: ${errors} error(s), ${findings.length - errors} warning(s)` : `lint: clean (${findings.length} warning(s))`);
  }
  return errors ? 1 : 0;
}
