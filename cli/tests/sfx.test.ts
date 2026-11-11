import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryBase, saveSound, savedSounds, searchSounds } from '../src/commands/sfx.ts';
import { readManifest } from '../src/providers/assets.ts';
import type { Http } from '../src/providers/fal.ts';

const run = () => mkdtempSync(join(tmpdir(), 'sfx-'));
const ENV = { OPEN_EDIT_LIBRARY_URL: 'http://127.0.0.1:3131/' };

/** The library endpoint as the environment serves it: pages of sounds, and a signed link per sound. */
function fakeLibrary(pages: { id: string; title: string; seconds: number }[][], calls: string[] = []): Http {
  return async (url) => {
    calls.push(url);
    const json = (status: number, body: unknown) => ({
      status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
    });
    const parsed = new URL(url);
    if (parsed.hostname === 'cdn.example') {
      return { status: 200, json: async () => ({}), arrayBuffer: async () => new TextEncoder().encode('MP3BYTES').buffer };
    }
    if (parsed.pathname === '/v1/library/sound-effects') {
      const page = Number(parsed.searchParams.get('page'));
      return json(200, { items: pages[page - 1] ?? [], page, total_pages: pages.length });
    }
    const id = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
    if (id === 'gone') return json(404, { error: 'The sound library has no sound with that id.' });
    return json(200, { id, url: `https://cdn.example/${id}.mp3?sig=abc`, expires_at: '2030-01-01T00:00:00Z', content_type: 'audio/mpeg' });
  };
}

const sounds = (...ids: string[]) => ids.map((id, i) => ({ id, title: `Sound ${id}`, seconds: i + 1 }));

test('sfx: a search lists the library\'s sounds for a description', async () => {
  const calls: string[] = [];
  const found = await searchSounds('a door slamming', { http: fakeLibrary([sounds('a', 'b', 'c')], calls), env: ENV });

  assert.deepEqual(found.sounds.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(found.sounds[1].seconds, 2);
  assert.equal(calls.length, 1, 'one page held everything');
  const asked = new URL(calls[0]);
  assert.equal(asked.origin + asked.pathname, 'http://127.0.0.1:3131/v1/library/sound-effects');
  assert.equal(asked.searchParams.get('q'), 'a door slamming');
});

test('sfx: a search leaves out the sounds the run already saved, so the next moment gets a new one', async () => {
  const dir = run();
  const http = fakeLibrary([sounds('a', 'b', 'c')]);
  await saveSound(dir, 'a', { http, env: ENV });

  const found = await searchSounds('whoosh', { runDir: dir, http, env: ENV });
  assert.deepEqual(found.sounds.map((s) => s.id), ['b', 'c']);
  assert.equal(found.savedLeftOut, 1);

  const all = await searchSounds('whoosh', { runDir: dir, includeSaved: true, http, env: ENV });
  assert.deepEqual(all.sounds.map((s) => s.id), ['a', 'b', 'c'], 'asked to, it lists them too');
  assert.equal(all.saved.get('a'), 'assets/sfx-a.mp3');
});

test('sfx: a search without a run leaves nothing out', async () => {
  const found = await searchSounds('whoosh', { http: fakeLibrary([sounds('a', 'b')]), env: ENV });
  assert.equal(found.savedLeftOut, 0);
  assert.equal(found.sounds.length, 2);
});

test('sfx: the length filter runs on each sound\'s seconds, and reads more pages to fill the list', async () => {
  const calls: string[] = [];
  const pages = [
    [{ id: 'long', title: 'Long', seconds: 30 }, { id: 'ok-1', title: 'Ok', seconds: 2 }],
    [{ id: 'short', title: 'Short', seconds: 0.2 }, { id: 'ok-2', title: 'Ok', seconds: 3 }],
  ];
  const found = await searchSounds('impact', {
    minSeconds: 1, maxSeconds: 5, limit: 2, http: fakeLibrary(pages, calls), env: ENV,
  });

  assert.deepEqual(found.sounds.map((s) => s.id), ['ok-1', 'ok-2']);
  assert.equal(found.lengthLeftOut, 2);
  assert.equal(calls.length, 2);
});

test('sfx: a search stops after a few pages however narrow the filter', async () => {
  const calls: string[] = [];
  const pages = Array.from({ length: 10 }, (_, p) => [{ id: `long-${p}`, title: 'Long', seconds: 60 }]);
  const found = await searchSounds('rain', { maxSeconds: 5, http: fakeLibrary(pages, calls), env: ENV });

  assert.equal(found.sounds.length, 0);
  assert.equal(calls.length, 3);
});

test('sfx: save downloads the sound into the run and records where it came from', async () => {
  const dir = run();
  const asset = await saveSound(dir, 'sfx-uuid/1', { name: 'door-slam', http: fakeLibrary([]), env: ENV });

  assert.equal(asset.path, 'assets/door-slam.mp3');
  assert.equal(readFileSync(join(dir, asset.path), 'utf8'), 'MP3BYTES');
  const [recorded] = readManifest(dir).assets;
  assert.equal(recorded.kind, 'sfx');
  assert.equal(recorded.provider, 'library');
  assert.equal(recorded.cost, 0);
  assert.equal(recorded.meta?.libraryId, 'sfx-uuid/1');
  assert.equal(recorded.meta?.sourceUrl, 'https://cdn.example/sfx-uuid/1.mp3', 'the signed query is not kept');
  assert.deepEqual([...savedSounds(dir)], [['sfx-uuid/1', 'assets/door-slam.mp3']]);
});

test('sfx: save names the file from the id when not given a name', async () => {
  const asset = await saveSound(run(), 'e3f1:9a', { http: fakeLibrary([]), env: ENV });
  assert.equal(asset.path, 'assets/sfx-e3f1-9a.mp3');
});

test('sfx: save refuses a name that would leave assets/', async () => {
  await assert.rejects(saveSound(run(), 'a', { name: '../x', http: fakeLibrary([]), env: ENV }), /invalid --as/);
});

test('sfx: the library\'s own words come back when it cannot answer', async () => {
  await assert.rejects(saveSound(run(), 'gone', { http: fakeLibrary([]), env: ENV }), /no sound with that id/);
});

test('sfx: with no library in the environment, the command says so and points at fal', () => {
  assert.throws(() => libraryBase({}), /OPEN_EDIT_LIBRARY_URL is not set\. Generate the sound with fal instead\./);
  assert.equal(libraryBase(ENV), 'http://127.0.0.1:3131');
});
