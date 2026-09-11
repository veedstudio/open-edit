// Tests for applyTreatment — the ANALYTIC evaluation of a remediation.
//
// THE SAMPLING CONTRACT: sampling happens once and never moves. A decoration is
// painted OVER the footage, so its effect is computed against those constant
// samples rather than measured by re-sampling a re-render. This turns the
// statistics into the post-treatment statistics, so the ordinary summary path
// scores the result — one evaluator, not a special credited side-path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTreatment } from '../src/wcag/treat.ts';
import { solveClassShadow } from '../src/wcag/recommend.ts';
import { resolveVerdicts, type ClusterStat, type ElementStat, type Statistics } from '../src/wcag/verdicts.ts';
import type { ChoiceEntry } from '../src/wcag/wcag-choice.ts';

const Z3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const rgb = (v: number) => ({ r: v, g: v, b: v });
const cl = (v: number, weight = 1): ClusterStat => ({ color: rgb(v), weight, covariance: Z3 });

const element = (id: string, fgV: number, bgV: number): ElementStat => {
  const fg = { ...rgb(fgV), a: 1 };
  const clusters = [cl(bgV)];
  return {
    id, rect: { x: 0, y: 0, w: 100, h: 20 }, font_size: 16, font_weight: 400,
    steady_alpha: 1, fg, total_samples: 100, total_frames: 1,
    unscored_transient_frames: 0, sampled_transient_frames: 0, indeterminate: false,
    clusters: clusters.map((c) => ({ ...c, frames: [0] })),
    frames: [{ frame: 0, fg, font_size: 16, font_weight: 400, unsampled: false, clusters }],
  };
};

const stats = (...elements: ElementStat[]): Statistics => ({
  version: 1, fps: 30, audit_density_fps: 5, budget_overflow_frames: 0, elements,
});

const classOf = (map: Record<string, string>) => (id: string) => map[id] ?? null;
const failing = (s: Statistics) => resolveVerdicts(s).failingAA;

// One element with an explicit fg (alpha included) over one grey background.
const elementWith = (fg: { r: number; g: number; b: number; a: number }, bg: number): ElementStat => {
  const clusters = [cl(bg)];
  return {
    id: 't', rect: { x: 0, y: 0, w: 100, h: 20 }, font_size: 16, font_weight: 400,
    steady_alpha: fg.a, fg, total_samples: 100, total_frames: 1,
    unscored_transient_frames: 0, sampled_transient_frames: 0, indeterminate: false,
    clusters: clusters.map((c) => ({ ...c, frames: [0] })),
    frames: [{ frame: 0, fg, font_size: 16, font_weight: 400, unsampled: false, clusters }],
  };
};

// Amber on mid-grey: fails AA.
const AMBER_ON_GREY = () => stats(element('w1', 0xc8, 150), element('w2', 0xc8, 150));

test('a hard ring replaces the sampled background outright', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'shadow', hex: '#000000', selector: '.w', ids: ['w1', 'w2'],
    recipe: { style: 'hard', directions: 8, offset: 1.5 },
  };
  const before = AMBER_ON_GREY();
  assert.equal(failing(before), 2);
  const after = applyTreatment(before, [entry], classOf({ w1: 'w', w2: 'w' }));
  assert.equal(failing(after), 0, 'a full ring lifts both off the grey');
  // The samples were not re-measured — they were TRANSFORMED by the ring.
  assert.deepEqual(after.elements[0].frames[0].clusters.map((c) => c.color), [{ r: 0, g: 0, b: 0 }]);
});

// The blended background was round-tripped through an 8-bit grey, and the
// quantisation was enough to push a shadow the solver had just certified back
// below its required ratio — so the pass would promote a fix and then re-propose
// one for the class it had just fixed.
test('a solver-certified shadow still clears AA after the treatment is applied', () => {
  const BLACK = { r: 0, g: 0, b: 0 };
  let flipped: string[] = [];
  for (let bg = 0; bg <= 255; bg += 1) {
    for (const v of [255, 0]) {
      for (const alpha of [1, 0.9, 0.7]) {
        const fg = { r: v, g: v, b: v, a: alpha };
        const clusters = [{ color: { r: bg, g: bg, b: bg }, weight: 1 }];
        const solved = solveClassShadow([{ fg, clusters, requiredRatio: 4.5 }], BLACK, 2.0, 0.1);
        if (!solved || solved.worstRatio < 4.5) continue; // solver did not certify it
        const s = stats(elementWith(fg, bg));
        const entry = {
          level: 'AA' as const, kind: 'shadow' as const, hex: '#000000',
          selector: '#t', ids: ['t'],
          recipe: solved.recipe.style === 'hard'
            ? { style: 'hard' as const, directions: solved.recipe.directions, offset: solved.recipe.offset }
            : { style: 'soft' as const, layers: solved.recipe.layers, blur: solved.recipe.blur },
        };
        if (resolveVerdicts(applyTreatment(s, [entry], () => null)).failingAA > 0) {
          flipped.push(`bg=${bg} fg=${v}@${alpha}`);
        }
      }
    }
  }
  assert.deepEqual(flipped, [], `treatment must not undo what the solver certified`);
});

test('a colour choice repaints the text, leaving the background untouched', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'colour', hex: '#000000', selector: '.w', ids: ['w1', 'w2'],
  };
  const after = applyTreatment(AMBER_ON_GREY(), [entry], classOf({ w1: 'w', w2: 'w' }));
  assert.equal(failing(after), 0, 'black on mid-grey clears AA');
  assert.deepEqual(after.elements[0].frames[0].fg, { r: 0, g: 0, b: 0, a: 1 });
  // The footage did not change, so neither did what is behind the text.
  assert.deepEqual(after.elements[0].frames[0].clusters.map((c) => c.color), [rgb(150)]);
});

test('a background plate replaces what is behind AND anchors the text', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'background', hex: '#ffffff', backingHex: '#000000',
    selector: '.w', ids: ['w1', 'w2'],
  };
  const after = applyTreatment(AMBER_ON_GREY(), [entry], classOf({ w1: 'w', w2: 'w' }));
  assert.equal(failing(after), 0);
  assert.deepEqual(after.elements[0].frames[0].fg, { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(after.elements[0].frames[0].clusters.map((c) => c.color), [{ r: 0, g: 0, b: 0 }]);
});

test('elements no entry covers are returned untouched', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'shadow', hex: '#000000', selector: '#w1', ids: ['w1'],
    recipe: { style: 'hard', directions: 8, offset: 1.5 },
  };
  const before = AMBER_ON_GREY();
  const after = applyTreatment(before, [entry], classOf({}));
  assert.equal(failing(after), 1, 'only the covered element is lifted');
  assert.deepEqual(after.elements[1], before.elements[1]);
});

// ---------------------------------------------------------------------------
// THE ELEMENT'S OWN OPACITY DILUTES ITS DECORATION.
//
// A plate and a ring are painted BY the text element, so the element's opacity
// multiplies them exactly as it multiplies the glyph. Modelling them opaque
// credits a caption at 40% with a solid black box it never actually shows —
// `bg' = alpha*plate + (1-alpha)*footage`, and the footage keeps showing through.
// (The real per-run alphas are animation opacities — 0.9967, 0.9789 — not colour
// alphas, which is what settles the reading.)
// ---------------------------------------------------------------------------

// White text at 40% over mid-grey with a black plate: the plate renders as
// 0.4*black + 0.6*grey, nowhere near black, and the pair never reaches AA.
test('a plate at reduced opacity does NOT blank out the footage behind it', () => {
  const s = stats(elementWith({ r: 255, g: 255, b: 255, a: 0.4 }, 150));
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'background', hex: '#ffffff', backingHex: '#000000',
    selector: '#t', ids: ['t'],
  };
  const after = applyTreatment(s, [entry], () => null);
  assert.equal(failing(after), 1, 'a 40% plate must not be credited as a solid box');
  // The discriminator: at full opacity the very same plate DOES take over.
  const opaque = stats(elementWith({ r: 255, g: 255, b: 255, a: 1 }, 150));
  assert.equal(failing(applyTreatment(opaque, [entry], () => null)), 0);
});

test('a hard ring at reduced opacity does NOT replace the sampled background', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'shadow', hex: '#000000', selector: '#t', ids: ['t'],
    recipe: { style: 'hard', directions: 8, offset: 1.5 },
  };
  const s = stats(elementWith({ r: 255, g: 255, b: 255, a: 0.5 }, 150));
  const after = applyTreatment(s, [entry], () => null);
  const [c] = after.elements[0].frames[0].clusters;
  assert.ok(c.color.r > 0, `a 50% ring leaves the footage showing: got ${c.color.r}`);
  assert.equal(failing(after), 1, 'and the pair must not be credited as passing');
});

// Defence in depth behind validateChoiceEntry: a recipe that paints nothing is a
// silent no-op here, and a chosen option promotes unconditionally — so the pass
// would ship the original template reported as remediated.
test('a hard recipe that never reaches the ring is refused, not silently ignored', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'shadow', hex: '#000000', selector: '#t', ids: ['t'],
    recipe: { style: 'hard', directions: 8, offset: 1 },
  };
  assert.throws(
    () => applyTreatment(stats(elementWith({ r: 255, g: 255, b: 255, a: 1 }, 150)), [entry], () => null),
    /never reaches/,
  );
});

// A soft stack tints rather than replaces, so the background must still show
// through in proportion — this is what stops a weak recipe from being credited
// as if it were a ring.
test('a soft stack blends toward the shadow without erasing the background', () => {
  const entry: ChoiceEntry = {
    level: 'AA', kind: 'shadow', hex: '#000000', selector: '.w', ids: ['w1', 'w2'],
    recipe: { style: 'soft', layers: 1, blur: 4 },
  };
  const after = applyTreatment(AMBER_ON_GREY(), [entry], classOf({ w1: 'w', w2: 'w' }));
  const [c] = after.elements[0].frames[0].clusters;
  assert.ok(c.color.r > 0 && c.color.r < 150, `blended, not replaced: got ${c.color.r}`);
});
