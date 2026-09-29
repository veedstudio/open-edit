// Google Fonts, made local: every woff2 subset of the named families downloaded beside a fonts.css
// that points at them, so a page renders the same typography offline and on every run.
//
//   openedit fonts "Inter:wght@400;700" Anton "Playfair Display:ital,wght@0,400;1,700" --out comp/fonts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';

// The CSS2 API answers by user agent; a current Chrome is served woff2 split into unicode-range subsets.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const API = 'https://fonts.googleapis.com/css2';
const URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/;
// A fresh timeout per request, so a slow file does not eat the next one's allowance.
const request = (): RequestInit => ({ headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });

export const usage = {
  summary: 'Download Google Fonts as local woff2 files and write a fonts.css that uses them',
  positionals: '<Family[:spec]> [...]',
  flags: {
    out: { type: 'string', required: true, value: '<dir>', help: 'Directory for the woff2 files and fonts.css' },
  },
  notes: [
    'A family is spelled as Google Fonts spells it, with an optional axis spec in the CSS2 API form:',
    '"Inter:wght@400;700", "Playfair Display:ital,wght@0,400;1,700", Anton. Every unicode-range subset is kept,',
    'so each script the family covers renders. fonts.css holds exactly the families of this call, with',
    'font-display: block; link it with <link rel="stylesheet" href="<dir>/fonts.css">.',
  ].join('\n'),
} satisfies Usage;

/** The CSS2 request for these families. */
export function cssUrl(families: string[]): string {
  const params = families.map((f) => {
    const [name, ...spec] = f.trim().split(':');
    const family = name.trim().replace(/\s+/g, '+');
    const axes = spec.join(':').replace(/\s+/g, '');
    return `family=${encodeURI(axes ? `${family}:${axes}` : family).replace(/&/g, '%26')}`;
  });
  return `${API}?${params.join('&')}&display=block`;
}

export interface Face {
  family: string;
  style: string;
  weight: string;
  /** The subset label Google writes above the rule (`latin`, `cyrillic-ext`), when it writes one. */
  subset: string | null;
  url: string;
}

/** Each @font-face rule's descriptors, in order, with the remote file it loads. */
export function parseFaces(css: string): Face[] {
  const faces: Face[] = [];
  const rule = /(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    const body = m[2];
    const get = (prop: string) => new RegExp(`${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim();
    const url = URL_RE.exec(body)?.[1];
    if (!url) continue;
    faces.push({
      family: (get('font-family') ?? '').replace(/^['"]|['"]$/g, ''),
      style: get('font-style') ?? 'normal',
      weight: get('font-weight') ?? '400',
      subset: m[1] ? m[1].replace(/[[\]]/g, '') : null,
      url,
    });
  }
  return faces;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Local names for the remote files: readable (family, style, weight, subset) and free of the `?`, `&`
 * and `=` a kit URL carries, which a file system or a later URL would read as syntax.
 */
export function localNames(faces: Face[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const counters = new Map<string, number>();
  for (const f of faces) {
    if (names.has(f.url)) continue;
    const stem = `${slug(f.family)}-${slug(f.style)}-${slug(f.weight)}`;
    const n = (counters.get(stem) ?? 0) + 1;
    counters.set(stem, n);
    const base = `${stem}-${f.subset ? slug(f.subset) : String(n)}`;
    let name = `${base}.woff2`;
    for (let k = 2; taken.has(name); k++) name = `${base}-${k}.woff2`;
    taken.add(name);
    names.set(f.url, name);
  }
  return names;
}

/** The API's own CSS with every remote URL replaced by its local file, so no descriptor is lost in a rewrite. */
export function localCss(css: string, names: Map<string, string>): string {
  return css.replace(new RegExp(URL_RE.source, 'g'), (whole, url: string) => (names.has(url) ? `url('${names.get(url)}')` : whole));
}

export interface FontsResult {
  /** The written fonts.css. */
  stylesheet: string;
  families: string[];
  files: string[];
  bytes: number;
}

export async function downloadFonts(families: string[], outDir: string, fetchImpl: typeof fetch = fetch): Promise<FontsResult> {
  const url = cssUrl(families);
  const res = await fetchImpl(url, request());
  const css = await res.text();
  if (!res.ok) {
    const why = css.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').replace(/For reference.*$/, '').trim().slice(0, 240);
    throw new Error(`Google Fonts refused ${families.join(', ')} (HTTP ${res.status}): ${why || 'no reason given'}; check the spelling and the axis spec at fonts.google.com`);
  }
  const faces = parseFaces(css);
  if (!faces.length) throw new Error(`Google Fonts returned no font files for ${families.join(', ')}`);
  const names = localNames(faces);
  mkdirSync(outDir, { recursive: true });

  let bytes = 0;
  const queue = [...names.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [remote, local] = next;
      const r = await fetchImpl(remote, request());
      if (!r.ok) throw new Error(`could not download ${remote}: HTTP ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      writeFileSync(join(outDir, local), body);
      bytes += body.length;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));

  const out = localCss(css, names);
  writeFileSync(join(outDir, 'fonts.css'), out);
  return { stylesheet: join(outDir, 'fonts.css'), families: [...new Set(faces.map((f) => f.family))], files: [...names.values()], bytes };
}

export async function fonts(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('fonts', usage, argv);
  if (!positionals.length || !values.out) {
    console.error(usageLine('fonts', usage));
    return 2;
  }
  const outDir = resolve(values.out);
  const r = await downloadFonts(positionals, outDir);
  console.log(`fonts: ${r.families.join(', ')}: ${r.files.length} woff2 file(s), ${(r.bytes / 1024).toFixed(0)} KB → ${outDir}`);
  console.log(`  css: ${r.stylesheet}`);
  return 0;
}
