// The one cache of seekable copies every render shares: found by the bytes of the source, never its name or the
// render's output; made again when those bytes change; kept within its size by removing the copies used longest
// ago; and left whole when several processes make the same copy at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../src/config.ts';
import { countFrames } from '../src/render/encode.ts';
import { boundCache, contentId, longestGop, seekableCopy } from '../src/render/media.ts';
import { scratchDir } from './helpers/synth.ts';

const copyChild = fileURLToPath(new URL('./helpers/copy-child.ts', import.meta.url));
const COPY = /^[0-9a-f]{20}\.(mp4|webm)$/;
const copiesIn = (dir: string) => readdirSync(dir).filter((n) => COPY.test(n)).sort();

/** A clip `seconds` long with keyframes `gop` frames apart, its picture a test pattern of `pattern`. */
function clip(file: string, o: { size?: string; seconds?: number; gop?: number; pattern?: string } = {}): string {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${o.pattern ?? 'testsrc'}=s=${o.size ?? '320x180'}:r=30:d=${o.seconds ?? 2}`,
    '-c:v', 'libx264', '-g', String(o.gop ?? 60), '-pix_fmt', 'yuv420p', file]);
  return file;
}

test('media cache: the same bytes under another name and folder find the copy made first, and changed bytes make a new one', async () => {
  const dir = scratchDir('media-cache-content');
  const cache = join(dir, 'cache');
  mkdirSync(join(dir, 'a'));
  mkdirSync(join(dir, 'b'));
  const first = clip(join(dir, 'a', 'clip.mp4'));
  const moved = join(dir, 'b', 'renamed.mp4');
  copyFileSync(first, moved);

  const made = await seekableCopy(first, cache);
  assert.equal(made.made, true);
  assert.equal(longestGop(made.path), 1, 'every frame of the copy a keyframe');
  assert.equal(countFrames(made.path), 60);
  const inode = statSync(made.path).ino;
  const again = await seekableCopy(moved, cache);
  assert.deepEqual({ path: again.path, made: again.made }, { path: made.path, made: false }, 'a copy of the file under another name is the same source');
  assert.equal(statSync(again.path).ino, inode, 'and its copy was not made again');

  // Touched, not changed: its bytes are what they were, so its copy is too.
  const later = new Date(Date.now() + 5000);
  utimesSync(moved, later, later);
  assert.equal((await seekableCopy(moved, cache)).made, false);

  // The same size and name, other bytes.
  clip(first, { pattern: 'smptebars' });
  const changed = await seekableCopy(first, cache);
  assert.equal(changed.made, true);
  assert.notEqual(changed.path, made.path);
  assert.deepEqual(copiesIn(cache).length, 2);
  assert.equal(changed.cache?.copies, 2, 'the render that made it says what the cache holds');
  assert.equal(changed.cache?.bytes, statSync(made.path).size + statSync(changed.path).size);
});

test('media cache: a file is read for its content once per version of it, not on every render', () => {
  const dir = scratchDir('media-cache-version');
  const file = clip(join(dir, 'clip.mp4'), { seconds: 1 });
  const cache = join(dir, 'cache');
  const id = contentId(file, cache);
  assert.match(id, /^[0-9a-f]{64}$/);
  const memos = readdirSync(join(cache, 'versions'));
  assert.equal(memos.length, 1);
  // What is remembered for this version is what is returned, so the file is not read again.
  writeFileSync(join(cache, 'versions', memos[0]), 'f'.repeat(64));
  assert.equal(contentId(file, cache), 'f'.repeat(64));
  // A new version of the same file is read again.
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  assert.equal(contentId(file, cache), id);
  assert.equal(readdirSync(join(cache, 'versions')).length, 2);
});

test('media cache: room is made by removing the copies used longest ago, never one in use, one just made, or anything not a copy', () => {
  const dir = scratchDir('media-cache-bound');
  const hour = 3600 * 1000;
  const at = (name: string, bytes: number, ago: number) => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.alloc(bytes));
    const when = new Date(Date.now() - ago);
    utimesSync(path, when, when);
    return path;
  };
  at(`${'1'.repeat(20)}.mp4`, 1000, 72 * hour);
  at(`${'2'.repeat(20)}.webm`, 1000, 48 * hour);
  const recent = at(`${'3'.repeat(20)}.mp4`, 1000, hour);
  const fresh = at(`${'4'.repeat(20)}.mp4`, 1000, 0);
  const theirs = at('notes.mp4', 5000, 96 * hour);
  const deadTmp = at(`${'5'.repeat(20)}.mp4.123-abcdef.tmp`, 10, 48 * hour);
  const liveTmp = at(`${'6'.repeat(20)}.mp4.456-abcdef.tmp`, 10, 0);
  mkdirSync(join(dir, 'versions'));
  at(join('versions', 'a'.repeat(40)), 64, 48 * hour);
  const liveMemo = at(join('versions', 'b'.repeat(40)), 64, 0);

  const first = boundCache(dir, [], 2500, 24 * hour);
  assert.deepEqual(first, { dir, copies: 2, bytes: 2000, removed: 2, freed: 2000 }, 'the two used longest ago go, and no more than it takes');
  assert.deepEqual(copiesIn(dir), [recent, fresh].map((p) => p.slice(dir.length + 1)));
  // Over any size, a copy used within the lease stays: a render still running may be serving it.
  assert.deepEqual(boundCache(dir, [], 0, 24 * hour), { dir, copies: 2, bytes: 2000, removed: 0, freed: 0 });
  const remaining = new Set(readdirSync(dir));
  for (const kept of [theirs, liveTmp]) assert.ok(remaining.has(kept.slice(dir.length + 1)), `${kept} is not the cache's to remove`);
  assert.ok(!remaining.has(deadTmp.slice(dir.length + 1)), 'a half-written copy a dead render left is removed');
  assert.deepEqual(readdirSync(join(dir, 'versions')), [liveMemo.slice(join(dir, 'versions').length + 1)], 'and a remembered content id past the lease');

  // One a render has just made stays even when it is the oldest there.
  const kept = at(`${'7'.repeat(20)}.mp4`, 1000, 72 * hour);
  assert.equal(boundCache(dir, [kept], 0, 24 * hour).removed, 0);
  assert.equal(boundCache(dir, [], 0, 24 * hour).removed, 1);
});

test('media cache: processes making the same copy at once leave one whole copy and nothing half-written', async () => {
  const dir = scratchDir('media-cache-race');
  const cache = join(dir, 'cache');
  const source = clip(join(dir, 'clip.mp4'), { size: '640x360', seconds: 6, gop: 90 });
  // The same bytes under four names, so the four processes share one copy only if the cache keys by content.
  const files = [0, 1, 2, 3].map((i) => {
    const f = join(dir, `clip-${i}.mp4`);
    copyFileSync(source, f);
    return f;
  });
  const startAt = Date.now() + 4000;
  const results = await Promise.all(files.map((file, i) => new Promise<{ path: string; made: boolean }>((done, fail) => {
    const p = spawn(process.execPath, ['--import', 'tsx', copyChild, file, cache, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`process ${i} exited ${code}: ${err}`))));
  })));
  assert.equal(new Set(results.map((r) => r.path)).size, 1, 'every process was given the same copy');
  assert.ok(results.filter((r) => r.made).length >= 2, `the copies were made at the same time (${results.filter((r) => r.made).length} made), so the race was run`);
  assert.deepEqual(readdirSync(cache).filter((n) => n !== 'versions'), [results[0].path.slice(cache.length + 1)], 'one copy, and no half-written one beside it');
  assert.equal(longestGop(results[0].path), 1);
  assert.equal(countFrames(results[0].path), 180, 'the copy is whole');
  assert.equal(readdirSync(join(cache, 'versions')).filter((n) => n.endsWith('.tmp')).length, 0);
});
