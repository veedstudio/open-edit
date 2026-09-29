// Install the pinned Chrome Headless Shell the render command drives. `render` does this itself on
// first use; this is for installing ahead of time, or checking what is there.
//
//   openedit install-browser            # download if missing (about 95-115 MB, per platform)
//   openedit install-browser --check    # report; exit 1 when it is not installed
//   openedit install-browser --force    # download again over an existing install
import { existsSync } from 'node:fs';
import { parseUsage, type Usage } from '../args.ts';
import { CHROME, chromePlatform, chromeVersion, installChrome, installedChrome, mb } from '../render/browser.ts';

export const usage = {
  summary: `Install the pinned Chrome Headless Shell (${CHROME.version}) that render drives; render installs it on first use`,
  flags: {
    check: { type: 'boolean', help: 'Report the installed browser and exit 1 if it is missing or does not start; downloads nothing' },
    force: { type: 'boolean', help: 'Download and unpack again even when it is installed' },
  },
} satisfies Usage;

export async function installBrowser(argv: string[]): Promise<number> {
  const { values } = parseUsage('install-browser', usage, argv);
  const p = chromePlatform();
  if (!p) {
    console.error(`install-browser: no Chrome Headless Shell build for ${process.platform}/${process.arch}; render takes --chrome <path> to a Chrome or Chromium you have`);
    return 1;
  }
  const exe = installedChrome(p);
  if (values.check) {
    if (!existsSync(exe)) {
      console.log(`install-browser: not installed (expected ${exe}); ${mb(CHROME.builds[p].bytes)} to download`);
      return 1;
    }
    const { banner, failure } = chromeVersion(exe);
    console.log(banner ? `install-browser: ${banner} at ${exe}` : `install-browser: ${exe} does not start: ${failure}`);
    return banner ? 0 : 1;
  }
  if (existsSync(exe) && !values.force) {
    console.log(`install-browser: already installed at ${exe}`);
    return 0;
  }
  await installChrome({ force: values.force, log: (line) => console.log(line) });
  return 0;
}
