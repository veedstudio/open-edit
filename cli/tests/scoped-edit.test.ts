import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopedDrift, unattributed } from '../src/commands/scoped-edit.ts';

const BASE = `<style>
@keyframes cueWin { 0%,99%{opacity:1} 100%{opacity:0} }
@keyframes pop { 0%{transform:scale(.9)} 100%{transform:none} }
.card1 { position:absolute; left:100px; top:80px; width:300px; height:200px; z-index:2 }
.card3 { position:absolute; left:700px; top:80px; width:300px; height:200px; z-index:2 }
</style>
<div class="card1" id="c1" style="animation-delay:0ms">A</div>
<div class="card3" id="c3" style="animation-delay:400ms">C</div>`;

/** The ask: widen card 3 and nothing else. */
const SCOPED = BASE.replace('.card3 { position:absolute; left:700px; top:80px; width:300px', '.card3 { position:absolute; left:700px; top:80px; width:480px');

/** The same ask, plus the footage of card 1 quietly shifted — corpus class `regression`. */
const DRIFTED = SCOPED.replace('id="c1" style="animation-delay:0ms"', 'id="c1" style="animation-delay:240ms"');

test('scoped-edit: an edit inside its stated scope is clean', () => {
  assert.deepEqual(scopedDrift(BASE, SCOPED, ['.card3']), []);
});

test('scoped-edit: a change outside the scope is named with both values', () => {
  const drift = scopedDrift(BASE, DRIFTED, ['.card3']);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].where, '#c1');
  assert.equal(drift[0].what, 'inline style');
  assert.match(drift[0].from, /animation-delay:0ms/);
  assert.match(drift[0].to, /animation-delay:240ms/);
});

test('scoped-edit: with no allow-list, nothing may differ', () => {
  assert.equal(scopedDrift(BASE, SCOPED, []).length, 1);
  assert.deepEqual(scopedDrift(BASE, BASE, []), []);
});

test('scoped-edit: a silently retimed keyframe block is drift, not a re-render', () => {
  const retimed = BASE.replace('@keyframes pop { 0%{transform:scale(.9)} 100%{transform:none} }', '@keyframes pop { 0%{transform:scale(.7)} 100%{transform:none} }');
  const drift = scopedDrift(BASE, retimed, ['.card3']);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].where, '@keyframes pop');
});

test('scoped-edit: whitespace and declaration order are not changes', () => {
  const reflowed = BASE
    .replace('.card1 { position:absolute; left:100px; top:80px; width:300px; height:200px; z-index:2 }',
             '.card1 {\n  position:absolute;\n  left:100px;\n  top:80px;\n  width:300px;\n  height:200px;\n  z-index:2\n}');
  assert.deepEqual(scopedDrift(BASE, reflowed, []), []);
});

test('scoped-edit: an allow token does not bless a longer name that starts with it', () => {
  // `--allow .card` once permitted `.card3`, `.discard` and `@keyframes cardIn`, in the one tool whose
  // purpose is proving that only the named thing changed.
  const a = '<style>.card3{left:1px}\n.card30{left:1px}</style>';
  const b = '<style>.card3{left:9px}\n.card30{left:9px}</style>';
  assert.equal(scopedDrift(a, b, ['.card']).length, 2, 'a prefix allows nothing');
  assert.deepEqual(scopedDrift(a, b, ['.card3']).map((d) => d.where), ['.card30']);
  assert.equal(scopedDrift(a, b, ['']).length, 2, 'an empty token must not disable the gate');
});

test('scoped-edit: an element added outside the scope is drift', () => {
  const drift = scopedDrift('<div id="a">X</div>', '<div id="a">X</div><div id="b">NEW HEADLINE</div>', []);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].where, '#b');
  assert.equal(drift[0].from, '(absent)');
});

test('scoped-edit: the <style> tag never leaks into a selector', () => {
  // String.match with /g returns whole matches; keeping them made the first selector `<style>.card3`.
  const drift = scopedDrift('<style>.a{left:1px}</style>', '<style>.a{left:2px}</style>', []);
  assert.deepEqual(drift.map((d) => d.where), ['.a']);
});

test('scoped-edit: it never calls a document equivalent when the change is where it cannot look', () => {
  // It compares CSS rules, keyframes, and the inline style and first text node of elements that carry
  // an id. A generated caption keeps its words and their per-word delays on unidentified spans, so it
  // reported "the documents are equivalent" after every glyph had been retimed and every word changed.
  const before = `<style>.g{opacity:0}</style><div id="cap1"><span class="g" style="animation-delay:0ms">A</span><span class="g" style="animation-delay:180ms">B</span></div>`;
  const retimed = `<style>.g{opacity:0}</style><div id="cap1"><span class="g" style="animation-delay:400ms">A</span><span class="g" style="animation-delay:580ms">B</span></div>`;
  const reworded = `<style>.g{opacity:0}</style><div id="cap1"><span class="g" style="animation-delay:0ms">X</span><span class="g" style="animation-delay:180ms">Y</span></div>`;

  assert.deepEqual(scopedDrift(before, retimed, []), [], 'none of its three views can see this — that is the point');
  assert.notEqual(unattributed(before), unattributed(retimed), 'but the residual does');
  assert.notEqual(unattributed(before), unattributed(reworded));

  assert.equal(unattributed(before), unattributed(before), 'identical documents have an identical residual');

  // A change inside <style> is fully attributed, so it must NOT show up as unattributed drift.
  const restyled = `<style>.g{opacity:0.5}</style><div id="cap1"><span class="g" style="animation-delay:0ms">A</span><span class="g" style="animation-delay:180ms">B</span></div>`;
  assert.equal(unattributed(before), unattributed(restyled), 'the stylesheet is compared elsewhere');
  assert.ok(scopedDrift(before, restyled, []).length > 0, 'and it is reported there');
});

test('scoped-edit: an element the caller allowed leaves the residual with its children', () => {
  // The residual ignored `--allow`, so an edit confined entirely to a permitted element was reported
  // as unattributed and NO set of allow tokens could make the tool pass — the documented mode was a
  // constant failure.
  const before = `<style>.g{opacity:0}</style><div id="cap1"><span style="animation-delay:0ms">A</span></div><div id="cap2"><span>B</span></div>`;
  const retimed = `<style>.g{opacity:0}</style><div id="cap1"><span style="animation-delay:400ms">X</span></div><div id="cap2"><span>B</span></div>`;

  assert.notEqual(unattributed(before), unattributed(retimed), 'unpermitted, it is drift');
  assert.equal(unattributed(before, ['cap1']), unattributed(retimed, ['cap1']), 'permitted, it is the point');
  assert.equal(unattributed(before, ['#cap1']), unattributed(retimed, ['#cap1']), 'a selector form works too');

  // Permitting one element must not blind the tool to the others.
  const alsoElsewhere = retimed.replace('<span>B</span>', '<span>CHANGED</span>');
  assert.notEqual(unattributed(before, ['cap1']), unattributed(alsoElsewhere, ['cap1']));

  // Nesting: the whole subtree goes, not up to the first closing tag of the same name. `keep` sits in
  // a child span because the residual already excludes an id-carrying element's own first text node —
  // that half is compared directly, not here.
  const nested = `<div id="a"><div><span>gone</span></div></div><div id="b"><span>keep</span></div>`;
  assert.match(unattributed(nested, ['a']), /keep/);
  assert.doesNotMatch(unattributed(nested, ['a']), /gone/);
});
