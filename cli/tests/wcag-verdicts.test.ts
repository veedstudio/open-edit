import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseElementClasses,
  resolveVerdicts,
  type ClusterStat,
  type ElementStat,
  type FrameStat,
  type Statistics,
} from '../src/wcag/verdicts.ts';
import type { Rgba, Srgb8 } from '../src/wcag/policy.ts';

const rgb = (r: number, g: number, b: number): Srgb8 => ({ r, g, b });
const WHITE = rgb(255, 255, 255);
const BLACK = rgb(0, 0, 0);
const Z3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

const cluster = (color: Srgb8, weight = 1.0): ClusterStat => ({ color, weight, covariance: Z3 });

const frame = (
  fg: Rgba, clusters: ClusterStat[], over: Partial<FrameStat> = {},
): FrameStat => ({
  frame: 0, fg, font_size: 16, font_weight: 400, unsampled: false, clusters, ...over,
});

const element = (id: string, frames: FrameStat[], over: Partial<ElementStat> = {}): ElementStat => ({
  id,
  rect: { x: 0, y: 0, w: 100, h: 20 },
  font_size: 16,
  font_weight: 400,
  steady_alpha: frames[0]?.fg.a ?? 1.0,
  fg: frames[0]?.fg ?? { ...BLACK, a: 1.0 },
  total_samples: 100,
  total_frames: frames.length,
  unscored_transient_frames: 0,
  sampled_transient_frames: 0,
  indeterminate: false,
  clusters: frames.flatMap((f) => f.clusters.map((c) => ({ ...c, frames: [f.frame] }))),
  frames,
  ...over,
});

const stats = (...elements: ElementStat[]): Statistics => ({
  version: 1, fps: 30, budget_overflow_frames: 0, elements,
});

const opaque = (c: Srgb8): Rgba => ({ ...c, a: 1.0 });

// ---------------------------------------------------------------------------
// parseElementClasses.
// ---------------------------------------------------------------------------

test('parseElementClasses: composite key is the SORTED dot-joined token set', () => {
  const m = parseElementClasses('<div id="a" class="w fade"></div><span id="b"></span>');
  assert.equal(m.get('a'), 'fade.w'); // sorted: fade < w
  assert.equal(m.get('b'), null); // class-less -> null (roll-up keys it #b)
  assert.equal(m.has('c'), false);
});

// ---------------------------------------------------------------------------
// resolveVerdicts.
// ---------------------------------------------------------------------------

test('verdict: black on white passes AA and AAA at 21:1', () => {
  const v = resolveVerdicts(stats(element('a', [frame(opaque(BLACK), [cluster(WHITE)])])));
  assert.deepEqual(
    v.elements.map((e) => [e.id, e.aa, e.aaa]),
    [['a', true, true]],
  );
  // Derivation: (1 + 0.05) / (0 + 0.05) = 21.
  assert.ok(Math.abs(v.elements[0].worstFrameRatio - 21.0) < 1e-12);
  assert.equal(v.failingAA, 0);
});

test('verdict: #767676 on white passes AA (4.542 >= 4.5) but fails AAA (< 7)', () => {
  const v = resolveVerdicts(stats(element('a', [frame(opaque(rgb(0x76, 0x76, 0x76)), [cluster(WHITE)])])));
  assert.equal(v.elements[0].aa, true);
  assert.equal(v.elements[0].aaa, false);
  assert.equal(v.failingAA, 0);
  assert.equal(v.failingAAA, 1);
});

test('verdict: every frame scores against ITS OWN font metrics (per-frame thresholds)', () => {
  // Derivation: pure red on white is 3.9985 — above the large-text bar (3.0),
  // below the normal bar (4.5). A 24px frame passes; adding a 16px frame of
  // the same colour flips the run to failing.
  const red = opaque(rgb(255, 0, 0));
  const largeOnly = element('a', [frame(red, [cluster(WHITE)], { font_size: 24 })]);
  assert.equal(resolveVerdicts(stats(largeOnly)).elements[0].aa, true);
  const mixed = element('a', [
    frame(red, [cluster(WHITE)], { frame: 0, font_size: 24 }),
    frame(red, [cluster(WHITE)], { frame: 1, font_size: 16 }),
  ]);
  assert.equal(resolveVerdicts(stats(mixed)).elements[0].aa, false);
});

test('verdict: the worst frame binds; each frame takes its own worst cluster', () => {
  // Derivation: black vs #808080 (luminance ~0.21586) is (0.26586)/(0.05) =
  // 5.317 — the binding cluster next to the 21:1 white one. AA passes,
  // AAA (7.0) fails.
  const e = element('a', [frame(opaque(BLACK), [cluster(WHITE, 0.5), cluster(rgb(0x80, 0x80, 0x80), 0.5)])]);
  const v = resolveVerdicts(stats(e));
  assert.ok(Math.abs(v.elements[0].worstFrameRatio - 5.317) < 5e-3);
  assert.equal(v.elements[0].aa, true);
  assert.equal(v.elements[0].aaa, false);
});

test('verdict: an unsampled peak frame fails the run even when sampled frames pass', () => {
  const e = element('a', [
    frame(opaque(BLACK), [cluster(WHITE)], { frame: 0 }),
    frame(opaque(BLACK), [], { frame: 1, unsampled: true }),
  ]);
  const v = resolveVerdicts(stats(e));
  assert.equal(v.elements[0].aa, false, 'unknown background -> cannot pass');
  // The worst ratio still reports the SAMPLED evidence (21:1), not 0.
  assert.ok(Math.abs(v.elements[0].worstFrameRatio - 21.0) < 1e-12);
});

// TEMPORAL READABILITY: the verdict is judged over one-second SLIDING windows.
// Per-instant scoring condemned a run for a single 200ms dip; pooling the whole
// run averaged a bad second away. Neither describes reading.
const GOOD = cluster(BLACK); // white text on black — comfortably passing
const BAD = cluster(WHITE); // white text on white — hopeless

// 5 sampled frames per window at the default audit density.
const run = (pattern: ('good' | 'bad')[]) =>
  element('t', pattern.map((p, i) =>
    frame({ ...WHITE, a: 1 }, [p === 'good' ? GOOD : BAD], { frame: i })));

const audited = (...elements: ElementStat[]): Statistics => ({
  version: 1, fps: 30, audit_density_fps: 5, budget_overflow_frames: 0, elements,
});

// What pooling actually buys is SPATIAL tolerance spread over time: a small
// bright speck behind the text for a moment is a fraction of a fraction of the
// window's mass, and stops condemning the run. The old per-instant verdict took
// the worst CLUSTER of the worst frame with no bar at all, so any speck failed.
test('verdict: a brief, SMALL, mild failure is absorbed', () => {
  // Mid-grey behind white text is ~3.95:1 — under AA, but well over the hard floor.
  const speck = element('t', Array.from({ length: 12 }, (_, i) =>
    frame({ ...WHITE, a: 1 }, i === 6
      ? [cluster(BLACK, 0.85), cluster(rgb(128, 128, 128), 0.15)]
      : [cluster(BLACK)], { frame: i })));
  const v = resolveVerdicts(audited(speck));
  // 0.15 of one frame, spread over a five-frame window -> 0.03 mass, under the bar.
  assert.equal(v.elements[0].aa, true);
});

// Tolerance has a floor: up to the bar may fail, but only a tenth of that may
// fail CATASTROPHICALLY (below 2:1). Text vanishing completely, even briefly and
// in a small patch, is not the same as text merely being dim.
test('verdict: an equally small but CATASTROPHIC failure is not absorbed', () => {
  const speck = element('t', Array.from({ length: 12 }, (_, i) =>
    frame({ ...WHITE, a: 1 }, i === 6
      ? [cluster(BLACK, 0.85), cluster(WHITE, 0.15)] // white on white: 1:1
      : [cluster(BLACK)], { frame: i })));
  assert.equal(resolveVerdicts(audited(speck)).elements[0].aa, false);
});

// The honest counterpart, and the limit of that tolerance: a frame that fails
// ENTIRELY is 1/5 of a second at this audit density, which is 20% of the
// window's mass and over the 10% bar. Text that vanishes for 200ms of every
// second is not noise.
test('verdict: a WHOLE bad instant is not absorbed — 1/5 of a second exceeds the bar', () => {
  const pattern: ('good' | 'bad')[] = Array(12).fill('good');
  pattern[6] = 'bad';
  const v = resolveVerdicts(audited(run(pattern)));
  assert.equal(v.elements[0].aa, false);
});

test('verdict: a full bad SECOND does condemn it', () => {
  const pattern: ('good' | 'bad')[] = Array(12).fill('good');
  for (let i = 4; i < 9; i++) pattern[i] = 'bad'; // five consecutive frames = 1s
  const v = resolveVerdicts(audited(run(pattern)));
  assert.equal(v.elements[0].aa, false, 'a whole second unreadable is a real failure');
});

// The discriminator for SLIDING over tumbling: a bad second straddling a
// boundary is invisible to fixed batches and caught by sliding ones.
test('verdict: a bad second STRADDLING a batch boundary is still caught', () => {
  const pattern: ('good' | 'bad')[] = Array(15).fill('good');
  for (let i = 3; i < 8; i++) pattern[i] = 'bad'; // spans the 0-4 / 5-9 boundary
  const v = resolveVerdicts(audited(run(pattern)));
  assert.equal(v.elements[0].aa, false);
});

// The verifier's own repro: a caption whose colour turns near-black for its last
// 0.8s over a near-black background. Because the window took its foreground from
// frames[0], those frames were judged with the ORIGINAL colour and the run was
// reported clean.
test('verdict: a colour change late in the run is scored with THAT colour', () => {
  const NEAR_BLACK_BG = cluster(rgb(10, 10, 10));
  const readable = { ...WHITE, a: 1 };
  const unreadable = { ...rgb(18, 18, 18), a: 1 };
  const frames = Array.from({ length: 10 }, (_, i) =>
    frame(i < 6 ? readable : unreadable, [NEAR_BLACK_BG], { frame: i }));
  const v = resolveVerdicts(audited(element('t', frames)));
  assert.equal(v.elements[0].aa, false, 'the final second is unreadable and must fail');
});

// A cluster-less SAMPLED frame must poison its window rather than be averaged out.
test('verdict: one unmeasured frame among measured ones fails closed', () => {
  const frames = Array.from({ length: 6 }, (_, i) =>
    frame({ ...BLACK, a: 1 }, i === 2 ? [] : [cluster(WHITE)], { frame: i }));
  assert.equal(resolveVerdicts(audited(element('t', frames))).elements[0].aa, false);
});

test('verdict: indeterminate or unscorable elements fail with ratio 0', () => {
  const ind = element('a', [frame(opaque(BLACK), [cluster(WHITE)])], { indeterminate: true });
  const empty = element('b', [], { indeterminate: false });
  const bare = element('c', [frame(opaque(BLACK), [])]); // sampled but no clusters
  const v = resolveVerdicts(stats(ind, empty, bare));
  assert.deepEqual(v.elements.map((e) => [e.id, e.aa, e.worstFrameRatio]), [
    ['a', false, 0],
    ['b', false, 0],
    ['c', false, 0],
  ]);
  assert.equal(v.indeterminateCount, 1); // only the flagged one
  assert.equal(v.failingAA, 3);
});

test('verdict: minRatio raises the effective bar (mirrors --min-ratio)', () => {
  const gray = element('a', [frame(opaque(rgb(0x76, 0x76, 0x76)), [cluster(WHITE)])]);
  assert.equal(resolveVerdicts(stats(gray)).elements[0].aa, true, '4.542 clears 4.5');
  assert.equal(resolveVerdicts(stats(gray), 7.0).elements[0].aa, false, 'max(4.5, 7.0) = 7 does not');
});
