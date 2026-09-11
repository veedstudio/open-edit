import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChoiceCss,
  buildPlanCss,
  hex,
  injectRemediationBlock,
  parsePlanFile,
  REMEDIATION_BLOCK_ID,
  type RemediationPlan,
} from '../src/wcag/remediate.ts';
import { DEFAULT_SHADOW_RECIPE, type ChoiceFile } from '../src/wcag/wcag-choice.ts';

const PLAN: RemediationPlan = {
  level: 'AA',
  rules: [
    { selector: '.w', hex: '#0b0b0c', massPct: 0, worstRatio: 4.62 },
    { selector: '#b', hex: '#f2f2f4', massPct: 1.0, worstRatio: 4.51 },
  ],
  notes: ['.t (2/3 failing): no colour satisfies AA for the whole class — shadow #000000 x3 @ 8px | background #ffffff on #000000'],
};

test('hex: lowercase 6-digit, zero-padded', () => {
  assert.equal(hex({ r: 0, g: 0, b: 0 }), '#000000');
  assert.equal(hex({ r: 255, g: 15, b: 1 }), '#ff0f01');
});

test('parsePlanFile: accepts the contract shape, rejects everything else', () => {
  assert.deepEqual(parsePlanFile(JSON.parse(JSON.stringify(PLAN))), PLAN);
  assert.throws(() => parsePlanFile({}), /expected \{ level: 'AA'/);
  assert.throws(() => parsePlanFile({ level: 'AAA', rules: [], notes: [] }), /expected/);
  // Uppercase / short hex is a producer bug, not something to normalize here.
  assert.throws(
    () => parsePlanFile({ level: 'AA', rules: [{ selector: '.w', hex: '#FFF' }], notes: [] }),
    /bad rule/,
  );
});

test('buildPlanCss: one rule per plan rule with its evidence; notes as comments', () => {
  const css = buildPlanCss(PLAN);
  assert.match(css, /\.w \{ color: #0b0b0c; \}/);
  assert.match(css, /#b \{ color: #f2f2f4; \}/);
  // Evidence comment precedes each rule.
  assert.match(css, /\/\* \.w: recolor \(estimated failure 0\.0%, worst 4\.62:1\) \*\//);
  // The unapplied recommendation survives as a comment — nothing goes unlisted.
  assert.match(css, /\/\* not applied — \.t \(2\/3 failing\): no colour satisfies AA/);
  // Negative: no colour rule for the noted selector.
  assert.doesNotMatch(css, /^\.t \{/m);
});

test('buildChoiceCss: one rule per chosen class, per kind', () => {
  const file: ChoiceFile = {
    schema: 1,
    chosen: [
      { level: 'AA', kind: 'colour', hex: '#e8e8e8', selector: '.w' },
      { level: 'AA', kind: 'shadow', hex: '#000000', selector: '.emph', recipe: { layers: 2, blur: 12 } },
      { level: 'AA', kind: 'background', hex: '#ffffff', backingHex: '#000000', selector: '#kicker' },
    ],
  };
  const css = buildChoiceCss(file);
  assert.match(css, /^\.w \{ color: #e8e8e8; \}$/m);
  // The solved recipe drives the stack: `layers` copies at the modelled alpha.
  assert.match(css, /^\.emph \{ text-shadow: 0 0 12px #000000d9, 0 0 12px #000000d9; \}$/m);
  assert.match(css, /^#kicker \{ color: #ffffff; background-color: #000000; \}$/m);
  // The retired outline rung must not reappear as a text-stroke.
  assert.doesNotMatch(css, /text-stroke/);
});

// A class KEY is not a CSS selector: the roll-up groups by the sorted composite
// class set, so `.w` names elements whose classes are exactly {w}, while as CSS
// it would also match class="fade w" — a different roll-up class that was scored
// separately and never named in this proposal. wcag-pass resolves the key to its
// member ids; the applier must target those.
test('buildChoiceCss: resolved ids are targeted, not the class key', () => {
  const css = buildChoiceCss({
    schema: 1,
    chosen: [{ level: 'AA', kind: 'colour', hex: '#e8e8e8', selector: '.w', ids: ['b1', 'b3'] }],
  });
  assert.match(css, /^#b1, #b3 \{ color: #e8e8e8; \}$/m);
  // The bare class key must not reach the stylesheet as a selector.
  assert.doesNotMatch(css, /^\.w \{/m);
  // It survives in the evidence comment, which is what a human reads.
  assert.match(css, /\/\* \.w: user-chosen/);
});

// A hard outline is a RING of zero-blur copies at full opacity — the faux-outline
// lint-template.ts points at, since CSS `outline:` is engine-unsupported. Emitting
// it as a blurred stack would not replace the background and would not reach AA.
test('buildChoiceCss: a hard recipe emits an 8-way zero-blur ring at full opacity', () => {
  const css = buildChoiceCss({
    schema: 1,
    chosen: [{
      level: 'AA', kind: 'shadow', hex: '#000000', selector: '.w',
      recipe: { style: 'hard', directions: 8, offset: 1.5 },
    }],
  });
  const rule = css.split('\n').find((l) => l.startsWith('.w {'))!;
  const shadows = rule.match(/-?[\d.]+px -?[\d.]+px 0 #000000/g) ?? [];
  assert.equal(shadows.length, 8, `expected 8 hard copies, got ${shadows.length} in ${rule}`);
  // Zero blur and NO alpha suffix: the ring must be opaque to replace the background.
  assert.doesNotMatch(rule, /#000000d9/);
  assert.doesNotMatch(rule, /px \d+px #/, 'no blurred layer may appear in a hard ring');
});

test('buildChoiceCss: a shadow with no recipe falls back to the SSOT pair', () => {
  const css = buildChoiceCss({
    schema: 1,
    chosen: [{ level: 'AA', kind: 'shadow', hex: '#000000', selector: '.w' }],
  });
  assert.notEqual(DEFAULT_SHADOW_RECIPE.style, 'hard', 'the SSOT fallback is a soft stack');
  const { layers, blur } = DEFAULT_SHADOW_RECIPE as { layers: number; blur: number };
  assert.equal([...css.matchAll(/0 0 \d+px #000000d9/g)].length, layers);
  assert.match(css, new RegExp(`0 0 ${blur}px #000000d9`));
});

test('injectRemediationBlock: before </head>, and idempotent on re-run', () => {
  const html = '<html><head><style>.a{}</style></head><body></body></html>';
  const once = injectRemediationBlock(html, 'X');
  // The block lands inside <head>, AFTER the author styles (cascade tie-break).
  assert.ok(once.indexOf('<style>.a{}</style>') < once.indexOf(`id="${REMEDIATION_BLOCK_ID}"`));
  assert.ok(once.indexOf(`id="${REMEDIATION_BLOCK_ID}"`) < once.indexOf('</head>'));
  // Re-running REPLACES the block — never a second copy.
  const twice = injectRemediationBlock(once, 'Y');
  assert.equal([...twice.matchAll(new RegExp(REMEDIATION_BLOCK_ID, 'g'))].length, 1);
  assert.match(twice, /Y/);
  assert.doesNotMatch(twice, />\nX/);
});

test('injectRemediationBlock: falls back to </body>, then to append', () => {
  const body = injectRemediationBlock('<body>hi</body>', 'X');
  assert.ok(body.indexOf(REMEDIATION_BLOCK_ID) < body.indexOf('</body>'));
  const bare = injectRemediationBlock('<p>bare</p>', 'X');
  assert.ok(bare.indexOf(REMEDIATION_BLOCK_ID) > bare.indexOf('<p>'));
});
