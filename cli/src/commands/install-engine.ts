// Install veed-engine-cli by downloading the release directly from GitHub (no package manager).
// Fetches the platform's archive + its .sha256 + the feature-support.md asset, verifies the checksum,
// and extracts everything into the app-data engine dir. The orchestrator asks the user before running.
// The upstream release assets keep their original names (weave-viewer-cli-*, weave-v* tags);
// the extracted binary is renamed locally to veed-engine-cli (.exe on Windows).
//
//   openedit install-engine               # install/upgrade to the latest release
//   openedit install-engine weave-v0.9.0  # pin a specific tag (upstream tag format)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsage, type Usage } from '../args.ts';
import { engineDir } from '../config.ts';
import { ENGINE_RELEASES_REPO as REPO, resolveLatestEngineTag } from '../engine-release.ts';
import { ENGINE_ASSETS, engineBinaryName, platformKey, probeVersion, unsupportedMessage } from '../platform.ts';

const say = (msg: string) => console.log(`install-engine: ${msg}`);

class InstallError extends Error {}
const die = (msg: string): never => { throw new InstallError(msg); };

const fetchOk = async (url: string, timeoutMs: number) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
};

const download = async (url: string, dest: string, timeoutMs: number) => {
  const res = await fetchOk(url, timeoutMs);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
};

export const usage = {
  summary: 'Download and verify the render engine into the app-data dir',
  positionals: '[<release-tag>]',
  flags: {},
  notes: 'Installs or upgrades to the latest release unless a release tag pins one.',
} satisfies Usage;

export async function installEngine(argv: string[]): Promise<number> {
  const { positionals: [tag = ''] } = parseUsage('install-engine', usage, argv);
  try {
    await install(tag);
    return 0;
  } catch (error) {
    if (error instanceof InstallError) {
      console.error(`install-engine: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function install(tagArg: string): Promise<void> {
  // Platform gate — only these assets are published; fail loudly elsewhere rather than installing a
  // binary that can't exec.
  const key = platformKey();
  if (!key) die(`${unsupportedMessage()} — see the published assets at ${REPO}.`);
  const { archive: ARCHIVE, upstreamBin: UPSTREAM_BIN } = ENGINE_ASSETS[key!];
  const DEST = engineDir();
  const LOCAL_BIN = engineBinaryName();

  // Resolve the tag to install (arg overrides; else the latest release)
  let tag = tagArg;
  if (!tag) {
    const latest = await resolveLatestEngineTag();
    tag = latest.tag;
    if (!tag) die(`could not resolve a release tag — ${latest.failures.join('; ')}`);
    // A fallback that worked still spent a metered API call. Naming the route that was skipped is
    // how a permanently blocked one gets noticed instead of quietly costing budget every run.
    if (latest.failures.length > 0) say(`note — ${latest.failures.join('; ')}`);
  }

  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  say(`installing ${tag} (${ARCHIVE}) → ${DEST}`);

  // Download archive + checksum + feature-support.md into a scratch dir
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veed-engine-'));
  try {
    try {
      await download(`${base}/${ARCHIVE}`, path.join(work, ARCHIVE), 120_000);
      await download(`${base}/${ARCHIVE}.sha256`, path.join(work, `${ARCHIVE}.sha256`), 30_000);
    } catch (error) {
      die(`download failed for ${tag}: ${(error as Error).message}`);
    }
    // feature-support.md is auxiliary (the support matrix) — don't abort the install if a release omits it.
    await download(`${base}/feature-support.md`, path.join(work, 'feature-support.md'), 30_000)
      .catch(() => say(`note — no feature-support.md asset on ${tag}; skipping it.`));
    // The binary is licensed separately from this package (PolyForm Shield, not Apache-2.0) and the archive
    // does not carry its terms, so fetch them from the release tag and install them next to the binary —
    // whoever ends up with the engine should also end up with its license. Repo file, not a release asset.
    await download(`https://raw.githubusercontent.com/${REPO}/${tag}/LICENSE-binary.md`, path.join(work, 'LICENSE-binary.md'), 30_000)
      .catch(() => say(`note — could not fetch the engine license for ${tag}; it is at https://github.com/${REPO}/blob/main/LICENSE-binary.md`));

    // Verify the checksum (the sidecar is `<hex>  <name>`)
    say('verifying sha256…');
    const expected = fs.readFileSync(path.join(work, `${ARCHIVE}.sha256`), 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash('sha256').update(fs.readFileSync(path.join(work, ARCHIVE))).digest('hex');
    if (!expected || expected !== actual) die(`sha256 mismatch for ${ARCHIVE}: expected ${expected ?? '(none)'}, got ${actual}`);

    // Extract into a clean engine dir (replace any prior install atomically-ish), then rename the
    // binary from its upstream name to the local one. System tar is bsdtar on macOS and Windows 10+,
    // which auto-detects both gzip and zip. On Windows pin the System32 binary: under Git Bash the
    // PATH resolves MSYS tar (GNU, no zip support) ahead of it.
    const tarBin = (() => {
      if (process.platform !== 'win32') return 'tar';
      const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      return fs.existsSync(sys) ? sys : 'tar';
    })();
    fs.rmSync(DEST, { recursive: true, force: true });
    fs.mkdirSync(DEST, { recursive: true });
    const tar = spawnSync(tarBin, ['-xf', path.join(work, ARCHIVE), '-C', DEST], { stdio: 'inherit' });
    if (tar.error && (tar.error as NodeJS.ErrnoException).code === 'ENOENT') die('system tar is required to extract the engine archive (it ships with macOS and Windows 10+).');
    if (tar.status !== 0) die(`extraction failed for ${ARCHIVE}.`);
    fs.renameSync(path.join(DEST, UPSTREAM_BIN), path.join(DEST, LOCAL_BIN));
    for (const extra of ['feature-support.md', 'LICENSE-binary.md']) {
      // copy, not rename: the scratch dir can sit on another volume than the app-data dir
      if (fs.existsSync(path.join(work, extra))) fs.copyFileSync(path.join(work, extra), path.join(DEST, extra));
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Verify the binary actually runs (catches a wrong-arch download or an unexpected archive layout)
  const bin = path.join(engineDir(), engineBinaryName());
  const { banner, failure } = probeVersion(bin);
  if (!banner) die(`ERROR — installed ${bin} but it did not run: ${failure}`);
  say(`installed ${banner}`);
  say(`VEED_ENGINE_BIN → ${bin}`);
}
