// Tests src/commands/retime-transcript.ts. Everything here is arithmetic over plain data, so it is
// asserted directly with no ffmpeg and no filesystem. The case that matters most is the last one: a
// retimed transcript that disagrees with the assembled file by a few frames sends every caption
// drifting, and the drift grows with each cut rather than announcing itself.
//   Run:  node --import tsx tests/retime-transcript.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeRange, regroup, retime, retimeTranscript } from '../src/commands/retime-transcript.ts';
import type { Edl, EdlRange, SnappedRange } from '../src/edl.ts';
import type { Transcript } from '../src/prep/transcript-types.ts';
import { TESTSRC, captureConsole, scratchDir, synthClip, withRoot } from './helpers/synth.ts';

const words = (...spec: [string, number, number][]) =>
  spec.map(([text, a, b]) => ({ text, timestamp: [a, b] as [number, number] }));

const chunk = (text: string, a: number, b: number, ws: [string, number, number][]) => ({
  text, timestamp: [a, b] as [number, number], words: words(...ws),
});

const transcript = (...chunks: ReturnType<typeof chunk>[]): Transcript => ({
  text: chunks.map((c) => c.text).join(' '), chunks,
});

/** The ranges tagged as the command would tag them; retime never re-snaps, so these need not sit on the grid. */
const snapped = (ranges: EdlRange[]): SnappedRange[] => ranges.map((r) => ({ ...r, fps: 25 }));

const one = transcript(
  chunk('one two three', 0, 3, [['one', 0, 1], ['two', 1, 2], ['three', 2, 3]]),
  chunk('four five', 4, 6, [['four', 4, 5], ['five', 5, 6]]),
);

await test('a kept range is moved to its place on the output timeline', () => {
  const placed = placeRange(one, { source: 'a', start: 1, end: 3 }, 10, 0);
  assert.deepEqual(placed.map((p) => p.word), words(['two', 10, 11], ['three', 11, 12]));
});

await test('a word is kept when MOST of it survives the cut, and dropped when it does not', () => {
  // 'two' spans 1-2. A range ending at 1.7 keeps 0.7 of it — most of the word, so it survives.
  const kept = placeRange(one, { source: 'a', start: 1, end: 1.7 }, 0, 0);
  assert.deepEqual(kept.map((p) => p.word.text), ['two']);
  // A range ending at 1.3 keeps 0.3 — a fragment whose caption would start before the sound.
  const dropped = placeRange(one, { source: 'a', start: 1, end: 1.3 }, 0, 0);
  assert.deepEqual(dropped.map((p) => p.word.text), []);
});

await test('a zero-length word is judged by whether its instant is inside, not by proportion', () => {
  const instant = transcript(chunk('x', 1, 1, [['x', 1, 1]]));
  assert.equal(placeRange(instant, { source: 'a', start: 0, end: 2 }, 0, 0).length, 1);
  assert.equal(placeRange(instant, { source: 'a', start: 2, end: 3 }, 0, 0).length, 0);
});

await test('one chunk cannot span a cut: the same source chunk split by two ranges yields two chunks', () => {
  const placed = [
    ...placeRange(one, { source: 'a', start: 0, end: 1 }, 0, 0),
    ...placeRange(one, { source: 'a', start: 2, end: 3 }, 1, 1),
  ];
  const chunks = regroup(placed);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.text), ['one', 'three']);
});

await test('separate source chunks stay separate even when the edit makes them adjacent', () => {
  const chunks = regroup(placeRange(one, { source: 'a', start: 0, end: 6 }, 0, 0));
  assert.deepEqual(chunks.map((c) => c.text), ['one two three', 'four five']);
});

await test('ranges play in the order written, not in the order they occur in the source', () => {
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [
      { source: 'a', start: 4, end: 6 },
      { source: 'a', start: 0, end: 2 },
    ],
  };
  const out = retime(snapped(edl.ranges), () => one);
  assert.deepEqual(out.chunks.map((c) => c.text), ['four five', 'one two']);
  assert.deepEqual(out.chunks[0].timestamp, [0, 2]);
  assert.deepEqual(out.chunks[1].timestamp, [2, 4]);
});

await test('a source used by several ranges is loaded once', () => {
  let loads = 0;
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [
      { source: 'a', start: 0, end: 1 },
      { source: 'a', start: 2, end: 3 },
      { source: 'a', start: 4, end: 5 },
    ],
  };
  retime(snapped(edl.ranges), () => { loads += 1; return one; });
  assert.equal(loads, 1);
});

await test('a range that does not run forwards is refused by name rather than silently reversed', () => {
  const edl: Edl = { sources: { a: 'a.mov' }, ranges: [{ source: 'a', start: 3, end: 1 }] };
  assert.throws(() => retime(snapped(edl.ranges), () => one), /range 0 of "a" ends at 1/);
});

await test('an EDL with no ranges is refused', () => {
  assert.throws(() => retime([], () => one), /no ranges/);
});

await test('the retimed timeline is exactly the sum of the ranges — apply-edl assembles to the same length', () => {
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [
      { source: 'a', start: 0.5, end: 2.5 },
      { source: 'a', start: 4.25, end: 5.75 },
    ],
  };
  const out = retime(snapped(edl.ranges), () => transcript(
    chunk('a b c', 0, 3, [['a', 0.5, 1.5], ['b', 1.5, 2.5], ['c', 2.5, 3]]),
    chunk('d e', 4, 6, [['d', 4.25, 5], ['e', 5, 5.75]]),
  ));
  const sumOfRanges = (2.5 - 0.5) + (5.75 - 4.25);
  const last = out.chunks[out.chunks.length - 1];
  assert.equal(last.timestamp[1], sumOfRanges);
});

await test('a zero-length word on a shared boundary belongs to ONE range, not both', () => {
  // The contract is half-open: a zero-length token exactly on a cut is in the range that starts there.
  const t = transcript(chunk('before x after', 0, 9, [['before', 1, 2], ['x', 5, 5], ['after', 6, 7]]));
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [{ source: 'a', start: 0, end: 5 }, { source: 'a', start: 5, end: 9 }],
  };
  const texts = retime(snapped(edl.ranges), () => t).chunks.flatMap((c) => c.words).map((w) => w.text);
  assert.deepEqual(texts.filter((w) => w === 'x').length, 1, 'a closed upper bound emitted it twice');
  assert.deepEqual(texts, ['before', 'x', 'after']);
});

await test('an edit that keeps no words ANYWHERE is refused — it is nearly always a unit mistake', () => {
  // Milliseconds where seconds were meant. Writing an empty transcript and exiting 0 hands the caption
  // run a file that reports success and contains nothing.
  const edl: Edl = { sources: { a: 'a.mov' }, ranges: [{ source: 'a', start: 1000, end: 3000 }] };
  assert.throws(() => retime(snapped(edl.ranges), () => one), /no range in this EDL kept a single word.*SECONDS/s);
});

await test('ONE silent range is a valid edit — b-roll, a held title, a pause', () => {
  // apply-edl assembles such a range happily; refusing it here would make the two tools disagree about
  // what a valid EDL is, on the same file, in the same flow.
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [{ source: 'a', start: 0, end: 2 }, { source: 'a', start: 20, end: 24 }],
  };
  const out = retime(snapped(edl.ranges), () => one);
  assert.deepEqual(out.chunks.flatMap((c) => c.words).map((w) => w.text), ['one', 'two']);
});

await test('a negative start is refused rather than silently meaning "the whole clip"', () => {
  const edl: Edl = { sources: { a: 'a.mov' }, ranges: [{ source: 'a', start: -1, end: 2 }] };
  assert.throws(() => retime(snapped(edl.ranges), () => one), /before the file begins/);
});

await test('words lost to a cut edge are counted, never just missing', () => {
  // "two" spans 10-12 and is split exactly in half by adjacent ranges, so it survives neither.
  const t = transcript(chunk('one two three', 9, 13, [['one', 9, 10], ['two', 10, 12], ['three', 12, 13]]));
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [{ source: 'a', start: 9, end: 11 }, { source: 'a', start: 11, end: 13 }],
  };
  const out = retime(snapped(edl.ranges), () => t);
  assert.deepEqual(out.chunks.flatMap((c) => c.words).map((w) => w.text), ['one', 'three']);
  // ONE word was lost. Counting per range would offer it to both and report two.
  assert.equal(out.droppedAtEdges, 1);
});

await test('a kept zero-length word does not drive the reported loss below zero', () => {
  const t = transcript(chunk('a x b', 0, 9, [['a', 1, 2], ['x', 5, 5], ['b', 6, 7]]));
  const edl: Edl = { sources: { a: 'a.mov' }, ranges: [{ source: 'a', start: 0, end: 9 }] };
  assert.equal(retime(snapped(edl.ranges), () => t).droppedAtEdges, 0);
});

await test('words with IDENTICAL windows are counted one each, so a dropped neighbour is not hidden', () => {
  // The whisper mapper spreads untimed tokens over zero-length windows that can coincide; keyed by
  // window they collapsed into one, and a word genuinely lost at an edge then reported as zero.
  const t = transcript(chunk('a b c d', 0, 9, [['a', 1, 1], ['b', 1, 1], ['c', 2, 4], ['d', 5, 6]]));
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [{ source: 'a', start: 0, end: 3 }, { source: 'a', start: 3, end: 9 }],
  };
  const out = retime(snapped(edl.ranges), () => t);
  assert.deepEqual(out.chunks.flatMap((c) => c.words).map((w) => w.text), ['a', 'b', 'd']);
  assert.equal(out.droppedAtEdges, 1, '"c" was split in half and lost; "a" and "b" must not mask it');
});

await test('a repeated take places the same words twice and loses nothing', () => {
  const edl: Edl = {
    sources: { a: 'a.mov' },
    ranges: [{ source: 'a', start: 0, end: 3 }, { source: 'a', start: 0, end: 3 }],
  };
  const out = retime(snapped(edl.ranges), () => one);
  assert.deepEqual(out.chunks.map((c) => c.text), ['one two three', 'one two three']);
  assert.equal(out.droppedAtEdges, 0);
});

// --- the command: where the transcript is looked for, and the grid it is cut on -------------------

const dir = scratchDir('retime');
const clip = synthClip(dir, 'a.mp4', { video: TESTSRC, seconds: 3 });

const seed = (root: string, key: string, t: Transcript) => {
  mkdirSync(join(root, 'runs', key), { recursive: true });
  writeFileSync(join(root, 'runs', key, 'transcript.json'), JSON.stringify(t));
};
const runCommand = (root: string, edl: unknown, name: string) => {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify(edl));
  const out = join(root, `${name}.out.json`);
  const { err } = captureConsole(() => retimeTranscript(['--edl', path, '--out', out]));
  return { out, err };
};

await test('without a transcripts map, each source\'s transcript is read from where transcribe wrote it', async () => {
  const root = join(dir, 'root-default');
  mkdirSync(root, { recursive: true });
  seed(root, 'a', transcript(chunk('x y', 0, 1, [['x', 0.5, 0.8], ['y', 0.8, 0.9]])));
  await withRoot(root, () => {
    // 0.013 snaps up to 0.04 on the 25fps grid, so every word moves by 0.04, not 0.013.
    const { out } = runCommand(root, { sources: { a: clip }, ranges: [{ source: 'a', start: 0.013, end: 0.9 }] }, 'edl');
    const result = JSON.parse(readFileSync(out, 'utf8')) as Transcript;
    const x = result.chunks[0].words[0].timestamp;
    assert.ok(Math.abs(x[0] - 0.46) < 1e-9 && Math.abs(x[1] - 0.76) < 1e-9, `x landed at ${x}`);
  });
});

await test('two ids for ONE file share its transcript without complaint', async () => {
  const root = join(dir, 'root-same-file');
  mkdirSync(root, { recursive: true });
  seed(root, 'a', transcript(chunk('x y', 0, 1, [['x', 0.04, 0.4], ['y', 0.4, 0.8]])));
  await withRoot(root, () => {
    const { out } = runCommand(root, { sources: { intro: clip, outro: clip }, ranges: [{ source: 'intro', start: 0, end: 1 }, { source: 'outro', start: 0, end: 1 }] }, 'same');
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).chunks.length, 2);
  });
});

await test('a chunk whose words are listed out of order still gets a window that holds them all', () => {
  const t = transcript(chunk('b a', 0, 2, [['b', 1, 2], ['a', 0, 1]]));
  const out = retime(snapped([{ source: 'a', start: 0, end: 2 }]), () => t);
  assert.deepEqual(out.chunks[0].timestamp, [0, 2]);
});

await test('two sources with one basename cannot share the default transcript', async () => {
  const root = join(dir, 'root-collide');
  mkdirSync(join(root, 'take2'), { recursive: true });
  const twin = synthClip(join(root, 'take2'), 'a.mp4', { video: TESTSRC, seconds: 1 });
  await withRoot(root, () => {
    assert.throws(
      () => runCommand(root, { sources: { x: clip, y: twin }, ranges: [{ source: 'x', start: 0, end: 1 }, { source: 'y', start: 0, end: 1 }] }, 'collide'),
      /share the run key "a".*"transcripts" map/,
    );
  });
});

await test('a missing transcript and a file that is not one are named, with the source id', async () => {
  const root = join(dir, 'root-missing');
  mkdirSync(root, { recursive: true });
  await withRoot(root, () => {
    assert.throws(
      () => runCommand(root, { sources: { a: clip }, ranges: [{ source: 'a', start: 0, end: 1 }] }, 'missing'),
      /no transcript for source "a" at .*runs[\\/]a[\\/]transcript\.json/,
    );
    writeFileSync(join(root, 'not-a-transcript.json'), JSON.stringify({ text: 'hello' }));
    assert.throws(
      () => runCommand(root, { sources: { a: clip }, transcripts: { a: 'not-a-transcript.json' }, ranges: [{ source: 'a', start: 0, end: 1 }] }, 'shape'),
      /transcript for source "a": .*is not a transcript\.json/,
    );
    writeFileSync(join(root, 'bad-word.json'), JSON.stringify({ text: 'x', chunks: [{ text: 'x', timestamp: [0, 1], words: [{ text: 'x' }] }] }));
    assert.throws(
      () => runCommand(root, { sources: { a: clip }, transcripts: { a: 'bad-word.json' }, ranges: [{ source: 'a', start: 0, end: 1 }] }, 'word'),
      /every word needs text and a \[start, end\] timestamp/,
    );
  });
});

await test('words lost at a cut edge are reported on stderr, with the count', async () => {
  const root = join(dir, 'root-dropped');
  mkdirSync(root, { recursive: true });
  // The cut at 1.5 snaps to 1.52 on the 25fps grid; "two" is placed so that 1.52 splits it in half.
  seed(root, 'a', transcript(chunk('one two three', 0, 3, [['one', 0, 1], ['two', 1.04, 2], ['three', 2, 3]])));
  await withRoot(root, () => {
    const { err } = runCommand(root, { sources: { a: clip }, ranges: [{ source: 'a', start: 0, end: 1.5 }, { source: 'a', start: 1.5, end: 3 }] }, 'edge');
    assert.match(err, /1 word\(s\) sat across a cut edge/);
  });
});
