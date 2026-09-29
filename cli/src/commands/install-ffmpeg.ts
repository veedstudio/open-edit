// Install FFmpeg for machines where the global install needs rights the user does not have.
// Looks first for the pair every command runs (config.ts's resolveFfmpegPair: env overrides, then a
// previous app-data install, then PATH) and only downloads when there is none; a set override is also
// run, since nothing else is used while it is set, and --check runs whichever pair it finds. Downloads
// a static build plus its .sha256, verifies the checksum, and extracts ffmpeg/ffprobe into the app-data
// dir — never a working directory, which a plugin host may not have.
//
// WINDOWS ONLY for the download, deliberately: macOS already has a no-admin route in
// `brew install ffmpeg`, and Linux has its package manager, so a missing install points there rather
// than putting a second binary on disk.
//
// Usage:
//   npx @veedstudio/openedit-cli install-ffmpeg            # install if none is there already
//   npx @veedstudio/openedit-cli install-ffmpeg --check    # report what is installed; write nothing
//   npx @veedstudio/openedit-cli install-ffmpeg --force    # install/upgrade the app-data copy regardless
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegDir, resolveFfmpegPair, type FfmpegTool } from '../config.ts';
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

type Pair = ReturnType<typeof resolveFfmpegPair>;
interface Found { where: string; ffmpeg: string; ffprobe: string }

const isOverride = (tool: FfmpegTool) => tool.from === 'OPENEDIT_FFMPEG' || tool.from === 'OPENEDIT_FFPROBE';

// A set override counts whether or not it runs, because config.ts uses it unconditionally.
const existing = (pair: Pair): Found | null => {
  const [ffmpeg, ffprobe] = [pair.ffmpeg, pair.ffprobe].map((tool) => (tool.from === 'PATH' ? findOnPath(tool.bin) : tool.bin));
  if (!ffmpeg || !ffprobe) return null;
  const where = pair.ffprobe.from === pair.ffmpeg.from ? pair.ffmpeg.from : `${pair.ffmpeg.from} (ffprobe: ${pair.ffprobe.from})`;
  return { where, ffmpeg, ffprobe };
};

// Names the variable behind the binary that fails: fixing or unsetting any other one cannot help.
const brokenOverride = (pair: Pair): string => {
  for (const [role, tool] of [['ffmpeg', pair.ffmpeg], ['ffprobe', pair.ffprobe]] as const) {
    if (!isOverride(tool)) continue;
    const { banner, failure } = probeVersion(tool.bin, FFMPEG_PROBE);
    if (banner) continue;
    const beside = role === 'ffprobe' && tool.from === 'OPENEDIT_FFMPEG' ? ', or set OPENEDIT_FFPROBE to an ffprobe elsewhere' : '';
    return `${tool.from} is set, but ${tool.bin} does not run (${failure}); fix or unset it${beside} — nothing else is used while it is set, so no install can stand in for it.`;
  }
  return '';
};

// A binary that exists but cannot start (a missing DLL, a broken dylib after an upgrade) fails every
// command that needs it, so presence alone proves nothing; ffprobe is half of those commands.
const runPair = (found: Found): { banner: string; failure: string } => {
  let banner = '';
  for (const bin of [found.ffmpeg, found.ffprobe]) {
    const probe = probeVersion(bin, FFMPEG_PROBE);
    if (!probe.banner) return { banner: '', failure: `${bin} does not run (${probe.failure})` };
    banner ||= probe.banner;
  }
  return { banner, failure: '' };
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

// Only Homebrew installs without root; elsewhere the hint is a system install the user runs.
export function noDownloadRoute(platform: NodeJS.Platform): string {
  const rights = platform === 'darwin' ? 'which needs no admin rights either' : 'a system install that needs root, so the user runs it';
  return `the download route covers Windows only; run \`${installHint('ffmpeg', platform)}\`, ${rights}.`;
}

export const usage = {
  summary: 'Install FFmpeg if none is there already: env override (run, never replaced) → app-data install → PATH → download (Windows)',
  flags: {
    check: { type: 'boolean', help: 'Report which FFmpeg would be used, run it and its ffprobe, and exit 1 if there is none or either does not start; installs nothing' },
    force: { type: 'boolean', help: 'Reinstall the app-data copy even when an FFmpeg is already there; refused while OPENEDIT_FFMPEG or OPENEDIT_FFPROBE is set' },
  },
} satisfies Usage;

export async function installFfmpeg(args: string[]): Promise<number> {
  const { values } = parseUsage('install-ffmpeg', usage, args);
  try {
    const pair = resolveFfmpegPair();
    if (values.check) {
      const found = existing(pair);
      if (!found) {
        say(`not installed (no OPENEDIT_FFMPEG, nothing on PATH, nothing in ${appDataBin()}); an FFmpeg elsewhere is used by setting OPENEDIT_FFMPEG to its path`);
        return 1;
      }
      const { banner, failure } = runPair(found);
      say(banner ? `installed via ${found.where} — ${banner}` : `installed via ${found.where}, but ${failure}`);
      say(`→ ${found.ffmpeg}`);
      return banner ? 0 : 1;
    }

    // Checked even under --force: config.ts would keep running an override over any fresh copy.
    const broken = brokenOverride(pair);
    if (broken) die(broken);
    // A fresh copy would never run in place of an overridden binary, yet install() reports it as the one used.
    const overridden = [pair.ffmpeg, pair.ffprobe].filter(isOverride);
    if (values.force && overridden.length) {
      const vars = [...new Set(overridden.map((tool) => tool.from))];
      die(`${vars.join(' and ')} ${vars.length > 1 ? 'are' : 'is'} set, so every command runs ${overridden.map((tool) => tool.bin).join(' and ')} over the app-data copy --force would install; unset ${vars.length > 1 ? 'them' : 'it'}, then re-run with --force.`);
    }
    const found = existing(pair);
    if (found && !values.force) {
      say(`already installed via ${found.where} — ${found.ffmpeg}; nothing to do${overridden.length ? '' : ' (--force reinstalls the app-data copy)'}`);
      return 0;
    }

    if (process.platform !== 'win32') die(noDownloadRoute(process.platform));
    await install();
    return 0;
  } catch (error) {
    console.error(`install-ffmpeg: ${error instanceof InstallError ? error.message : ((error as Error).stack ?? error)}`);
    return 1;
  }
}
