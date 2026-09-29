// The fonts command: the CSS2 request, local file names, the rewritten CSS, and (when the network and the
// browser are both here) that Chrome actually loads the faces from the written fonts.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cssUrl, downloadFonts, localNames, parseFaces } from '../src/commands/fonts.ts';
import { chromePlatform, installedChrome, CHROME_FLAGS } from '../src/render/browser.ts';
import { startPageServer } from '../src/render/server.ts';
import { scratchDir } from './helpers/synth.ts';

const CSS = `/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url(https://fonts.gstatic.com/s/inter/v20/ext.woff2) format('woff2');
  unicode-range: U+0100-02BA;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url(https://fonts.gstatic.com/s/inter/v20/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url(https://fonts.gstatic.com/s/inter/v20/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Dela Gothic One';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url(https://fonts.gstatic.com/l/font?kit=abc&skey=def&v=v19) format('woff2');
  unicode-range: U+4E00-4E10;
}
`;

test('fonts: the request names each family with its axis spec, and asks for block display', () => {
  const url = cssUrl(['Inter:wght@400;700', 'Playfair Display:ital,wght@0,400;1,700', 'Anton']);
  assert.equal(url, 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Playfair+Display:ital,wght@0,400;1,700&family=Anton&display=block');
});

test('fonts: local names are readable, unique per file, and carry none of a kit URL\'s ?&=', () => {
  const faces = parseFaces(CSS);
  assert.equal(faces.length, 4);
  assert.deepEqual(faces.map((f) => f.subset), ['latin-ext', 'latin', 'latin', null]);
  const names = localNames(faces);
  assert.equal(names.size, 3, 'one file per distinct URL: the variable-weight file is shared');
  assert.equal(names.get('https://fonts.gstatic.com/s/inter/v20/latin.woff2'), 'inter-normal-400-latin.woff2');
  for (const n of names.values()) assert.match(n, /^[a-z0-9-]+\.woff2$/);
});

test('fonts: every file is downloaded and fonts.css points at them, descriptors intact', async () => {
  const dir = scratchDir('fonts');
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    assert.match(String((init?.headers as Record<string, string>)['user-agent']), /Chrome\//, 'a UA the API answers with woff2');
    return url.startsWith('https://fonts.googleapis.com/') ? new Response(CSS) : new Response(`bytes of ${url}`);
  }) as typeof fetch;
  const r = await downloadFonts(['Inter:wght@400;700', 'Dela Gothic One'], dir, fetchImpl);
  assert.deepEqual(r.families, ['Inter', 'Dela Gothic One']);
  assert.equal(asked.length, 4, 'the CSS once, each distinct file once');
  const css = readFileSync(join(dir, 'fonts.css'), 'utf8');
  assert.doesNotMatch(css, /gstatic|https?:/);
  assert.equal((css.match(/@font-face/g) ?? []).length, 4);
  assert.match(css, /unicode-range: U\+0100-02BA;/);
  assert.match(css, /font-weight: 700;\n  font-display: block;\n  src: url\('inter-normal-400-latin\.woff2'\)/);
  for (const m of css.matchAll(/url\('([^']+)'\)/g)) assert.ok(existsSync(join(dir, m[1])), `${m[1]} was written`);
  assert.deepEqual(readdirSync(dir).sort(), ['dela-gothic-one-normal-400-1.woff2', 'fonts.css', 'inter-normal-400-latin-ext.woff2', 'inter-normal-400-latin.woff2']);
});

test('fonts: a file that fails to download fails the call by URL, and no fonts.css points at missing faces', async () => {
  const dir = scratchDir('fonts');
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://fonts.googleapis.com/')) return new Response(CSS);
    return url.endsWith('/latin.woff2') ? new Response('gone', { status: 404 }) : new Response(`bytes of ${url}`);
  }) as typeof fetch;
  await assert.rejects(downloadFonts(['Inter'], dir, fetchImpl), /could not download https:\/\/fonts\.gstatic\.com\/s\/inter\/v20\/latin\.woff2: HTTP 404/);
  assert.equal(existsSync(join(dir, 'fonts.css')), false);
});

test('fonts: a stylesheet with no font files in it is refused', async () => {
  const fetchImpl = (async () => new Response('/* nothing */')) as unknown as typeof fetch;
  await assert.rejects(downloadFonts(['Inter'], scratchDir('fonts'), fetchImpl), /returned no font files for Inter/);
});

test('fonts: an unknown family is refused with the API\'s reason', async () => {
  const fetchImpl = (async () => new Response('<html><body><p>400: Missing font family</p> The requested font families are not available.</body></html>', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(downloadFonts(['Nope Sans'], scratchDir('fonts'), fetchImpl), /Nope Sans \(HTTP 400\): 400: Missing font family/);
});

const platform = chromePlatform();
const online = await fetch('https://fonts.googleapis.com/css2?family=Anton', { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
const live = !online ? 'Google Fonts is not reachable' : !platform || !existsSync(installedChrome(platform)) ? 'Chrome Headless Shell is not installed' : false;

test('fonts: Chrome loads every face of the written fonts.css from disk', { skip: live }, async () => {
  const dir = scratchDir('fonts-live');
  await downloadFonts(['Anton', 'Inter:wght@400;700'], join(dir, 'fonts'));
  writeFileSync(join(dir, 'page.html'), '<!doctype html><link rel="stylesheet" href="fonts/fonts.css"><p style="font-family:Anton">Aa</p><p style="font-family:Inter;font-weight:700">Bb</p>');
  const { chromium } = await import('playwright-core');
  const server = await startPageServer({ roots: [dir] });
  const browser = await chromium.launch({ executablePath: installedChrome(platform!), args: CHROME_FLAGS });
  try {
    const p = await browser.newPage();
    await p.goto(server.urlFor(join(dir, 'page.html')));
    const faces = await p.evaluate('Promise.all([...document.fonts].map((f) => f.load().then(() => f.family + " " + f.weight + " " + f.status, () => f.family + " failed")))') as string[];
    assert.ok(faces.length > 2);
    assert.deepEqual(faces.filter((f) => !f.endsWith('loaded')), []);
    assert.equal(await p.evaluate('document.fonts.check("700 20px Inter") && document.fonts.check("20px Anton")'), true);
  } finally {
    await browser.close();
    await server.close();
  }
});
