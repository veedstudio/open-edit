// VEED PULL — take a project from VEED's editor to work on: a screen recording, or an edit a person changed.
//
//   openedit veed-pull <openedit-<project id>.json> --out <dir>
//
// The "Send to Claude" bookmark saves the project (its timeline, captions, and the records of the files it plays)
// into Downloads; this fetches every file into <dir>/media and writes the project as <dir>/plan.json, the plan
// veed-project takes, so an edit made on it goes back to VEED as a new project.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { stateDir } from '../config.ts';
import { readJsonFile } from '../json-file.ts';
import { errorText } from '../proxy.ts';
import { contentTypeOf, extensionOf } from '../providers/fal-storage.ts';
import { VEED_ORIGIN } from '../veed/api.ts';
import { isVeedId, planFromPulled, printable, veedMediaUrl, type HandoffRecord, type PulledItem, type SourceAsset } from '../veed/editor-project.ts';

export const usage = {
  summary: 'Fetch a VEED editor project saved by the "Send to Claude" bookmark: its files into <dir>/media and its timeline as <dir>/plan.json for veed-project',
  positionals: '<openedit-<project id>.json>',
  flags: {
    out: { type: 'string', required: true, value: '<dir>', help: 'Where media/, plan.json and the raw project.json go' },
  },
} satisfies Usage;

interface Pulled {
  /** The bookmark's file format; this reads the first. */
  v?: number;
  project: { id: string; name?: string; aspect?: [number, number]; fps?: number };
  timeline: (PulledItem & { id: string })[];
  subtitles: unknown[];
  assets: { id: string; contentType?: string; cdnUrl?: string; filePath?: string; error?: string }[];
}


/** A file's path as a plan beside `out` names it: relative, with forward slashes, so the plan reads the same on any system. */
const inPlan = (out: string, file: string): string => relative(out, file).split(sep).join('/');

export async function veedPull(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('veed-pull', usage, argv);
  const src = positionals[0];
  if (!src || !values.out) {
    console.error(`veed-pull: give the saved project and --out\n${usageLine('veed-pull', usage)}`);
    return 2;
  }
  if (!existsSync(src)) {
    console.error(`veed-pull: no file at ${src}; click "Send to Claude" on the project in VEED first`);
    return 1;
  }
  const pulled = readJsonFile(src) as Pulled;
  const p = pulled.project;
  const timed = (i: { from?: unknown }) => Number.isFinite(i?.from);
  if (pulled.v !== 1 || !isVeedId(p?.id) || !Array.isArray(pulled.timeline) || !pulled.timeline.every(timed) || !Array.isArray(pulled.assets)) {
    console.error(`veed-pull: ${src} is not a project saved by the "Send to Claude" bookmark`);
    return 1;
  }
  const out = resolve(values.out);
  mkdirSync(join(out, 'media'), { recursive: true });
  writeFileSync(join(out, 'project.json'), JSON.stringify(pulled, null, 2));

  const files = new Map<string, string>();
  const source: Record<string, SourceAsset> = {};
  const missed: string[] = [];
  for (const a of pulled.assets) {
    // The file names a link to fetch and a name to save under; only VEED's own hosts and VEED's ids are taken.
    const url = veedMediaUrl(a.cdnUrl, VEED_ORIGIN);
    if (!isVeedId(a.id) || !url) {
      missed.push(`${printable(a.id)}: ${a.error ? printable(a.error) : 'no download link on VEED'}`);
      continue;
    }
    // A media type the table knows names the extension; otherwise the link's own, only if it is a media type too.
    const fromLink = /\.([a-z0-9]{1,5})$/i.exec(url.pathname)?.[1]?.toLowerCase();
    const ext = extensionOf(a.contentType ?? '') ?? (fromLink && extensionOf(contentTypeOf(`f.${fromLink}`)) ? fromLink : 'bin');
    const file = join(out, 'media', `${a.id}.${ext}`);
    try {
      // VEED's media host serves only pages of the app that made the project, which it tells by the referrer.
      const res = await fetch(url, { headers: { referer: `${VEED_ORIGIN}/` } });
      if (!res.ok) throw new Error(`${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      missed.push(`${a.id}: the download failed (${errorText(e)})`);
      continue;
    }
    files.set(a.id, file);
    const st = statSync(file);
    source[inPlan(out, file)] = { asset: a.id, ...(a.filePath ? { path: a.filePath } : {}), bytes: st.size, mtimeMs: st.mtimeMs };
  }

  console.log(`veed-pull: "${printable(p.name ?? p.id)}", ${printable(p.aspect?.join('x') ?? '?')} at ${printable(p.fps ?? '?')} fps, ${pulled.timeline.length} items, ${files.size} files in ${join(out, 'media')}`);
  for (const i of [...pulled.timeline].sort((a, b) => a.from - b.from)) {
    const m = i.metadata ?? {};
    const span = `${i.from.toFixed(2)}-${Number(i.visibleUntil ?? i.from).toFixed(2)} s`;
    const what = i.category === 'text' ? `"${printable(m.value).slice(0, 60)}"` : i.assetId ? (files.get(i.assetId) ?? `asset ${printable(i.assetId)}`) : '';
    const trim = 'trimStart' in m ? ` (plays ${Number(m.trimStart).toFixed(2)}-${Number(m.trimEnd).toFixed(2)} s of the file)` : '';
    console.log(`  ${span.padEnd(16)} z${printable(i.zIndex ?? 0)} ${printable(i.category).padEnd(11)} ${printable(i.name)} ${what}${trim}`);
  }

  // A project veed-project sent from this machine says what each of its files was made from; a file copied into it
  // from another project is found by its storage path, which the copy keeps.
  const record = join(stateDir(), 'veed-handoffs', `${p.id}.json`);
  const sent: Partial<HandoffRecord> = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {};
  const pathOf = new Map(pulled.assets.map((a) => [a.id, a.filePath]));
  const madeFrom = (id: string) => sent.assets?.[id] ?? sent.paths?.[pathOf.get(id) ?? ''];
  const { plan, left } = planFromPulled(p, pulled.timeline, (id) => (files.has(id) ? inPlan(out, files.get(id)!) : undefined), madeFrom);
  if (pulled.subtitles?.length) left.push(`${pulled.subtitles.length} VEED subtitle track(s): the plan has no part for them (they are in project.json)`);
  plan.source = { project: p.id, assets: source };
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2));
  console.log(`veed-pull: the timeline as a plan is ${join(out, 'plan.json')}; edit it and send it back with openedit veed-project`);
  for (const line of left) console.log(`  not in the plan: ${printable(line)}`);
  if (missed.length) {
    console.error(`veed-pull: ${missed.length} of the project's files did not download, so their items are not in the plan:\n  ${missed.join('\n  ')}`);
    console.error('veed-pull: click "Send to Claude" on the project again for fresh links, then run this again');
    return 1;
  }
  return 0;
}
