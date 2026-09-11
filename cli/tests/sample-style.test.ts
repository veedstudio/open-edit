import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHEET_THRESHOLD, candidatesFor, energyOf, mulberry32, readStylePick, sampleStyle, seedFromKey, transcriptStats,
} from '../src/commands/sample-style.ts';

const repoRoot = join(import.meta.dirname, '..', '..');
// sampleStyle anchors to the workspace root the way real runs do: through OPEN_EDIT_ROOT.
process.env.OPEN_EDIT_ROOT = repoRoot;

// Moved from the repository's cli-entry suite with the entry points: the mistake that started the
// strict parser was a flag accepted and ignored, so the CLI dispatch must refuse it too.
test('sample-style and generate-recipe reject unknown flags, naming the valid ones', async () => {
  const { execFile } = await import('node:child_process');
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (args: string[]) => new Promise<{ code: number; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, ...args], { encoding: 'utf8' },
      (error, _out, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, err: stderr }));
  });

  const style = await run(['sample-style', '--run', 'x', '--stile', 'karaoke']);
  assert.equal(style.code, 1);
  assert.match(style.err, /Unknown option '--stile'/);
  assert.match(style.err, /Valid flags: --exclude --recipes-only --run --seed --style/);

  const recipe = await run(['generate-recipe', '--run', 'x', '--style', 'karaoke']);
  assert.equal(recipe.code, 1);
  assert.match(recipe.err, /Unknown option '--style'/);
  assert.match(recipe.err, /--module/, 'the message has to name what IS valid, or the next guess is blind too');
});

test('seedFromKey is deterministic and key-sensitive', () => {
  assert.equal(seedFromKey('monday-test-video'), seedFromKey('monday-test-video'));
  assert.notEqual(seedFromKey('monday-test-video'), seedFromKey('tuesday-test-video'));
});

test('mulberry32 is a deterministic stream in [0,1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 5; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('transcriptStats + energyOf: dense caps-heavy speech reads high, slow speech reads low', () => {
  const hype = transcriptStats([{
    text: 'STOP SCROLLING NOW really',
    timestamp: [0, 1.2],
    words: [
      { text: 'STOP', timestamp: [0, 0.3] }, { text: 'SCROLLING', timestamp: [0.3, 0.6] },
      { text: 'NOW', timestamp: [0.6, 0.9] }, { text: 'really', timestamp: [0.9, 1.2] },
    ],
  }]);
  assert.equal(energyOf(hype), 'high');
  const calm = transcriptStats([{
    text: 'breathe in and out',
    timestamp: [0, 4],
    words: [
      { text: 'breathe', timestamp: [0, 1] }, { text: 'in', timestamp: [1, 2] },
      { text: 'and', timestamp: [2, 3] }, { text: 'out', timestamp: [3, 4] },
    ],
  }]);
  assert.equal(energyOf(calm), 'low');
  assert.equal(energyOf(transcriptStats([])), 'mid');
});

// Against the real pool: candidates are stable-ordered, aspect-true per the curated `fit` facet, and
// fully recipe-backed (the 28-ref pool is 100% compiled — the index integrity check guarantees it).
test('candidatesFor: pools are non-empty, sorted, fit-true, and recipes-only', () => {
  for (const aspect of ['9:16', '16:9'] as const) {
    const c = candidatesFor(repoRoot, aspect);
    assert.ok(c.length > 0, `${aspect} refs exist`);
    assert.deepEqual(c.map((x) => x.id), [...c.map((x) => x.id)].sort((a, b) => a.localeCompare(b)));
    assert.ok(c.every((x) => x.facets.fit.includes(aspect)));
    assert.ok(c.every((x) => x.hasRecipe), 'every index entry has a compiled recipe');
  }
  // The verify-occlusion engine bug was fixed in engine 0.6.0 — scattered-kinetic refs are back in the draw.
  const ids = new Set(candidatesFor(repoRoot, '9:16').map((x) => x.id));
  assert.ok(ids.has('hook-015 (0-00-14-06)'), 'no draw-exclusions remain since the 0.6.0 fix');
});

function runDirWith(meta: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sample-style-'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

test('portrait: hard filter is ON — the seeded pick always ships a recipe; reproducible per key', () => {
  const sheets = candidatesFor(repoRoot, '9:16').filter((c) => c.hasRecipe);
  assert.ok(sheets.length >= SHEET_THRESHOLD, `portrait coverage ${sheets.length} >= ${SHEET_THRESHOLD}`);
  const dir = runDirWith({ key: 'video1', width: 736, height: 1312 });
  const a = sampleStyle(dir);
  const b = sampleStyle(dir);
  assert.equal(a.refId, b.refId, 'same key → same pick');
  assert.equal(a.hasRecipe, true, 'default portrait draw never leaves the recipe pool');
  assert.equal(a.coverage.filtered, true);
  assert.equal(a.coverage.aspect, '9:16');
});

test('landscape: coverage clears the threshold — hard filter is ON for 16:9 too', () => {
  const sheets = candidatesFor(repoRoot, '16:9').filter((c) => c.hasRecipe);
  assert.ok(sheets.length >= SHEET_THRESHOLD, `landscape coverage ${sheets.length} >= ${SHEET_THRESHOLD}`);
  const dir = runDirWith({ key: 'landscape-demo', width: 1280, height: 720 });
  const s = sampleStyle(dir);
  assert.equal(s.coverage.aspect, '16:9');
  assert.equal(s.coverage.filtered, true, 'hard filter engaged at >= threshold');
  assert.equal(s.hasRecipe, true, 'default landscape draw never leaves the recipe pool');
});

test('different seeds roll different styles (variety), same seed reproduces', () => {
  const dir = runDirWith({ key: 'variety-check', width: 736, height: 1312 });
  const picks = new Set([1, 2, 3, 4, 5, 6, 7].map((n) => sampleStyle(dir, { seed: n }).refId));
  assert.ok(picks.size >= 2, `7 seeds hit ${picks.size} distinct styles`);
  assert.equal(sampleStyle(dir, { seed: 3 }).refId, sampleStyle(dir, { seed: 3 }).refId);
});

test('alternates: 4 same-aspect recipe-backed ids, never the pick itself', () => {
  const dir = runDirWith({ key: 'alt-check', width: 736, height: 1312 });
  const s = sampleStyle(dir);
  assert.equal(s.alternates.length, 4);
  assert.ok(!s.alternates.includes(s.refId));
  const recipeIds = new Set(candidatesFor(repoRoot, '9:16').filter((c) => c.hasRecipe).map((c) => c.id));
  assert.ok(s.alternates.every((id) => recipeIds.has(id)), 'alternates come from validated recipes only');
});

test('--style forces an index candidate; an id outside the runtime index is rejected', () => {
  const withRecipe = candidatesFor(repoRoot, '9:16')[0];
  assert.ok(withRecipe, 'the portrait index is non-empty');
  const dir = runDirWith({ key: 'forced', width: 736, height: 1312 });
  const s = sampleStyle(dir, { style: withRecipe.id });
  assert.equal(s.refId, withRecipe.id);
  // ids outside the runtime index (a deleted HTML-era leftover and a never-existed id) — both rejected
  assert.throws(() => sampleStyle(dir, { style: 'hook-104-peak' }), /not a valid 9:16 candidate/);
  assert.throws(() => sampleStyle(dir, { style: 'hook-999-nope' }), /not a valid 9:16 candidate/);
});

test('--style rejects an id from the wrong aspect', () => {
  const land = candidatesFor(repoRoot, '16:9')[0];
  const dir = runDirWith({ key: 'wrong-aspect', width: 736, height: 1312 });
  assert.throws(() => sampleStyle(dir, { style: land.id }), /not a valid 9:16 candidate/);
});

test('transcript energy lands in style.json: hype reads high, slow reads low', () => {
  const mkDir = (text: string, words: Array<{ text: string; timestamp: [number, number] }>, span: [number, number]) => {
    const dir = runDirWith({ key: 'energy-check', width: 736, height: 1312 });
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ chunks: [{ text, timestamp: span, words }] }));
    return dir;
  };
  const hypeDir = mkDir('STOP SCROLLING NOW GO GO GO!', [
    { text: 'STOP', timestamp: [0, 0.2] }, { text: 'SCROLLING', timestamp: [0.2, 0.4] }, { text: 'NOW', timestamp: [0.4, 0.6] },
    { text: 'GO', timestamp: [0.6, 0.8] }, { text: 'GO', timestamp: [0.8, 1.0] }, { text: 'GO!', timestamp: [1.0, 1.2] },
  ], [0, 1.2]);
  assert.equal(sampleStyle(hypeDir).energy, 'high');
  const calmDir = mkDir('breathe in and out slowly', [
    { text: 'breathe', timestamp: [0, 1] }, { text: 'in', timestamp: [1, 2] }, { text: 'and', timestamp: [2, 3] },
    { text: 'out', timestamp: [3, 4] }, { text: 'slowly', timestamp: [4, 5] },
  ], [0, 5]);
  assert.equal(sampleStyle(calmDir).energy, 'low');
});

// readStylePick: the canonical style.json reader generate-recipe.ts routes on. Tolerant of missing
// fields; hasRecipe true ONLY on exact true (a legacy/malformed file must route from-scratch, never
// chase a nonexistent generator module).
test('readStylePick: reads back a written pick; hasRecipe defaults false; missing refId throws', () => {
  const dir = runDirWith({ key: 'roundtrip', width: 736, height: 1312 });
  const written = sampleStyle(dir);
  const back = readStylePick(dir);
  assert.equal(back.refId, written.refId);
  // STORED content-relative, READ back absolute: the run outlives the install that wrote it, and an
  // absolute path into node_modules stops being true at the next update.
  assert.ok(!isAbsolute(written.refPath), `stored refPath is relative: ${written.refPath}`);
  assert.equal(back.refPath, join(repoRoot, written.refPath));
  assert.equal(back.hasRecipe, true);
  assert.equal(back.seed, written.seed);

  const legacy = mkdtempSync(join(tmpdir(), 'style-legacy-'));
  writeFileSync(join(legacy, 'style.json'), JSON.stringify({ refId: written.refId, refPath: '/tmp/x.wv', seed: 'NaN' }));
  const tolerant = readStylePick(legacy);
  assert.equal(tolerant.hasRecipe, false, 'missing hasRecipe reads false');
  assert.equal(tolerant.seed, 0, 'malformed seed reads 0');

  const broken = mkdtempSync(join(tmpdir(), 'style-broken-'));
  writeFileSync(join(broken, 'style.json'), JSON.stringify({ seed: 1 }));
  assert.throws(() => readStylePick(broken), /missing refId\/refPath/);
});

// style.json is a file on disk whose refId becomes an import()ed module path. The reader owes the
// same index check --style gets on the way in — tolerance stops at fields, never at the id.
test('readStylePick: an refId outside the runtime index is rejected, traversal or not', () => {
  for (const bad of ['../../../../tmp/evil', 'hook-999-nope', 'hook-104-peak']) {
    const dir = mkdtempSync(join(tmpdir(), 'style-bad-id-'));
    writeFileSync(join(dir, 'style.json'), JSON.stringify({ refId: bad, refPath: '/tmp/x.wv', hasRecipe: true }));
    assert.throws(() => readStylePick(dir), /not in the runtime index/, `rejected: ${bad}`);
  }
});

test('sample-style: an excluded id is removed from the pool and from the alternates', () => {
  const run = runDirWith({ aspect: '9:16', width: 1080, height: 1920, fps: 30, durationSec: 6 });
  const first = sampleStyle(run);
  const second = sampleStyle(run, { exclude: [first.refId] });
  assert.notEqual(second.refId, first.refId, 'the same seed must not land on an excluded id');
  assert.equal(second.seed, first.seed, 'excluding changes the pool, not the seed');
  assert.ok(!second.alternates.includes(first.refId), 'an excluded id is not offered as an alternate either');
});

test('sample-style: excluding an id outside the runtime index is an error, not a silent no-op', () => {
  const run = runDirWith({ aspect: '9:16', width: 1080, height: 1920, fps: 30, durationSec: 6 });
  assert.throws(() => sampleStyle(run, { exclude: ['no-such-ref'] }), /outside the .* runtime index/);
});
