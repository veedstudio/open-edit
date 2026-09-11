import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, briefFor, type Brand } from '../src/commands/brand.ts';

const RACE: Brand = {
  name: 'RACE FASHION',
  palette: { accent: '#96FF1A', ink: '#FFFFFF', warn: '#FF502C', ground: '#1F1616' },
  colourLaw: [
    'ink and accent carry everything; warn is a micro-accent inside a graphic, never type at size',
    'type sitting ON an accent plate is the ground colour, never ink',
  ],
  type: { display: 'Akrobat 900', body: 'Akrobat 600', notes: 'tracking tight at display sizes' },
  logo: { placement: 'bottom-right, small, constant size, very light shadow', never: 'cropped out of the brandbook raster' },
  set: { shared: ['the mark in the same spot', 'one type pair', 'the colour law'], varies: ['composition'] },
};

test('brand: a well-formed law validates', () => {
  assert.deepEqual(validate(RACE, tmpdir()), []);
});

test('brand: palette keys must be ROLES, because a role survives a palette swap', () => {
  const bad = { ...RACE, palette: { '#96FF1A': '#96FF1A' } };
  const problems = validate(bad, tmpdir());
  assert.ok(problems.some((p) => /must be a role/.test(p.message)));
});

test('brand: a named mark that is not on disk is a problem, not a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'));
  const missing = validate({ ...RACE, logo: { asset: 'mark.svg' } }, dir);
  assert.ok(missing.some((p) => p.field === 'logo.asset'));
  writeFileSync(join(dir, 'mark.svg'), '<svg/>');
  assert.deepEqual(validate({ ...RACE, logo: { asset: 'mark.svg' } }, dir), []);
});

test('brand: a set with nothing shared is not a set', () => {
  const problems = validate({ ...RACE, set: { shared: [] } }, tmpdir());
  assert.ok(problems.some((p) => p.field === 'set.shared'));
});

test('brand: the brief names the law, the mark rule and the shared bone', () => {
  const text = briefFor(RACE, tmpdir());
  assert.match(text, /THE BRAND — RACE FASHION/);
  assert.match(text, /accent: #96FF1A/);
  assert.match(text, /never type at size/);
  assert.match(text, /THE SHARED BONE/);
  assert.match(text, /Compositions differ; the bone does not/);
});
