// Serves the page and everything it references over loopback HTTP rather than file://, where fetch(),
// ES modules and ranged <video> reads are refused. Files are addressed by absolute path, so a page's
// `../footage/clip.mp4` resolves exactly as it would on disk; a random first path segment keeps other
// local processes from reading through it while a render runs.
//
// Every script on the page, a CDN include as much as the page's own, shares this server's origin and
// can read whatever it serves, so it serves only beneath the roots it was given, never a hidden (dot)
// name below them (.ssh, .env, .git), and never the CLI's own state, where the login token lives, or
// the file OPEN_EDIT_FAL_KEY_FILE names.
import { randomBytes } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, parse, posix, relative, resolve, sep, win32 } from 'node:path';
import { pipeline } from 'node:stream';
import { runsDir, stateDir } from '../config.ts';
import { planRange } from './range.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export interface Refusal {
  /** Why the file is not served. */
  reason: string;
  /**
   * A directory that, given as --root, would let the page read it; absent when none would, and when that
   * directory is too wide to suggest or hidden.
   */
  root?: string;
  /** Why no --root is offered for the folder a file outside the roots sits in, as unsafeRoot() words it. */
  folder?: string;
}

export interface PageServer {
  /** The URL the page at `file` is served under. */
  urlFor(file: string): string;
  /** The file a served URL reads, for naming a failed load by its path rather than its URL. */
  fileFor(url: string): string | null;
  /** Why this server refused a URL it was asked for, or null when it did not refuse it. */
  refusalFor(url: string): Refusal | null;
  /** `text` with each of this server's URLs in it replaced by the file it reads. */
  named(text: string): string;
  /** Answer requests for `file` with `replacement`, under the same URL. */
  substitute(file: string, replacement: string): void;
  /** Every file a request has named so far, whether or not it was there to serve. */
  requested(): string[];
  close(): Promise<void>;
}

function toUrlPath(file: string): string {
  const abs = resolve(file).split(sep).join('/');
  const rooted = abs.startsWith('/') ? abs : `/${abs}`;
  return rooted.split('/').map(encodeURIComponent).join('/');
}

/** `p` relative to `root`, or null when it lies outside it. */
function beneath(root: string, p: string): string | null {
  const rel = relative(root, p);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel;
}

/** Whether a path names a hidden (dot) entry. */
export function hidden(rel: string, platform: NodeJS.Platform = process.platform): boolean {
  return rel.split(platform === 'win32' ? /[\\/]/ : sep).some((part) => part.startsWith('.'));
}

/**
 * hidden() for a path as the native resolver spells it, except a dot entry directly inside node_modules: a
 * package manager's own, as pnpm links every package out of node_modules/.pnpm.
 */
export function hiddenOnDisk(rel: string): boolean {
  return rel.split(process.platform === 'win32' ? /[\\/]/ : sep).some((part, i, parts) => part.startsWith('.') && parts[i - 1] !== 'node_modules');
}

/**
 * `p` as it is spelled on disk, or as given when it does not exist. The native resolver, as the
 * per-request `realpath` is: the JS one keeps a path's case as typed and a Windows 8.3 short name
 * unexpanded, so the two sides of a containment check would not compare.
 */
export function onDisk(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** tooBroad() for `dir` as spelled, against each spelling of home given. */
function broadByName(dir: string, homes: string[]): string | null {
  if (dir === parse(dir).root) return 'the filesystem root';
  for (const home of homes) {
    const rel = relative(dir, home);
    if (rel === '') return 'your home directory';
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) return 'an ancestor of your home directory';
  }
  return null;
}

/**
 * What `dir` would expose when it is too wide to serve unasked, else null: the filesystem root, the home
 * directory or an ancestor of it, where a page's scripts would reach every file the user has.
 */
export function tooBroad(dir: string, home = homedir()): string | null {
  return broadByName(onDisk(dir), [onDisk(home)]);
}

/**
 * Why the folder `dir`, as spelled, is not one to suggest as a --root, or null when it may be: home, an
 * ancestor of it or /, a hidden folder the dot rule protects, or on Windows a folder whose 8.3 short name
 * may stand for a hidden one, since nothing outside the roots is looked up to expand it.
 */
export function unsafeRoot(dir: string, homes: string[], platform: NodeJS.Platform = process.platform): string | null {
  if (hidden(dir, platform)) return 'a hidden folder';
  if (platform === 'win32' && /~\d/.test(dir)) return 'a folder whose short name may stand for a hidden one';
  return broadByName(dir, homes);
}

/**
 * The file a request names, or null when it names no local absolute path. On Windows that means a drive
 * path: looking up a UNC share or a device path opens a connection to it, with the user's credentials.
 */
export function requestedFile(decoded: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return posix.resolve(decoded);
  // `/C:/Users/...`
  const local = decoded.replace(/^\/+/, '');
  return /^[A-Za-z]:[\\/]/.test(local) ? win32.resolve(local) : null;
}

export interface PageServerOptions {
  /** Directories the page may read beneath; every one must exist. */
  roots: string[];
}

export async function startPageServer(o: PageServerOptions): Promise<PageServer> {
  const asked = new Set<string>();
  const roots = [...new Set(o.roots.map((r) => resolve(r)))].map((logical) => {
    if (!statSync(logical).isDirectory()) throw new Error(`${logical} is not a directory`);
    return { logical, real: realpathSync.native(logical) };
  });
  const state = onDisk(stateDir());
  // Runs live in the state dir when no workspace was found, and a page kept there must still load.
  const runs = onDisk(runsDir());
  // The fal key may be kept in any file, a workspace one included, where no other rule covers it.
  const keyFile = process.env.OPEN_EDIT_FAL_KEY_FILE ? onDisk(process.env.OPEN_EDIT_FAL_KEY_FILE) : null;
  const homeOnDisk = onDisk(homedir());
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}`;
  const substitutes = new Map<string, string>();

  const toFile = (pathname: string): string | null => {
    if (!pathname.startsWith(`${prefix}/`)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return null;
    }
    return requestedFile(decoded);
  };

  /**
   * A file outside every root, judged by its spelling alone: the page learns nothing from it, and cannot make
   * the server look up a path no root admits. The --root that would admit it is offered only where serving
   * that folder whole is safe to suggest.
   */
  const outside = (reason: string, file: string): Refusal => {
    // A dot file stays refused under any root, so no --root is offered for it.
    if (hidden(basename(file))) return { reason: 'Hidden (dot) path refused' };
    const dir = dirname(file);
    const folder = unsafeRoot(dir, [resolve(homedir()), homeOnDisk]);
    return folder ? { reason, folder } : { reason, root: dir };
  };
  /** Why `named` is not served, or null when it may be. Checked before a substitute replaces it. */
  const refusal = async (named: string): Promise<Refusal | null> => {
    const rels = roots.map((r) => beneath(r.logical, named)).filter((rel): rel is string => rel !== null);
    if (!rels.length) return outside('Outside the served roots', named);
    if (rels.every((rel) => hidden(rel))) return { reason: 'Hidden (dot) path refused' };
    let real: string;
    try {
      real = await realpath(named);
    } catch {
      return null;
    }
    // A link inside a root must not reach past it, nor reach a dot entry under a name without the dot, as
    // a Windows 8.3 short name (GIT~1 for .git) does too; the native resolver expands those.
    const realRels = roots.map((r) => beneath(r.real, real)).filter((rel): rel is string => rel !== null);
    if (!realRels.length) return outside('Outside the served roots through a link', real);
    if (realRels.every((rel) => hiddenOnDisk(rel))) return { reason: 'Hidden (dot) path refused' };
    if (beneath(state, real) !== null && beneath(runs, real) === null) return { reason: 'The CLI state is never served' };
    if (real === keyFile) return { reason: 'The fal key file is never served' };
    return null;
  };
  // Kept so the page's failed load can be told apart from a missing file and named with its remedy.
  const refused = new Map<string, Refusal>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const named = toFile(url.pathname);
    if (!named || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const why = await refusal(named);
    if (why) {
      refused.set(named, why);
      res.writeHead(403, why.reason).end();
      return;
    }
    const file = substitutes.get(named) ?? named;
    asked.add(file);
    let size: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      size = st.size;
    } catch (e) {
      // Named for what went wrong, so the warning line does not call an unreadable file missing.
      const code = (e as NodeJS.ErrnoException).code;
      const status = code === 'ENOENT' || code === 'ENOTDIR' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 500;
      res.writeHead(status).end();
      return;
    }
    // A read the browser cancelled while the file was looked up (a video's load() restarts its reads)
    // has nobody left to answer, and piping into it throws.
    if (res.destroyed) return;
    const plan = planRange(req.headers.range, size);
    const headers = { ...plan.headers, 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' };
    if (plan.status === 416 || req.method === 'HEAD' || size === 0) {
      res.writeHead(plan.status, headers).end();
      return;
    }
    res.writeHead(plan.status, headers);
    // An aborted range read (a video seek cancels them) must end this response, not the process.
    pipeline(createReadStream(file, { start: plan.start, end: plan.end }), res, () => {});
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('the page server has no port');
  const origin = `http://127.0.0.1:${addr.port}`;

  const fileFor = (u: string): string | null => {
    try {
      const parsed = new URL(u);
      return parsed.origin === origin ? toFile(parsed.pathname) : null;
    } catch {
      return null;
    }
  };
  // A served URL is percent-encoded, so it holds no space; it ends at one, or at the ': ' a message
  // puts after it (a Windows path keeps its own `C:/`).
  const served = new RegExp(`${`${origin}${prefix}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S*?(?=:\\s|\\s|$)`, 'g');

  return {
    urlFor: (file) => `${origin}${prefix}${toUrlPath(file)}`,
    fileFor,
    refusalFor: (u) => {
      const file = fileFor(u);
      return file === null ? null : refused.get(file) ?? null;
    },
    named: (text) => text.replace(served, (u) => fileFor(u) ?? u),
    substitute: (file, replacement) => {
      substitutes.set(resolve(file), replacement);
    },
    requested: () => [...asked],
    close: () => new Promise<void>((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}
