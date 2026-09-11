import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestEffortColorAlpha,
  betterAnchor,
  compositeLuminance,
  contrastRatio,
  failureMassAlpha,
  feasibleSet,
  feasibleSetAlpha,
  feasibleSetIsEmpty,
  guaranteedFix,
  huePreservingCandidates,
  isLargeText,
  massBelowRatio,
  nearestBoundary,
  optionWithinBar,
  ratioFromLuminance,
  relativeLuminance,
  rollUpPolicy,
  solveHaloAlpha,
  targetLuminanceDarker,
  targetLuminanceLighter,
  threshold,
  toOklch,
  type RecCluster,
  type RunPolicyInput,
  type Srgb8,
} from '../src/wcag/policy.ts';

const rgb = (r: number, g: number, b: number): Srgb8 => ({ r, g, b });
const WHITE = rgb(255, 255, 255);
const BLACK = rgb(0, 0, 0);

const close = (actual: number, expected: number, tol: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} != ${expected} (tol ${tol})`);

// ---------------------------------------------------------------------------
// WCAG contrast model.
// ---------------------------------------------------------------------------

test('relative luminance: white 1, black 0 (channel weights sum to 1)', () => {
  close(relativeLuminance(WHITE), 1.0, 1e-12, 'white');
  close(relativeLuminance(BLACK), 0.0, 1e-12, 'black');
});

test('contrast ratio: white vs black = 21 exactly, symmetric', () => {
  // Derivation: (1 + 0.05) / (0 + 0.05) = 21.
  close(contrastRatio(WHITE, BLACK), 21.0, 1e-12, 'white/black');
  close(contrastRatio(BLACK, WHITE), 21.0, 1e-12, 'order-free');
});

test('contrast ratio: #767676 vs white ~ 4.5419 (the AA boundary gray)', () => {
  // Derivation: c = 118/255 = 0.4627451; ((c+0.055)/1.055)^2.4 =
  // 0.4907537^2.4 ~ 0.18116; ratio = 1.05 / 0.23116 ~ 4.5419. Discriminates
  // the transfer exponent (2.4) and the 0.055/1.055 constants.
  close(contrastRatio(rgb(0x76, 0x76, 0x76), WHITE), 4.5419, 5e-3, '#767676/white');
});

test('contrast ratio: pure red vs white ~ 3.9985 (fails AA normal, passes AA large)', () => {
  // Derivation: L(red) = 0.2126 * linearize(1.0) = 0.2126 exactly;
  // ratio = 1.05 / 0.2626 = 3.99848...
  const r = contrastRatio(rgb(255, 0, 0), WHITE);
  close(r, 3.99848, 1e-4, 'red/white');
  assert.ok(r < threshold('AA', 16, 400) && r >= threshold('AA', 24, 400));
});

test('thresholds: the WCAG table, driven by the large-text rule', () => {
  assert.equal(threshold('AA', 16, 400), 4.5);
  assert.equal(threshold('AA', 24, 400), 3.0);
  assert.equal(threshold('AAA', 16, 400), 7.0);
  assert.equal(threshold('AAA', 24, 400), 4.5);
  // Boundaries: >=24px any weight; >=18.66px at weight >=700.
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(23.99, 400), false);
  assert.equal(isLargeText(18.66, 700), true);
  assert.equal(isLargeText(18.66, 699), false);
  assert.equal(isLargeText(18.65, 700), false);
});

test('composite luminance: straight alpha blend of luminances', () => {
  close(compositeLuminance(0.5, 1.0, 0.1), 0.5, 1e-12, 'opaque = fg');
  close(compositeLuminance(0.5, 0.0, 0.1), 0.1, 1e-12, 'transparent = bg');
  // Derivation: 0.4*0.5 + 0.6*0.1 = 0.26.
  close(compositeLuminance(0.5, 0.4, 0.1), 0.26, 1e-12, 'blend');
});

// ---------------------------------------------------------------------------
// Feasibility solvers.
// ---------------------------------------------------------------------------

test('target luminances invert the ratio formula exactly', () => {
  // Derivation (darker, bg=white, r=4.5, opaque): (1.05/4.5) - 0.05 = 0.1833333...
  const d = targetLuminanceDarker(1.0, 4.5, 1.0);
  close(d, 1.05 / 4.5 - 0.05, 1e-12, 'darker target');
  close(ratioFromLuminance(d, 1.0), 4.5, 1e-12, 'darker target achieves r');
  // Derivation (lighter, bg=black, r=4.5, opaque): 4.5*0.05 - 0.05 = 0.175.
  const l = targetLuminanceLighter(0.0, 4.5, 1.0);
  close(l, 0.175, 1e-12, 'lighter target');
  close(ratioFromLuminance(l, 0.0), 4.5, 1e-12, 'lighter target achieves r');
});

test('feasible set on white at AA: dark side only', () => {
  const fs = feasibleSet([1.0], 4.5);
  close(fs.dark!, 0.18333333333333332, 1e-12, 'dark bound');
  // Lighter would need 4.5*1.05 - 0.05 = 4.675 > 1 -> no light side.
  assert.equal(fs.light, null);
});

test('feasible set: 50% alpha text on white cannot reach AA at all', () => {
  // Derivation: composited target 0.18333 needs raw text luminance
  // (0.18333 - 0.5*1)/0.5 = -0.633 < 0; light side needs (4.675-0.5)/0.5 =
  // 8.35 > 1. Both sides infeasible -> empty set.
  assert.equal(feasibleSetIsEmpty(feasibleSetAlpha([1.0], 4.5, 0.5)), true);
  // Sanity discriminator: opaque text on white IS feasible.
  assert.equal(feasibleSetIsEmpty(feasibleSetAlpha([1.0], 4.5, 1.0)), false);
});

test('nearest boundary picks the closer side; dark wins ties', () => {
  const fs = { dark: 0.2, light: 0.8 };
  assert.deepEqual(nearestBoundary(fs, 0.3), ['dark', 0.2]); // 0.1 < 0.5
  assert.deepEqual(nearestBoundary(fs, 0.75), ['light', 0.8]); // 0.05 < 0.55
  assert.deepEqual(nearestBoundary(fs, 0.5), ['dark', 0.2]); // tie -> dark
  assert.equal(nearestBoundary({ dark: null, light: null }, 0.5), null);
});

// ---------------------------------------------------------------------------
// Halo / guaranteed fix.
// ---------------------------------------------------------------------------

test('halo solver: mid-gray at AA -> black halo (higher ratio than white)', () => {
  // Derivation: L(#767676) ~ 0.18116. Over black: (0.23116)/(0.05) = 4.623 >=
  // 4.5. Over white: 1.05/0.23116 = 4.542 >= 4.5. Both pass -> argmax = black.
  assert.deepEqual(solveHaloAlpha(rgb(0x76, 0x76, 0x76), 4.5, 1.0), BLACK);
});

test('halo solver: mid-gray at 7.0 -> no halo (both extremes below 7)', () => {
  assert.equal(solveHaloAlpha(rgb(0x76, 0x76, 0x76), 7.0, 1.0), null);
});

test('halo solver: white text -> black halo (21:1)', () => {
  assert.deepEqual(solveHaloAlpha(WHITE, 4.5, 1.0), BLACK);
});

// THE LADDER'S GUARANTEE, stated precisely.
//
// Claim: for bright text a dark enough halo always reaches AA, and for dark text
// a bright enough one does. That is TRUE — but only for OPAQUE text, and only for
// a SOLID halo (coverage 1.0). Both qualifiers are load-bearing: the soft-shadow
// rung the pass actually offers cannot reach coverage 1.0 (see
// tests/wcag-recommend.test.ts), which is why the background rung has to exist.
//
// Why it holds: over black the ratio is (L+0.05)/0.05, which clears 4.5 once
// L >= 0.175; over white it is 1.05/(L+0.05), which clears 4.5 while L <= 0.1833.
// The two intervals OVERLAP, so no luminance falls between them.
test('solid halo: EVERY opaque text colour has a black-or-white halo that clears AA', () => {
  for (let v = 0; v <= 255; v++) {
    assert.ok(solveHaloAlpha(rgb(v, v, v), 4.5, 1.0), `grey ${v} must have a halo at AA`);
    assert.ok(solveHaloAlpha(rgb(v, v, v), 3.0, 1.0), `grey ${v} must have a halo at AA-large`);
  }
  // Not just greys: the argument is about luminance, so it covers the cube.
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        assert.ok(solveHaloAlpha(rgb(r, g, b), 4.5, 1.0), `rgb(${r},${g},${b}) must have a halo`);
      }
    }
  }
});

// The negative discriminator: the sweep above is not vacuous, and the guarantee
// is specifically about OPACITY. Compositing mixes the text into the halo, so a
// translucent run can sit in the gap the opaque case cannot.
test('solid halo: the guarantee is opacity-dependent, and fails once text is faded', () => {
  const unsolvable = (a: number) => {
    let n = 0;
    for (let v = 0; v <= 255; v++) if (!solveHaloAlpha(rgb(v, v, v), 4.5, a)) n++;
    return n;
  };
  assert.equal(unsolvable(1.0), 0, 'opaque text is always solvable');
  assert.ok(unsolvable(0.9) > 0, 'a 10% fade already opens a gap');
  assert.ok(unsolvable(0.5) > unsolvable(0.9), 'more fade, wider gap');
});

test('guaranteedFix: halo when feasible, else recolor-to-anchor + backing', () => {
  // Mid-gray at 4.5: the halo above.
  assert.deepEqual(guaranteedFix(rgb(0x76, 0x76, 0x76), 4.5, 1.0), { kind: 'halo', color: BLACK });
  // Mid-gray at 7.0: halo infeasible; the fg is Oklab-light (L ~ cbrt(0.181)
  // ~ 0.57 >= 0.5) -> anchor WHITE, backing = argmax halo for white = black.
  assert.deepEqual(guaranteedFix(rgb(0x76, 0x76, 0x76), 7.0, 1.0), {
    kind: 'recolor_with_backing', color: WHITE, backing: BLACK,
  });
});

test('guaranteedFix: near-invisible text (alpha 0.02) has NO guaranteed fix', () => {
  // Derivation: fg #767676 at a=0.02 over a black halo composites to
  // 0.02*0.18116 = 0.0036 -> ratio 1.07; over white to 0.9836 -> ratio 1.016.
  // The white-anchor backing fails the same way -> null.
  assert.equal(guaranteedFix(rgb(0x76, 0x76, 0x76), 4.5, 0.02), null);
});

test('betterAnchor: Oklab lightness picks the preserving anchor', () => {
  assert.deepEqual(betterAnchor(rgb(0xee, 0xee, 0xee)), WHITE);
  assert.deepEqual(betterAnchor(rgb(0x10, 0x10, 0x10)), BLACK);
});

// ---------------------------------------------------------------------------
// Failure mass / acceptability bar.
// ---------------------------------------------------------------------------

const MIX: RecCluster[] = [
  { color: WHITE, weight: 0.9 },
  { color: BLACK, weight: 0.1 },
];

test('failure mass: black text on a 90/10 white/black mix fails only the black 10%', () => {
  // Derivation: black-on-white 21 (pass), black-on-black 1 (fail) -> mass 0.1,
  // worst ratio 1.0 at cluster index 1.
  const [mass, worstRatio, worstIdx] = failureMassAlpha(BLACK, MIX, 4.5, 1.0);
  close(mass, 0.1, 1e-12, 'mass');
  close(worstRatio, 1.0, 1e-12, 'worst ratio');
  assert.equal(worstIdx, 1);
});

test('mass below floor: the catastrophic (sub-2.0) share', () => {
  close(massBelowRatio(BLACK, MIX, 2.0, 1.0), 0.1, 1e-12, 'black-on-black is below 2.0');
  close(massBelowRatio(BLACK, MIX, 0.5, 1.0), 0.0, 1e-12, 'nothing below 0.5 (ratios are >= 1)');
});

test('optionWithinBar: mass <= bar AND catastrophic mass <= bar/10, boundaries inclusive', () => {
  assert.equal(optionWithinBar(0.1, 0.01, 0.1), true);
  assert.equal(optionWithinBar(0.1, 0.011, 0.1), false); // catastrophic share breaches
  assert.equal(optionWithinBar(0.101, 0.0, 0.1), false); // total mass breaches
});

// ---------------------------------------------------------------------------
// Candidates.
// ---------------------------------------------------------------------------

test('best-effort colour finds the between-luminances window on a black+white mix', () => {
  // Derivation: the two-sided feasible set is empty (nothing is darker than
  // black's lighter-bound AND lighter than white's... both sides collapse),
  // but any text luminance in [0.175, 0.18333] clears 4.5 against BOTH white
  // and black. The boundary candidates land there -> winning mass 0.
  const clusters: RecCluster[] = [{ color: WHITE, weight: 0.5 }, { color: BLACK, weight: 0.5 }];
  assert.equal(feasibleSetIsEmpty(feasibleSet([1.0, 0.0], 4.5)), true);
  const [c] = bestEffortColorAlpha(rgb(0x99, 0x99, 0x99), clusters, 4.5, 1.0);
  const [mass] = failureMassAlpha(c, clusters, 4.5, 1.0);
  close(mass, 0.0, 1e-12, 'winner clears both extremes');
});

test('hue-preserving candidates: fg seeded first; chroma-bearing candidates keep the hue', () => {
  const fg = rgb(0xcc, 0x44, 0x44);
  const [, , fgHue] = toOklch(fg);
  const cands = huePreservingCandidates(fg, [{ color: WHITE, weight: 1.0 }], 4.5, 1.0);
  assert.deepEqual(cands[0][0], fg, 'the unchanged fg is the zero-change seed');
  let checked = 0;
  for (const [c, strategy] of cands.slice(1)) {
    if (strategy !== 'hue_preserving') continue;
    const [, , hue] = toOklch(c);
    // u8 quantization wobbles the realized hue slightly; 2 degrees bounds it.
    const d = Math.abs(((hue - fgHue + 540) % 360) - 180);
    assert.ok(d < 2.0, `candidate hue ${hue} drifted from fg hue ${fgHue}`);
    checked += 1;
  }
  assert.ok(checked > 0, 'expected at least one hue-preserving realization');
  // And at least one candidate actually clears AA on white.
  assert.ok(
    cands.some(([c]) => failureMassAlpha(c, [{ color: WHITE, weight: 1.0 }], 4.5, 1.0)[0] === 0),
    'some candidate passes 4.5 on white',
  );
});

test('hue-preserving candidates: achromatic fg labels everything anchor', () => {
  const cands = huePreservingCandidates(rgb(0x77, 0x77, 0x77), [{ color: WHITE, weight: 1.0 }], 4.5, 1.0);
  assert.ok(cands.every(([, s]) => s === 'anchor'), 'no hue to preserve -> anchor labels only');
});

// ---------------------------------------------------------------------------
// Class roll-up.
// ---------------------------------------------------------------------------

const input = (over: Partial<RunPolicyInput> & { id: string }): RunPolicyInput => {
  const clusters = over.clusters ?? [{ color: WHITE, weight: 1.0 }];
  return {
    className: null,
    fg: rgb(0x99, 0x99, 0x99), // ~2.85:1 on white -> fails AA normal
    fgAlpha: 1.0,
    requiredRatio: 4.5,
    bgLums: clusters.map((c) => relativeLuminance(c.color)),
    clusters,
    totalSamples: 100,
    indeterminate: false,
    passes: false,
    ...over,
  };
};

test('roll-up: a passing class is tier 0 with nothing to say', () => {
  const [c] = rollUpPolicy([input({ id: 'a', fg: BLACK, passes: true })], 0.1, 2.0);
  assert.equal(c.tier, 0);
  assert.deepEqual(c.recolorOptions, []);
  assert.deepEqual(c.exceptions, []);
});

test('roll-up: failing gray-on-white class -> tier 1, within-bar recolor, no exceptions', () => {
  // Derivation: #999999 on white is 2.85 < 4.5; the dark boundary (luminance
  // <= 0.18333) is feasible and clears the single white cluster completely ->
  // lead mass 0 -> tier 1. Same clusters for both members -> the class colour
  // covers them -> no exceptions.
  const rolled = rollUpPolicy(
    [input({ id: 'a', className: 'w' }), input({ id: 'b', className: 'w' })], 0.1, 2.0,
  );
  assert.equal(rolled.length, 1);
  const c = rolled[0];
  assert.equal(c.classKey, '.w');
  assert.equal(c.tier, 1);
  assert.equal(c.recolorOptions[0].fix.kind, 'recolor');
  assert.equal(c.recolorOptions[0].withinBar, true);
  close(c.recolorOptions[0].estimatedFailure.mass, 0.0, 1e-12, 'lead clears the class');
  assert.deepEqual(c.exceptions, []);
});

test('roll-up: an indeterminate member becomes a tier-3 exception', () => {
  const rolled = rollUpPolicy(
    [input({ id: 'a', className: 'w' }), input({ id: 'b', className: 'w', indeterminate: true, clusters: [] })],
    0.1, 2.0,
  );
  const c = rolled[0];
  assert.equal(c.tier, 3);
  assert.deepEqual(c.exceptions.map((e) => [e.id, e.indeterminate]), [['b', true]]);
});

test('roll-up: a member the class colour cannot cover gets its own exception (tier 2)', () => {
  // Derivation: member a (99 samples) sits on white; member b (1 sample) sits
  // on #595959 (luminance ~0.0999). The two-sided feasible set over
  // {white, #595959} is empty (dark needs <= -0.0167 vs #595959; light needs
  // >= 4.675 vs white), so the class lead comes from the within-bar
  // hue-preserving ladder: a dark colour that clears white and concedes b's
  // cluster — pooled mass 0.01 <= bar 0.1, catastrophic 0.01 <= 0.01 ->
  // within bar, tier 2 (mass != 0). Against member b ALONE the class colour
  // fails outright (mass 1), so b gets an exception; b's own light-side
  // recolor (>= 0.6243 luminance vs #595959) exists and is within bar.
  const rolled = rollUpPolicy(
    [
      input({ id: 'a', className: 'w', totalSamples: 99 }),
      input({
        id: 'b', className: 'w', totalSamples: 1,
        clusters: [{ color: rgb(0x59, 0x59, 0x59), weight: 1.0 }],
      }),
    ],
    0.1, 2.0,
  );
  const c = rolled[0];
  assert.equal(c.tier, 2);
  assert.equal(c.recolorOptions[0].withinBar, true);
  close(c.recolorOptions[0].estimatedFailure.mass, 0.01, 1e-9, 'class lead concedes exactly b');
  assert.equal(c.exceptions.length, 1);
  assert.equal(c.exceptions[0].id, 'b');
  assert.equal(c.exceptions[0].indeterminate, false);
  assert.equal(c.exceptions[0].recolorOptions[0].withinBar, true, 'b has its own full fix');
});

test('roll-up: classes keyed and ordered deterministically (.name / #id, sorted)', () => {
  const rolled = rollUpPolicy(
    [input({ id: 'solo' }), input({ id: 'x', className: 'w' })], 0.1, 2.0,
  );
  assert.deepEqual(rolled.map((c) => c.classKey), ['#solo', '.w']);
});
