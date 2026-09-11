// Tests for the SHADOW solver (the Gaussian falloff model behind the shadow rung).
//
// Numeric expectations are DERIVED from the model's own primitives, never
// golden-copied: a change to the coverage formula must move the assertion and the
// implementation together, or these fail.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHADOW_ALPHA,
  hardRingCoverage,
  layerCoverage,
  phi,
  ringCoverage,
  shadowFailure,
  solveClassShadow,
  solveClassShadowRecipe,
  solveShadowRecipe,
} from "../src/wcag/recommend.ts";
import {
  compositeLuminance,
  ratioFromLuminance,
  relativeLuminance,
} from "../src/wcag/policy.ts";

test("falloff model: phi pins Phi(-1); layer coverage is 0 at blur 0 and monotone in blur/offset", () => {
  // phi(x) = 0.5(1+erf(x/sqrt2)) with A&S 7.1.26 erf. Pin the standard-normal CDF.
  assert.ok(Math.abs(phi(-1) - 0.15865526383236372) < 1e-7, `phi(-1)=${phi(-1)}`);

  // A blur-0 layer paints nothing -> ZERO coverage (no credit).
  assert.equal(layerCoverage(SHADOW_ALPHA, 0, 0, 0), 0);
  // Wider blur -> more ring coverage (sigma grows, -d_eff/sigma -> 0-, phi rises).
  const c = [4, 8, 12, 16].map((b) => layerCoverage(SHADOW_ALPHA, b, 0, 0));
  assert.ok(c[0] < c[1] && c[1] < c[2] && c[2] < c[3], `blur monotonic: ${c}`);
  // Larger offset -> LESS coverage at the ring (d_eff grows).
  assert.ok(layerCoverage(SHADOW_ALPHA, 8, 2, 0) < layerCoverage(SHADOW_ALPHA, 8, 0, 0));
  // Derivation: blur 16 centered => sigma 8, d_eff 1, C = 0.85*phi(-0.125) ~= 0.3827.
  assert.ok(Math.abs(c[3] - 0.85 * phi(-1 / 8)) < 1e-12);
});

test("shadowFailure blends per layer at its own coverage; rating moves with the clusters", () => {
  const fg = { r: 230, g: 184, b: 102, a: 1 } as const;
  const shadow = { r: 0, g: 0, b: 0 } as const;
  const C = layerCoverage(SHADOW_ALPHA, 12, 0, 0);
  const onLight = shadowFailure(fg, shadow, [C, C], [{ color: { r: 210, g: 205, b: 200 }, weight: 1 }], 3, 2);
  const onDark = shadowFailure(fg, shadow, [C, C], [{ color: { r: 40, g: 40, b: 46 }, weight: 1 }], 3, 2);
  assert.notEqual(onLight.worstRatio, onDark.worstRatio); // background-dependent
  // More layers -> darker blended bg -> higher amber-vs-blended ratio.
  const one = shadowFailure(fg, shadow, [C], [{ color: { r: 150, g: 150, b: 150 }, weight: 1 }], 3, 2);
  const four = shadowFailure(fg, shadow, [C, C, C, C], [{ color: { r: 150, g: 150, b: 150 }, weight: 1 }], 3, 2);
  assert.ok(four.worstRatio > one.worstRatio);
});

// ONE COVERAGE MODEL.
//
// Coverage at the 1px ring is  alpha * Phi((reach - 1) / sigma), where sigma is
// blur/2 and `reach` is the offset's component along the LEAST-covered ring
// point's outward normal. For n evenly spaced directions that component is
// offset*cos(pi/n) — which is max_i min_n (u_i . n), so it degrades gracefully:
//
//   n = 1  ->  cos(pi)      = -1      one shadow, worst direction: offset HURTS
//   n = 2  ->  cos(pi/2)    =  0      two opposite copies: the gap is broadside
//   n = 4  ->  cos(pi/4)    =  0.707
//   n = 8  ->  cos(pi/8)    =  0.924  the faux-outline ring
//
// and sigma -> 0 is a STEP rather than a special case, which is what lets a hard
// shadow say "the immediate outline is entirely mine".

// The Rust analyzer mirrors this falloff, so the single-shadow case must keep
// returning exactly what the published closed form does. The reference here is
// computed independently, not by calling the implementation.
test("ring coverage: the single-shadow case still matches the published closed form", () => {
  for (const alpha of [1.0, 0.85, 0.5]) {
    for (const blur of [1, 4, 8, 16]) {
      for (const off of [0, 1, 2.5]) {
        const expected = alpha * phi(-(1 + off) / (blur / 2)); // alpha * Phi(-d_eff/sigma)
        assert.ok(
          Math.abs(ringCoverage(alpha, blur, off, 1) - expected) < 1e-12,
          `alpha ${alpha} blur ${blur} offset ${off}`,
        );
        // And the old entry point keeps agreeing with it.
        assert.equal(layerCoverage(alpha, blur, off, 0), ringCoverage(alpha, blur, off, 1));
      }
    }
  }
});

test("ring coverage: blur 0 is a step, so a hard ring takes the ring outright", () => {
  // A CENTERED hard shadow sits under the glyph and reaches nothing outside it.
  assert.equal(ringCoverage(1.0, 0, 0, 1), 0);
  // A single hard shadow is rated at its worst direction, where it has moved AWAY.
  assert.equal(ringCoverage(1.0, 0, 3, 1), 0);
  // A ring of 8 at 1.5px reaches 1.386px along the worst normal -> the whole ring.
  assert.equal(ringCoverage(1.0, 0, 1.5, 8), 1.0);
  assert.equal(ringCoverage(1.0, 0, 1.0, 8), 0, "0.924px falls short of the 1px ring");
});

// The case NEITHER old function could express: a ring that is also blurred. The
// old layerCoverage read it as a lone shadow moving away; hardRingCoverage only
// knew blur 0.
test("ring coverage: a softened ring sits between the hard ring and a lone shadow", () => {
  const hard = ringCoverage(1.0, 0, 1.5, 8);
  const soft = ringCoverage(1.0, 6, 1.5, 8);
  const lone = ringCoverage(1.0, 6, 1.5, 1);
  assert.equal(hard, 1.0);
  assert.ok(soft < hard, `a blurred ring gives up some coverage (${soft.toFixed(4)})`);
  assert.ok(soft > lone, `but keeps far more than one shadow moving away (${lone.toFixed(4)})`);
  assert.ok(soft > 0.5, `and still covers most of the ring (${soft.toFixed(4)})`);
});

// A HARD (zero-blur) shadow is not a Gaussian at all: it is the glyph itself,
// translated. It therefore paints whatever it lands on FULLY instead of falling
// off — which is why the soft model rates it zero and cannot represent it.
//
// One offset covers the ring on one side only, so the guarantee comes from a RING
// of them (the 8-way faux-outline lint-template.ts already points at). The
// least-covered point sits midway between two adjacent directions, where the
// offset's component along that point's outward normal is offset·cos(pi/n) — that
// projection is what has to reach the 1px ring.
test("hard ring: coverage is worst-case across directions, not an average", () => {
  // 8 directions are 45 deg apart, so the worst point is 22.5 deg off an offset:
  // reach = offset * cos(22.5 deg) = offset * 0.9239. It needs >= 1px.
  assert.equal(hardRingCoverage(1.0, 1.5, 8), 1.0, "1.5px 8-way reaches the ring (1.386)");
  assert.equal(hardRingCoverage(1.0, 1.0, 8), 0, "1.0px 8-way falls short (0.924)");
  // Fewer directions leave wider gaps, so they need a longer offset.
  assert.equal(hardRingCoverage(1.0, 1.5, 4), 1.0, "1.5px 4-way reaches it (1.061)");
  assert.equal(hardRingCoverage(1.0, 1.2, 4), 0, "1.2px 4-way falls short (0.849)");
  // Coverage is the shadow's own alpha where it lands — nothing is diluted.
  assert.equal(hardRingCoverage(0.5, 2.0, 8), 0.5);
  // Degenerate input paints nothing.
  assert.equal(hardRingCoverage(1.0, 0, 8), 0);
});

// ---------------------------------------------------------------------------
// A STRONG SHADOW OVERRIDES THE SAMPLES.
//
// Once a treatment covers the ring completely, what the sampler saw stops
// mattering: the adjacent colour IS the shadow colour, so the rating is fg over
// that colour and nothing else. These pin that as an exact identity, because it
// is the whole reason the shadow rung can carry a guarantee.
//
// The fixtures are HOSTILE on purpose — one caption over bright sky AND dark
// shadow. Ordinary backgrounds make this vacuous: text that fails over white
// passes over black, so there is nothing to compare.
// ---------------------------------------------------------------------------

const HOSTILE: Record<string, { color: { r: number; g: number; b: number }; weight: number }[]> = {
  "sky+shadow": [{ color: { r: 255, g: 255, b: 255 }, weight: 0.5 }, { color: { r: 0, g: 0, b: 0 }, weight: 0.5 }],
  "three-way": [
    { color: { r: 250, g: 250, b: 250 }, weight: 0.34 },
    { color: { r: 10, g: 10, b: 10 }, weight: 0.33 },
    { color: { r: 128, g: 128, b: 128 }, weight: 0.33 },
  ],
  "near-extremes": [{ color: { r: 240, g: 240, b: 240 }, weight: 0.6 }, { color: { r: 20, g: 20, b: 20 }, weight: 0.4 }],
  flat: [{ color: { r: 128, g: 128, b: 128 }, weight: 1 }],
};

// The reference rating, computed from the policy primitives rather than by
// calling the code under test.
const ratioOver = (fg: { r: number; g: number; b: number; a: number }, behind: { r: number; g: number; b: number }) => {
  const lB = relativeLuminance(behind);
  return ratioFromLuminance(compositeLuminance(relativeLuminance(fg), fg.a, lB), lB);
};

// OPAQUE text only. The element's own opacity dilutes its ring by the same
// factor it dilutes the glyph, so below 1 the samples come back — see
// "full coverage at reduced opacity" below, which is the other half of this.
test("full coverage: the rating EQUALS fg-over-shadow exactly, whatever was sampled", () => {
  const BLACK = { r: 0, g: 0, b: 0 };
  for (const fg of [{ r: 200, g: 200, b: 200, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, { r: 230, g: 184, b: 102, a: 1 }]) {
    const expected = ratioOver(fg, BLACK);
    for (const name of Object.keys(HOSTILE)) {
      const got = shadowFailure(fg, BLACK, [1.0], HOSTILE[name], 4.5, 2.0).worstRatio;
      // EXACT, not epsilon: compositeLuminance(L, 1.0, bg) drops the bg term
      // outright, so any drift here is a structural regression, not float noise.
      assert.equal(got, expected, `${name} must not influence a fully covered ring`);
    }
  }
});

test("full coverage: every sampled background collapses to ONE rating", () => {
  const fg = { r: 200, g: 200, b: 200, a: 1 };
  const ratings = Object.keys(HOSTILE).map((n) => shadowFailure(fg, { r: 0, g: 0, b: 0 }, [1.0], HOSTILE[n], 4.5, 2.0).worstRatio);
  assert.equal(new Set(ratings).size, 1, `expected one rating, got ${ratings.join(", ")}`);
});

// The discriminator that keeps the two above honest: if someone ever made every
// shadow full-coverage, they would still pass while saying nothing. A soft stack
// at its strongest must still move with the background.
test("soft stack at its STRONGEST is still sample-dependent", () => {
  const fg = { r: 200, g: 200, b: 200, a: 1 };
  const C = layerCoverage(SHADOW_ALPHA, 16, 0, 0); // the widest blur offered
  const ratings = Object.keys(HOSTILE).map((n) =>
    shadowFailure(fg, { r: 0, g: 0, b: 0 }, Array(4).fill(C), HOSTILE[n], 4.5, 2.0).worstRatio,
  );
  assert.equal(new Set(ratings).size, Object.keys(HOSTILE).length, "the ~14.5% bleed must still show through");
});

test("coverage converges monotonically onto the fg-over-shadow rating", () => {
  const fg = { r: 200, g: 200, b: 200, a: 1 };
  const BLACK = { r: 0, g: 0, b: 0 };
  const clusters = HOSTILE["three-way"];
  const ratings = [0.5, 0.8, 0.9, 0.99].map((c) => shadowFailure(fg, BLACK, [c], clusters, 4.5, 2.0).worstRatio);
  for (let i = 1; i < ratings.length; i++) {
    assert.ok(ratings[i] > ratings[i - 1], `rating must rise with coverage: ${ratings.join(" -> ")}`);
  }
  const full = shadowFailure(fg, BLACK, [1.0], clusters, 4.5, 2.0).worstRatio;
  assert.ok(full > ratings[ratings.length - 1]);
  assert.equal(full, ratioOver(fg, BLACK), "and lands exactly on the halo rating");
});

// THE RESTORED GUARANTEE.
//
// tests/wcag-policy.test.ts proves a SOLID halo rescues every opaque text colour.
// The soft stack could not inherit that (116 of 256 greys had no recipe over a
// white background). A hard ring replaces the adjacent background outright, so
// the shadow rung now matches the solid-halo result exactly — which is the whole
// reason for modelling it.
test("shadow rung: with the hard ring, EVERY opaque text colour is rescuable", () => {
  const onWhite = [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }];
  const rescuable = (v: number, solve: typeof solveClassShadow) => {
    const members = [{ fg: { r: v, g: v, b: v, a: 1 }, clusters: onWhite, requiredRatio: 4.5 }];
    return !!(solve(members, { r: 0, g: 0, b: 0 }, 2.0, 0.1) || solve(members, { r: 255, g: 255, b: 255 }, 2.0, 0.1));
  };
  const unrescued = (solve: typeof solveClassShadow) => {
    let n = 0;
    for (let v = 0; v <= 255; v++) if (!rescuable(v, solve)) n++;
    return n;
  };
  // The soft stack alone leaves a large band unrescued — the negative
  // discriminator that keeps this test honest.
  assert.ok(unrescued(solveClassShadowRecipe) > 100, 'the soft stack alone must still fall short');
  assert.equal(unrescued(solveClassShadow), 0, 'the hard ring closes the band completely');
});

// THE BOUND ON THAT GUARANTEE: the element's own opacity.
//
// A ring is painted BY the text element, so the element's opacity multiplies it
// exactly as it multiplies the glyph — a 60% caption shows a 60% ring, and the
// footage keeps showing through at 40% no matter how many copies are stacked.
// The reach the ring buys is therefore bounded by the opacity, and the solver
// has to return null rather than certify a halo the render will not produce.
test("shadow rung: the element's own opacity dilutes its ring, and bounds the reach", () => {
  const onWhite = [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }];
  const white = (a: number) => [{ fg: { r: 255, g: 255, b: 255, a }, clusters: onWhite, requiredRatio: 4.5 }];
  const black = { r: 0, g: 0, b: 0 };
  // Opaque white on white is the case the ring exists for, and it still holds.
  assert.ok(solveClassShadow(white(1), black, 2.0, 0.1), 'the ring still rescues opaque text');
  // At 60% the darkest reachable adjacent colour is 0.4 * white — far from black.
  assert.equal(solveClassShadow(white(0.6), black, 2.0, 0.1), null, 'no ring survives 60% opacity here');
  assert.equal(solveClassShadow(white(0.2), black, 2.0, 0.1), null, 'and none at 20%');
  // The ring still buys real reach the soft stack cannot, once the footage is
  // dark enough to work with: 60% white over mid-grey clears only with the ring.
  const onGrey = [{ color: { r: 128, g: 128, b: 128 }, weight: 1 }];
  const dimmed = [{ fg: { r: 255, g: 255, b: 255, a: 0.6 }, clusters: onGrey, requiredRatio: 4.5 }];
  assert.equal(solveClassShadowRecipe(dimmed, black, 2.0, 0.1), null, 'no soft stack at 60% over grey');
  assert.equal(solveClassShadow(dimmed, black, 2.0, 0.1)?.recipe.style, 'hard', 'the ring rescues it');
});

test("full coverage at reduced opacity: the samples still show through", () => {
  const BLACK = { r: 0, g: 0, b: 0 };
  const fg = { r: 255, g: 255, b: 255, a: 0.6 };
  const ratings = Object.keys(HOSTILE).map((n) => shadowFailure(fg, BLACK, [1.0], HOSTILE[n], 4.5, 2.0).worstRatio);
  assert.ok(
    new Set(ratings).size > 1,
    `a 60% ring cannot override what is behind it, got one rating: ${ratings.join(", ")}`,
  );
});

// WHY THE BACKGROUND RUNG EXISTS.
//
// A SOLID halo rescues every opaque text colour (proved in tests/wcag-policy.test.ts).
// A SOFT shadow does not inherit that guarantee: the recipe space tops out at 4
// layers of 16px, and each layer only covers `alpha·phi(-d/sigma)` of the edge
// ring, so the stack's compounded coverage is ~0.855 — about 14.5% of the real
// background still shows through and keeps dragging the ratio down. These pin
// where that leaves the ladder, so a future change to the space has to restate
// the trade rather than silently move it.
test("soft shadow: the stack cannot reach full coverage, so background always bleeds through", () => {
  const C = layerCoverage(SHADOW_ALPHA, 16, 0, 0); // the widest blur offered
  const aEff = 1 - Math.pow(1 - C, 4); // the most layers offered
  assert.ok(C < 0.4, `per-layer coverage is ${C.toFixed(4)}, far from opaque`);
  assert.ok(aEff > 0.85 && aEff < 0.86, `compounded coverage is ${aEff.toFixed(4)}`);
  assert.ok(1 - aEff > 0.14, "the residual bleed is what breaks the solid-halo guarantee");
});

test("soft shadow: pure white text IS rescued on the worst background", () => {
  // White on white is the hardest bright case: the background cannot get lighter.
  // Darkening it enough leaves white-vs-blended clearing AA.
  const solved = solveShadowRecipe(
    { r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0 },
    [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }], 4.5, 2.0, 0.1,
  );
  assert.ok(solved, "pure white opaque text must be rescuable by a dark shadow");
  assert.ok(solved!.worstRatio >= 4.5);
});

// The shadow rung prefers the SOFT stack (the lighter look), and falls back to a
// hard outline only when no soft recipe covers the class. A hard ring replaces
// the adjacent background outright, so it inherits the solid-halo guarantee that
// the soft stack cannot reach.
test("solveClassShadow: keeps the soft stack when one covers the class", () => {
  const solved = solveClassShadow(
    [{ fg: { r: 230, g: 184, b: 102, a: 1 }, clusters: [{ color: { r: 150, g: 150, b: 150 }, weight: 1 }], requiredRatio: 4.5 }],
    { r: 0, g: 0, b: 0 }, 2.0, 0.1,
  );
  assert.ok(solved);
  assert.equal(solved!.recipe.style, "soft", "a soft recipe exists here, so it leads");
});

test("solveClassShadow: falls back to a hard outline for text no soft stack rescues", () => {
  // #c8c8c8 on white: proved above to have no soft recipe at either colour.
  const members = [{
    fg: { r: 0xc8, g: 0xc8, b: 0xc8, a: 1 },
    clusters: [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }],
    requiredRatio: 4.5,
  }];
  const solved = solveClassShadow(members, { r: 0, g: 0, b: 0 }, 2.0, 0.1);
  assert.ok(solved, "a hard outline must rescue what the soft stack cannot");
  assert.equal(solved!.recipe.style, "hard");
  assert.ok(solved!.worstRatio >= 4.5, `offered outline must clear AA, got ${solved!.worstRatio}`);
});

test("solveClassShadow: a hard outline must clear EVERY member, not just one", () => {
  // Two members over different backgrounds; the ring replaces both backgrounds,
  // so the verdict rests on each member's own foreground and alpha.
  const members = [
    { fg: { r: 0xc8, g: 0xc8, b: 0xc8, a: 1 }, clusters: [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }], requiredRatio: 4.5 },
    { fg: { r: 0xc8, g: 0xc8, b: 0xc8, a: 0.1 }, clusters: [{ color: { r: 20, g: 20, b: 20 }, weight: 1 }], requiredRatio: 4.5 },
  ];
  // The faded member composites almost entirely into the ring colour, so nothing
  // rescues the pair — and the solver must say so rather than cover the first.
  assert.equal(solveClassShadow(members, { r: 0, g: 0, b: 0 }, 2.0, 0.1), null);
});

test("soft shadow: MID-bright text is NOT rescued, at either shadow colour", () => {
  // "A dark enough shadow always works for bright text" holds for a solid halo
  // but not here: #c8c8c8 is bright, yet no recipe in the space rescues it over
  // white — the bleed keeps the blended background too light.
  const clusters = [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }];
  const fg = { r: 0xc8, g: 0xc8, b: 0xc8, a: 1 };
  assert.equal(solveShadowRecipe(fg, { r: 0, g: 0, b: 0 }, clusters, 4.5, 2.0, 0.1), null);
  assert.equal(solveShadowRecipe(fg, { r: 255, g: 255, b: 255 }, clusters, 4.5, 2.0, 0.1), null);
});

test("soft shadow: even pure white stops being rescuable once the text is faded", () => {
  const clusters = [{ color: { r: 255, g: 255, b: 255 }, weight: 1 }];
  const at = (a: number) =>
    solveShadowRecipe({ r: 255, g: 255, b: 255, a }, { r: 0, g: 0, b: 0 }, clusters, 4.5, 2.0, 0.1);
  assert.ok(at(1.0), "opaque white is rescuable");
  assert.equal(at(0.6), null, "a 40% fade puts white text beyond the space");
});

test("shadow SOLVER proposes the minimal recipe (fewer layers, then smaller blur) that clears the ratio", () => {
  // fg amber (230,184,102), black shadow, one mid-gray cluster (150,150,150, lum 0.305), req 3.0.
  const fg = { r: 230, g: 184, b: 102, a: 1 } as const;
  const shadow = { r: 0, g: 0, b: 0 } as const;
  const clusters = [{ color: { r: 150, g: 150, b: 150 }, weight: 1 }];

  const solved = solveShadowRecipe(fg, shadow, clusters, 3.0, 2.0, 0.1);
  assert.ok(solved, "solver must find a recipe");
  // Derivation (falloff C per layer: 4px .2623, 8px .3411): every 1-layer recipe
  // and 2x4px fail below 3.0; 2x8px is the FIRST to clear at ~3.128:1.
  assert.deepEqual(solved!.recipe.style === 'soft'
    ? { layers: solved!.recipe.layers, blur: solved!.recipe.blur }
    : solved!.recipe, { layers: 2, blur: 8 });
  assert.ok(solved!.worstRatio >= 3.0);

  // The immediately-smaller candidates must fail (proving minimality).
  const c4 = layerCoverage(SHADOW_ALPHA, 4, 0, 0);
  const c8 = layerCoverage(SHADOW_ALPHA, 8, 0, 0);
  assert.ok(shadowFailure(fg, shadow, [c4], clusters, 3.0, 2.0).worstRatio < 3.0, "1x4px must fail");
  assert.ok(shadowFailure(fg, shadow, [c4, c4], clusters, 3.0, 2.0).worstRatio < 3.0, "2x4px must fail");
  assert.ok(shadowFailure(fg, shadow, [c8, c8], clusters, 3.0, 2.0).worstRatio >= 3.0, "2x8px clears it");

  // No recipe reaches an AAA-level 7.0 over this cluster -> honest null. This is
  // why the shadow rung can be withheld and the box rung has to exist.
  assert.equal(solveShadowRecipe(fg, shadow, clusters, 7.0, 2.0, 0.1), null);
});
