// The brief: what the user asked of one piece (how long it runs, where it is posted, their own words), written once
// by `openedit brief` as brief.json in the piece's runs/<key>/ folder. A tool finds it from the file it works on, in
// that file's folder or the nearest one above it inside the workspace: every file of a piece lives under its own
// runs/<key>/, so the walk reaches that piece's brief and never a sibling's, and two pieces made at once never share
// one. A file outside the workspace is looked up in its own folder only, so nothing above a project is read.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { describeValue } from './args.ts';
import { workspaceRoot } from './config.ts';
import { readJsonFile } from './json-file.ts';
import { writeAtomic } from './providers/exclusive-files.ts';

export const BRIEF_FILE = 'brief.json';

export interface Brief {
  /** Seconds the piece should run. */
  length?: number;
  /** Where it is posted, as a name `safe-zone` takes: an app (`tiktok`), a shape (`9:16`) or both (`linkedin 1:1`). */
  platform?: string;
  /** The user's own words for the piece, as they wrote them. */
  words?: string;
}

export interface FoundBrief {
  path: string;
  brief: Brief;
}

// Spelled as on disk, so a workspace reached through a symlink (macOS's /tmp, say) still contains its own files.
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The folder a lookup starts in: the path itself when it is a folder, else the one holding it, or the nearest that
 * exists when that does not yet, as for a render's --out: a folder not made yet holds no brief.
 */
function startOf(from: string): string {
  let path = resolve(from);
  if (existsSync(path) && statSync(path).isDirectory()) return real(path);
  path = dirname(path);
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
  return real(path);
}

/** The brief.json that applies to a file or folder of a piece, or null when there is none. */
export function findBrief(from: string): string | null {
  let dir = startOf(from);
  const root = real(workspaceRoot());
  const inside = dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
  for (;;) {
    const file = join(dir, BRIEF_FILE);
    if (existsSync(file)) return file;
    const parent = dirname(dir);
    if (!inside || dir === root || parent === dir) return null;
    dir = parent;
  }
}

/** A brief's fields, checked; a field this version does not know is left out rather than refused. */
export function parseBrief(value: unknown, path: string): Brief {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not a brief: it holds ${describeValue(value)}, where a brief is an object`);
  }
  const { length, platform, words } = value as Record<string, unknown>;
  const brief: Brief = {};
  if (length !== undefined) {
    if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) {
      throw new Error(`${path} is not a brief: its length is ${describeValue(length)}, where it wants seconds above 0`);
    }
    brief.length = length;
  }
  if (platform !== undefined) {
    if (typeof platform !== 'string' || platform.trim() === '') {
      throw new Error(`${path} is not a brief: its platform is ${describeValue(platform)}, where it wants a name such as tiktok`);
    }
    brief.platform = platform;
  }
  if (words !== undefined) {
    if (typeof words !== 'string') throw new Error(`${path} is not a brief: its words are ${describeValue(words)}, where it wants text`);
    brief.words = words;
  }
  return brief;
}

/** The brief for a file or folder of a piece, or null when there is none; one that cannot be read throws, naming it. */
export function readBrief(from: string): FoundBrief | null {
  const path = findBrief(from);
  return path === null ? null : { path, brief: parseBrief(readJsonFile(path), path) };
}

/**
 * Sets the fields given in `dir`'s brief.json and keeps the others, so a length stated first and a platform stated
 * later end up in one brief. A file there that is not a brief is replaced, and `replaced` says why it was.
 */
export function writeBrief(dir: string, fields: Brief): FoundBrief & { replaced?: string } {
  const path = join(resolve(dir), BRIEF_FILE);
  let kept: Brief = {};
  let replaced: string | undefined;
  if (existsSync(path)) {
    try {
      kept = parseBrief(readJsonFile(path), path);
    } catch (error) {
      replaced = (error as Error).message;
    }
  }
  const brief: Brief = { ...kept };
  if (fields.length !== undefined) brief.length = fields.length;
  if (fields.platform !== undefined) brief.platform = fields.platform;
  if (fields.words !== undefined) brief.words = fields.words;
  writeAtomic(path, brief);
  return replaced === undefined ? { path, brief } : { path, brief, replaced };
}
