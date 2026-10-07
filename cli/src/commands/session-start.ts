// Earlier versions' SessionStart hooks still call this, and what it prints to stdout lands in the agent's
// session. It removes those hooks and gives Codex and Gemini the skill copy they used to reach through the
// hook's note, and runs nothing else.
import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Usage } from '../args.ts';
import { findWorkspace } from '../config.ts';
import { removeProjectHooks } from '../project-hooks.ts';

export const usage = {
  summary: 'Remove the SessionStart hooks earlier versions installed, and copy the skill to .agents/skills (what those hooks still call)',
  positionals: '[claude|codex|gemini]',
  flags: {},
  notes: 'The agent is what old hook command lines pass. Always exits 0, so a hook never fails a session; what it cannot do is reported on stderr.',
} satisfies Usage;

// Codex and Gemini list skills when a session opens, before this runs, so the session that lays the copy
// down hears where it is once; Gemini reads hook output as JSON.
const pointer = (agent: string, skill: string): string | null => {
  const note = `For video work, the open-edit skill is ${skill}.`;
  if (agent === 'codex') return note;
  if (agent === 'gemini') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } });
  return null;
};

const isLink = (path: string): boolean => Boolean(lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink());

export async function sessionStart(args: string[], cwd: string = process.cwd()): Promise<number> {
  try {
    // The tool found the hook in its working directory's config, which init may resolve to a different
    // project above it; both are cleaned.
    const workspace = findWorkspace(cwd) ?? cwd;
    for (const dir of new Set([workspace, resolve(cwd)])) {
      removeProjectHooks(dir, (line) => {
        if (!line.startsWith('removed')) console.error(line);
      });
    }
    const claude = join(workspace, '.claude', 'skills', 'open-edit');
    const agents = join(workspace, '.agents', 'skills', 'open-edit');
    if (!existsSync(join(claude, 'SKILL.md')) || existsSync(join(agents, 'SKILL.md'))) return 0;
    // Unlike init, this follows no link at all: it runs unattended, and a link can lead anywhere.
    if ([join(workspace, '.agents'), join(workspace, '.agents', 'skills'), agents].some(isLink)) {
      console.error(`did not copy the open-edit skill to ${agents}: a link is on the way; bare init lays it there`);
      return 0;
    }
    // Copied aside and renamed into place, so a failed copy leaves nothing a later run takes for done. The
    // staging folder sits outside skills/, where Codex and Gemini would list a half-copied skill.
    const staging = join(workspace, '.agents', `.open-edit-${process.pid}.tmp`);
    try {
      rmSync(agents, { recursive: true, force: true });
      cpSync(claude, staging, { recursive: true });
      mkdirSync(join(workspace, '.agents', 'skills'), { recursive: true });
      renameSync(staging, agents);
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* the copy's own error is the one worth reporting */ }
      console.error(`could not copy the open-edit skill to ${agents} (${(error as Error).message}); bare init lays it there`);
      return 0;
    }
    const note = pointer(args[0] ?? '', join(agents, 'SKILL.md'));
    if (note) console.log(note);
  } catch (error) {
    // Advisory: nothing here may fail a session.
    console.error(`could not finish removing the old Open Edit hook (${(error as Error).message}); bare init does the rest`);
  }
  return 0;
}
