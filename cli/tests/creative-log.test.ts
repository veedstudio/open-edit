import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Point the module at a scratch log BEFORE importing it: it resolves the path once, at load.
const LOG = join(mkdtempSync(join(tmpdir(), 'creative-log-')), 'log.json');
process.env.OPEN_EDIT_CREATIVE_LOG = LOG;
const { reject, accept, logFor, briefFor } = await import('../src/commands/creative-log.ts');

const CLIP = '/tmp/creative-log-test/makeup-EN.mp4';

beforeEach(() => {
  if (existsSync(LOG)) rmSync(LOG);
});

test('creative-log: rejections accumulate against the footage, not the run', () => {
  reject(CLIP, 'pixel-arcade Press Start 2P with an orange extruded echo trail', 'it read as a game, not a campaign');
  reject(CLIP, 'a cream slab rotated -3deg with skewed hazard bars', 'the skew never rendered and the slab fought the room');
  const log = logFor(CLIP);
  assert.equal(log.rejected.length, 2);
  assert.equal(log.source, resolve(CLIP));
});

test('creative-log: the same attempt recorded twice stays one attempt', () => {
  reject(CLIP, 'straight bar arrows', 'every variant used the same one');
  reject(CLIP, 'straight bar arrows', 'every variant used the same one');
  assert.equal(logFor(CLIP).rejected.length, 1);
});

test('creative-log: a later acceptance replaces the earlier one, rejections survive', () => {
  reject(CLIP, 'plain HUD lower-thirds', 'no copy to illustrate');
  accept(CLIP, 'KISS-CUT — die-cut vinyl over the studio', 'colours worked with the room instead of fighting it');
  accept(CLIP, 'ARC CROWN — curved display type over the head', 'the type choice carried it and nothing was outlined');
  const log = logFor(CLIP);
  assert.equal(log.accepted?.what, 'ARC CROWN — curved display type over the head');
  assert.equal(log.rejected.length, 1, 'accepting something does not clear what was rejected');
});

test('creative-log: a first round carries no ceremony', () => {
  assert.equal(briefFor('/tmp/creative-log-test/never-touched.mp4'), '');
});

test('creative-log: the brief names the bar and the exclusions, with reasons', () => {
  reject(CLIP, 'tick-ring stopwatch inset', 'read as chrome with nothing to say');
  accept(CLIP, 'KISS-CUT — die-cut vinyl over the studio', 'graphic, bright, punchy, and the typefaces were interestingly chosen');
  const text = briefFor(CLIP);
  assert.match(text, /WHAT THE CLIENT ACCEPTED/);
  assert.match(text, /graphic, bright, punchy/);
  assert.match(text, /ALREADY TRIED ON THIS FOOTAGE AND REJECTED/);
  assert.match(text, /tick-ring stopwatch inset — rejected because read as chrome/);
});

test('creative-log: a corrupt log reads as empty but is never written over', () => {
  reject(CLIP, 'first look', 'too early');
  writeFileSync(LOG, '{ not json');
  assert.deepEqual(logFor(CLIP).rejected, [], 'reading through it is fine — history is a helper, not a gate');

  // Writing through it is not: the empty fallback would erase every clip's history. The bytes are
  // kept aside and a fresh log starts.
  reject(CLIP, 'second look', 'still wrong');
  const kept = LOG.replace(/\.json$/, '.corrupt.json');
  assert.ok(existsSync(kept), 'the unreadable file is preserved, not deleted');
  assert.equal(readFileSync(kept, 'utf8'), '{ not json');
  assert.deepEqual(logFor(CLIP).rejected.map((r) => r.what), ['second look']);
});
