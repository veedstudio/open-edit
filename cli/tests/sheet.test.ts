import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { assertTile, tilePath, tileSheet, withTileDir } from '../src/sheet.ts';

test('assertTile: a tile ffmpeg never wrote, or wrote empty, is refused by name', () => {
  withTileDir((dir) => {
    assert.throws(() => assertTile(tilePath(dir, 0), 't=9s of clip.mp4'), /no frame came out for t=9s of clip\.mp4/);
    writeFileSync(tilePath(dir, 0), '');
    assert.throws(() => assertTile(tilePath(dir, 0), 'tile 1'), /no frame came out/);
    writeFileSync(tilePath(dir, 0), 'png');
    assert.doesNotThrow(() => assertTile(tilePath(dir, 0), 'tile 1'));
  });
});

test('withTileDir: the scratch directory is gone afterwards, whether the work returned or threw', () => {
  let seen = '';
  assert.equal(withTileDir((dir) => { seen = dir; return existsSync(dir); }), true);
  assert.equal(existsSync(seen), false);
  assert.throws(() => withTileDir((dir) => { seen = dir; throw new Error('a seek past the last frame'); }), /past the last frame/);
  assert.equal(existsSync(seen), false);
});

test('tileSheet: a sequence with a hole in it is refused before ffmpeg is asked to tile it', () => {
  withTileDir((dir) => {
    writeFileSync(tilePath(dir, 0), 'png');
    assert.throws(() => tileSheet(dir, 2, 2, `${dir}/sheet.jpg`), /no frame came out for tile 2/);
    assert.throws(() => tileSheet(dir, 0, 2, `${dir}/sheet.jpg`), /nothing to tile/);
  });
});
