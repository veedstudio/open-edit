// Remembers which workspace the user chose to have billed, so the choice is made once rather than every
// session. It lives beside the login it belongs to (and is gitignored the same way): it names an account
// resource that spends real money, so it is local state, never something to commit or share.
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';

// The one place this file's location is defined; veed/generate.ts reads and writes it through its injected
// state helpers, which is why nothing here touches the filesystem.
export const DEFAULT_WORKSPACE_PATH = join(REPO_ROOT, 'veed', '.veed-workspace.json');

export interface WorkspaceChoice {
  workspaceId: string;
  workspaceName?: string;
  chosenAt: number;
}

// A corrupt or truncated file is treated as "no choice yet": asking again costs nothing, while acting on a
// half-read workspace id would spend somewhere nobody picked.
export function parseWorkspaceChoice(raw: string | null): WorkspaceChoice | null {
  if (raw === null) return null;
  let parsed: WorkspaceChoice;
  try {
    parsed = JSON.parse(raw) as WorkspaceChoice;
  } catch {
    return null;
  }
  if (typeof parsed?.workspaceId !== 'string' || parsed.workspaceId === '') return null;
  return parsed;
}

export function serializeWorkspaceChoice(choice: WorkspaceChoice): string {
  return `${JSON.stringify(choice, null, 2)}\n`;
}
