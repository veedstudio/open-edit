// SessionStart adapter for Claude Code, Codex, and Gemini CLI: the command the workspace hook
// entries invoke when an agent session opens. Runs init against the invoking workspace and turns
// the report into the context note each harness expects. Advisory by design — always exits 0; the
// note itself carries any setup failure to the agent.
import { parseUsage, type Usage } from '../args.ts';
import { main as initMain } from './init.ts';

export function composeContext(status: number, output: string): string {
  if (status === 0 && !/APPROVAL REQUIRED|incomplete|not ready|waiting/.test(output)) {
    // This hook already RAN init, so sending the agent to run it again buys nothing but a round trip —
    // the one thing it needed from that run was the root, and the run it just did knows it. When
    // anything needs approval the message below is unchanged: that path still goes through --dry.
    // AGENTS.md travels with the CONTENT, which on the package path is not the workspace root.
    const root = /OPEN_EDIT_ROOT=(.+)/.exec(output)?.[1]?.trim();
    return root
      ? `Open Edit preflight is ready and OPEN_EDIT_ROOT=${root}. Before using the open-edit skill in this session, read AGENTS.md from the content root (\`npx @veedstudio/openedit-cli content-root\`) completely. No further preflight is needed; proceed silently.`
      : 'Open Edit preflight is ready. Before using the open-edit skill in this session, still run `npx @veedstudio/openedit-cli init --dry`, resolve OPEN_EDIT_ROOT, and read AGENTS.md from the content root (`npx @veedstudio/openedit-cli content-root`) completely. Proceed silently if preflight remains ready.';
  }
  return `Open Edit startup preflight reported:\n${output}\nBefore doing Open Edit work, ALWAYS run \`npx @veedstudio/openedit-cli init --dry\`, communicate every APPROVAL REQUIRED action to the user, and wait for explicit approval. Run init --auto-approve only after the user approves all reported actions. Never install machine-global dependencies or update existing code without that approval (the one self-update bare init performs is a clean patch/minor of the CLI itself). After resolving OPEN_EDIT_ROOT, read AGENTS.md from the content root (\`npx @veedstudio/openedit-cli content-root\`) completely before running repository commands.`;
}

export function formatNote(agent: string, context: string): string {
  if (agent === 'gemini') {
    // Gemini requires JSON on stdout.
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
  }
  return context;
}

type RunInit = (argv: string[]) => Promise<{ status: number; output: string }>;

const runInitInProcess: RunInit = async (argv) => {
  const errLines: string[] = [];
  const outLines: string[] = [];
  const status = await initMain(argv, {
    err: (line: string) => errLines.push(line),
    out: (line: string) => outLines.push(line),
  });
  // The report goes to stderr and stdout carries only the final root, so stderr-then-stdout reads in order.
  return { status, output: [...errLines, ...outLines].join('\n') };
};

export const usage = {
  summary: 'Agent SessionStart adapter: run init and print the context note',
  positionals: '[claude|codex|gemini|plain]',
  flags: {},
  notes: 'Always exits 0; the note itself carries any setup failure to the agent. gemini gets JSON on stdout.',
} satisfies Usage;

export async function sessionStart(args: string[], runInit: RunInit = runInitInProcess): Promise<number> {
  const { positionals: [agent = 'plain'] } = parseUsage('session-start', usage, args);
  // No explicit --workspace: a hook's cwd may be a subdirectory, and init's own resolution
  // (nearest project, then git toplevel, then cwd) is better than pinning it here.
  const { status, output } = await runInit([]);
  console.log(formatNote(agent, composeContext(status, output.replace(/\n+$/, ''))));
  return 0;
}
