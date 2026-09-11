import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, midRetryTime, probeStats } from '../src/commands/probe-qa.ts';

// tiny 10x10 synthetic frames
const W = 10, H = 10;
const flat = (v: number) => new Uint8Array(W * H).fill(v);

test('probeStats: identical frames → zero ink, no contrast', () => {
  const s = probeStats(flat(120), flat(120), W, H);
  assert.equal(s.inkPct, 0);
  assert.equal(s.contrast, null);
});

test('probeStats: bright text block on dark footage → ink + high contrast', () => {
  const source = flat(30);
  const render = flat(30);
  for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) render[y * W + x] = 240; // 16 text px
  const s = probeStats(render, source, W, H);
  assert.equal(s.inkPct, 16);
  assert.ok(s.contrast !== null && s.contrast > 10, `contrast ${s.contrast} is high`);
});

test('probeStats: white-on-white — invisible overlay leaves no ink; tonally-close overlay reads low', () => {
  const source = flat(230);
  const render = flat(230);
  for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) render[y * W + x] = 245; // diff 15 < threshold
  const s = probeStats(render, source, W, H);
  assert.equal(s.inkPct, 0, 'below diff threshold — invisible overlay leaves no ink');
  const render2 = flat(230);
  for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) render2[y * W + x] = 200; // visible but washy
  const s2 = probeStats(render2, source, W, H);
  assert.ok(s2.contrast !== null && s2.contrast < 2, `white-ish on white → contrast ${s2.contrast} < 2`);
});

test('probeStats: card device — dark card with bright text separates via INNER contrast', () => {
  const source = flat(120);
  const render = flat(120);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) render[y * W + x] = 40;   // dark card
  for (let y = 4; y < 6; y++) for (let x = 3; x < 7; x++) render[y * W + x] = 250;  // text on card
  const s = probeStats(render, source, W, H);
  assert.ok(s.contrast !== null && s.contrast > 4.5, `card+text inner contrast ${s.contrast} > 4.5`);
});

test('probeStats: small text on a large opaque bubble — percentile split separates (hook-072 case)', () => {
  const source = flat(150); // mid-grey shirt
  const render = flat(150);
  for (let y = 1; y < 9; y++) for (let x = 1; x < 9; x++) render[y * W + x] = 45;  // big dark bubble (64 px)
  for (let y = 4; y < 6; y++) for (let x = 3; x < 7; x++) render[y * W + x] = 250; // text ≈12% of the mask
  const s = probeStats(render, source, W, H);
  assert.ok(s.contrast !== null && s.contrast > 4.5, `text-on-bubble contrast ${s.contrast} > 4.5 (the MEAN split washed this class to ~2 — hook-072's false FAIL)`);
});

test('judge: mid-beat dead-air fails, tail dead-air only warns (exit fades are by design)', () => {
  assert.equal(judge('mid', { inkPct: 0.1, contrast: null }).verdict, 'fail');
  assert.equal(judge('tail', { inkPct: 0.1, contrast: null }).verdict, 'warn');
});

test('judge: low contrast fails, borderline warns, good passes', () => {
  assert.equal(judge('mid', { inkPct: 5, contrast: 1.5 }).verdict, 'fail');
  assert.equal(judge('mid', { inkPct: 5, contrast: 3.0 }).verdict, 'warn');
  assert.equal(judge('mid', { inkPct: 5, contrast: 8.0 }).verdict, 'pass');
});

test('midRetryTime: late words earn a post-speech resample; early words do not; no timings → null', () => {
  // words land late: midpoint 5.0 < retry 6.18 (last word 5.88 + 0.3)
  assert.ok(Math.abs((midRetryTime({ i: 1, startSec: 4, endSec: 6.5, lastWordSec: 5.88 }) ?? 0) - 6.18) < 1e-9);
  // words land early: retry (2.3) would precede the midpoint (3.0) → null
  assert.equal(midRetryTime({ i: 2, startSec: 2, endSec: 4, lastWordSec: 2.0 }), null);
  // retry clamps to endSec - 0.12
  assert.ok(Math.abs((midRetryTime({ i: 3, startSec: 4, endSec: 6, lastWordSec: 5.95 }) ?? 0) - 5.88) < 1e-9);
  // no word timings (transcript fallback) → no retry
  assert.equal(midRetryTime({ i: 4, startSec: 0, endSec: 2 }), null);
});
