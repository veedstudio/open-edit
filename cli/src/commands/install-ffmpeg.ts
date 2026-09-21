// Install FFmpeg for machines where the global install needs rights the user does not have.
// Checks for a working install first (env override, then PATH, then a previous app-data install)
// and only downloads when nothing works. Downloads a static build plus its .sha256, verifies the
// checksum, and extracts ffmpeg/ffprobe into the app-data dir — never a working directory, which
// a plugin host may not have.
//
// WINDOWS ONLY for the download, deliberately: macOS already has a no-admin route in
// `brew install ffmpeg`, so a missing install points there rather than putting a second binary on disk.
//
// Usage:
//   npx @veedstudio/openedit-cli install-ffmpeg            # install if nothing works already
//   npx @veedstudio/openedit-cli install-ffmpeg --check    # report what is installed; write nothing
//   npx @veedstudio/openedit-cli install-ffmpeg --force    # install/upgrade the app-data copy regardless
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegDir } from '../config.ts';
import { parseUsage, type Usage } from '../args.ts';
import { FFMPEG_PROBE, findOnPath, installHint, probeVersion } from '../platform.ts';

// Gyan's builds are the ones the FFmpeg project itself links for Windows.
const BASE = 'https://www.gyan.dev/ffmpeg/builds';
const ARCHIVE = 'ffmpeg-release-essentials.zip';

const say = (msg: string) => console.log(`install-ffmpeg: ${msg}`);
// Throws rather than exiting, so the caller's finally still removes the ~100 MB scratch dir.
class InstallError extends Error {}
const die = (msg: string): never => {
  throw new InstallError(msg);
};

const exeName = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
const appDataBin = () => path.join(ffmpegDir(), 'bin');
const appDataInstalled = () => ['ffmpeg', 'ffprobe'].every((n) => fs.existsSync(path.join(appDataBin(), exeName(n))));

const versionBanner = (bin: string): string => probeVersion(bin, FFMPEG_PROBE).banner;

// Where a run of the pipeline would actually find ffmpeg: the same order config.ts resolves in.
const existing = (): { where: string; bin: string } | null => {
  const env = process.env.VEED_ENGINE_FFMPEG;
  if (env && versionBanner(env)) return { where: 'VEED_ENGINE_FFMPEG', bin: env };
  if (appDataInstalled()) return { where: 'app-data install', bin: path.join(appDataBin(), exeName('ffmpeg')) };
  const onPath = findOnPath('ffmpeg');
  if (onPath && findOnPath('ffprobe')) return { where: 'PATH', bin: onPath };
  return null;
};

const fetchOk = async (url: string, timeoutMs: number) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
};

async function install(): Promise<void> {
  const DEST = ffmpegDir();
  const version = await fetchOk(`${BASE}/release-version`, 30_000)
    .then((r) => r.text())
    .then((t) => t.trim())
    .catch(() => '');
  say(`installing FFmpeg ${version || '(current release)'} → ${DEST}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'open-edit-ffmpeg-'));
  const staged = `${DEST}.new`;
  try {
    const zip = path.join(work, ARCHIVE);
    try {
      const res = await fetchOk(`${BASE}/${ARCHIVE}`, 600_000);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    } catch (error) {
      die(`download failed: ${(error as Error).message}`);
    }

    // The published sidecar tracks the same rolling archive, so a mismatch means the release rotated
    // mid-download (or the bytes are wrong); either way, refuse rather than install unverified.
    say('verifying sha256…');
    const expected = await fetchOk(`${BASE}/${ARCHIVE}.sha256`, 30_000)
      .then((r) => r.text())
      .then((t) => t.trim().split(/\s+/)[0]?.toLowerCase())
      .catch(() => '');
    if (!expected) die('could not fetch the published sha256; refusing to install unverified bytes.');
    const actual = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    if (expected !== actual) die(`sha256 mismatch: expected ${expected}, got ${actual}. Re-run to pick up the current release.`);

    // System tar is bsdtar on Windows 10+, which reads zip. Under Git Bash the PATH resolves MSYS tar
    // (GNU, no zip support) first, so pin the System32 copy.
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const tarBin = fs.existsSync(sys) ? sys : 'tar';
    const unpacked = path.join(work, 'x');
    fs.mkdirSync(unpacked, { recursive: true });
    const tar = spawnSync(tarBin, ['-xf', zip, '-C', unpacked], { stdio: 'inherit' });
    if ((tar.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') die('system tar is required to extract the archive (it ships with Windows 10+).');
    if (tar.status !== 0) die('extraction failed.');

    // The archive nests everything under ffmpeg-<version>-essentials_build/; flatten so the layout
    // stays stable across releases and config.ts can hardcode one path.
    const top = fs.readdirSync(unpacked).map((d) => path.join(unpacked, d)).find((d) => fs.statSync(d).isDirectory());
    const srcBin = top && path.join(top, 'bin');
    if (!srcBin || !fs.existsSync(srcBin)) die('unexpected archive layout: no bin/ directory inside.');

    // Build the replacement completely BEFORE touching the existing install: a half-removed dir
    // would leave the machine with no FFmpeg at all, having had a working one a moment earlier.
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(path.join(staged, 'bin'), { recursive: true });
    for (const file of fs.readdirSync(srcBin as string)) fs.copyFileSync(path.join(srcBin as string, file), path.join(staged, 'bin', file));
    for (const extra of ['LICENSE', 'README.txt']) {
      const from = top && path.join(top, extra);
      if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(staged, extra));
    }

    // Swap. Windows refuses to rename a directory holding a running binary, so an upgrade attempted
    // while a render is using ffmpeg.exe fails here — with the previous install still intact.
    const previous = `${DEST}.old`;
    fs.rmSync(previous, { recursive: true, force: true });
    try {
      fs.mkdirSync(path.dirname(DEST), { recursive: true });
      if (fs.existsSync(DEST)) fs.renameSync(DEST, previous);
      fs.renameSync(staged, DEST);
    } catch (error) {
      if (!fs.existsSync(DEST) && fs.existsSync(previous)) fs.renameSync(previous, DEST); // put it back
      die(`could not replace ${DEST}: ${(error as Error).message}. Close anything using ffmpeg.exe and re-run.`);
    }
    fs.rmSync(previous, { recursive: true, force: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(staged, { recursive: true, force: true });
  }

  if (!appDataInstalled()) die(`installed but ${appDataBin()} is missing ffmpeg/ffprobe.`);
  const bin = path.join(appDataBin(), exeName('ffmpeg'));
  const { banner, failure } = probeVersion(bin, FFMPEG_PROBE);
  if (!banner) die(`installed ${bin} but it did not run: ${failure}`);
  say(`installed ${banner}`);
  say('every command finds it automatically; no env vars needed');
}

export const usage = {
  summary: 'Install FFmpeg if nothing works already: env override → PATH → app-data download (Windows)',
  flags: {
    check: { type: 'boolean', help: 'Report which FFmpeg would be used and exit 1 if none runs; installs nothing' },
    force: { type: 'boolean', help: 'Reinstall the app-data copy even when an FFmpeg already works' },
  },
} satisfies Usage;

export async function installFfmpeg(args: string[]): Promise<number> {
  const { values } = parseUsage('install-ffmpeg', usage, args);
  try {
    if (values.check) {
      const found = existing();
      if (!found) {
        say(`not installed (no env override, nothing on PATH, nothing in ${appDataBin()})`);
        return 1;
      }
      say(`installed via ${found.where} — ${versionBanner(found.bin) || 'present but not runnable'}`);
      say(`→ ${found.bin}`);
      return 0;
    }

    if (!values.force) {
      const found = existing();
      if (found) {
        say(`already installed via ${found.where} — ${found.bin}; nothing to do (--force reinstalls the app-data copy)`);
        return 0;
      }
    }

    if (process.platform !== 'win32') {
      die(`the download route covers Windows only; run \`${installHint('ffmpeg')}\`, which needs no admin rights either.`);
    }
    await install();
    return 0;
  } catch (error) {
    console.error(`install-ffmpeg: ${error instanceof InstallError ? error.message : ((error as Error).stack ?? error)}`);
    return 1;
  }
}
