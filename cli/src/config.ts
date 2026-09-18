// Where the CLI keeps its login state: the platform's own per-user app-data
// directory, like any installed app — never the working directory or a checkout.
// OPENEDIT_STATE_DIR overrides for tests and unusual setups.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { engineBinaryName } from "./platform.ts";

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

// --- media tools: the same env contract the Open Edit repository's config.ts reads,
// so one environment configures both codebases identically during the migration. ---

// Where install-ffmpeg puts its no-admin copy (app-data, like the engine — a plugin host
// may have no working directory to install into).
export function ffmpegDir(): string {
  return join(stateDir(), "ffmpeg");
}

// Preferred over PATH so the install-ffmpeg route needs no env vars afterwards.
const appDataFfmpegTool = (name: string): string | null => {
  const file = join(ffmpegDir(), "bin", process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(file) ? file : null;
};

// ffmpeg — base-frame extraction + audio work. Env override → app-data install → PATH.
export const FFMPEG = process.env.VEED_ENGINE_FFMPEG ?? appDataFfmpegTool("ffmpeg") ?? "ffmpeg";

// ffprobe (source dims + duration → canvas aspect). Defaults next to FFMPEG when that path is set, else PATH.
export const FFPROBE = process.env.VEED_ENGINE_FFPROBE
  ?? (process.env.VEED_ENGINE_FFMPEG
    ? process.env.VEED_ENGINE_FFMPEG.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1")
    : appDataFfmpegTool("ffprobe") ?? "ffprobe");

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
// repository root, which is what lets a checkout and an install share one content layout.
export function packageRoot(): string {
  // resolve() drops the trailing separator a directory URL carries; content-root prints this.
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

// The content tree: refs, pipeline, docs, the skill. OPEN_EDIT_ROOT pins it only when the directory
// really carries content — a workspace that merely exported the variable would otherwise hide the
// content the package ships with, and every recipe run would fail on an index that was never there.
export function contentRoot(): string {
  const pinned = process.env.OPEN_EDIT_ROOT;
  if (pinned && existsSync(join(pinned, "refs", "tags.json"))) return pinned;
  return packageRoot();
}

const PACKAGE_NAME = "@veedstudio/openedit-cli";

function isWorkspaceDir(dir: string): boolean {
  // The installed package carries these markers too; skipping it lets the walk reach the project
  // that owns the node_modules, which is where renders belong.
  if (dir.split(sep).includes("node_modules")) return false;
  if (existsSync(join(dir, ".open-edit-prefs.json"))) return true;
  if (existsSync(join(dir, "refs", "tags.json"))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return Boolean(pkg.devDependencies?.[PACKAGE_NAME] ?? pkg.dependencies?.[PACKAGE_NAME]);
  } catch {
    return false;
  }
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

// Where the CLI WRITES: runs and the recorded provider choice. Never the content root — a published
// install's content sits in node_modules, which is no place to put a user's renders.
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

// Where the render engine is installed (a downloaded binary, like any other app data).
export function engineDir(): string {
  return join(stateDir(), "engine");
}

export function engineBinPath(): string {
  return process.env.VEED_ENGINE_BIN ?? join(engineDir(), engineBinaryName());
}

// The engine resolves `ffmpeg` for --record through the OS search path and takes no override of its
// own, so an explicitly configured ffmpeg is invisible to it unless its directory is on the child's PATH.
export function engineEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!isAbsolute(FFMPEG)) return base;
  const dir = dirname(FFMPEG);
  const key = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = base[key] ?? "";
  if (current.split(delimiter).includes(dir)) return base;
  return { ...base, [key]: current ? `${dir}${delimiter}${current}` : dir };
}

// The WCAG remediation applier, spawned as its OWN plain-node process (application policy stays
// out of the analyzer's). It ships inside this package; the sibling path carries whatever
// extension THIS module runs as (.ts under tsx in development, .js from dist when published) —
// plain node runs both; ts-runtime.ts adds a type-stripping flag when the .ts case needs one.
export function wcagRemediatePath(): string {
  if (process.env.WCAG_REMEDIATE) return process.env.WCAG_REMEDIATE;
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./wcag/remediate${ext}`, import.meta.url));
}
