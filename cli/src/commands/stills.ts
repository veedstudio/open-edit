// Getting a real picture, with the right to use it recorded next to it.
//
// A long piece can go its whole length without a single real picture in it — an ident, a poster, a
// book jacket, a magazine spread — for mechanical rather than editorial reasons. Search returns text,
// so nothing points at a picture asset; and every image prompt ends "absolutely no text, no lettering,
// no words", which rules out generating one too. There was no route to a real picture at all.
//
// This is the missing route. Wikimedia Commons is the first source because it is the one that answers
// the rights question in the same response as the file: every result carries its licence and its
// required attribution, so a still is never acquired without knowing what may be done with it.
//
// A still whose licence cannot be established is still recorded — as unknown. Not knowing is a fact
// worth writing down, because it is the one that has to be revisited before anything ships.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseFlags } from '../args.ts';
import type { Http } from '../providers/fal.ts';
import { record, type AssetRecord } from '../providers/assets.ts';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

export interface StillSource {
  /** Direct URL to the bytes. */
  url: string;
  /** The page a human should look at to check the claim. */
  pageUrl?: string;
  title: string;
  /** As stated by the source. `unknown` when the source does not say. */
  licence: string;
  /** The credit line the licence requires, when it requires one. */
  attribution?: string;
  width?: number;
  height?: number;
}

function api(http: Http | undefined): Http {
  return http ?? (async (url, init) => {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, json: () => res.json(), arrayBuffer: () => res.arrayBuffer() };
  });
}

/** Commons search, restricted to files. Returns candidate titles for `commonsStill` to resolve. */
export async function commonsSearch(query: string, opts: { http?: Http; limit?: number } = {}): Promise<string[]> {
  const url = `${COMMONS_API}?action=query&list=search&srnamespace=6&srlimit=${opts.limit ?? 10}&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
  const res = await api(opts.http)(url, { method: 'GET', headers: {} });
  if (res.status >= 300) throw new Error(`commons search failed (${res.status}) for "${query}"`);
  const body = (await res.json()) as { query?: { search?: { title: string }[] } };
  return (body.query?.search ?? []).map((s) => s.title);
}

/**
 * Resolve one Commons file to its bytes URL and its terms.
 *
 * `extmetadata` is where the licence lives. It is absent often enough that the caller must handle
 * `unknown` rather than assume a permissive default — assuming is how an unlicensed image ends up in
 * a delivered film.
 */
export async function commonsStill(title: string, opts: { http?: Http } = {}): Promise<StillSource> {
  const file = title.startsWith('File:') ? title : `File:${title}`;
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent(file)}&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&format=json&origin=*`;
  const res = await api(opts.http)(url, { method: 'GET', headers: {} });
  if (res.status >= 300) throw new Error(`commons lookup failed (${res.status}) for ${file}`);
  const body = (await res.json()) as {
    query?: { pages?: Record<string, {
      title?: string;
      imageinfo?: { url: string; descriptionurl?: string; width?: number; height?: number; extmetadata?: Record<string, { value?: string }> }[];
    }> };
  };
  const page = Object.values(body.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info?.url) throw new Error(`commons has no file at ${file}`);
  const meta = info.extmetadata ?? {};
  const strip = (v?: string) => v?.replace(/<[^>]*>/g, '').trim() || undefined;
  return {
    url: info.url,
    pageUrl: info.descriptionurl,
    title: page?.title ?? file,
    licence: strip(meta.LicenseShortName?.value) ?? strip(meta.UsageTerms?.value) ?? 'unknown',
    attribution: strip(meta.Artist?.value) ?? strip(meta.Credit?.value),
    width: info.width,
    height: info.height,
  };
}

/** A still from anywhere, with terms the caller had to state — nothing is assumed permissive. */
export function directStill(url: string, terms: { title: string; licence: string; attribution?: string; pageUrl?: string }): StillSource {
  return { url, ...terms };
}

/**
 * Fetch the bytes and land a manifest record.
 *
 * The record is what makes the still defensible later: a licence question that arrives after delivery
 * is answerable from the file rather than from somebody's memory of where the picture came from.
 */
export async function saveStill(
  runDir: string,
  id: string,
  src: StillSource,
  opts: { http?: Http; runKey?: string; ext?: string } = {},
): Promise<AssetRecord> {
  const ext = opts.ext ?? (src.url.match(/\.(png|jpe?g|webp|gif|svg)(?:$|\?)/i)?.[1]?.toLowerCase() ?? 'png');
  const rel = `assets/${id}.${ext}`; // POSIX in the manifest, whichever OS wrote it
  const dest = join(runDir, rel);
  const res = await api(opts.http)(src.url, { method: 'GET', headers: {} });
  if (res.status >= 300) {
    const q = src.url.indexOf('?');
    throw new Error(`still download failed (${res.status}) for ${q < 0 ? src.url : `${src.url.slice(0, q)}?…`}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));

  const asset: AssetRecord = {
    id,
    kind: 'image',
    path: rel,
    provider: src.pageUrl?.includes('wikimedia') ? 'wikimedia-commons' : 'direct',
    model: 'sourced',
    createdAt: new Date().toISOString(),
    // Nothing was generated, so nothing was billed. `null` would read as "the provider gave no price".
    cost: 0,
    meta: {
      sourceUrl: src.url,
      pageUrl: src.pageUrl,
      title: src.title,
      licence: src.licence,
      attribution: src.attribution,
      width: src.width,
      height: src.height,
    },
  };
  record(runDir, asset, opts.runKey);
  return asset;
}

/** Stills in this run whose terms were never established — the list to settle before delivery. */
export function unlicensed(assets: AssetRecord[]): AssetRecord[] {
  return assets.filter((a) => a.model === 'sourced' && (!a.meta?.licence || a.meta.licence === 'unknown'));
}

export async function stillsCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseFlags({
    args: argv,
    options: { run: { type: 'string' }, id: { type: 'string' }, limit: { type: 'string' }, licence: { type: 'string' } },
    allowPositionals: true,
  });
  const [verb, ...rest] = positionals;

  if (verb === 'search') {
    const titles = await commonsSearch(rest.join(' '), { limit: Number(values.limit ?? 10) });
    if (!titles.length) console.log('(nothing on Commons for that)');
    for (const t of titles) console.log(t);
    return 0;
  }

  if (verb === 'show') {
    const src = await commonsStill(rest.join(' '));
    console.log(`${src.title}\n  ${src.width ?? '?'}x${src.height ?? '?'}\n  licence: ${src.licence}\n  credit : ${src.attribution ?? '(none required)'}\n  page   : ${src.pageUrl ?? '(n/a)'}`);
    return 0;
  }

  if (verb === 'save') {
    const runDir = values.run;
    const id = values.id;
    if (!runDir || !id) { console.error('save needs --run <run-dir> --id <asset-id>'); return 2; }
    const target = rest.join(' ');
    // A bare URL needs its terms from the caller; a Commons title carries its own.
    const src = /^https?:\/\//.test(target)
      ? directStill(target, { title: id, licence: values.licence ?? 'unknown' })
      : await commonsStill(target);
    const asset = await saveStill(runDir, id, src);
    console.log(`${asset.path} — ${asset.meta!.licence}${asset.meta!.attribution ? `, credit: ${asset.meta!.attribution}` : ''}`);
    if (asset.meta!.licence === 'unknown') {
      console.log('  terms unknown: settle them before this ships, or swap the asset');
    }
    return 0;
  }

  console.error(
    'usage:\n' +
    '  openedit stills search <query> [--limit 10]           # candidate Commons files\n' +
    '  openedit stills show <File:Name.svg>                  # its url, size, licence and credit\n' +
    '  openedit stills save <File:Name.svg|url> --run <dir> --id <asset-id> [--licence "<terms>"]',
  );
  return 2;
}
