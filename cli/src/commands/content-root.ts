import { parseUsage, type Usage } from "../args.ts";
import { contentRoot } from "../config.ts";

export const usage = {
  summary: "Print the content tree this CLI resolves to (recipes, briefs, gates)",
  flags: {},
} satisfies Usage;

// Where the recipes, briefs and gates this CLI will use actually live — the installed package, or a
// checkout when OPEN_EDIT_ROOT points at one. Printed rather than inferred because "which content
// answered" is the first question when a run picks a style nobody expected.
export function contentRootCommand(argv: string[]): number {
  parseUsage("content-root", usage, argv);
  console.log(contentRoot());
  return 0;
}
