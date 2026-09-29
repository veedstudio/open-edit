// The browser the HTML renderer drives: Chrome Headless Shell at one pinned version, downloaded from
// the Chrome for Testing bucket into the CLI's app-data dir. Pinned to the build the driver library
// was released against, so the protocol the two speak is the one both were tested on.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { browserDir } from '../config.ts';
import { probeVersion } from '../platform.ts';
import { extractZip } from './unzip.ts';

export type ChromePlatform = 'mac-arm64' | 'mac-x64' | 'linux64' | 'linux-arm64' | 'win64';

/**
 * The pin, with the size and MD5 the bucket publishes for each archive (its content-length and
 * x-goog-hash headers), so a truncated or altered download is refused rather than installed.
 */
export const CHROME = {
  version: '153.0.8010.12',
  builds: {
    'mac-arm64': { bytes: 98_831_293, md5: 'dew3XY0eautubimRYnqH9w==' },
    'mac-x64': { bytes: 104_060_463, md5: 'OdFYJBgA3G4tymkCfE/9iQ==' },
    linux64: { bytes: 119_809_080, md5: 'mo62E1sc2lbej1R3dikeNQ==' },
    'linux-arm64': { bytes: 120_278_638, md5: 'iryuNu+qLajWde8Piw6NGw==' },
    win64: { bytes: 120_200_717, md5: 'OWsKyaVtRm/AmYhyyiqrgA==' },
  } satisfies Record<ChromePlatform, { bytes: number; md5: string }>,
} as const;

export function chromePlatform(platform = process.platform, arch = process.arch): ChromePlatform | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null;
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : arch === 'x64' ? 'linux64' : null;
  if (platform === 'win32' && arch === 'x64') return 'win64';
  return null;
}

export function chromeUrl(p: ChromePlatform): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${CHROME.version}/${p}/chrome-headless-shell-${p}.zip`;
}

const installRoot = (): string => join(browserDir(), `chrome-headless-shell-${CHROME.version}`);

export function installedChrome(p: ChromePlatform, root = installRoot()): string {
  return join(root, `chrome-headless-shell-${p}`, p === 'win64' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
}

export const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

export interface InstallOptions {
  force?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  platform?: ChromePlatform | null;
  root?: string;
  /** The size and MD5 to verify against, in place of the pin's; for tests. */
  build?: { bytes: number; md5: string };
}

/** Downloads, verifies and unpacks the pinned build unless it is already in place; returns the binary. */
export async function installChrome(o: InstallOptions = {}): Promise<string> {
  const log = o.log ?? ((line: string) => console.error(line));
  const p = o.platform === undefined ? chromePlatform() : o.platform;
  if (!p) throw new Error(`no Chrome Headless Shell build for ${process.platform}/${process.arch}; pass --chrome <path> to a Chrome or Chromium you have`);
  const root = o.root ?? installRoot();
  const exe = installedChrome(p, root);
  if (existsSync(exe) && !o.force) return exe;

  const build = o.build ?? CHROME.builds[p];
  const url = chromeUrl(p);
  log(`browser: downloading Chrome Headless Shell ${CHROME.version} (${p}), ${mb(build.bytes)}, from ${url}`);
  mkdirSync(dirname(root), { recursive: true });
  // Staged beside the final directory under a name no other process uses, then swapped in whole: two
  // renders installing at once must not unpack into each other's half-written tree.
  const stage = `${root}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const zip = `${stage}.zip`;
  try {
    const started = Date.now();
    const res = await (o.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(900_000) });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    const md5 = createHash('md5');
    let got = 0;
    let nextMark = 0.25;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (chunk: Buffer) => {
      md5.update(chunk);
      got += chunk.length;
      if (got / build.bytes >= nextMark && nextMark < 1) {
        log(`browser: ${Math.round(nextMark * 100)}% (${mb(got)})`);
        nextMark += 0.25;
      }
    });
    await pipeline(body, createWriteStream(zip));
    const digest = md5.digest('base64');
    if (got !== build.bytes || digest !== build.md5) {
      throw new Error(`downloaded archive does not match the pinned build (${got} bytes, md5 ${digest}; expected ${build.bytes} bytes, md5 ${build.md5})`);
    }
    log(`browser: downloaded ${mb(got)} in ${((Date.now() - started) / 1000).toFixed(1)} s, checksum ok; unpacking`);
    await extractZip(zip, stage);
    // A root without the binary is a broken install, and a rename onto it would fail on every run.
    if (o.force || !existsSync(exe)) rmSync(root, { recursive: true, force: true });
    try {
      renameSync(stage, root);
    } catch (e) {
      // Another process finished the same install first; its copy is the same pinned build.
      if (!existsSync(exe)) throw e;
    }
  } finally {
    rmSync(zip, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
  if (!existsSync(exe)) throw new Error(`installed the archive but ${exe} is missing`);
  const { banner, failure } = chromeVersion(exe);
  if (!banner) throw new Error(`installed ${exe} but it does not start: ${failure}${linuxHint()}`);
  log(`browser: installed ${banner} → ${dirname(exe)}`);
  return exe;
}

/**
 * What the binary says of itself. A Windows build writes nothing to a console, so there a clean exit
 * is the whole answer.
 */
export function chromeVersion(exe: string): { banner: string; failure: string } {
  const probe = probeVersion(exe);
  if (!probe.banner && process.platform === 'win32' && probe.failure.startsWith('exited 0')) {
    return { banner: `Chrome Headless Shell ${CHROME.version}`, failure: '' };
  }
  return probe;
}

export const linuxHint = (): string =>
  (process.platform === 'linux' ? '\n  A missing system library is the usual cause on Linux; `npx playwright-core install-deps chromium-headless-shell` installs them.' : '');

/** The binary to run: an explicit one, else the pinned install, downloading it on first use. */
export async function resolveChrome(explicit: string | undefined, log?: (line: string) => void): Promise<string> {
  if (explicit) {
    if (!existsSync(explicit) || !statSync(explicit).isFile()) throw new Error(`--chrome ${explicit} is not a file`);
    return explicit;
  }
  return installChrome({ log });
}

/**
 * Flags for a frame-exact capture: colour pinned to sRGB so the machine's display profile never
 * reaches the pixels, images decoded before the frame that shows them, and every invalidated tile
 * rastered whole, since re-rastering only part of one leaves edge pixels that depend on which frames
 * this worker happened to draw before. The frame-rate limit stays on: lifting it saves a few ms per
 * capture on one worker, but every Chrome then produces frames nonstop, and several at once burn
 * about 20 times the CPU per frame.
 */
export const CHROME_FLAGS = [
  '--force-color-profile=srgb',
  '--disable-partial-raster',
  '--disable-checker-imaging',
  '--run-all-compositor-stages-before-draw',
  '--disable-threaded-animation',
  '--disable-new-content-rendering-timeout',
  '--font-render-hinting=none',
  '--hide-scrollbars',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
];

