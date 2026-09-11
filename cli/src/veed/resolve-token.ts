// The one way a command turns "the user is logged in" into a Bearer token: env wins,
// then the stored login (refreshed when stale), refused when minted for another origin.
import { VEED_ORIGIN } from './api.ts';
import { DEFAULT_TOKEN_PATH, resolveToken } from './token-store.ts';

export function resolveVeedToken(): Promise<string | null> {
  return resolveToken({
    envToken: process.env.VEED_ACCESS_TOKEN,
    tokenPath: DEFAULT_TOKEN_PATH,
    expectedOrigin: VEED_ORIGIN,
  });
}

export const NO_LOGIN_HELP = [
  'No VEED login found. Log in with VEED:',
  '',
  '  npx @veedstudio/openedit-cli login',
  '',
  'It opens your browser once and stores a refreshable token, owner-only, in the',
  "CLI's app-data directory (npx @veedstudio/openedit-cli token --path prints where).",
].join('\n');
