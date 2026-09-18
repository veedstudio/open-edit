import { parseUsage, type Usage } from "../args.ts";
import { engineBinPath } from "../config.ts";

export const usage = {
  summary: "Print the renderer binary this CLI drives (platform, VEED_ENGINE_BIN and state dir applied)",
  flags: {},
} satisfies Usage;

// Printed rather than written into documents: the answer moves with the platform, VEED_ENGINE_BIN
// and OPENEDIT_STATE_DIR.
export function enginePathCommand(argv: string[]): number {
  parseUsage("engine-path", usage, argv);
  console.log(engineBinPath());
  return 0;
}
