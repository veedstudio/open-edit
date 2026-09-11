import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectationsFor, elementsWithId } from '../src/commands/expect-windows.ts';

const WV = `<style>
@keyframes cueWin { 0%,99%{opacity:1} 100%{opacity:0} }
@keyframes wIn { 0%{opacity:0} 100%{opacity:1} }
.cue { position:absolute; z-index:9; opacity:0; animation-name:cueWin }
.w { display:inline-block; animation: wIn .4s both }
</style>
<div class="cue" id="cue1" style="animation-delay:0ms; animation-duration:1500ms"><span class="w">A</span></div>
<div class="cue" id="cue2" style="animation-delay:1500ms; animation-duration:1500ms"><span class="w">B</span></div>`;

test('expect-windows: a cue whose ink lives in child spans is skipped, not asserted wrongly', () => {
  // engine 0.8.0 measures expect-visible against the element's OWN ink, so a parent whose words are
  // child spans reads as invisible on a document that renders perfectly. Asserting on it would fail
  // every correct run. The behaviour is pinned by tests/expect-visible-nested.test.ts.
  assert.deepEqual(expectationsFor(WV, 3000, 40), []);
});

test('expect-windows: a cue carrying its own text becomes an assertion inside its window', () => {
  const direct = `<style>
@keyframes cueWin { 0%,99%{opacity:1} 100%{opacity:0} }
.cue { position:absolute; z-index:9; opacity:0; animation-name:cueWin }
</style>
<div class="cue" id="cue1" style="animation-delay:0ms; animation-duration:1500ms">ALPHA</div>
<div class="cue" id="cue2" style="animation-delay:1500ms; animation-duration:1500ms">BETA</div>`;
  const e = expectationsFor(direct, 3000, 40);
  assert.equal(e.length, 2);
  assert.deepEqual(e[0], { element: 'cue1', visible: true, from: 0.04, to: 1.46 });
  assert.deepEqual(e[1], { element: 'cue2', visible: true, from: 1.54, to: 2.96 });
});

test('expect-windows: an entrance is not a gate — only a keyframes block that ends hidden is', () => {
  const entranceOnly = WV.replace('@keyframes cueWin { 0%,99%{opacity:1} 100%{opacity:0} }', '@keyframes cueWin { 0%{opacity:0} 100%{opacity:1} }');
  assert.deepEqual(expectationsFor(entranceOnly, 3000), []);
});

test('expect-windows: a window too short to sample inside is skipped rather than asserted on noise', () => {
  const tiny = `<style>
@keyframes g { 0%,99%{opacity:1} 100%{opacity:0} }
.c { animation-name:g }
</style><div class="c" id="c1" style="animation-delay:0ms; animation-duration:50ms"></div>`;
  assert.deepEqual(expectationsFor(tiny, 3000, 40), []);
});

test('expect-windows: the assertion never runs past the end of the timeline', () => {
  const e = expectationsFor(WV, 2000, 40);
  for (const x of e) assert.ok(x.to <= 2000 / 1000 - 0.04 + 1e-9, `${x.element} to=${x.to}`);
});

test('expect-windows: it derives real assertions from a document that actually shipped', (t) => {
  // This ran against hp-ES, whose every word is a child span: it yields ZERO expectations, so both of
  // its loops iterated an empty array and the test asserted nothing at all. _ugc4-news is a delivered
  // document whose cues carry their own ink, so the derivation has something to be wrong about.
  // The corpus does not ship with this package. OPENEDIT_CORPUS_DOC names one delivered document's
  // directory; without it there is nothing real to derive from and the case skips.
  const doc = process.env.OPENEDIT_CORPUS_DOC ?? '';
  const wv = doc && join(doc, 'template.wv');
  const mf = doc && join(doc, 'manifest.json');
  if (!wv || !mf || !existsSync(wv) || !existsSync(mf)) { t.skip('regression corpus not present (set OPENEDIT_CORPUS_DOC)'); return; }
  const src = readFileSync(wv, 'utf8');
  const duration = JSON.parse(readFileSync(mf, 'utf8')).render.duration * 1000;
  // A tolerance that is NOT the module's default, so the numbers below cannot come out right by
  // inheriting it: each one is the document's own declared window inset by 50ms at each end.
  const e = expectationsFor(src, duration, 50);

  assert.equal(e.length, 8, `the document states eight gated windows, got ${JSON.stringify(e)}`);
  // `cap1` declares its window INLINE (animation-duration:660ms, animation-delay:70ms); `nb_l1` takes
  // it from the `.narr` rule (640ms after 1400ms). A gate that reads only one of the two places
  // silently drops half of a real document.
  assert.deepEqual(e[0], { element: 'cap1', visible: true, from: 0.12, to: 0.68 });
  assert.deepEqual(e[2], { element: 'nb_l1', visible: true, from: 1.45, to: 1.99 });
  assert.deepEqual(e.at(-1), { element: 'bal_l2', visible: true, from: 2.16, to: 2.58 });

  const elements = elementsWithId(src);
  const ids = new Set(elements.map((x) => x.id));
  for (const x of e) {
    assert.ok(ids.has(x.element), `${x.element} is an element the document actually carries`);
    assert.equal(x.visible, true, `${x.element} asserts presence, which is all --verify can check`);
    assert.ok(x.from < x.to, `${x.element} window is ordered`);
    assert.ok(x.to * 1000 <= duration, `${x.element} stays inside the timeline`);
  }

  // Every assertion is sampled strictly INSIDE the window its own element declares. One that reached
  // the flip instant would fail on a render that is exactly right — the failure this gate exists to
  // avoid producing.
  for (const x of e) {
    const open = elements.find((n) => n.id === x.element)!.open;
    const at = (prop: string) => Number(open.match(new RegExp(`animation-${prop}:(\\d+)ms`))?.[1]);
    const delay = at('delay'), dur = at('duration');
    if (!Number.isFinite(delay) || !Number.isFinite(dur)) continue; // its timing lives in a class rule
    assert.ok(x.from * 1000 > delay, `${x.element} starts after its own gate opens`);
    assert.ok(x.to * 1000 < delay + dur, `${x.element} ends before its own gate closes`);
  }
});

test('expect-windows: a div holding divs is not mistaken for one with its own ink', () => {
  // The element match was non-greedy, so it stopped at the FIRST closing tag of the same name — the
  // inner one. The leftover unbalanced text read as the parent's own ink, the "no ink of its own"
  // guard never fired, and the gate emitted assertions that FAIL on documents rendering perfectly.
  const ownInk = (html: string, id: string) => {
    const el = elementsWithId(html).find((e) => e.id === id)!;
    return el.inner.replace(/<(\w+)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, '').trim();
  };

  assert.equal(ownInk('<div id="cue1"><div class="w">HELLO</div><div class="w">THERE</div></div>', 'cue1'), '');
  assert.equal(ownInk('<div id="cue1"><span class="w">HELLO</span></div>', 'cue1'), '', 'a span child behaves the same');
  assert.equal(ownInk('<div id="t1">WORDS</div>', 't1'), 'WORDS', 'a leaf still has its own ink');
  assert.equal(ownInk('<div id="t1">LEAD <span>rest</span></div>', 't1'), 'LEAD', 'mixed content keeps only what is its own');

  // Every id in a nested document is found, not just the outermost.
  const ids = elementsWithId('<div id="a"><div id="b"><span id="c">x</span></div></div>').map((e) => e.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);

  // A void tag never opens a level, so it cannot swallow the rest of the document.
  assert.equal(ownInk('<div id="t1">A<br>B</div>', 't1'), 'AB');
});

test('expect-windows: an element inside a comment is not in the document', () => {
  // It produced an expectation for an id the engine never draws, failing a render that is correct.
  const live = elementsWithId('<div id="a">x</div>').map((e) => e.id);
  const commented = elementsWithId('<!-- <div id="a">x</div> --><div id="b">y</div>').map((e) => e.id);
  assert.deepEqual(live, ['a']);
  assert.deepEqual(commented, ['b'], 'only the element that is really there');

  // Blanking keeps offsets true, so a line number reported after a comment is still the right one.
  const src = '<!-- one -->\n<div id="c">z</div>';
  assert.equal(elementsWithId(src)[0].inner, 'z');
});
