// The page veed/login.ts serves after the OAuth redirect.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'login-success.html');

export async function loginSuccessPage(pagePath: string = PAGE_PATH): Promise<string> {
  // A missing page must not fail the token exchange.
  return readFile(pagePath, 'utf8').catch(() => '<h3>Logged in with VEED. You can close this tab.</h3>');
}
