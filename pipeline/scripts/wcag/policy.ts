// WCAG contrast POLICY layer. Semantics match weave-renderer's wcag-contrast
// analyzer. Unit-tested with hand-derived cases in tests/wcag-policy.test.ts.
//
// SCOPE: the pooled-cluster policy math only — per-cluster ratios, feasibility,
// hue-preserving recolor candidates/selection, estimated-failure numbers,
// option_within_bar, and the class roll-up tiers. Per-frame verdict scoring
// lives in verdicts.ts (it needs the per-frame statistics).
//
// Color math delegates to culori (luminance, Oklab/Oklch conversions); only
// WCAG-specific policy formulas (ratio, thresholds, alpha compositing) are
// written out here.

import { oklch, rgb, wcagLuminance } from 'culori';

export type Level = "AA" | "AAA";
export interface Srgb8 { r: number; g: number; b: number }
export interface Rgba extends Srgb8 { a: number }
export interface RecCluster { color: Srgb8; weight: number }
export type Strategy = "hue_preserving" | "anchor" | "hue_shift";

export interface Fix {
  kind: "recolor" | "halo" | "recolor_with_backing";
  color: Srgb8;
  strategy?: Strategy;
  backing?: Srgb8;
}

export interface EstimatedFailure {
  mass: number;
  worstRatio: number;
  massBelowFloor: number;
  worstCluster: { color: Srgb8; weight: number } | null;
}

export interface RecOption {
  fix: Fix;
  estimatedFailure: EstimatedFailure;
  guaranteed: boolean;
  withinBar: boolean;
}

const srgb8 = (r: number, g: number, b: number): Srgb8 => ({ r, g, b });
const sameColor = (a: Srgb8, b: Srgb8) => a.r === b.r && a.g === b.g && a.b === b.b;

// ---------------------------------------------------------------------------
// WCAG 2.2 contrast model.
// ---------------------------------------------------------------------------

export function isLargeText(fontSize: number, fontWeight: number): boolean {
  return fontSize >= 24.0 || (fontWeight >= 700.0 && fontSize >= 18.66);
}

// WCAG relative luminance — culori. Culori linearizes at sRGB's 0.04045
// breakpoint where WCAG's formula says 0.03928; no u8/255 channel value falls
// between them, so 8-bit verdicts are identical either way.
export function relativeLuminance(c: Srgb8): number {
  return wcagLuminance(toCuloriRgb(c));
}

export function ratioFromLuminance(la: number, lb: number): number {
  const hi = la >= lb ? la : lb;
  const lo = la >= lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastRatio(a: Srgb8, b: Srgb8): number {
  return ratioFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

export function threshold(level: Level, fontSize: number, fontWeight: number): number {
  const large = isLargeText(fontSize, fontWeight);
  if (level === "AA") return large ? 3.0 : 4.5;
  return large ? 4.5 : 7.0;
}

export function compositeLuminance(lFg: number, a: number, lBg: number): number {
  if (a >= 1.0) return lFg;
  const ac = Math.min(Math.max(a, 0.0), 1.0);
  return ac * lFg + (1.0 - ac) * lBg;
}

// ---------------------------------------------------------------------------
// sRGB <-> Oklab <-> Oklch conversions — culori. Converters return UNCLAMPED
// channels (out-of-gamut values survive), which the eval_oklch gamut test
// relies on; clamping/quantization stays explicit at the call sites.
// ---------------------------------------------------------------------------

const toCuloriRgb = (c: Srgb8) => ({ mode: 'rgb' as const, r: c.r / 255.0, g: c.g / 255.0, b: c.b / 255.0 });

// Srgb8 -> (L, C, H degrees). Achromatic colors have no hue (culori leaves it
// undefined); 0 is used — every consumer multiplies it into a zero chroma.
export function toOklch(c: Srgb8): [number, number, number] {
  const o = oklch(toCuloriRgb(c));
  return [o.l, o.c, o.h ?? 0.0];
}

// ---------------------------------------------------------------------------
// Feasibility, realization, candidates, selection.
// ---------------------------------------------------------------------------

export interface FeasibleSet { dark: number | null; light: number | null }
export const feasibleSetIsEmpty = (fs: FeasibleSet) => fs.dark === null && fs.light === null;

export function targetLuminanceDarker(lBg: number, r: number, a: number): number {
  const comp = (lBg + 0.05) / r - 0.05;
  return (comp - (1.0 - a) * lBg) / a;
}

export function targetLuminanceLighter(lBg: number, r: number, a: number): number {
  const comp = r * (lBg + 0.05) - 0.05;
  return (comp - (1.0 - a) * lBg) / a;
}

export function feasibleSetAlpha(bgLums: number[], r: number, a: number): FeasibleSet {
  let darkMax = Infinity;
  let lightMin = -Infinity;
  for (const lBg of bgLums) {
    darkMax = Math.min(darkMax, targetLuminanceDarker(lBg, r, a));
    lightMin = Math.max(lightMin, targetLuminanceLighter(lBg, r, a));
  }
  return {
    dark: darkMax >= 0.0 ? Math.min(darkMax, 1.0) : null,
    light: lightMin <= 1.0 ? Math.max(lightMin, 0.0) : null,
  };
}

export function feasibleSet(bgLums: number[], r: number): FeasibleSet {
  return feasibleSetAlpha(bgLums, r, 1.0);
}

export type Side = "dark" | "light";

// Oklch -> (clamped WCAG luminance, in_gamut, u8 color). The gamut test runs on
// CLAMPED channels (vacuously true); the real out-of-gamut signal is
// realizeAtLuminance's |lum - target| > 1e-3 check — clamped luminance tops out
// below an unreachable target.
function evalOklch(l: number, chroma: number, hue: number): [number, boolean, Srgb8] {
  const u = rgb({ mode: 'oklch', l, c: Math.max(chroma, 0.0), h: hue });
  const clamp01 = (v: number) => Math.min(Math.max(v, 0.0), 1.0);
  const red = clamp01(u.r);
  const green = clamp01(u.g);
  const blue = clamp01(u.b);
  const eps = 1e-4;
  const hiBound = 1.0 + eps;
  const inGamut = [red, green, blue].every((v) => v >= -eps && v <= hiBound);
  const toU8 = (v: number) => Math.round(Math.min(Math.max(v, 0.0), 1.0) * 255.0);
  const c8 = srgb8(toU8(red), toU8(green), toU8(blue));
  const lum = wcagLuminance({ mode: 'rgb', r: red, g: green, b: blue });
  return [lum, inGamut, c8];
}

// Binary search on Oklch lightness (WCAG luminance is monotonic in it); null
// when out of gamut.
function realizeAtLuminance(target: number, hue: number, chroma: number): Srgb8 | null {
  let lo = 0.0;
  let hi = 1.0;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const [lum] = evalOklch(mid, chroma, hue);
    if (lum < target) lo = mid;
    else hi = mid;
  }
  const l = 0.5 * (lo + hi);
  const [lum, inGamut, c8] = evalOklch(l, chroma, hue);
  if (!inGamut || Math.abs(lum - target) > 1e-3) return null;
  return c8;
}

// Nudge into the feasible interior until the composited ratio clears `r`
// against every cluster.
function realizePassingAlpha(
  target: number, hue: number, chroma: number, side: Side,
  bgLums: number[], r: number, a: number,
): Srgb8 | null {
  let t = target;
  for (let i = 0; i < 32; i++) {
    const c = realizeAtLuminance(t, hue, chroma);
    if (c === null) return null;
    const lc = relativeLuminance(c);
    if (bgLums.every((lb) => ratioFromLuminance(compositeLuminance(lc, a, lb), lb) >= r)) {
      return c;
    }
    t += side === "dark" ? -0.003 : 0.003;
    if (!(t >= 0.0 && t <= 1.0)) break;
  }
  return null;
}

export function nearestBoundary(fs: FeasibleSet, lFg: number): [Side, number] | null {
  const dark: [Side, number, number] | null = fs.dark !== null ? ["dark", fs.dark, lFg - fs.dark] : null;
  const light: [Side, number, number] | null = fs.light !== null ? ["light", fs.light, fs.light - lFg] : null;
  if (dark && light) return dark[2] <= light[2] ? [dark[0], dark[1]] : [light[0], light[1]];
  if (dark) return [dark[0], dark[1]];
  if (light) return [light[0], light[1]];
  return null;
}

const anchor = (side: Side): Srgb8 => (side === "dark" ? srgb8(0, 0, 0) : srgb8(255, 255, 255));

// Argmax over {black, white} of the composited ratio, restricted to extremes
// clearing `r`; tie-break BLACK.
export function solveHaloAlpha(fg: Srgb8, r: number, a: number): Srgb8 | null {
  const black = srgb8(0, 0, 0);
  const white = srgb8(255, 255, 255);
  const lFg = relativeLuminance(fg);
  const ratioOver = (halo: Srgb8) => {
    const lHalo = relativeLuminance(halo);
    return ratioFromLuminance(compositeLuminance(lFg, a, lHalo), lHalo);
  };
  const rb = ratioOver(black);
  const rw = ratioOver(white);
  if (rb >= r && rw >= r) return rb >= rw ? black : white;
  if (rb >= r) return black;
  if (rw >= r) return white;
  return null;
}

// Anchor by Oklab lightness: light fgs keep white, dark fgs keep black.
export function betterAnchor(fg: Srgb8): Srgb8 {
  const [lOk] = toOklch(fg);
  return lOk >= 0.5 ? srgb8(255, 255, 255) : srgb8(0, 0, 0);
}

// Halo for the unchanged fg, else recolor-to-anchor + backing; null iff
// opacity-limited (no adjacent fix reaches `r` at coverage `a`).
export function guaranteedFix(fg: Srgb8, r: number, a: number): Fix | null {
  const halo = solveHaloAlpha(fg, r, a);
  if (halo !== null) return { kind: "halo", color: halo };
  const anchorC = betterAnchor(fg);
  const backing = solveHaloAlpha(anchorC, r, a);
  if (backing !== null) return { kind: "recolor_with_backing", color: anchorC, backing };
  return null;
}

// Minimal hue-preserving color on the feasible side nearest l_fg, anchor
// fallback.
function realizeMinFeasible(
  fg: Srgb8, bgLums: number[], fs: FeasibleSet, r: number, a: number,
): [Srgb8, Strategy] {
  const lFg = relativeLuminance(fg);
  const nb = nearestBoundary(fs, lFg);
  if (nb === null) throw new Error("non-empty feasible set has a boundary");
  const [side, target] = nb;
  const [, chroma, hue] = toOklch(fg);
  const c = realizePassingAlpha(target, hue, chroma, side, bgLums, r, a);
  return c !== null ? [c, "hue_preserving"] : [anchor(side), "anchor"];
}

// Plain numeric order (values are finite, non-negative; -0.0 is normalized
// upstream).
const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const cmpRgb = (a: Srgb8, b: Srgb8) => cmp(a.r, b.r) || cmp(a.g, b.g) || cmp(a.b, b.b);

interface FailurePartition { mass: number; worstRatio: number; worstIdx: number | null }

// THE one place a cluster's composited ratio and its pass/fail are computed;
// per-frame scoring lives in verdicts.ts.
function partitionFailures(text: Srgb8, clusters: RecCluster[], r: number, a: number): FailurePartition {
  const lText = relativeLuminance(text);
  let mass = 0.0;
  let worstRatio = Infinity;
  let worstIdx: number | null = null;
  for (let i = 0; i < clusters.length; i++) {
    const lBg = relativeLuminance(clusters[i].color);
    const ratio = ratioFromLuminance(compositeLuminance(lText, a, lBg), lBg);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstIdx = i;
    }
    if (ratio < r) mass += clusters[i].weight;
  }
  if (clusters.length === 0) worstRatio = 0.0;
  return { mass, worstRatio, worstIdx };
}

export function failureMassAlpha(
  text: Srgb8, clusters: RecCluster[], r: number, a: number,
): [number, number, number | null] {
  const p = partitionFailures(text, clusters, r, a);
  return [p.mass, p.worstRatio, p.worstIdx];
}

// The `+ 0.0` normalizes -0.0.
export function massBelowRatio(text: Srgb8, clusters: RecCluster[], floorRatio: number, a: number): number {
  const lText = relativeLuminance(text);
  let sum = 0.0;
  for (const cl of clusters) {
    const lBg = relativeLuminance(cl.color);
    const ratio = ratioFromLuminance(compositeLuminance(lText, a, lBg), lBg);
    if (ratio < floorRatio) sum += cl.weight;
  }
  return sum + 0.0;
}

function estimateAlpha(
  text: Srgb8, clusters: RecCluster[], r: number, a: number, floorRatio: number,
): EstimatedFailure {
  const p = partitionFailures(text, clusters, r, a);
  const worstCluster =
    p.mass > 0.0 && p.worstIdx !== null
      ? { color: clusters[p.worstIdx].color, weight: clusters[p.worstIdx].weight }
      : null;
  return {
    mass: p.mass,
    worstRatio: p.worstRatio,
    massBelowFloor: massBelowRatio(text, clusters, floorRatio, a),
    worstCluster,
  };
}

// The color minimizing weighted COMPOSITED failure mass; exact over the
// cluster representation.
// Tie-break: mass asc, worst_ratio desc, luminance asc (darker), rgb order.
export function bestEffortColorAlpha(
  fg: Srgb8, clusters: RecCluster[], r: number, a: number,
): [Srgb8, Strategy] {
  const [, chroma, hue] = toOklch(fg);
  const cands: [Srgb8, Strategy][] = [
    [srgb8(0, 0, 0), "anchor"],
    [srgb8(255, 255, 255), "anchor"],
  ];
  const pushBoundary = (target: number, side: Side, l: number) => {
    if (!(target >= 0.0 && target <= 1.0)) return;
    const c = realizePassingAlpha(target, hue, chroma, side, [l], r, a);
    if (c !== null) {
      cands.push([c, "hue_preserving"]);
    } else {
      const c0 = realizePassingAlpha(target, 0.0, 0.0, side, [l], r, a);
      if (c0 !== null) cands.push([c0, "anchor"]);
    }
  };
  for (const cl of clusters) {
    const l = relativeLuminance(cl.color);
    pushBoundary(targetLuminanceDarker(l, r, a), "dark", l);
    pushBoundary(targetLuminanceLighter(l, r, a), "light", l);
  }
  const scored = cands.map(([c, s]) => {
    const [mass, worstRatio] = failureMassAlpha(c, clusters, r, a);
    return { c, s, mass, worstRatio, lum: relativeLuminance(c) };
  });
  scored.sort(
    (x, y) =>
      cmp(x.mass, y.mass) || cmp(y.worstRatio, x.worstRatio) || cmp(x.lum, y.lum) || cmpRgb(x.c, y.c),
  );
  return [scored[0].c, scored[0].s];
}

function bestColorWith(
  fg: Srgb8, clusters: RecCluster[], r: number, a: number, bgLums: number[], fs: FeasibleSet,
): [Srgb8, Strategy] {
  return feasibleSetIsEmpty(fs)
    ? bestEffortColorAlpha(fg, clusters, r, a)
    : realizeMinFeasible(fg, bgLums, fs, r, a);
}

// Oklch (dL, dC) distance at the fg's fixed hue (the hue term is zero by
// construction).
function oklchChange(l0: number, c0: number, cand: Srgb8): number {
  const [l1, c1] = toOklch(cand);
  return Math.sqrt(Math.pow(l1 - l0, 2) + Math.pow(c1 - c0, 2));
}

// Fg hue FIXED; each cluster's closed-form darker/lighter boundary realized at
// the progressive desaturation ladder C0, 0.75*C0, 0.5*C0, 0.25*C0, 0. The
// original fg is seeded as a zero-change candidate; achromatic fgs label all
// candidates anchor.
export function huePreservingCandidates(
  fg: Srgb8, clusters: RecCluster[], r: number, a: number,
): [Srgb8, Strategy][] {
  const [, c0, hue] = toOklch(fg);
  const cands: [Srgb8, Strategy][] = [];
  const achromatic = c0 < 1e-4;
  const label = (chromaBearing: boolean): Strategy =>
    chromaBearing && !achromatic ? "hue_preserving" : "anchor";
  cands.push([fg, label(true)]);
  for (const frac of [1.0, 0.75, 0.5, 0.25, 0.0]) {
    const chroma = c0 * frac;
    const strat = label(frac > 0.0);
    for (const cl of clusters) {
      const l = relativeLuminance(cl.color);
      const targets: [number, Side][] = [
        [targetLuminanceDarker(l, r, a), "dark"],
        [targetLuminanceLighter(l, r, a), "light"],
      ];
      for (const [target, side] of targets) {
        if (!(target >= 0.0 && target <= 1.0)) continue;
        const c = realizePassingAlpha(target, hue, chroma, side, [l], r, a);
        if (c !== null) cands.push([c, strat]);
      }
    }
  }
  return cands;
}

export const FLOOR_MASS_FRACTION = 0.1;

// THE single acceptability predicate:
// mass <= bar AND mass_below_floor <= bar * FLOOR_MASS_FRACTION.
export function optionWithinBar(mass: number, massBelowFloor: number, bar: number): boolean {
  return mass <= bar && massBelowFloor <= bar * FLOOR_MASS_FRACTION;
}

// Smallest perceptual change among acceptable candidates; deterministic total
// order.
function bestHuePreservingWithinBar(
  fg: Srgb8, clusters: RecCluster[], r: number, a: number, bar: number, floorRatio: number,
): [Srgb8, Strategy] | null {
  const [l0, c0] = toOklch(fg);
  const acceptable = huePreservingCandidates(fg, clusters, r, a)
    .map(([c, strat]) => {
      const [mass, worstRatio] = failureMassAlpha(c, clusters, r, a);
      const mbf = massBelowRatio(c, clusters, floorRatio, a);
      return { c, strat, change: oklchChange(l0, c0, c), mass, worstRatio, ok: optionWithinBar(mass, mbf, bar) };
    })
    .filter((x) => x.ok);
  if (acceptable.length === 0) return null;
  acceptable.sort(
    (x, y) =>
      cmp(x.change, y.change) || cmp(x.mass, y.mass) || cmp(y.worstRatio, x.worstRatio) || cmpRgb(x.c, y.c),
  );
  return [acceptable[0].c, acceptable[0].strat];
}

interface ColorChoice { lead: [Srgb8, Strategy]; alternative: [Srgb8, Strategy] | null }

// Subtle hue-preserved lead within the bar on the best-effort path
// (mass-argmin demoted to labelled alternative); unchanged minimal
// hue-preserving lead when the feasible set is non-empty.
export function bestChoice(
  fg: Srgb8, clusters: RecCluster[], r: number, a: number, bar: number, floor: number,
): ColorChoice {
  const bgLums = clusters.map((c) => relativeLuminance(c.color));
  const fs = feasibleSetAlpha(bgLums, r, a);
  const defaultLead = bestColorWith(fg, clusters, r, a, bgLums, fs);
  if (feasibleSetIsEmpty(fs)) {
    const subtle = bestHuePreservingWithinBar(fg, clusters, r, a, bar, floor);
    if (subtle !== null) {
      const alternative = !sameColor(subtle[0], defaultLead[0]) ? defaultLead : null;
      return { lead: subtle, alternative };
    }
  }
  return { lead: defaultLead, alternative: null };
}

// RECOLOR options only: the lead color option, then its labelled mass-argmin
// alternative when present.
export function buildRecolorOptionsAlpha(
  fg: Srgb8, a: number, clusters: RecCluster[], r: number, bar: number, floor: number,
): RecOption[] {
  const choice = bestChoice(fg, clusters, r, a, bar, floor);
  const mk = (color: Srgb8, strategy: Strategy): RecOption => {
    const estimatedFailure = estimateAlpha(color, clusters, r, a, floor);
    return {
      fix: { kind: "recolor", color, strategy },
      estimatedFailure,
      guaranteed: false,
      withinBar: optionWithinBar(estimatedFailure.mass, estimatedFailure.massBelowFloor, bar),
    };
  };
  const opts = [mk(choice.lead[0], choice.lead[1])];
  if (choice.alternative !== null) opts.push(mk(choice.alternative[0], choice.alternative[1]));
  return opts;
}

// ---------------------------------------------------------------------------
// Effective threshold.
// ---------------------------------------------------------------------------

export function effectiveThreshold(
  level: Level, fontSize: number, fontWeight: number, minRatio: number | null,
): number {
  const t = threshold(level, fontSize, fontWeight);
  return minRatio !== null ? Math.max(t, minRatio) : t;
}

// ---------------------------------------------------------------------------
// Class roll-up: tiers, recolor options, exceptions.
// ---------------------------------------------------------------------------

export interface RunPolicyInput {
  id: string;
  className: string | null;
  fg: Srgb8;
  fgAlpha: number;
  requiredRatio: number;
  bgLums: number[];
  clusters: RecCluster[];
  totalSamples: number;
  indeterminate: boolean;
  passes: boolean;
}

export interface PolicyException {
  id: string;
  recolorOptions: RecOption[];
  feasibleEmpty: boolean;
  indeterminate: boolean;
}

export interface ClassPolicyResult {
  classKey: string;
  tier: number;
  recolorOptions: RecOption[];
  exceptions: PolicyException[];
}

// Member cluster weights rescaled by sample share
function pool(members: RunPolicyInput[]): RecCluster[] {
  const samples = members.reduce((s, m) => s + m.totalSamples, 0);
  const n = Math.max(members.length, 1);
  const clusters: RecCluster[] = [];
  for (const m of members) {
    const share = samples > 0 ? m.totalSamples / samples : 1.0 / n;
    for (const c of m.clusters) clusters.push({ color: c.color, weight: c.weight * share });
  }
  return clusters;
}

// The recolor lead is options[0].
const colorMass = (options: RecOption[]) =>
  options.length > 0 ? options[0].estimatedFailure.mass : Infinity;
const colorMassBelow = (options: RecOption[]) =>
  options.length > 0 ? options[0].estimatedFailure.massBelowFloor : Infinity;

// Halo/backing options are not assembled here — tiers and exceptions do not
// depend on them; dispositions surface them via guaranteedFix.
function rollupClass(
  classKey: string, members: RunPolicyInput[], bar: number, floor: number,
): ClassPolicyResult {
  const determinate = members.filter((m) => !m.indeterminate);
  const indeterminate = members.filter((m) => m.indeterminate);

  if (indeterminate.length === 0 && determinate.every((m) => m.passes)) {
    return { classKey, tier: 0, recolorOptions: [], exceptions: [] };
  }

  const detFailing = determinate.some((m) => !m.passes);
  const maxR = determinate.reduce((r, m) => Math.max(r, m.requiredRatio), 0.0);

  const options =
    determinate.length === 0 || !detFailing
      ? []
      : buildRecolorOptionsAlpha(
          determinate[0].fg, determinate[0].fgAlpha, pool(determinate), maxR, bar, floor,
        );
  const classMass = colorMass(options);
  const classWithinBar = optionWithinBar(classMass, colorMassBelow(options), bar);

  const exceptions: PolicyException[] = [];
  if (determinate.length >= 2 && options.length > 0) {
    const cc = options[0].fix.color;
    for (const m of determinate) {
      const [mmass] = failureMassAlpha(cc, m.clusters, m.requiredRatio, m.fgAlpha);
      const mBelow = massBelowRatio(cc, m.clusters, floor, m.fgAlpha);
      if (!optionWithinBar(mmass, mBelow, bar)) {
        exceptions.push({
          id: m.id,
          recolorOptions: buildRecolorOptionsAlpha(
            m.fg, m.fgAlpha, m.clusters, m.requiredRatio, bar, floor,
          ),
          feasibleEmpty: feasibleSetIsEmpty(feasibleSetAlpha(m.bgLums, m.requiredRatio, m.fgAlpha)),
          indeterminate: false,
        });
      }
    }
  }
  for (const m of indeterminate) {
    exceptions.push({ id: m.id, recolorOptions: [], feasibleEmpty: false, indeterminate: true });
  }
  exceptions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const tier = indeterminate.length > 0 || !classWithinBar ? 3 : classMass === 0.0 ? 1 : 2;
  return { classKey, tier, recolorOptions: options, exceptions };
}

// Classes keyed `.name`, class-less ids `#id`;
// deterministic key order; members sorted by id.
export function rollUpPolicy(
  runs: RunPolicyInput[], bar: number, floor: number,
): ClassPolicyResult[] {
  const groups = new Map<string, RunPolicyInput[]>();
  for (const r of runs) {
    const key = r.className !== null ? `.${r.className}` : `#${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => {
    const members = [...groups.get(key)!].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rollupClass(key, members, bar, floor);
  });
}
