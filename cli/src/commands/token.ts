// Prints a valid VEED access token for other tools to consume. This is the
// process-boundary seam: callers spawn the CLI instead of importing the token
// store, so login state and refresh live in exactly one codebase.
import { resolveVeedToken } from '../veed/resolve-token.ts';
import { DEFAULT_TOKEN_PATH } from '../veed/token-store.ts';

export async function token(opts: { path?: boolean } = {}): Promise<number> {
  // --path reports where the store lives without touching it (no refresh, no network).
  if (opts.path) {
    console.log(DEFAULT_TOKEN_PATH);
    return 0;
  }
  const accessToken = await resolveVeedToken();
  if (!accessToken) {
    console.error('No VEED login found — run: npx @veedstudio/openedit-cli login');
    return 1;
  }
  // A pipe is the tool this command exists for; a terminal is a person, and there the value would
  // outlive the moment in scrollback and shell history. Only the interactive case is masked, so
  // nothing that captures the output sees any change.
  if (process.stdout.isTTY) {
    console.log(`${'\u2022'.repeat(12)} (a valid token is stored, ${accessToken.length} characters)`);
    console.error('Masked because this is a terminal. Capture it to use it, e.g. VEED_ACCESS_TOKEN=$(npx @veedstudio/openedit-cli token)');
    return 0;
  }
  console.log(accessToken);
  return 0;
}
