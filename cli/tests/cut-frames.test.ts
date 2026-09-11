import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneMetadata, mergeAdjacent, tileTimes, type Cut } from '../src/commands/cut-frames.ts';

/** ffmpeg's metadata printer emits the time and the score on separate lines, in that order. */
function metaLines(pairs: [number, number][]): string {
  return pairs
    .map(([t, s]) => `frame:0    pts:0       pts_time:${t}\nlavfi.scene_score=${s}`)
    .join('\n');
}

test('the scene printer is read as time/score pairs, in time order', () => {
  const cuts = parseSceneMetadata(metaLines([[5.29, 0.31], [1.83, 0.24], [8.58, 0.19]]));
  assert.deepEqual(cuts.map((c) => c.tSec), [1.83, 5.29, 8.58]);
  assert.deepEqual(cuts.map((c) => c.score), [0.24, 0.31, 0.19]);
});

test('a score with no time before it is not a cut', () => {
  // The failure mode of this parse is returning [], which the tool reports as "0 cuts" — a silent
  // success on a video full of cuts.
  assert.deepEqual(parseSceneMetadata('lavfi.scene_score=0.9\nnothing here'), []);
  assert.deepEqual(parseSceneMetadata(''), []);
  assert.equal(parseSceneMetadata(metaLines([[3, 0.5]])).length, 1);
});

test('detections within two frames are one cut, and the strongest of the run wins', () => {
  const dissolve: Cut[] = [
    { tSec: 10.000, score: 0.20 },
    { tSec: 10.042, score: 0.35 },
    { tSec: 10.083, score: 0.28 },
    { tSec: 10.125, score: 0.31 },
    { tSec: 11.000, score: 0.22 },
  ];
  const merged = mergeAdjacent(dissolve, 24);
  assert.equal(merged.length, 2, 'a dissolve scoring on four consecutive frames is one cut');
  assert.equal(merged[0].tSec, 10.000, 'the merged cut keeps the first detection time');
  assert.equal(merged[0].score, 0.35, 'and the strongest score in the run');
  assert.equal(merged[1].tSec, 11.000);
});

test('a cut clear of the window is its own cut', () => {
  const fps = 24;
  assert.equal(mergeAdjacent([{ tSec: 1, score: 0.3 }, { tSec: 1 + 3 / fps, score: 0.3 }], fps).length, 2);
  assert.equal(mergeAdjacent([{ tSec: 1, score: 0.3 }, { tSec: 1 + 1 / fps, score: 0.3 }], fps).length, 1);
});

test('the tiles are the frame before the cut and the frames after it', () => {
  const t = tileTimes({ tSec: 10, score: 0.3 }, 25, 30, 3);
  assert.deepEqual(t.map((x) => Number(x.toFixed(3))), [9.98, 10.02, 10.06, 10.1]);
});

test('tiles are clamped to the clip, at both ends', () => {
  // A cut at the very start has no frame before it; one at the very end has nothing after it. Both
  // used to reach ffmpeg regardless — a seek past the stream exits 0 and writes no file, and the
  // sheet was then stacked from however many tiles happened to exist.
  assert.deepEqual(tileTimes({ tSec: 0, score: 0.3 }, 25, 30, 3).map((x) => Number(x.toFixed(3))), [0.02, 0.06, 0.1]);
  assert.equal(tileTimes({ tSec: 29.99, score: 0.3 }, 25, 30, 3).length, 1, 'only the before-frame survives at the end');
  assert.deepEqual(tileTimes({ tSec: 5, score: 0.3 }, 25, 30, 0), [4.98], '--after 0 is just the before-frame');
});

test('a run of detections is capped, so a strobe does not swallow every cut in it', () => {
  // Sliding the window alone is transitively closed: 60 detections one frame apart collapsed to a
  // single cut spanning two seconds, and every real boundary inside it went unreported.
  const fps = 30;
  const strobe = Array.from({ length: 60 }, (_, i) => ({ tSec: 10 + i / fps, score: 0.3 + (i % 7) / 100 }));
  const merged = mergeAdjacent(strobe, fps);
  assert.ok(merged.length >= 3, `a 2-second run collapsed to ${merged.length} cut(s)`);
  // A genuine dissolve is still one cut.
  const dissolve = Array.from({ length: 4 }, (_, i) => ({ tSec: 20 + i / fps, score: 0.2 + i / 100 }));
  assert.equal(mergeAdjacent(dissolve, fps).length, 1);
});

test('the run cap is the same edit at every frame rate', () => {
  // Counted in frames, one half-second dissolve came back as one cut at 24 fps and three at 60.
  const counts = [24, 25, 30, 50, 60].map((fps) => {
    const n = Math.round(0.5 * fps);
    const dissolve = Array.from({ length: n }, (_, i) => ({ tSec: 5 + i / fps, score: 0.2 + (i % 5) / 100 }));
    return mergeAdjacent(dissolve, fps).length;
  });
  assert.deepEqual(counts, [1, 1, 1, 1, 1], `one dissolve, one cut, at every rate — got ${counts}`);
});
