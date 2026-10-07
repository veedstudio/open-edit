// Removes the SessionStart hooks earlier versions of init wrote into a workspace's agent configs.
import { lstatSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpName } from './providers/exclusive-files.ts';

const CONFIGS = ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json'];

// Identity is loose on purpose: older configs point at the skill-bundled adapters
// (hooks/session-start.mjs or .sh, quoted or not) instead of the package command. All of them are ours.
const OURS = [/openedit-cli['" ]+session-start/, /open-edit[/\\]hooks[/\\]session-start\.(mjs|sh)/];
const isOurs = (hook: any): boolean => typeof hook?.command === 'string' && OURS.some((pattern) => pattern.test(hook.command));
const holdsOurs = (group: any): boolean => Array.isArray(group?.hooks) && group.hooks.some(isOurs);

type Found = { document: Record<string, any> } | { problem: string };

const inspect = (path: string): Found | null => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // absent, or unreadable: nothing init could change either way
  }
  let document: any;
  try {
    document = JSON.parse(text);
  } catch {
    // Gemini CLI accepts comments in its settings, which JSON.parse refuses.
    return OURS.some((pattern) => pattern.test(text)) ? { problem: 'it is not plain JSON' } : null;
  }
  const groups = document?.hooks?.SessionStart;
  if (!Array.isArray(groups) || !groups.some(holdsOurs)) return null;
  // Rewriting through a link would edit a file outside the workspace, or replace the link with a copy.
  if (lstatSync(path).isSymbolicLink()) return { problem: 'it is a symbolic link' };
  return { document };
};

const manualRemoval = (rel: string, problem: string) =>
  `found an Open Edit SessionStart hook in ${rel} that init cannot edit (${problem}); remove its openedit-cli session-start entry by hand`;

/** The configs that still hold one of our hooks; `manual` is set on the ones init cannot edit, saying what to do. */
export const findProjectHooks = (workspace: string): { rel: string; manual?: string }[] =>
  CONFIGS.flatMap((rel) => {
    const found = inspect(resolve(workspace, rel));
    if (!found) return [];
    return 'problem' in found ? [{ rel, manual: manualRemoval(rel, found.problem) }] : [{ rel }];
  });

/**
 * Takes our hook entries out of each config and leaves every other hook and setting; a config rewritten
 * comes back as 2-space JSON, and one left empty is deleted. Never throws: a config it cannot clean is
 * reported with what to remove by hand.
 */
export function removeProjectHooks(workspace: string, report: (line: string) => void): void {
  for (const rel of CONFIGS) {
    const path = resolve(workspace, rel);
    try {
      const found = inspect(path);
      if (!found) continue;
      if ('problem' in found) {
        report(manualRemoval(rel, found.problem));
        continue;
      }
      const { document } = found;
      document.hooks.SessionStart = document.hooks.SessionStart.flatMap((group: any) => {
        if (!holdsOurs(group)) return [group];
        // A harness may have appended someone else's hook to our group; only ours goes.
        const hooks = group.hooks.filter((hook: any) => !isOurs(hook));
        return hooks.length ? [{ ...group, hooks }] : [];
      });
      if (document.hooks.SessionStart.length === 0) delete document.hooks.SessionStart;
      if (Object.keys(document.hooks).length === 0) delete document.hooks;
      if (Object.keys(document).length === 0) {
        rmSync(path, { force: true });
        // Only an emptied directory goes; one holding anything else throws and stays.
        try { rmdirSync(dirname(path)); } catch { /* not empty */ }
      } else {
        // Written aside and renamed over, so no reader sees half a config. The new file is created with the
        // old one's mode: a settings file kept private can carry env secrets.
        const tmp = tmpName(path);
        try {
          writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: statSync(path).mode & 0o777 });
          renameSync(tmp, path);
        } catch (error) {
          try { unlinkSync(tmp); } catch { /* never written */ }
          throw error;
        }
      }
      report(`removed the Open Edit SessionStart hook from ${rel}`);
    } catch (error) {
      report(`could not remove the Open Edit SessionStart hook from ${rel} (${(error as Error).message}); remove its openedit-cli session-start entry by hand`);
    }
  }
}
