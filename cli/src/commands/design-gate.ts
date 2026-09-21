import { parseUsage, usageLine, type Usage } from "../args.ts";
import { contentRoot } from "../config.ts";
import { loadDesignGate, type GateFinding } from "../gates/content-gates.ts";

export const usage = {
  summary: "Read a run's documents back against its own design system",
  positionals: "<run-dir>",
  flags: {
    doc: { type: "string", value: "<subdir>", help: "Gate one document under the run, a chapter of a longer piece" },
    json: { type: "boolean", help: "Print the findings as JSON" },
  },
} satisfies Usage;

// A run's authored documents read back against its own design system. Same gate the workspace script
// runs; loaded from content so a published install needs no checkout and no tsx.
export async function designGate(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage("design-gate", usage, argv);
  const [runDir] = positionals;
  if (!runDir) {
    console.error(usageLine("design-gate", usage));
    return 2;
  }

  const gate = await loadDesignGate(contentRoot());
  const { findings, documents } = gate(runDir, { doc: values.doc });
  const errors = findings.filter((f) => f.severity === "error").length;
  if (values.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    // Findings repeat across documents; one line per distinct message with a count reads better than
    // the same tracking error printed 217 times.
    const seen = new Map<string, { f: GateFinding & { file?: string }; n: number }>();
    for (const f of findings) {
      const key = `${f.rule}|${f.message}`;
      const entry = seen.get(key);
      if (entry) entry.n++;
      else seen.set(key, { f, n: 1 });
    }
    for (const { f, n } of seen.values()) {
      const repeats = n > 1 ? `+${n - 1} more` : "";
      const inner = [f.file, repeats].filter(Boolean).join(" ");
      console.log(`${f.severity.toUpperCase()}[${f.rule}] ${f.message}${inner ? ` (${inner})` : ""}`);
    }
    console.log(errors
      ? `design-gate: ${errors} error(s) across ${documents} document(s)`
      : `design-gate: clean (${documents} document(s), ${findings.length} warning(s))`);
  }
  return errors ? 1 : 0;
}
