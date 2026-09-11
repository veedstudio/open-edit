// Tests for the sliding SAMPLE WINDOW — the one temporal unit every score uses.
//
// The contract: sampling happens ONCE and is a fixed stochastic model of the
// colour behind the text. Readability is judged over a second of footage, not
// per instant, because a caption unreadable for a second is a real failure while
// one 200ms dip is sampling noise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slidingWindows, windowSize } from '../src/wcag/windows.ts';
import type { ClusterStat, ElementStat, FrameStat } from '../src/wcag/verdicts.ts';

const Z3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const rgb = (v: number) => ({ r: v, g: v, b: v });
const cl = (v: number, weight: number): ClusterStat => ({ color: rgb(v), weight, covariance: Z3 });

const frame = (n: number, over: Partial<FrameStat> = {}): FrameStat => ({
  frame: n,
  fg: { r: 255, g: 255, b: 255, a: 1 },
  font_size: 40,
  font_weight: 400,
  unsampled: false,
  clusters: [cl(255, 1)],
  ...over,
});

const element = (frames: FrameStat[]): ElementStat => ({
  id: 't',
  rect: { x: 0, y: 0, w: 100, h: 20 },
  font_size: 40,
  font_weight: 400,
  steady_alpha: 1,
  fg: { r: 255, g: 255, b: 255, a: 1 },
  total_samples: 100,
  total_frames: frames.length,
  unscored_transient_frames: 0,
  sampled_transient_frames: 0,
  indeterminate: false,
  clusters: [{ ...cl(255, 1), frames: frames.map((f) => f.frame) }],
  frames,
});

test('windowSize: one second of footage, read from the audit density', () => {
  assert.equal(windowSize({ audit_density_fps: 5 }), 5);
  assert.equal(windowSize({ audit_density_fps: 10 }), 10);
  // Absent or nonsensical densities fall back rather than producing a zero-width
  // window, which would make every element vacuously passing.
  assert.equal(windowSize({}), 5);
  assert.equal(windowSize({ audit_density_fps: 0 }), 1);
});

test('slidingWindows: every sampled frame belongs to at least one window', () => {
  const frames = Array.from({ length: 12 }, (_, i) => frame(i));
  const w = slidingWindows(element(frames), 5);
  assert.equal(w.length, 8, '12 frames, window 5 -> 12-5+1 windows');
  for (const win of w) assert.equal(win.frames.length, 5);
  // SLIDING is what removes the orphaned tail: no frame falls outside every window.
  const covered = new Set(w.flatMap((win) => win.frames));
  assert.deepEqual([...covered].sort((a, b) => a - b), frames.map((f) => f.frame));
});

test('slidingWindows: a run shorter than a second is ONE window, not none', () => {
  const w = slidingWindows(element([frame(0), frame(1), frame(2)]), 5);
  assert.equal(w.length, 1, 'a 0.6s caption still has to be judged');
  assert.deepEqual(w[0].frames, [0, 1, 2]);
});

test('slidingWindows: unsampled frames are excluded, not counted as black', () => {
  const frames = [frame(0), frame(1, { unsampled: true }), frame(2), frame(3), frame(4), frame(5)];
  const w = slidingWindows(element(frames), 5);
  assert.equal(w.length, 1, '5 sampled frames -> exactly one full window');
  assert.deepEqual(w[0].frames, [0, 2, 3, 4, 5]);
});

// A SAMPLED frame that measured no adjacent background is unmeasured, not clean.
// Pooling used to dilute it: four good frames at weight 0.2 gave total weight 0.8
// and a failing mass of 0, so the window passed. Only an ENTIRELY empty window was
// caught, which is not what this file's header promises.
test('slidingWindows: ONE cluster-less sampled frame makes the whole window unscorable', () => {
  const frames = [
    frame(0), frame(1),
    frame(2, { clusters: [] }), // sampled, but nothing behind the text was measured
    frame(3), frame(4),
  ];
  const [w] = slidingWindows(element(frames), 5);
  assert.equal(w.unscorable, true, 'an unmeasured frame must poison its window');
});

test('slidingWindows: a window whose frames all measured is scorable', () => {
  const [w] = slidingWindows(element([frame(0), frame(1), frame(2)]), 5);
  assert.equal(w.unscorable, false);
});

// The window carried ONE foreground, taken from frames[0]. A caption that changes
// colour mid-run was then judged with a colour it no longer had — and the last k-1
// sampled frames were never scored with their own colour at all.
test('slidingWindows: every distinct foreground in the window is carried', () => {
  const AMBER = { r: 230, g: 184, b: 102, a: 1 };
  const DARK = { r: 20, g: 20, b: 20, a: 1 };
  const frames = [
    frame(0, { fg: AMBER }), frame(1, { fg: AMBER }),
    frame(2, { fg: DARK }), frame(3, { fg: DARK }),
  ];
  const [w] = slidingWindows(element(frames), 4);
  const seen = w.foregrounds.map((f) => `${f.fg.r},${f.fg.g},${f.fg.b}@${f.alpha}`).sort();
  assert.deepEqual(seen, ['20,20,20@1', '230,184,102@1'], 'both colours must be scored');
});

test('slidingWindows: no sampled frames yields no windows', () => {
  assert.deepEqual(slidingWindows(element([frame(0, { unsampled: true })]), 5), []);
});

// The refinement that matters: pooling must PRESERVE both modes. Averaging the
// colours of bright sky and dark shadow would produce a mid-grey that looks
// readable and is not — erasing exactly the bimodality that causes the failure.
test('slidingWindows: clusters are POOLED by weight, never colour-averaged', () => {
  const frames = [
    frame(0, { clusters: [cl(255, 1)] }), // a second of bright sky...
    frame(1, { clusters: [cl(255, 1)] }),
    frame(2, { clusters: [cl(0, 1)] }), // ...and dark shadow
    frame(3, { clusters: [cl(0, 1)] }),
  ];
  const [w] = slidingWindows(element(frames), 4);
  const shades = w.clusters.map((c) => c.color.r).sort((a, b) => a - b);
  assert.deepEqual(shades, [0, 0, 255, 255], 'both extremes survive');
  assert.ok(!shades.includes(128), 'nothing is averaged into a mid-grey');
  const total = w.clusters.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights renormalise to 1, got ${total}`);
});

test('slidingWindows: carries the WORST alpha and the strictest metrics in the window', () => {
  const frames = [
    frame(0, { fg: { r: 255, g: 255, b: 255, a: 1.0 }, font_size: 40, font_weight: 700 }),
    frame(1, { fg: { r: 255, g: 255, b: 255, a: 0.4 }, font_size: 40, font_weight: 700 }),
    // Small light text is the strictest moment: it needs the higher ratio.
    frame(2, { fg: { r: 255, g: 255, b: 255, a: 0.9 }, font_size: 12, font_weight: 300 }),
  ];
  const [w] = slidingWindows(element(frames), 3);
  assert.equal(w.fgAlpha, 0.4, 'the faintest instant governs the window');
  assert.equal(w.fontSize, 12, 'and so does the smallest type');
  assert.equal(w.fontWeight, 300);
});
