// Where a clip's face boxes live: runs/<key>/faces-<hash of the clip's real path>/, a folder of that clip's own, so
// two clips of one name never compete for it; faces writes there and every reader looks there.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runsDir } from '../config.ts';
import { runKeyOf } from '../resolve-video.ts';

// The operating system's own answer, so on a case-insensitive disk A/clip.mp4 and a/clip.mp4 are one clip.
const real = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

/** Whether two spellings name one file: /tmp and /private/tmp, or a link and its target, are the same clip. */
export const sameFile = (a: string, b: string): boolean => real(a) === real(b);

/** The clip a faces.json was found on, or undefined when the file is missing or unreadable. */
export function boxesOwner(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const { video } = JSON.parse(readFileSync(path, 'utf8')) as { video?: unknown };
    return typeof video === 'string' ? video : undefined;
  } catch {
    return undefined;
  }
}

const runOf = (video: string) => join(runsDir(), runKeyOf(video));
const isOwnFolder = (name: string) => /^faces-[0-9a-f]{8}$/.test(name);

/** The folder faces writes `video`'s boxes to when no --out is given. */
export function facesFolder(video: string): string {
  return join(runOf(video), `faces-${createHash('sha256').update(real(video)).digest('hex').slice(0, 8)}`);
}

/** Where faces writes `video`'s boxes when --out does not say. */
export const facesPathFor = (video: string): string => join(facesFolder(video), 'faces.json');

// Where faces wrote every clip's boxes before each clip had a folder of its own.
const shared = (video: string) => join(runOf(video), 'faces.json');

/**
 * The faces.json a reader takes for `video` when none is named, or null when faces has not run on it: the one in its own
 * folder whatever it holds, so a broken or stale one is reported, else the shared one from before when it names this clip.
 */
export function ownFaces(video: string): string | null {
  if (existsSync(facesPathFor(video))) return facesPathFor(video);
  const owner = boxesOwner(shared(video));
  return owner !== undefined && sameFile(owner, video) ? shared(video) : null;
}

/** A faces.json from before each clip had its own folder that holds another clip's boxes, which are never used. */
export function othersFaces(video: string): string | null {
  const owner = boxesOwner(shared(video));
  return owner !== undefined && !sameFile(owner, video) ? shared(video) : null;
}

/** A clip's boxes as faces.json records the clip they were found on. */
export interface Stranded { path: string; owner: string; width: number; height: number; durationSec: number }

/** Boxes under `video`'s name found on files that are no longer there, as a moved clip, or a card taken out, leaves them. */
export function strandedFaces(video: string): Stranded[] {
  let own: string[];
  try {
    own = readdirSync(runOf(video)).filter(isOwnFolder).map((name) => join(runOf(video), name, 'faces.json'));
  } catch {
    return [];
  }
  return [shared(video), ...own].flatMap((path) => {
    const owner = boxesOwner(path);
    if (owner === undefined || existsSync(owner)) return [];
    const { width, height, durationSec } = JSON.parse(readFileSync(path, 'utf8')) as Omit<Stranded, 'path' | 'owner'>;
    return [{ path, owner, width, height, durationSec }];
  });
}
