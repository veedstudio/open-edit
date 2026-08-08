import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cjkScriptOf, ensureFontCoverage } from '../pipeline/scripts/ensure-font-coverage.ts';

const DOC = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,800;0,900&family=Playfair+Display:ital,wght@0,500;0,600&display=swap" rel="stylesheet">
<style>
  .sans  { font-family:"Archivo","Helvetica Neue",Arial,sans-serif; font-weight:800; }
  .serif { font-family:"Playfair Display",Georgia,serif; font-style:italic; }
</style>`;

test('a latin transcript passes through byte-identical', () => {
  assert.equal(ensureFontCoverage(DOC, 'happy birthday to you'), DOC);
});

test('script detection: han→tc, kana→jp, hangul→kr, latin→null', () => {
  assert.equal(cjkScriptOf('第二個願望'), 'tc');
  assert.equal(cjkScriptOf('誕生日おめでとう'), 'jp');
  assert.equal(cjkScriptOf('생일 축하해'), 'kr');
  assert.equal(cjkScriptOf('happy birthday'), null);
});

test('a chinese transcript gains noto on the existing css2 request', () => {
  const out = ensureFontCoverage(DOC, '第二個願望就是大家的感情都有個好歸宿');
  assert.match(out, /family=Noto\+Sans\+TC/);
  assert.match(out, /family=Noto\+Serif\+TC/);
  // extended in place, not a second request
  assert.equal((out.match(/fonts\.googleapis\.com\/css2/g) ?? []).length, 1);
  // &display stays terminal on the URL
  assert.match(out, /family=Noto\+Serif\+TC:[^"]*&display=swap/);
});

test('the covering family lands ahead of the generic keyword', () => {
  const out = ensureFontCoverage(DOC, '生日快樂');
  assert.match(out, /font-family:"Archivo","Helvetica Neue",Arial,"Noto Sans TC",sans-serif/);
  assert.match(out, /font-family:"Playfair Display",Georgia,"Noto Serif TC",serif/);
});

test('a japanese transcript picks the jp faces', () => {
  const out = ensureFontCoverage(DOC, 'おめでとう');
  assert.match(out, /Noto\+Sans\+JP/);
  assert.match(out, /"Noto Sans JP",sans-serif/);
});

test('a recipe that already covers the script is left alone', () => {
  const covered = DOC.replace('"Helvetica Neue"', '"Noto Sans TC","Helvetica Neue"');
  assert.equal(ensureFontCoverage(covered, '第二個願望'), covered);
});

test('a document with no webfont link gains one', () => {
  const bare = '<style>.t { font-family:Arial,sans-serif; }</style>';
  const out = ensureFontCoverage(bare, '生日快樂');
  assert.match(out, /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Noto\+Sans\+TC/);
  assert.match(out, /font-family:Arial,"Noto Sans TC",sans-serif/);
});

test('a stack with no generic keyword still gains the family', () => {
  const bare = '<style>.t { font-family:"Archivo"; }</style>';
  const out = ensureFontCoverage(bare, '生日快樂');
  assert.match(out, /font-family:"Archivo","Noto Sans TC"/);
});
