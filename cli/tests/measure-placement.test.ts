import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureFrame } from '../src/commands/measure-placement.ts';
import { safeZone } from '../src/safe-zone.ts';

// a 54x96 portrait grid standing for a 1080x1920 canvas
const GW = 54, GH = 96, W = 1080, H = 1920;
const flat = (v: number) => new Uint8Array(GW * GH).fill(v);
function rect(buf: Uint8Array, x0: number, y0: number, x1: number, y1: number, v: number): Uint8Array {
  const out = Uint8Array.from(buf);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * GW + x] = v;
  return out;
}

test('measureFrame: a speaker moving on a still background is boxed from motion, head at the top of the box', () => {
  const early = rect(flat(60), 18, 30, 36, 80, 200);
  const late = rect(flat(60), 20, 30, 38, 80, 200); // the same block two cells to the right
  const m = measureFrame(early, late, late, GW, GH, W, H);
  assert.equal(m.subjectFrom, 'motion');
  assert.equal(m.headFrom, 'motion');
  assert.ok(m.subjectBox && m.headBox);
  assert.equal(m.headBox.y, m.subjectBox.y, 'the head is the top of the subject box');
  assert.ok(m.headBox.w < m.subjectBox.w, 'a face is narrower than shoulders');
});

test('measureFrame: the calmest band never crosses the head, even when it is the emptiest', () => {
  // head in the upper bands, heavy texture everywhere below it: the flat band under the head wins
  let mid = flat(80);
  for (let y = 60; y < GH; y++) for (let x = 0; x < GW; x++) mid[y * GW + x] = (x + y) % 2 ? 250 : 10;
  const early = rect(mid, 20, 12, 34, 40, 220);
  const late = rect(mid, 22, 12, 36, 40, 220);
  const m = measureFrame(early, late, late, GW, GH, W, H);
  const calm = m.bands.find((b) => b.name === m.calmest);
  assert.ok(calm && !calm.overHead, `calmest ${m.calmest} must not cross the head`);
  assert.ok(calm.detail < 5, 'and it is the flat band, not the textured one');
});

test('measureFrame: a speck of motion does not end the search — the detail pass still finds the speaker', () => {
  // a textured subject that does not move, plus scattered flicker just over the 1% motion gate
  let mid = flat(80);
  for (let y = 30; y < 80; y++) for (let x = 18; x < 36; x++) mid[y * GW + x] = (x + y) % 2 ? 240 : 20;
  const early = Uint8Array.from(mid), late = Uint8Array.from(mid);
  // 66 isolated cells, 8 apart: over the 1% gate, and no two close enough to dilate into one blob
  for (let k = 0; k < 66; k++) { const i = (4 + 8 * Math.floor(k / 6)) * GW + 4 + 8 * (k % 6); late[i] = late[i] > 128 ? 0 : 255; }
  const m = measureFrame(early, mid, late, GW, GH, W, H);
  assert.equal(m.subjectFrom, 'detail');
  assert.ok(m.subjectBox && m.headBox, 'and with a head box, the calmest band can no longer be the one over the face');
});

test('measureFrame: a still frame with no subject reports none rather than inventing a box', () => {
  const m = measureFrame(flat(90), flat(90), flat(90), GW, GH, W, H);
  assert.equal(m.subjectBox, null);
  assert.equal(m.headBox, null);
  assert.equal(m.headFrom, null);
  assert.equal(m.bands.length, 6);
});

test('measureFrame: with no usable motion a face is found by skin chroma, not by background detail', () => {
  const mid = flat(120);
  const rgb = new Uint8Array(GW * GH * 3).fill(120);
  for (let y = 20; y < 34; y++) for (let x = 22; x < 32; x++) {
    const i = (y * GW + x) * 3; rgb[i] = 224; rgb[i + 1] = 172; rgb[i + 2] = 140; // a skin tone
  }
  const m = measureFrame(mid, mid, mid, GW, GH, W, H, rgb);
  assert.equal(m.headFrom, 'skin');
  assert.ok(m.headBox);
  const faceTop = 20 * (H / GH);
  assert.ok(m.headBox.y < faceTop, 'grown upward for hair or a hat');
  assert.ok(m.headBox.y + m.headBox.h >= 33 * (H / GH), 'and still reaching the chin');
});

test('safeZone: portrait keeps the feed-UI band clear; landscape and square are plain insets', () => {
  assert.deepEqual(safeZone(1080, 1920), { x0: 0.06, x1: 0.89, y0: 0.11, y1: 0.83 });
  assert.equal(safeZone(1920, 1080).x0, 0.06);
  assert.equal(safeZone(1080, 1080).x0, 0.05);
});
