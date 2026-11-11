// Real sound effects from a stock library, where the environment serves one at OPEN_EDIT_LIBRARY_URL.
//
// A generated effect comes back the same for the same prompt, so a piece repeats one sound at every cut. A search
// leaves out what the run already saved, so searching again for the next moment finds a different sound.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { numberFlag, parseUsage, renderUsage, type Usage } from '../args.ts';
import type { Http } from '../providers/fal.ts';
import { readManifest, record, type AssetRecord } from '../providers/assets.ts';

export const LIBRARY_ENV = 'OPEN_EDIT_LIBRARY_URL';
const PROVIDER = 'library';
const MODEL = 'sound-effects';
/** The most results the library answers a page. */
const PAGE_SIZE = 50;
/** A search reads this many pages at most, so a narrow length filter cannot page through the whole library. */
const MAX_PAGES = 3;
/** The library holds a call while it looks the sound up; past this the command gives up. */
const LIBRARY_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface LibrarySound {
  id: string;
  title: string;
  seconds: number;
}

export interface SoundSearch {
  sounds: LibrarySound[];
  /** Sounds the search found and left out, because this run saved them already. */
  savedLeftOut: number;
  /** Sounds the search found and left out for their length. */
  lengthLeftOut: number;
  /** Sounds this run saved, by library id, with where each landed. */
  saved: Map<string, string>;
}

function api(http: Http | undefined, timeoutMs: number): Http {
  return http ?? (async (url, init) => {
    const res = await fetch(url, { method: init.method, headers: init.headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, json: () => res.json(), arrayBuffer: () => res.arrayBuffer() };
  });
}

/** The library's base URL, or why there is none. */
export function libraryBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env[LIBRARY_ENV]?.trim();
  if (!base) {
    throw new Error(`No sound library here: ${LIBRARY_ENV} is not set. Generate the sound with fal instead.`);
  }
  return base.replace(/\/+$/, '');
}

async function ask(http: Http, url: string): Promise<Record<string, unknown>> {
  const res = await http(url, { method: 'GET', headers: { accept: 'application/json' } });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // An answer that is not JSON still has its status, below.
  }
  if (res.status >= 300) {
    const said = typeof body.error === 'string' ? body.error : `the sound library answered ${res.status}`;
    throw new Error(said);
  }
  return body;
}

/** One page of the library's results for a description of the sound. */
export async function libraryPage(
  term: string,
  page: number,
  opts: { http?: Http; env?: NodeJS.ProcessEnv; size?: number } = {},
): Promise<{ sounds: LibrarySound[]; totalPages: number }> {
  const query = new URLSearchParams({ q: term, page: String(page), size: String(opts.size ?? PAGE_SIZE) });
  const body = await ask(api(opts.http, LIBRARY_TIMEOUT_MS), `${libraryBase(opts.env)}/v1/library/sound-effects?${query}`);
  const items = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
  return {
    sounds: items.map((item) => ({ id: String(item.id ?? ''), title: String(item.title ?? ''), seconds: Number(item.seconds ?? 0) }))
      .filter((sound) => sound.id !== ''),
    totalPages: Number(body.total_pages ?? 0),
  };
}

/** The sounds a run already saved, by library id. */
export function savedSounds(runDir: string): Map<string, string> {
  const saved = new Map<string, string>();
  for (const asset of readManifest(runDir).assets) {
    const libraryId = asset.meta?.libraryId;
    if (asset.kind === 'sfx' && asset.provider === PROVIDER && typeof libraryId === 'string' && !saved.has(libraryId)) {
      saved.set(libraryId, asset.path);
    }
  }
  return saved;
}

/**
 * Up to `limit` sounds for a description, within the length asked for. With a run, the sounds it saved are
 * left out unless `includeSaved`, so the next moment gets a sound the piece does not have yet.
 */
export async function searchSounds(
  term: string,
  opts: {
    limit?: number; minSeconds?: number; maxSeconds?: number; runDir?: string; includeSaved?: boolean;
    http?: Http; env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SoundSearch> {
  const limit = opts.limit ?? 10;
  const saved = opts.runDir ? savedSounds(opts.runDir) : new Map<string, string>();
  const found: SoundSearch = { sounds: [], savedLeftOut: 0, lengthLeftOut: 0, saved };
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES && found.sounds.length < limit; page++) {
    const { sounds, totalPages } = await libraryPage(term, page, opts);
    for (const sound of sounds) {
      if (seen.has(sound.id)) continue;
      seen.add(sound.id);
      if (saved.has(sound.id) && !opts.includeSaved) found.savedLeftOut++;
      else if ((opts.minSeconds !== undefined && sound.seconds < opts.minSeconds)
        || (opts.maxSeconds !== undefined && sound.seconds > opts.maxSeconds)) found.lengthLeftOut++;
      else if (found.sounds.length < limit) found.sounds.push(sound);
    }
    if (sounds.length === 0 || page >= totalPages) break;
  }
  return found;
}

const EXTENSIONS: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

/** A file name from a library id: the id's own characters where they are safe in a path. */
function defaultName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return `sfx-${safe || 'sound'}`;
}

/**
 * Fetch one sound into the run and record it, with its library id, so a later search leaves it out and a
 * question about where it came from is answerable from the run.
 */
export async function saveSound(
  runDir: string,
  id: string,
  opts: { name?: string; http?: Http; env?: NodeJS.ProcessEnv; runKey?: string } = {},
): Promise<AssetRecord> {
  const name = opts.name ?? defaultName(id);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.') || name.startsWith('-')) {
    throw new Error(`invalid --as "${name}": use letters, digits, dot, dash or underscore (it names a file under assets/)`);
  }
  const link = await ask(api(opts.http, LIBRARY_TIMEOUT_MS), `${libraryBase(opts.env)}/v1/library/sound-effects/${encodeURIComponent(id)}`);
  const url = typeof link.url === 'string' ? link.url : '';
  if (!/^https?:\/\//.test(url)) throw new Error(`the sound library gave no file for ${id}`);
  const res = await api(opts.http, DOWNLOAD_TIMEOUT_MS)(url, { method: 'GET', headers: {} });
  const bare = url.split('?')[0];
  if (res.status >= 300) throw new Error(`sound download failed (${res.status}) for ${bare}`);
  const ext = EXTENSIONS[String(link.content_type ?? '').toLowerCase()] ?? bare.match(/\.(mp3|wav)$/i)?.[1]?.toLowerCase() ?? 'mp3';
  const rel = `assets/${name}.${ext}`; // POSIX in the manifest, whichever OS wrote it
  const dest = join(runDir, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));

  const asset: AssetRecord = {
    id: name,
    kind: 'sfx',
    path: rel,
    provider: PROVIDER,
    model: MODEL,
    createdAt: new Date().toISOString(),
    // Nothing was generated, so nothing was billed. `null` would read as "the provider gave no price".
    cost: 0,
    meta: { libraryId: id, sourceUrl: bare },
  };
  record(runDir, asset, opts.runKey);
  return asset;
}

export const usage = {
  summary: 'Real sound effects from a stock library: search by description / save into the run',
  positionals: 'search <description> | save <id>',
  flags: {
    run: { type: 'string', value: '<run-dir>', help: 'search: leave out the sounds this run already saved; save: the run the sound lands in' },
    'include-saved': { type: 'boolean', help: 'search: list the sounds this run already saved too, marked with where they are' },
    'min-seconds': { type: 'string', value: 'N', help: 'search: only sounds at least this long' },
    'max-seconds': { type: 'string', value: 'N', help: 'search: only sounds at most this long' },
    limit: { type: 'string', value: 'N', help: 'search: how many sounds to list (default 10)' },
    as: { type: 'string', value: '<name>', help: 'save: the file name under assets/ (default sfx-<id>)' },
  },
  notes: 'search lists `<id>  <seconds>s  <title>` for a plain description of the sound ("a door slamming in an\n'
    + 'empty hallway"); the library has no tags, so describe it in words and filter by length. With --run, the\n'
    + 'sounds that run saved are left out, so searching again for the next moment finds a sound the piece does\n'
    + 'not have yet. save downloads one into <run-dir>/assets/ and records it in the asset manifest.\n'
    + `The library is the one the environment serves at ${LIBRARY_ENV}; where none is set, generate the\n`
    + 'sound with fal instead.',
} satisfies Usage;

const atLeastZero = (n: number) => n >= 0;

export async function sfxCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('sfx', usage, argv);
  const [verb, ...rest] = positionals;

  if (verb === 'search') {
    const term = rest.join(' ').trim();
    if (!term) { console.error('search needs a description of the sound, e.g. sfx search "a door slamming"'); return 2; }
    const minSeconds = values['min-seconds'] === undefined ? undefined : numberFlag('min-seconds', values['min-seconds'], 0, atLeastZero, 'a length in seconds');
    const maxSeconds = values['max-seconds'] === undefined ? undefined : numberFlag('max-seconds', values['max-seconds'], 0, atLeastZero, 'a length in seconds');
    const limit = numberFlag('limit', values.limit, 10, (n) => Number.isInteger(n) && n >= 1 && n <= 100, 'a whole number from 1 to 100');
    const found = await searchSounds(term, {
      limit, minSeconds, maxSeconds, runDir: values.run, includeSaved: values['include-saved'],
    });
    for (const sound of found.sounds) {
      const where = found.saved.get(sound.id);
      console.log(`${sound.id}  ${sound.seconds}s  ${sound.title}${where ? `  (saved as ${where})` : ''}`);
    }
    if (!found.sounds.length) console.log('(no sound in the library fits that; describe it another way, or change the length)');
    if (found.savedLeftOut) {
      console.log(`(${found.savedLeftOut} this run already saved left out; --include-saved lists them)`);
    }
    if (found.lengthLeftOut) console.log(`(${found.lengthLeftOut} left out for their length)`);
    return 0;
  }

  if (verb === 'save') {
    const id = rest.join(' ').trim();
    if (!id || !values.run) { console.error('save needs <id> --run <run-dir>'); return 2; }
    const asset = await saveSound(values.run, id, { name: values.as });
    console.log(join(values.run, asset.path));
    return 0;
  }

  console.error(renderUsage('sfx', usage));
  return 2;
}
