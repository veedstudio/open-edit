import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRange } from '../src/preview/media.ts';

test('no header: full 200 with length + accept-ranges', () => {
  const p = planRange(undefined, 100);
  assert.equal(p.status, 200);
  assert.equal(p.start, 0);
  assert.equal(p.end, 99);
  assert.equal(p.headers['content-length'], '100');
  assert.equal(p.headers['accept-ranges'], 'bytes');
});

test('bytes=10-19 slices inclusively', () => {
  const p = planRange('bytes=10-19', 100);
  assert.equal(p.status, 206);
  assert.equal(p.start, 10);
  assert.equal(p.end, 19);
  assert.equal(p.headers['content-range'], 'bytes 10-19/100');
  assert.equal(p.headers['content-length'], '10');
});

test('open end clamps to eof', () => {
  const p = planRange('bytes=90-', 100);
  assert.equal(p.status, 206);
  assert.equal(p.start, 90);
  assert.equal(p.end, 99);
});

test('end past eof clamps to eof', () => {
  const p = planRange('bytes=90-500', 100);
  assert.equal(p.status, 206);
  assert.equal(p.end, 99);
});

test('suffix range takes the last n bytes', () => {
  const p = planRange('bytes=-25', 100);
  assert.equal(p.status, 206);
  assert.equal(p.start, 75);
  assert.equal(p.end, 99);
});

test('start past eof is 416 with a */size content-range', () => {
  const p = planRange('bytes=100-', 100);
  assert.equal(p.status, 416);
  assert.equal(p.headers['content-range'], 'bytes */100');
});

test('malformed header falls back to full 200', () => {
  assert.equal(planRange('bites=0-1', 100).status, 200);
  assert.equal(planRange('bytes=a-b', 100).status, 200);
});
