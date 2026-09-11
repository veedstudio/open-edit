// Typed loaders for the gates that ship as CONTENT, co-versioned with the recipes they govern.
// A published install carries them compiled, so they load in-process as plain node — no tsx, no
// spawn; a checkout carries only .ts, which tsx resolves through the same call. The shapes mirror
// the gate modules' own exports (pipeline/scripts/lint-template.ts, pipeline/design/gate.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface GateFinding {
  rule: string;
  severity: "error" | "warn";
  message: string;
}

/** Canvas facts the lint gate's timing rules need, from the run's manifest render block. */
export interface RenderFacts {
  fps: number;
  duration: number;
  width?: number;
  height?: number;
}

export type LintGate = (src: string, render?: RenderFacts) => GateFinding[];

export interface DesignGateResult {
  findings: (GateFinding & { file?: string })[];
  documents: number;
}

export type DesignGate = (runDir: string, opts?: { doc?: string }) => DesignGateResult;

async function importContentModule(contentRoot: string, rel: string): Promise<Record<string, unknown>> {
  for (const ext of [".js", ".ts"]) {
    const file = join(contentRoot, `${rel}${ext}`);
    if (!existsSync(file)) continue;
    try {
      return await import(pathToFileURL(file).href) as Record<string, unknown>;
    } catch (error) {
      // A .ts gate needs a Node that strips types; the engines floor does not guarantee one, and the
      // raw loader error names neither the cause nor the way out.
      if ((error as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_FILE_EXTENSION") throw error;
      throw new Error(`${file} is TypeScript and Node ${process.version} cannot strip types — point OPEN_EDIT_ROOT at a compiled content tree, or run Node 22.18 or newer`);
    }
  }
  throw new Error(`content module ${rel}.js not found under ${contentRoot} — the content root is not a complete Open Edit content tree`);
}

export async function loadLintGate(contentRoot: string): Promise<LintGate> {
  const mod = await importContentModule(contentRoot, join("pipeline", "scripts", "lint-template"));
  if (typeof mod.lintTemplate !== "function") {
    throw new Error(`lint-template under ${contentRoot} exports no lintTemplate function`);
  }
  return mod.lintTemplate as LintGate;
}

export async function loadDesignGate(contentRoot: string): Promise<DesignGate> {
  const mod = await importContentModule(contentRoot, join("pipeline", "design", "gate"));
  if (typeof mod.gate !== "function") {
    throw new Error(`design gate under ${contentRoot} exports no gate function`);
  }
  return mod.gate as DesignGate;
}
