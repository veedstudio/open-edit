// SHADOW solver — the Gaussian falloff model behind the WCAG pass's shadow rung.
//
// A soft text-shadow does NOT replace the background: each blurred layer paints
// the letter's edge ring only partially, so a shadow's real contrast depends on
// both the recipe and the pixels behind it. This file models that (erf/phi ->
// per-layer coverage -> blended background) and solves for the MINIMAL recipe
// that clears a required ratio within the failure bar.
//
// It is pure math over already-committed statistics — it renders nothing, samples
// nothing, and reads no files. All contrast/feasibility primitives are COMPOSED
// from policy.ts; this file never keeps a second copy of that math.
//
// Consumers: wcag-pass.ts (builds the shadow rung of a class proposal) and
// credited-verdicts.ts (credits an applied shadow the sampler cannot see).

import {
  compositeLuminance,
  optionWithinBar,
  ratioFromLuminance,
  relativeLuminance,
  type RecCluster,
  type Rgba,
  type Srgb8,
} from "./policy.ts";

// contrast-statistics.json types live in verdicts.ts (the consumer-contract
// SSOT); re-exported for the credited resolver.
export type { ClusterStat, ElementStat, FrameStat, PooledClusterStat, Statistics } from "./verdicts.ts";

// Declared per-layer alpha of the emitted soft shadow (the `d9` in HEXd9).
export const SHADOW_ALPHA = 0.85;
// The recipe space the solver searches (centered halos only): layer counts and
// blur radii (px), minimal-first (fewer layers, then smaller blur).
const SOLVER_LAYERS = [1, 2, 3, 4];
const SOLVER_BLURS = [4, 8, 12, 16];

// --- The falloff model ---------------------------------------------------------
// The Rust analyzer mirrors the SINGLE-COPY case (see ringCoverage); its closed
// form is pinned against this implementation in tests/wcag-recommend.test.ts, so
// the two cannot drift apart unnoticed.
// A&S 7.1.26 error function, EXACT op order for byte-for-byte parity; odd for x<0.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
// Standard normal CDF.
export function phi(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
/** Where "adjacent" is measured: a ring 1px outside the glyph outline. WCAG 1.4.3
 * asks about the colour NEXT TO the text, and this is that surface. */
const RING_DISTANCE = 1;
/** A ring of hard copies is emitted at full opacity: the point is to REPLACE the
 * adjacent background, which is what makes the guarantee hold. */
export const HARD_OUTLINE_ALPHA = 1.0;

/**
 * THE coverage model: how much of the 1px ring one shadow treatment paints.
 *
 *     coverage = alpha · Phi((reach − RING_DISTANCE) / sigma)
 *
 * `sigma` = blur/2 (CSS defines the blur radius as 2 sigma). Blurring the glyph's
 * edge — locally a half-plane — gives a Gaussian CDF profile, so at distance d
 * outside the edge the shadow's own alpha has decayed to Phi(−d/sigma) of itself.
 *
 * `reach` is the offset's component along the LEAST-covered ring point's outward
 * normal. For `directions` evenly spaced copies that component is
 * offset·cos(pi/directions), which is max_i min_n (u_i · n) — the best any copy
 * does at the worst point. It degrades exactly as the geometry should:
 *
 *   1 copy  -> cos(pi)   = −1     rated where it has moved AWAY: offset HURTS
 *   2 copies-> cos(pi/2) =  0     opposite copies leave a broadside gap
 *   8 copies-> cos(pi/8) =  0.924 the faux-outline ring
 *
 * sigma -> 0 is the STEP limit, not a special case: a hard shadow paints what it
 * lands on at full alpha and nothing past it. That is what lets a hard ring take
 * the immediate outline outright, and a centered hard shadow — which never leaves
 * the glyph — still take none of it.
 *
 * Pure. The single-copy case is the published falloff the Rust analyzer mirrors;
 * tests/wcag-recommend.test.ts pins it against the closed form.
 */
export function ringCoverage(alpha: number, blur: number, offset: number, directions: number): number {
  if (directions < 1) return 0;
  const reach = offset * Math.cos(Math.PI / directions);
  const sigma = blur / 2;
  if (sigma <= 0) return reach >= RING_DISTANCE ? alpha : 0;
  return alpha * phi((reach - RING_DISTANCE) / sigma);
}

/** Coverage of ONE centered-or-offset blurred shadow — the published falloff,
 * expressed through the model above (a lone copy is rated at its worst side). */
export function layerCoverage(alpha: number, blur: number, dx: number, dy: number): number {
  return ringCoverage(alpha, blur, Math.hypot(dx, dy), 1);
}

/** Worst-case ring coverage of a `directions`-way HARD (zero-blur) ring. */
export function hardRingCoverage(alpha: number, offset: number, directions: number): number {
  return ringCoverage(alpha, 0, offset, directions);
}

/** Whether a hard ring reaches the surface WCAG asks about at all. Below it the
 * ring paints nothing adjacent to the glyph, so the treatment is a no-op that
 * every analytic score reads as "unchanged" — and a chosen option promotes
 * unconditionally, which would ship the original template reported as fixed. */
export function hardRingReaches(directions: number, offset: number): boolean {
  return hardRingCoverage(HARD_OUTLINE_ALPHA, offset, directions) > 0;
}

/**
 * The alpha a decoration ACTUALLY paints, once the element's own opacity is
 * applied — THE one place the two compose.
 *
 * A shadow stack and a background plate are painted BY the text element, so they
 * live inside its opacity group: the layers compound among themselves first
 * (1 − prod(1 − C)), and the whole group is then composited over the footage at
 * the element's alpha. The two multiply. Scaling each layer instead would be a
 * different (and wrong) number — three 0.3 layers at 50% opacity paint 0.329 of
 * the ring, not 0.386.
 *
 * At alpha = 1 this is exactly the old layer-by-layer blend, so the override
 * invariants (a full ring / a solid plate replace what was sampled) survive
 * unchanged — they are now the opaque LIMIT of one formula rather than a
 * special case. Pure.
 */
export function effectiveCoverage(layerCoverages: readonly number[], elementAlpha: number): number {
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  const compounded = 1 - layerCoverages.reduce((p, C) => p * (1 - clamp01(C)), 1);
  return compounded * clamp01(elementAlpha);
}

// SHADOW rating (background-DEPENDENT). WCAG G18 spec (mirrored into the Rust
// oracle in parallel): a SOFT text-shadow does NOT replace the background — for
// EACH sample, blend the shadow over the sample at the coverage the layers
// actually paint, then score the fg (composited at its OWN alpha) over that
// blended background. Weighted mass below `r`. Moves with the clusters.
//
// The decoration is painted BY this element, so it wears the element's opacity
// too — see effectiveCoverage. The fg term is then composited over that blended
// colour rather than over the raw footage: exact at alpha = 1, and below it a
// deliberate UNDER-statement of the ratio, since the modelled fg is pulled
// toward the very colour it is being compared against. Erring the other way
// would credit fixes the render does not deliver.
export function shadowFailure(
  fg: Rgba,
  shadow: Srgb8,
  layerCoverages: number[],
  clusters: RecCluster[],
  r: number,
  floorRatio: number,
): { mass: number; worstRatio: number; massBelowFloor: number } {
  const lShadow = relativeLuminance(shadow);
  const lFgRaw = relativeLuminance(fg);
  const coverage = effectiveCoverage(layerCoverages, fg.a);
  let mass = 0;
  let massBelowFloor = 0;
  let worst = Infinity;
  for (const cl of clusters) {
    const lBlendedBg = compositeLuminance(lShadow, coverage, relativeLuminance(cl.color));
    const lFg = compositeLuminance(lFgRaw, fg.a, lBlendedBg);
    const ratio = ratioFromLuminance(lFg, lBlendedBg);
    if (ratio < worst) worst = ratio;
    if (ratio < r) mass += cl.weight;
    if (ratio < floorRatio) massBelowFloor += cl.weight;
  }
  if (clusters.length === 0) worst = 0;
  return { mass, worstRatio: worst, massBelowFloor };
}

/** A stack of centered BLURRED shadows: the lighter look, but it can never
 * fully cover the ring, so some background always bleeds through. */
export interface SoftShadowRecipe {
  style: 'soft';
  layers: number;
  blur: number;
  /** Per-layer coverage C at this blur (falloff model, centered). */
  coverage: number;
  /** Compounded effective alpha over the layers: 1-(1-C)^layers. */
  aEff: number;
}

/** A ring of HARD (zero-blur) copies — the faux-outline. It replaces the
 * adjacent background rather than tinting it, which is what lets the shadow rung
 * carry the solid-halo guarantee. */
export interface HardShadowRecipe {
  style: 'hard';
  directions: number;
  offset: number;
  coverage: number;
  aEff: number;
}

export type ShadowRecipe = SoftShadowRecipe | HardShadowRecipe;

/** One text run a shared shadow has to cover: its OWN foreground (with alpha),
 * its OWN sampled backgrounds, and its OWN required ratio. */
export interface ShadowMember {
  fg: Rgba;
  clusters: RecCluster[];
  requiredRatio: number;
}

// PROPER-SHADOW SOLVER, class-wide: the minimal centered-halo recipe (fewer
// layers, then smaller blur) that clears EVERY member within the bar.
//
// One remediation per class means one recipe has to satisfy the whole class, so
// a member is only covered when scored against its own fg/alpha/backgrounds —
// solving from a single member and applying to the rest silently ships text that
// never reached AA. Returns the recipe plus its WORST rating across members, or
// null when no recipe in the space covers all of them.
export function solveClassShadowRecipe(
  members: ShadowMember[],
  shadow: Srgb8,
  floorRatio: number,
  bar: number,
): { recipe: ShadowRecipe; mass: number; worstRatio: number; massBelowFloor: number } | null {
  if (members.length === 0) return null;
  for (const layers of SOLVER_LAYERS) {
    for (const blur of SOLVER_BLURS) {
      const C = layerCoverage(SHADOW_ALPHA, blur, 0, 0); // centered
      const coverages = Array(layers).fill(C);
      let mass = 0;
      let massBelowFloor = 0;
      let worstRatio = Infinity;
      let coversAll = true;
      for (const m of members) {
        const sf = shadowFailure(m.fg, shadow, coverages, m.clusters, m.requiredRatio, floorRatio);
        if (sf.worstRatio < m.requiredRatio || !optionWithinBar(sf.mass, sf.massBelowFloor, bar)) {
          coversAll = false;
          break;
        }
        mass = Math.max(mass, sf.mass);
        massBelowFloor = Math.max(massBelowFloor, sf.massBelowFloor);
        worstRatio = Math.min(worstRatio, sf.worstRatio);
      }
      if (coversAll) {
        return {
          recipe: { style: 'soft', layers, blur, coverage: C, aEff: 1 - Math.pow(1 - C, layers) },
          mass,
          massBelowFloor,
          worstRatio: worstRatio === Infinity ? 0 : worstRatio,
        };
      }
    }
  }
  return null;
}

// Candidate ring offsets, minimal-first: the tightest stroke that reaches the
// ring is the least intrusive one.
const HARD_OFFSETS = [1.5, 2, 3];
const HARD_DIRECTIONS = 8;

/** The minimal HARD outline that clears every member, or null.
 *
 * Where the ring lands it replaces the background outright, so each member is
 * scored fg-over-ring-colour — the same quantity solveHaloAlpha maximises. That
 * is why this rung inherits the solid-halo guarantee the soft stack cannot. */
export function solveClassHardOutline(
  members: ShadowMember[],
  colour: Srgb8,
  floorRatio: number,
  bar: number,
): { recipe: ShadowRecipe; mass: number; worstRatio: number; massBelowFloor: number } | null {
  if (members.length === 0) return null;
  for (const offset of HARD_OFFSETS) {
    const C = hardRingCoverage(HARD_OUTLINE_ALPHA, offset, HARD_DIRECTIONS);
    if (C <= 0) continue;
    let mass = 0;
    let massBelowFloor = 0;
    let worstRatio = Infinity;
    let coversAll = true;
    for (const m of members) {
      const sf = shadowFailure(m.fg, colour, [C], m.clusters, m.requiredRatio, floorRatio);
      if (sf.worstRatio < m.requiredRatio || !optionWithinBar(sf.mass, sf.massBelowFloor, bar)) {
        coversAll = false;
        break;
      }
      mass = Math.max(mass, sf.mass);
      massBelowFloor = Math.max(massBelowFloor, sf.massBelowFloor);
      worstRatio = Math.min(worstRatio, sf.worstRatio);
    }
    if (coversAll) {
      return {
        recipe: { style: 'hard', directions: HARD_DIRECTIONS, offset, coverage: C, aEff: C },
        mass,
        massBelowFloor,
        worstRatio: worstRatio === Infinity ? 0 : worstRatio,
      };
    }
  }
  return null;
}

/** THE shadow rung's solver: the soft stack leads because it is the lighter
 * look, and the hard outline is the fallback that rescues what it cannot. */
export function solveClassShadow(
  members: ShadowMember[],
  colour: Srgb8,
  floorRatio: number,
  bar: number,
): { recipe: ShadowRecipe; mass: number; worstRatio: number; massBelowFloor: number } | null {
  return (
    solveClassShadowRecipe(members, colour, floorRatio, bar) ??
    solveClassHardOutline(members, colour, floorRatio, bar)
  );
}

// The single-run case, expressed through the class solver so there is one loop.
export function solveShadowRecipe(
  fg: Rgba,
  shadow: Srgb8,
  clusters: RecCluster[],
  r: number,
  floorRatio: number,
  bar: number,
): { recipe: ShadowRecipe; mass: number; worstRatio: number; massBelowFloor: number } | null {
  return solveClassShadowRecipe([{ fg, clusters, requiredRatio: r }], shadow, floorRatio, bar);
}
