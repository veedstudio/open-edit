// Tests for the STRUCTURAL post-apply check — the proof that what the pass
// SCORED is what actually landed in the promoted template.
//
// The outcome is computed analytically from the treatments (treat.ts), never
// re-sampled, so `after` describes the treatments and says nothing about the
// applier's output. Without this check a stylesheet that targeted the wrong
// elements, emitted the wrong declaration, or never got injected at all would
// still report an improvement and promote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApplied, parseCssRules } from '../src/wcag/verify-applied.ts';
import { buildChoiceCss, injectRemediationBlock } from '../src/wcag/remediate.ts';
import type { Treatment } from '../src/wcag/treat.ts';
import type { ChoiceFile } from '../src/wcag/wcag-choice.ts';

const AUDITED = new Set(['a', 'b', 'c']);

const COLOUR: Treatment = { kind: 'colour', hex: '#0b0b0c', ids: ['a', 'b'] };
const SHADOW: Treatment = {
  kind: 'shadow', hex: '#000000', ids: ['c'], recipe: { style: 'hard', directions: 8, offset: 1.5 },
};
const BOX: Treatment = { kind: 'background', hex: '#ffffff', backingHex: '#000000', ids: ['c'] };

// Build the stylesheet the applier really would emit for these treatments, so
// the check is exercised against production output rather than a hand-written
// approximation of it.
const cssFor = (treatments: Treatment[]): string =>
  buildChoiceCss({
    schema: 1,
    chosen: treatments.map((t) => ({
      level: 'AA' as const, selector: `.${t.ids![0]}`, kind: t.kind,
      hex: t.hex, backingHex: t.backingHex, recipe: t.recipe, ids: t.ids,
    })),
  } as ChoiceFile);

const templateWith = (css: string) => injectRemediationBlock('<html><head></head><body></body></html>', css);

test('parseCssRules: reads selector/declaration pairs and ignores comments', () => {
  const rules = parseCssRules(cssFor([COLOUR, SHADOW]));
  assert.equal(rules.length, 2);
  assert.equal(rules[0].selector, '#a, #b');
  assert.equal(rules[0].decls, 'color: #0b0b0c;');
  assert.match(rules[1].decls, /^text-shadow: /);
});

test('the applier output for the treatments we scored passes the check', () => {
  for (const set of [[COLOUR], [SHADOW], [BOX], [COLOUR, SHADOW]]) {
    const css = cssFor(set);
    assert.equal(
      checkApplied({ css, template: templateWith(css), treatments: set, auditedIds: AUDITED }),
      null,
      JSON.stringify(set),
    );
  }
});

// The gate that matters: a treatment whose CSS did not land must not promote.
test('a treatment with no emitted rule is caught', () => {
  const css = cssFor([COLOUR]); // the shadow never made it out
  assert.match(
    checkApplied({ css, template: templateWith(css), treatments: [COLOUR, SHADOW], auditedIds: AUDITED })!,
    /shadow.*#c/s,
  );
});

test('an emitted rule that differs from what we scored is caught', () => {
  const css = cssFor([{ ...COLOUR, hex: '#123456' }]);
  assert.match(
    checkApplied({ css, template: templateWith(css), treatments: [COLOUR], auditedIds: AUDITED })!,
    /#0b0b0c/,
  );
});

test('an emitted rule nothing scored is caught', () => {
  const css = cssFor([COLOUR, SHADOW]);
  assert.match(
    checkApplied({ css, template: templateWith(css), treatments: [COLOUR], auditedIds: AUDITED })!,
    /nothing scored/,
  );
});

// The audit is what every number in the report rests on; styling text it never
// measured is a claim with no evidence under it.
test('a rule targeting text the audit never measured is caught', () => {
  const css = cssFor([COLOUR]);
  assert.match(
    checkApplied({ css, template: templateWith(css), treatments: [COLOUR], auditedIds: new Set(['a']) })!,
    /#b.*never measured/s,
  );
});

test('a stylesheet that was never injected is caught', () => {
  const css = cssFor([COLOUR]);
  assert.match(
    checkApplied({ css, template: '<html><head></head><body></body></html>', treatments: [COLOUR], auditedIds: AUDITED })!,
    /was not injected/,
  );
});

// A treatment carrying no resolved ids has nothing to compare against, so it
// cannot be checked — and an unbounded selector is exactly what the id
// resolution exists to prevent.
test('a treatment with no resolved ids is refused rather than skipped', () => {
  const css = cssFor([COLOUR]);
  assert.match(
    checkApplied({
      css, template: templateWith(css),
      treatments: [{ kind: 'colour', hex: '#0b0b0c', selector: '.w' }],
      auditedIds: AUDITED,
    })!,
    /no resolved ids/,
  );
});
