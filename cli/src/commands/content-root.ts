import { contentRoot } from "../config.ts";

// Where the recipes, briefs and gates this CLI will use actually live — the installed package, or a
// checkout when OPEN_EDIT_ROOT points at one. Printed rather than inferred because "which content
// answered" is the first question when a run picks a style nobody expected.
export function contentRootCommand(argv: string[]): number {
  if (argv.length) {
    console.error("usage: openedit content-root");
    return 2;
  }
  console.log(contentRoot());
  return 0;
}
