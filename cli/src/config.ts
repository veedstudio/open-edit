// Where the CLI keeps its login state: the platform's own per-user app-data
// directory, like any installed app — never the working directory or a checkout.
// OPENEDIT_STATE_DIR overrides for tests and unusual setups.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function stateDir(): string {
  const explicit = process.env.OPENEDIT_STATE_DIR;
  if (explicit) return explicit;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "veed-openedit");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "veed-openedit");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "veed-openedit");
}

export function tokenPath(): string {
  return join(stateDir(), "token.json");
}

export function clientPath(): string {
  return join(stateDir(), "client.json");
}

// Where install-ffmpeg puts its no-admin copy (app-data: a plugin host may have no working
// directory to install into).
export function ffmpegDir(): string {
  return join(stateDir(), "ffmpeg");
}

// Preferred over PATH so the install-ffmpeg route needs no env vars afterwards.
const appDataFfmpegTool = (name: string): string | null => {
  const file = join(ffmpegDir(), "bin", process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(file) ? file : null;
};

const ffprobeBeside = (ffmpeg: string): string => ffmpeg.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1");

// An ffprobe beside OPENEDIT_FFMPEG is attributed to that variable, since it is the one to fix.
export type FfmpegSource = "OPENEDIT_FFMPEG" | "OPENEDIT_FFPROBE" | "app-data install" | "PATH";
export interface FfmpegTool { bin: string; from: FfmpegSource }

// Each tool: its env override → app-data install → PATH, and a set OPENEDIT_FFMPEG puts ffprobe beside it
// unless OPENEDIT_FFPROBE is set. An empty variable counts as unset (spawning '' fails every command);
// init and install-ffmpeg call this too, so they check the pair every command runs.
export function resolveFfmpegPair(
  env: Record<string, string | undefined> = process.env,
  appDataTool: (name: string) => string | null = appDataFfmpegTool,
): { ffmpeg: FfmpegTool; ffprobe: FfmpegTool } {
  const fallback = (name: string): FfmpegTool => {
    const local = appDataTool(name);
    return local ? { bin: local, from: "app-data install" } : { bin: name, from: "PATH" };
  };
  const ffmpegEnv = env.OPENEDIT_FFMPEG || "";
  const ffprobeEnv = env.OPENEDIT_FFPROBE || "";
  return {
    ffmpeg: ffmpegEnv ? { bin: ffmpegEnv, from: "OPENEDIT_FFMPEG" } : fallback("ffmpeg"),
    ffprobe: ffprobeEnv
      ? { bin: ffprobeEnv, from: "OPENEDIT_FFPROBE" }
      : ffmpegEnv ? { bin: ffprobeBeside(ffmpegEnv), from: "OPENEDIT_FFMPEG" } : fallback("ffprobe"),
  };
}

const ffmpegPair = resolveFfmpegPair();
export const FFMPEG = ffmpegPair.ffmpeg.bin;
export const FFPROBE = ffmpegPair.ffprobe.bin;

// WhisperX — the local, free transcription provider. Default: PATH.
export const WHISPERX_BIN = process.env.WHISPERX_BIN ?? "whisperx";

// Fallback quality tier, used only until the user's choice is recorded in .open-edit-prefs.json.
export const WHISPERX_MODEL = process.env.WHISPERX_MODEL ?? "small.en";

// WhisperX device/compute. cpu/int8 runs everywhere (CTranslate2 has no GPU path on Apple Silicon);
// a CUDA-capable box can override, e.g. OPEN_EDIT_WHISPERX_DEVICE=cuda OPEN_EDIT_WHISPERX_COMPUTE=float16.
export const WHISPERX_DEVICE = process.env.OPEN_EDIT_WHISPERX_DEVICE ?? "cpu";
export const WHISPERX_COMPUTE = process.env.OPEN_EDIT_WHISPERX_COMPUTE ?? "int8";

// The package root. This module is cli/src/config.ts under tsx and cli/dist/config.js when published,
// so the same two levels up land on the package root either way — and the package root IS the
// repository root, which is what lets init read the skill from a checkout and an install alike.
export function packageRoot(): string {
  // resolve() drops the trailing separator a directory URL carries.
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export const PACKAGE_NAME = "@veedstudio/openedit-cli";

const readPackageJson = (dir: string): Record<string, any> | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

// Files only a source checkout carries: an installed copy has no pnpm lockfile (npm drops it from
// every pack) and no cli/src (`files` ships cli/dist).
export function hasCheckoutLayout(dir: string): boolean {
  return existsSync(join(dir, "pnpm-lock.yaml")) && existsSync(join(dir, "cli", "src", "cli.ts"));
}

// A source checkout of this package. The name keeps any other pnpm project with a cli/src/cli.ts
// from passing, which init would reuse in place and install into without asking.
export function isOpenEditCheckout(dir: string): boolean {
  return hasCheckoutLayout(dir) && readPackageJson(dir)?.name === PACKAGE_NAME;
}

function isWorkspaceDir(dir: string): boolean {
  // Renders belong to the project that owns a node_modules, never to a dependency inside it, even one
  // that itself depends on this package.
  if (dir.split(sep).includes("node_modules")) return false;
  if (existsSync(join(dir, ".open-edit-prefs.json"))) return true;
  // A checkout of this package is its own workspace, so a contributor's runs stay in the checkout.
  if (isOpenEditCheckout(dir)) return true;
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.devDependencies?.[PACKAGE_NAME] ?? pkg?.dependencies?.[PACKAGE_NAME]);
}

// Exported: init resolves the same workspace before the project exists, and two answers to "which
// project is this" is the bug.
export function findWorkspace(startDir: string): string | null {
  let dir: string;
  try {
    dir = resolve(startDir);
  } catch {
    return null;
  }
  for (;;) {
    if (isWorkspaceDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Where the CLI WRITES: runs and the recorded provider choice. Never the package root — a published
// install sits in node_modules, which is no place to put a user's renders.
export function workspaceRoot(): string {
  const pinned = process.env.OPEN_EDIT_ROOT;
  if (pinned) return pinned;
  // The spawns that follow init inherit none of its env, so the project has to be discovered.
  let cwd: string;
  try {
    cwd = process.cwd();
  } catch {
    return stateDir();
  }
  // A plugin host may have no useful working directory.
  return findWorkspace(cwd) ?? stateDir();
}

export function prefsPath(): string {
  return join(workspaceRoot(), ".open-edit-prefs.json");
}

export function runsDir(): string {
  return join(workspaceRoot(), "runs");
}

// The remembered billing-workspace choice. Remembered is not confirmed: the spend
// path re-confirms it before anything bills.
export function workspacePath(): string {
  return join(stateDir(), "workspace.json");
}

// Speaking rates measured on THIS machine's paid runs — local evidence, never shared
// state. The committed seed rates live beside the voice-rates module itself.
export function voiceRatesPath(): string {
  return join(stateDir(), "voice-rates.json");
}

// Where install-browser puts the pinned headless Chrome the HTML renderer drives.
export function browserDir(): string {
  return join(stateDir(), "browser");
}
