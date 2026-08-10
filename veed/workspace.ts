// Which VEED workspace a run bills, resolved in ONE place.
//
// A workspace is an account-level billing decision, and more than one thing spends against it:
// transcription draws VEED credits today, and anything else that bills will draw its own. So the question
// is answered here, once, rather than by each caller in its own way — transcription used to silently take
// the first workspace the listing returned, which is exactly how a user ends up billed somewhere they
// never named.
//
// The rule: an explicit choice wins; otherwise, if the account holds exactly ONE workspace there is
// nothing to decide, so take it and SAY which — informing is not the same as choosing for someone. Only a
// genuine ambiguity, several workspaces and no answer, is a question.
import { type VeedHttp, listWorkspaces } from './api.ts';
import { getAllowances } from './allowances.ts';

export interface WorkspaceCredits {
  id: string;
  name: string;
  // null when the allowance call failed. A workspace nobody could price is still one the user may own and
  // may want to spend from, so it is shown rather than hidden — and an unreadable balance is never read as
  // an empty one.
  credits: number | null;
  ttsSeconds: number | null;
}

export type WorkspaceSource = 'flag' | 'only-one';

export type Resolution =
  | { kind: 'resolved'; workspace: WorkspaceCredits; source: WorkspaceSource }
  // Several to choose between and nobody has chosen: the caller asks, this never guesses.
  | { kind: 'must-choose'; workspaces: WorkspaceCredits[] };

// Every workspace with both allowances, for the one case that needs the comparison: asking the user to
// choose. Balances are best-effort — an unreadable one is shown as unknown, never as zero, and never
// blocks a run, because it is not evidence of an empty workspace.
export async function listWorkspacesWithCredits(http: VeedHttp): Promise<WorkspaceCredits[]> {
  const workspaces = await listWorkspaces(http);
  if (workspaces.length === 0) throw new Error('no VEED workspaces on this account — nothing can be billed');
  return Promise.all(workspaces.map((w) => priced(http, w.id, w.name ?? w.id)));
}

async function priced(http: VeedHttp, id: string, name: string): Promise<WorkspaceCredits> {
  try {
    const a = await getAllowances(http, id);
    return { id, name, credits: a.aiPlaygroundCredits, ttsSeconds: a.textToSpeechSeconds };
  } catch {
    return { id, name, credits: null, ttsSeconds: null };
  }
}

export async function resolveWorkspace(opts: {
  http: VeedHttp;
  // Named on the command line; wins over everything, and is not second-guessed against the listing.
  explicit?: string;
}): Promise<Resolution> {
  const named = opts.explicit;
  const source: WorkspaceSource = 'flag';
  const workspaces = await listWorkspaces(opts.http);
  if (workspaces.length === 0) throw new Error('no VEED workspaces on this account — nothing can be billed');

  // Price only what the answer depends on. A named workspace needs ONE balance; an account with several
  // and no answer needs all of them, because that is the comparison the user is being asked to make.
  if (named) {
    // An id the caller named is taken as given even if the listing does not show it: the listing can fail
    // partially, and refusing a workspace the user explicitly asked for would be a worse error than
    // letting the first scoped call report the server's own message.
    const name = workspaces.find((w) => w.id === named)?.name ?? named;
    return { kind: 'resolved', workspace: await priced(opts.http, named, name), source };
  }
  if (workspaces.length === 1) {
    const only = workspaces[0];
    return { kind: 'resolved', workspace: await priced(opts.http, only.id, only.name ?? only.id), source: 'only-one' };
  }
  return { kind: 'must-choose', workspaces: await Promise.all(workspaces.map((w) => priced(opts.http, w.id, w.name ?? w.id))) };
}

// True when not one balance could be read — usually an expired login rather than empty workspaces. Worth
// saying only where the user is being asked to choose between them on price.
export function allUnpriced(workspaces: WorkspaceCredits[]): boolean {
  return workspaces.length > 0 && workspaces.every((w) => w.credits === null);
}

// What the user reads before naming the workspace they want billed. Both allowances, because a run can be
// stopped by either of them.
export function formatWorkspaceTable(workspaces: WorkspaceCredits[]): string {
  const w = (pick: (x: WorkspaceCredits) => string, min: number): number =>
    Math.max(min, ...workspaces.map((x) => pick(x).length));
  const credits = (x: WorkspaceCredits): string => (x.credits === null ? 'unknown' : String(x.credits));
  const tts = (x: WorkspaceCredits): string => (x.ttsSeconds === null ? 'unknown' : `${x.ttsSeconds}s`);
  const idW = w((x) => x.id, 2);
  const nameW = w((x) => x.name, 4);
  const creditW = w(credits, 7);
  const row = (a: string, b: string, c: string, d: string): string =>
    `  ${a.padEnd(idW)}  ${b.padEnd(nameW)}  ${c.padStart(creditW)}  ${d}`;
  return [
    row('ID', 'NAME', 'CREDITS', 'TEXT-TO-SPEECH'),
    ...workspaces.map((x) => row(x.id, x.name, credits(x), tts(x))),
  ].join('\n');
}

// The one-liner a run prints once it knows whose credits it is about to use. Says which workspace, what it
// holds, and — when nobody chose it — why it did not ask.
export function describeChoice(workspace: WorkspaceCredits, source: WorkspaceSource): string {
  const held = workspace.credits === null
    ? 'balance unavailable'
    : `${workspace.credits} AI Playground credits` +
      (workspace.ttsSeconds === null ? '' : `, ${workspace.ttsSeconds}s text-to-speech`);
  const why = source === 'only-one' ? ' — the only workspace on this account, so nothing was asked' : '';
  return `billing workspace ${workspace.name} (${workspace.id}) — ${held}${why}`;
}
