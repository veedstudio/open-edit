import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commonsSearch, commonsStill, directStill, saveStill, unlicensed } from '../src/commands/stills.ts';
import { readManifest, spend } from '../src/providers/assets.ts';
import type { Http } from '../src/providers/fal.ts';

const run = () => mkdtempSync(join(tmpdir(), 'stills-'));

/** The shape Commons actually returns, trimmed to the fields that decide anything. */
function fakeCommons(over: Record<string, unknown> = {}): Http {
  return async (url) => {
    if (url.includes('list=search')) {
      return {
        status: 200,
        json: async () => ({ query: { search: [{ title: 'File:Paramount 1968.svg' }, { title: 'File:Paramount logo.png' }] } }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (url.includes('prop=imageinfo')) {
      return {
        status: 200,
        json: async () => ({
          query: {
            pages: {
              '123': {
                title: 'File:Paramount 1968.svg',
                imageinfo: [{
                  url: 'https://upload.wikimedia.org/x/Paramount_1968.svg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Paramount_1968.svg',
                  width: 800,
                  height: 600,
                  extmetadata: {
                    LicenseShortName: { value: 'Public domain' },
                    Artist: { value: '<a href="/wiki/User:X">Someone</a>' },
                  },
                  ...over,
                }],
              },
            },
          },
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return { status: 200, json: async () => ({}), arrayBuffer: async () => new TextEncoder().encode('PNGBYTES').buffer };
  };
}

test('stills: a search returns file titles a lookup can resolve', async () => {
  const titles = await commonsSearch('Paramount Pictures logo 1968', { http: fakeCommons() });
  assert.deepEqual(titles, ['File:Paramount 1968.svg', 'File:Paramount logo.png']);
});

test('stills: the licence and the credit arrive with the file, not afterwards', async () => {
  const src = await commonsStill('Paramount 1968.svg', { http: fakeCommons() });
  assert.equal(src.url, 'https://upload.wikimedia.org/x/Paramount_1968.svg');
  assert.equal(src.licence, 'Public domain');
  assert.equal(src.attribution, 'Someone', 'the markup Commons wraps the credit in is stripped');
  assert.equal(src.width, 800);
});

test('stills: a file with no stated terms reads as unknown, never as permissive', async () => {
  // Assuming a default is how an unlicensed image reaches a delivered film.
  const src = await commonsStill('Mystery.png', { http: fakeCommons({ extmetadata: {} }) });
  assert.equal(src.licence, 'unknown');
  assert.equal(src.attribution, undefined);
});

test('stills: saving one lands the bytes and a record that can answer a rights question later', async () => {
  const dir = run();
  const http = fakeCommons();
  const src = await commonsStill('Paramount 1968.svg', { http });
  const asset = await saveStill(dir, 'ident-paramount', src, { http, runKey: 'fnl' });

  assert.ok(existsSync(join(dir, asset.path)));
  assert.equal(readFileSync(join(dir, asset.path), 'utf8'), 'PNGBYTES');
  assert.equal(asset.provider, 'wikimedia-commons');
  assert.equal(asset.meta!.licence, 'Public domain');
  assert.equal(asset.meta!.pageUrl, 'https://commons.wikimedia.org/wiki/File:Paramount_1968.svg');

  const m = readManifest(dir);
  assert.equal(m.runKey, 'fnl');
  assert.equal(m.assets.length, 1);
  // Sourcing costs nothing, and 0 says that. `null` would claim the provider withheld a price.
  assert.equal(spend(dir).total, 0);
  assert.equal(spend(dir).unpriced, 0);
});

test('stills: a direct url demands its terms from the caller', async () => {
  const dir = run();
  const src = directStill('https://example.test/jacket.jpg?sig=SECRET', { title: 'jacket', licence: 'unknown' });
  const asset = await saveStill(dir, 'jacket', src, { http: fakeCommons() });
  assert.equal(asset.provider, 'direct');
  assert.equal(asset.path, 'assets/jacket.jpg');
  assert.deepEqual(unlicensed([asset]).map((a) => a.id), ['jacket'], 'it lands on the list to settle before delivery');
});

test('stills: a failed download does not print the signed query string', async () => {
  const dir = run();
  const http: Http = async () => ({ status: 403, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    () => saveStill(dir, 'x', directStill('https://cdn.test/x.png?sig=SECRETSIG', { title: 'x', licence: 'unknown' }), { http }),
    (e: Error) => {
      assert.doesNotMatch(e.message, /SECRETSIG/);
      assert.match(e.message, /cdn\.test\/x\.png/);
      return true;
    },
  );
});
