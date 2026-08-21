// Open a URL in the user's default browser, fire-and-forget: callers keep their own manual
// fallbacks (printed URLs), so a launcher that is missing or fails is not an error here.
import { execFile } from 'node:child_process';

export function openUrl(url: string): void {
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else if (process.platform === 'win32') {
    // rundll32 takes the URL as plain argv; `cmd /c start` would parse the & in OAuth URLs.
    execFile('rundll32', ['url.dll,FileProtocolHandler', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}
