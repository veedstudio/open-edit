// WCAG recommendation STUDIO — an on-demand, read-only advisor that turns one
// run's committed contrast statistics into a SHORT, AGGREGATE remediation menu:
// the failing text is rolled up by class (the corpus + its outliers), and each
// group gets a handful of options (a hue-preserving recolor, a halo, a backing)
// at AA and again at AAA — 4-8 option rows total, not one section per element.
//
//   node --import tsx pipeline/scripts/wcag/recommend.ts --run runs/<key>
//
// It renders NOTHING and samples NOTHING: it reads final/contrast-statistics.json
// + final/template.wv (re-running the analyzer ONLY to fill a missing
// statistics file when raw samples are present), and writes
// final/wcag-recommendations.json + wcag-recommendations.html, both
// byte-deterministic for a fixed input. The analyzer's compliance report is
// never read — verdicts come from verdicts.ts, policy from policy.ts.
//
// All contrast/feasibility/candidate math is COMPOSED from policy.ts — the
// class roll-up, colour choice, halo, and backing all come from policy.ts; this
// file adds the grouping, the per-group background pooling, and presentation,
// never a second copy of the math.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  betterAnchor,
  buildRecolorOptionsAlpha,
  compositeLuminance,
  effectiveThreshold,
  isLargeText,
  optionWithinBar,
  ratioFromLuminance,
  relativeLuminance,
  rollUpPolicy,
  solveHaloAlpha,
  threshold,
  type ClassPolicyResult,
  type Level,
  type RecCluster,
  type RecOption,
  type RunPolicyInput,
  type Rgba,
  type Srgb8,
  type Strategy,
} from "./policy.ts";
import { renderPage, renderVariantsPage } from "./recommend-viz.ts";
import {
  parseElementClasses,
  resolveVerdicts,
  type ElementStat,
  type PooledClusterStat,
  type Statistics,
  type VerdictResult,
} from "./verdicts.ts";
import { DEFAULT_BAR, DEFAULT_MIN_LEAD_RATIO } from "../wcag-pass.ts";

// contrast-statistics.json types live in verdicts.ts (the consumer-contract
// SSOT); re-exported for the viz layer.
export type { ClusterStat, ElementStat, FrameStat, PooledClusterStat, Statistics } from "./verdicts.ts";

// ---------------------------------------------------------------------------
// Aggregate recommendation model (also the JSON output schema, `schema: 2`).
// ---------------------------------------------------------------------------

export type OptionKind = "colour" | "shadow" | "outline" | "background";
export type GroupScope = "corpus" | "outliers";

export interface OptionRow {
  scope: GroupScope;
  kind: OptionKind;
  label: string;
  available: boolean;
  /** Specimen text colour (the recolor, or the fg for halo/background rows).
   * Omitted on unavailable rows that have no meaningful colour. */
  textHex?: string;
  /** Halo colour, present on `kind: "halo"`. */
  shadowHex?: string;
  /** Solid backing colour, present on `kind: "background"`. */
  backingHex?: string;
  strategy?: Strategy;
  /** Estimated ratio (pooled worst cluster, or composited halo/backing ratio). */
  ratio?: number;
  requiredRatio: number;
  passes: boolean;
  failingMass?: number;
  massBelowFloor?: number;
  withinBar?: boolean;
  autoChoice: boolean;
  /** Within-class exceptions the corpus colour leaves above bar (compact ids). */
  exceptionIds?: string[];
  note?: string;
  /** The pooled background strip drawn behind this row. */
  bands: PooledClusterStat[];
  fontSize: number;
  fontWeight: number;
  specimenLabel: string;
  /** CSS selector(s) this option targets (corpus class key, or the outlier id
   * list as a comma-joined selector) — carried into the choice entry. */
  selector: string;
  /** Heterogeneous groups get a per-selector split (outlier halo/background,
   * where each element's fg solves to its own halo/anchor colour). */
  split?: { selector: string; hex: string; backingHex?: string }[];
  /** Human summary of a split, e.g. "black halo (16) · white halo (2)". */
  splitLabel?: string;
  /** The solved shadow recipe (kind "shadow"): layers + blur, modeled coverage. */
  recipe?: ShadowRecipe;
}

// One group's block within a level: a titled section (its own pooled-splat strip
// is shown on each of its rows) holding that group's options together — corpus
// and outliers never interleave.
export interface GroupBlock {
  scope: GroupScope;
  title: string;
  rows: OptionRow[];
}

export interface LevelSection {
  level: Level;
  corpusRequiredRatio: number;
  largeText: boolean;
  groups: GroupBlock[]; // [corpus] or [corpus, outliers]
}

export interface AppendixEntry {
  id: string;
  className: string;
  group: GroupScope;
  currentRatio: number;
  aa: boolean;
  aaa: boolean;
  indeterminate: boolean;
}

// The ORIGINAL (pre-remediation) render to preview: a relative src, or an
// explicit omission with a reason (post-apply runs whose out.mp4 is remediated
// and have no draft render to fall back to). null = no video at all (pre-apply
// with no render).
export type VideoRef = { src: string } | { src: null; reason: string };

export interface AggregateDoc {
  schema: 2;
  bar: number;
  floor: number;
  passed: boolean;
  corpusClassKey: string;
  corpusMemberCount: number;
  outlierMemberCount: number;
  failingCount: number;
  levels: LevelSection[]; // [AA, AAA]
  appendix: AppendixEntry[];
  video: VideoRef | null;
  /** Past measurement of a prior apply (before -> after failing counts at AA),
   * present only when remediated statistics exist. */
  measured: { beforeFailing: number; afterFailing: number } | null;
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

const hex2 = (v: number) => v.toString(16).padStart(2, "0");
export const toHex = (c: Srgb8) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const rgb = (c: Rgba | Srgb8): Srgb8 => ({ r: c.r, g: c.g, b: c.b });
const sameColor = (a: Srgb8, b: Srgb8) => a.r === b.r && a.g === b.g && a.b === b.b;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const MAX_BANDS = 10; // cap the pooled strip to a legible band count

// The maximum number of background bands the studio will paint per group strip.
export const bandCap = () => MAX_BANDS;

// Composited ratio of a foreground (at coverage `a`) OVER a solid colour — the
// quantity solve_halo_alpha maximizes, recomputed to surface the achieved value.
function compositedRatio(fg: Srgb8, a: number, behind: Srgb8): number {
  const lb = relativeLuminance(behind);
  return ratioFromLuminance(compositeLuminance(relativeLuminance(fg), a, lb), lb);
}

// Declared per-layer alpha of the emitted soft shadow (the `d9` in HEXd9).
export const SHADOW_ALPHA = 0.85;
// The recipe space the solver searches (centered halos only): layer counts and
// blur radii (px), minimal-first (fewer layers, then smaller blur).
const SOLVER_LAYERS = [1, 2, 3, 4];
const SOLVER_BLURS = [4, 8, 12, 16];

// --- Gaussian FALLOFF model (exact spec; the Rust analyzer mirrors this). ------
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
// Effective coverage of ONE shadow layer at the letter's edge ring: a blurred
// shadow does NOT paint the edge fully. sigma = blur/2; the ring sits ~1px past
// the glyph plus the offset magnitude, so d_eff = 1 + |offset|; coverage there is
// alpha·phi(-d_eff/sigma). A blur-0 layer paints nothing at the ring (C = 0).
export function layerCoverage(alpha: number, blur: number, dx: number, dy: number): number {
  if (blur === 0) return 0;
  const sigma = blur / 2;
  const dEff = 1 + Math.hypot(dx, dy);
  return alpha * phi(-dEff / sigma);
}

// SHADOW rating (background-DEPENDENT). WCAG G18 spec (mirrored into the Rust
// oracle in parallel): a SOFT text-shadow does NOT replace the background — for
// EACH sample, blend the shadow over the sample ONCE PER LAYER in emitted order,
// each layer at ITS OWN coverage `layerCoverages[k]` (from the falloff model),
// then score the fg (composited at its OWN alpha) over that blended background.
// Weighted mass below `r`. Moves with the clusters (unlike an outline).
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
  let mass = 0;
  let massBelowFloor = 0;
  let worst = Infinity;
  for (const cl of clusters) {
    let lBlendedBg = relativeLuminance(cl.color);
    for (const C of layerCoverages) lBlendedBg = compositeLuminance(lShadow, C, lBlendedBg);
    const lFg = compositeLuminance(lFgRaw, fg.a, lBlendedBg);
    const ratio = ratioFromLuminance(lFg, lBlendedBg);
    if (ratio < worst) worst = ratio;
    if (ratio < r) mass += cl.weight;
    if (ratio < floorRatio) massBelowFloor += cl.weight;
  }
  if (clusters.length === 0) worst = 0;
  return { mass, worstRatio: worst, massBelowFloor };
}

export interface ShadowRecipe {
  layers: number;
  blur: number;
  /** Per-layer coverage C at this blur (falloff model, centered). */
  coverage: number;
  /** Compounded effective alpha over the layers: 1-(1-C)^layers. */
  aEff: number;
}

// PROPER-SHADOW SOLVER: the minimal centered-halo recipe (fewer layers, then
// smaller blur) whose modeled per-cluster blended contrast clears `r` WITHIN the
// bar (mass + mass-below-floor via option_within_bar, as for colours). Returns
// that recipe + its rating, or null when no recipe in the space reaches `r`.
export function solveShadowRecipe(
  fg: Rgba,
  shadow: Srgb8,
  clusters: RecCluster[],
  r: number,
  floorRatio: number,
  bar: number,
): { recipe: ShadowRecipe; mass: number; worstRatio: number; massBelowFloor: number } | null {
  for (const layers of SOLVER_LAYERS) {
    for (const blur of SOLVER_BLURS) {
      const C = layerCoverage(SHADOW_ALPHA, blur, 0, 0); // centered
      const sf = shadowFailure(fg, shadow, Array(layers).fill(C), clusters, r, floorRatio);
      if (sf.worstRatio >= r && optionWithinBar(sf.mass, sf.massBelowFloor, bar)) {
        return { recipe: { layers, blur, coverage: C, aEff: 1 - Math.pow(1 - C, layers) }, ...sf };
      }
    }
  }
  return null;
}

// OUTLINE rating (background-INDEPENDENT). A hard outline REPLACES the letters'
// adjacent surface, so contrast is fg (composited at its own alpha) vs the
// outline colour ONLY — the sampled clusters play no part. [Spec mirrored into
// the Rust oracle in parallel.]
export function outlineRatio(fg: Rgba, outline: Srgb8): number {
  return compositedRatio(rgb(fg), fg.a, outline);
}

// Strictest required ratio across an element's PEAK frames (animated runs vary
// font metrics per frame; thresholds need no samples so all frames count).
function requiredRatioFor(level: Level, elt: ElementStat): number {
  const src = elt.frames.length ? elt.frames : [elt];
  return src.reduce((mx, f) => Math.max(mx, effectiveThreshold(level, f.font_size, f.font_weight, null)), 0);
}

type Verdict = VerdictResult["elements"][number];
const passesAtLevel = (v: Verdict | undefined, level: Level): boolean =>
  v ? (level === "AAA" ? v.aaa : v.aa) : false;

const isFailingAt = (elt: ElementStat, v: Verdict | undefined, level: Level): boolean =>
  elt.indeterminate || !passesAtLevel(v, level);

// ---------------------------------------------------------------------------
// Grouping: element -> declared class, via verdicts.ts's parseElementClasses
// (the SAME composite-key convention the gate's roll-up uses).
// ---------------------------------------------------------------------------

// roll-up key convention: classed -> `.name`, class-less -> `#id`.
const keyForClass = (id: string, className: string | null) => (className === null ? `#${id}` : `.${className}`);

// ---------------------------------------------------------------------------
// Pooling: merge a group's element clusters by weight x sample-share (the same
// rescale rollup.rs::pool applies) so a strip shows the FULL range the group
// sits over, not one element's flat near-gray cluster.
// ---------------------------------------------------------------------------

function poolBands(members: ElementStat[]): PooledClusterStat[] {
  const total = members.reduce((s, m) => s + m.total_samples, 0);
  const n = Math.max(members.length, 1);
  const bands: PooledClusterStat[] = [];
  for (const m of members) {
    const share = total > 0 ? m.total_samples / total : 1 / n;
    for (const c of m.clusters) {
      bands.push({ color: c.color, weight: c.weight * share, frames: c.frames, covariance: c.covariance });
    }
  }
  // Weight desc, then a stable colour key — deterministic top-K.
  bands.sort((a, b) => b.weight - a.weight || toHex(a.color).localeCompare(toHex(b.color)));
  return bands.slice(0, MAX_BANDS);
}

// RecCluster pooling (color+weight only) for the policy math — ALL clusters, no
// cap: the colour/halo solve must see the whole distribution.
function poolRec(members: ElementStat[]): RecCluster[] {
  const total = members.reduce((s, m) => s + m.total_samples, 0);
  const n = Math.max(members.length, 1);
  const out: RecCluster[] = [];
  for (const m of members) {
    const share = total > 0 ? m.total_samples / total : 1 / n;
    for (const c of m.clusters) out.push({ color: rgb(c.color), weight: c.weight * share });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Option rows per group.
// ---------------------------------------------------------------------------

const colourName = (hex: string): string => (hex === "#000000" ? "black" : hex === "#ffffff" ? "white" : hex);
const hexToSrgb = (h: string): Srgb8 => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

// Outliers' SHADOW / OUTLINE / BACKGROUND rows (heterogeneous fgs -> each row
// SPLITS by the solved colour, carried as a per-selector `split`).
// - OUTLINE (hard stroke) is background-INDEPENDENT: fg vs the outline colour.
// - SHADOW (soft text-shadow) is background-DEPENDENT: rated per pooled cluster
//   (the translucent shadow blended over the sampled backgrounds).
function outlierAnchorRows(
  members: ElementStat[],
  level: Level,
  outReq: number,
  bands: PooledClusterStat[],
  repOut: ElementStat,
  bar: number,
  floor: number,
): { shadow: OptionRow; outline: OptionRow; background: OptionRow } {
  const repFgHex = toHex(rgb(repOut.fg));
  const recClusters = poolRec(members);
  const base = {
    scope: "outliers" as GroupScope,
    requiredRatio: outReq,
    bands,
    fontSize: repOut.font_size,
    fontWeight: repOut.font_weight,
    specimenLabel: "Outliers",
    autoChoice: false,
  };

  // Per-element solved black/white colour, grouped by colour (shared by SHADOW
  // and OUTLINE — same colours, different ratings).
  const colGroups = new Map<string, string[]>();
  let outlineWorst = Infinity;
  let unsolved = 0;
  for (const e of members) {
    const h = solveHaloAlpha(rgb(e.fg), requiredRatioFor(level, e), e.steady_alpha);
    if (!h) { unsolved++; continue; }
    const hx = toHex(h);
    (colGroups.get(hx) ?? colGroups.set(hx, []).get(hx)!).push(e.id);
    outlineWorst = Math.min(outlineWorst, outlineRatio(e.fg, h));
  }
  const entries = [...colGroups.entries()]
    .map(([hex, ids]) => ({ hex, ids: ids.slice().sort(), count: ids.length }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
  const ok = entries.length > 0;
  const split = entries.map((e) => ({ selector: e.ids.map((id) => `#${id}`).join(", "), hex: e.hex }));
  const selectorAll = split.map((s) => s.selector).join(", ");
  const dominant = entries[0]?.hex;

  // OUTLINE — background-independent (fg vs colour), worst across elements.
  const outline: OptionRow = ok
    ? {
        ...base,
        kind: "outline",
        label: "Outline (text-stroke, per element)",
        available: true,
        textHex: repFgHex,
        shadowHex: dominant,
        ratio: outlineWorst,
        passes: true,
        selector: selectorAll,
        split,
        splitLabel: entries.map((e) => `${colourName(e.hex)} outline (${e.count})`).join(" · "),
        note: "the outline replaces the sampled backgrounds — rated fg vs outline colour only (background-independent)." + (unsolved ? ` ${unsolved} element(s) opacity-limited.` : ""),
      }
    : { ...base, kind: "outline", label: "Outline (text-stroke, per element)", available: false, textHex: repFgHex, passes: false, selector: "", note: "opacity-limited: no element's outline reaches its required ratio." };

  // SHADOW — the SOLVER over the pooled outlier clusters (dominant colour); the
  // split carries every element's colour. Rated by the Gaussian falloff model.
  const outlierShadow = ok && dominant ? solveShadowRecipe(repOut.fg, hexToSrgb(dominant), recClusters, outReq, floor, bar) : null;
  const shadow: OptionRow = outlierShadow
    ? {
        ...base,
        kind: "shadow",
        label: `Soft shadow · ${outlierShadow.recipe.layers}× ${outlierShadow.recipe.blur}px (per element)`,
        available: true,
        textHex: repFgHex,
        shadowHex: dominant,
        ratio: outlierShadow.worstRatio,
        passes: true,
        failingMass: outlierShadow.mass,
        massBelowFloor: outlierShadow.massBelowFloor,
        withinBar: true,
        selector: selectorAll,
        split,
        splitLabel: entries.map((e) => `${colourName(e.hex)} shadow (${e.count})`).join(" · "),
        recipe: outlierShadow.recipe,
        note: `proper soft shadow: ${outlierShadow.recipe.layers}× centered 0 0 ${outlierShadow.recipe.blur}px (Gaussian falloff) — rated per sampled background, NOT background-independent.`,
      }
    : { ...base, kind: "shadow", label: "Soft shadow (per element)", available: false, textHex: repFgHex, passes: false, selector: "", note: ok ? `no shadow recipe achieves ${outReq.toFixed(2)}:1 over the outlier backgrounds.` : "opacity-limited: no shadow colour." };

  // BACKGROUND: recolor to the fg's anchor + a solid plate, per element.
  const bgGroups = new Map<string, { ids: string[]; anchor: string; backing: string }>();
  let bgWorst = Infinity;
  let bgUnsolved = 0;
  for (const e of members) {
    const anchor = betterAnchor(rgb(e.fg));
    const backing = solveHaloAlpha(anchor, requiredRatioFor(level, e), e.steady_alpha);
    if (!backing) { bgUnsolved++; continue; }
    const key = `${toHex(anchor)}|${toHex(backing)}`;
    const g = bgGroups.get(key) ?? bgGroups.set(key, { ids: [], anchor: toHex(anchor), backing: toHex(backing) }).get(key)!;
    g.ids.push(e.id);
    bgWorst = Math.min(bgWorst, compositedRatio(anchor, e.steady_alpha, backing));
  }
  const bgEntries = [...bgGroups.values()]
    .map((g) => ({ ...g, ids: g.ids.slice().sort(), count: g.ids.length }))
    .sort((a, b) => b.count - a.count || a.anchor.localeCompare(b.anchor));
  const bgOk = bgEntries.length > 0;
  const bgSplit = bgEntries.map((e) => ({ selector: e.ids.map((id) => `#${id}`).join(", "), hex: e.anchor, backingHex: e.backing }));
  // Unavailable rows take the proper unavailable shape (no textHex/backingHex) so
  // the specimen never emits `color:undefined` (F8).
  const background: OptionRow = bgOk
    ? {
        ...base,
        kind: "background",
        label: "Background plate (per element)",
        available: true,
        textHex: bgEntries[0].anchor,
        backingHex: bgEntries[0].backing,
        ratio: bgWorst,
        passes: true,
        selector: bgSplit.map((s) => s.selector).join(", "),
        split: bgSplit,
        splitLabel: bgEntries.map((e) => `${colourName(e.anchor)} on ${colourName(e.backing)} (${e.count})`).join(" · "),
        note: "guaranteed fix: recolor each element to its anchor and paint a solid plate behind it." + (bgUnsolved ? ` ${bgUnsolved} element(s) opacity-limited.` : ""),
      }
    : {
        ...base,
        kind: "background",
        label: "Background plate (per element)",
        available: false,
        passes: false,
        selector: "",
        note: "opacity-limited: even an anchor over a solid plate cannot reach the required ratio.",
      };

  return { shadow, outline, background };
}

// The three option rows for one group at one level: COLOUR (hue-preserving
// recolor over the pooled clusters), HALO (shadow), BACKGROUND (recolor to an
// anchor + solid backing). `colourOpt` is the group's roll-up recolor lead.
function groupRows(args: {
  scope: GroupScope;
  level: Level;
  members: ElementStat[]; // determinate members whose clusters/font drive the group
  repElt: ElementStat; // the representative (roll-up basis) element
  requiredRatio: number;
  colourOpt: RecOption | null;
  bands: PooledClusterStat[];
  recClusters: RecCluster[]; // full pooled clusters for the SHADOW per-cluster rating
  bar: number;
  floor: number;
  exceptionIds?: string[];
  autoColourEligible: boolean; // AA corpus colour keeps the auto-choice badge
  specimenLabel: string;
  selector: string;
}): OptionRow[] {
  const { scope, level, repElt, requiredRatio, colourOpt, bands, recClusters, bar, floor, exceptionIds, autoColourEligible } = args;
  const fg = rgb(repElt.fg);
  const a = repElt.steady_alpha;
  const fontSize = repElt.font_size;
  const fontWeight = repElt.font_weight;
  const base = { scope, requiredRatio, bands, fontSize, fontWeight, specimenLabel: args.specimenLabel, selector: args.selector };
  const rows: OptionRow[] = [];

  // COLOUR
  if (colourOpt) {
    const est = colourOpt.estimatedFailure;
    rows.push({
      ...base,
      kind: "colour",
      label: `${scope === "corpus" ? "Corpus" : "Outliers"} recolor · ${colourOpt.fix.strategy ?? "anchor"}`,
      available: true,
      textHex: toHex(colourOpt.fix.color),
      strategy: colourOpt.fix.strategy,
      ratio: est.worstRatio,
      passes: est.worstRatio >= requiredRatio,
      failingMass: est.mass,
      massBelowFloor: est.massBelowFloor,
      withinBar: colourOpt.withinBar,
      autoChoice: autoColourEligible && colourOpt.withinBar,
      exceptionIds: exceptionIds && exceptionIds.length ? exceptionIds : undefined,
      note: colourOpt.withinBar
        ? undefined
        : `no within-bar hue-preserving colour at ${level} (the mid-gray backgrounds cap the reachable ratio); best effort shown.`,
    });
  } else {
    rows.push({
      ...base,
      kind: "colour",
      label: `${scope === "corpus" ? "Corpus" : "Outliers"} recolor`,
      available: false,
      textHex: toHex(fg),
      passes: false,
      autoChoice: false,
      note: "no feasible recolor for this group (no sampled background).",
    });
  }

  // The black/white treatment colour (both shadow and outline use it).
  const halo = solveHaloAlpha(fg, requiredRatio, a);

  // SHADOW (soft text-shadow) — the SOLVER proposes the minimal recipe whose
  // MODELED (falloff) per-cluster blended contrast clears the ratio within bar.
  const shadowRow = halo ? solveShadowRecipe(repElt.fg, halo, recClusters, requiredRatio, floor, bar) : null;
  if (shadowRow) {
    const rc = shadowRow.recipe;
    rows.push({
      ...base,
      kind: "shadow",
      label: `Soft shadow · ${rc.layers}× ${rc.blur}px`,
      available: true,
      textHex: toHex(fg),
      shadowHex: toHex(halo!),
      ratio: shadowRow.worstRatio,
      passes: true,
      failingMass: shadowRow.mass,
      massBelowFloor: shadowRow.massBelowFloor,
      withinBar: true,
      autoChoice: false,
      recipe: rc,
      note: `proper soft shadow: ${rc.layers}× centered 0 0 ${rc.blur}px (Gaussian falloff, per-layer coverage ${rc.coverage.toFixed(3)}, a_eff ${rc.aEff.toFixed(3)}) — rated per sampled background, NOT background-independent.`,
    });
  } else {
    rows.push({ ...base, kind: "shadow", label: "Soft shadow", available: false, textHex: toHex(fg), passes: false, autoChoice: false, note: halo ? `no shadow recipe achieves ${requiredRatio.toFixed(2)}:1 over the sampled backgrounds (Gaussian falloff model).` : `opacity-limited: no black/white shadow colour at alpha ${a.toFixed(3)}.` });
  }

  // OUTLINE (hard stroke) — background-INDEPENDENT: rated fg vs the outline
  // colour ONLY; the outline replaces the sampled backgrounds.
  if (halo) {
    rows.push({
      ...base,
      kind: "outline",
      label: "Outline (text-stroke)",
      available: true,
      textHex: toHex(fg),
      shadowHex: toHex(halo),
      ratio: outlineRatio(repElt.fg, halo),
      passes: true,
      autoChoice: false,
      note: "the outline replaces the sampled backgrounds — rated fg vs outline colour only (background-independent).",
    });
  } else {
    rows.push({ ...base, kind: "outline", label: "Outline (text-stroke)", available: false, textHex: toHex(fg), passes: false, autoChoice: false, note: `opacity-limited: no black/white outline colour reaches ${requiredRatio.toFixed(2)}:1 at alpha ${a.toFixed(3)}.` });
  }

  // BACKGROUND (recolor_with_backing)
  const anchor = betterAnchor(fg);
  const backing = solveHaloAlpha(anchor, requiredRatio, a);
  rows.push(
    backing
      ? {
          ...base,
          kind: "background",
          label: "Background plate (recolor + backing)",
          available: true,
          textHex: toHex(anchor),
          backingHex: toHex(backing),
          ratio: compositedRatio(anchor, a, backing),
          passes: true,
          autoChoice: false,
          note: "guaranteed fix: recolor the text to the anchor and paint a solid plate behind it.",
        }
      : {
          ...base,
          kind: "background",
          label: "Background plate (recolor + backing)",
          available: false,
          textHex: toHex(anchor),
          passes: false,
          autoChoice: false,
          note: `opacity-limited: even an anchor over a solid plate cannot reach ${requiredRatio.toFixed(2)}:1 at alpha ${a.toFixed(3)}.`,
        },
  );

  return rows;
}

// ---------------------------------------------------------------------------
// The aggregate build.
// ---------------------------------------------------------------------------

export function buildAggregate(
  stats: Statistics,
  templateText: string,
  opts: { video?: VideoRef | null; remediatedStats?: Statistics | null } = {},
): AggregateDoc {
  const bar = DEFAULT_BAR;
  const floor = DEFAULT_MIN_LEAD_RATIO;
  const verdicts = resolveVerdicts(stats);
  const runById = new Map(verdicts.elements.map((v) => [v.id, v]));
  const classMap = parseElementClasses(templateText);
  const scored = stats.elements;
  const classOf = (id: string) => classMap.get(id) ?? null;
  const keyOf = (id: string) => keyForClass(id, classOf(id));

  // Group scored elements by roll-up key; the corpus is the largest group
  // (ties: most pooled samples, then key order).
  const groups = new Map<string, ElementStat[]>();
  for (const e of scored) {
    const k = keyOf(e.id);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  const corpusKey = [...groups.entries()].sort((a, b) => {
    const [ka, ea] = a;
    const [kb, eb] = b;
    return (
      eb.length - ea.length ||
      eb.reduce((s, m) => s + m.total_samples, 0) - ea.reduce((s, m) => s + m.total_samples, 0) ||
      ka.localeCompare(kb)
    );
  })[0][0];
  const corpusMembers = (groups.get(corpusKey) ?? []).slice().sort(byId);

  // Build the per-level policy inputs once per level and roll up.
  const buildRuns = (level: Level): RunPolicyInput[] =>
    scored.map((e) => ({
      id: e.id,
      className: classOf(e.id),
      fg: rgb(e.fg),
      fgAlpha: e.steady_alpha,
      requiredRatio: requiredRatioFor(level, e),
      bgLums: e.clusters.map((c) => relativeLuminance(c.color)),
      clusters: e.clusters.map((c) => ({ color: rgb(c.color), weight: c.weight })),
      totalSamples: e.total_samples,
      indeterminate: e.indeterminate,
      passes: passesAtLevel(runById.get(e.id), level),
    }));

  const corpusStrip = poolBands(corpusMembers.filter((e) => !e.indeterminate));

  const buildLevel = (level: Level): LevelSection => {
    const rollup: ClassPolicyResult[] = rollUpPolicy(buildRuns(level), bar, floor);
    const corpusResult = rollup.find((r) => r.classKey === corpusKey) ?? null;
    const corpusDeterminate = corpusMembers.filter((e) => !e.indeterminate);
    const repElt = corpusDeterminate[0] ?? corpusMembers[0];
    const corpusReq = corpusDeterminate.reduce((mx, e) => Math.max(mx, requiredRatioFor(level, e)), 0) || requiredRatioFor(level, repElt);
    const corpusColour = corpusResult?.recolorOptions?.[0] ?? null;
    const withinClassExceptions = (corpusResult?.exceptions ?? []).filter((x) => !x.indeterminate).map((x) => x.id);

    // CORPUS rows: [colour, shadow, outline, background].
    const [corpusColourRow, corpusShadowRow, corpusOutlineRow, corpusBgRow] = groupRows({
      scope: "corpus",
      level,
      members: corpusDeterminate,
      repElt,
      requiredRatio: corpusReq,
      colourOpt: corpusColour,
      bands: corpusStrip,
      recClusters: poolRec(corpusDeterminate),
      bar,
      floor,
      exceptionIds: withinClassExceptions,
      autoColourEligible: level === "AA",
      specimenLabel: "Corpus",
      selector: corpusKey, // the class key is already a valid CSS selector (.w / #id)
    });

    // OUTLIERS = corpus within-class exceptions + all failing members of OTHER
    // classes (elements the corpus colour does not serve). One group, one COLOUR
    // row — the halo/background rows are the same anchor treatment for everyone.
    const exceptionSet = new Set(withinClassExceptions);
    const outlierMembers = scored
      .filter(
        (e) =>
          !e.indeterminate &&
          isFailingAt(e, runById.get(e.id), level) &&
          (exceptionSet.has(e.id) || keyOf(e.id) !== corpusKey),
      )
      .sort(byId);

    // Two SEPARATED group blocks — corpus first, then outliers (never interleaved).
    const groups: GroupBlock[] = [
      {
        scope: "corpus",
        title: `Main captions (corpus ${corpusKey})`,
        rows: [corpusColourRow, corpusShadowRow, corpusOutlineRow, corpusBgRow],
      },
    ];

    if (outlierMembers.length > 0) {
      const repOut = outlierMembers
        .slice()
        .sort((a, b) => b.total_samples - a.total_samples || byId(a, b))[0];
      const outReq = outlierMembers.reduce((mx, e) => Math.max(mx, requiredRatioFor(level, e)), 0);
      const outlierBands = poolBands(outlierMembers);
      const outColour = buildRecolorOptionsAlpha(rgb(repOut.fg), repOut.steady_alpha, poolRec(outlierMembers), outReq, bar, floor)[0] ?? null;
      const sameAsCorpus = !!(corpusColour && outColour && sameColor(outColour.fix.color, corpusColour.fix.color));
      // The COLOUR row is the honest drastic recolor (often above bar for the
      // messy outlier backgrounds); halo/background are the background-independent
      // alternatives that make the drastic recolor unnecessary.
      const outlierColourRow = groupRows({
        scope: "outliers",
        level,
        members: outlierMembers,
        repElt: repOut,
        requiredRatio: outReq,
        colourOpt: outColour,
        bands: outlierBands,
        recClusters: poolRec(outlierMembers),
        bar,
        floor,
        exceptionIds: outlierMembers.map((e) => e.id),
        autoColourEligible: false,
        specimenLabel: "Outliers",
        selector: outlierMembers.map((e) => `#${e.id}`).join(", "),
      }).find((r) => r.kind === "colour")!;
      if (sameAsCorpus && outlierColourRow.note === undefined) {
        outlierColourRow.note = "same colour as the corpus — these outliers can take the corpus recolor.";
      }
      const { shadow, outline, background } = outlierAnchorRows(outlierMembers, level, outReq, outlierBands, repOut, bar, floor);
      groups.push({
        scope: "outliers",
        title: `Outliers (${outlierMembers.length} element${outlierMembers.length === 1 ? "" : "s"})`,
        rows: [outlierColourRow, shadow, outline, background],
      });
    }

    return {
      level,
      corpusRequiredRatio: corpusReq,
      largeText: isLargeText(repElt.font_size, repElt.font_weight),
      groups,
    };
  };

  const levels = [buildLevel("AA"), buildLevel("AAA")];

  // Appendix: every failing scored element (id, class, group, current ratio).
  const outlierIds = new Set<string>();
  for (const lv of levels) for (const g of lv.groups) for (const r of g.rows) if (r.scope === "outliers" && r.exceptionIds) for (const id of r.exceptionIds) outlierIds.add(id);
  const failing = scored
    .filter((e) => isFailingAt(e, runById.get(e.id), "AA") || isFailingAt(e, runById.get(e.id), "AAA"))
    .sort(byId);
  const appendix: AppendixEntry[] = failing.map((e) => {
    const v = runById.get(e.id);
    const inCorpus = keyOf(e.id) === corpusKey && !outlierIds.has(e.id);
    return {
      id: e.id,
      className: keyOf(e.id),
      group: inCorpus ? "corpus" : "outliers",
      currentRatio: v ? v.worstFrameRatio : 0,
      aa: v ? v.aa : false,
      aaa: v ? v.aaa : false,
      indeterminate: e.indeterminate,
    };
  });

  const outlierMemberCount = appendix.filter((a) => a.group === "outliers").length;
  return {
    schema: 2,
    bar,
    floor,
    passed: verdicts.failingAA === 0,
    corpusClassKey: corpusKey,
    corpusMemberCount: appendix.length - outlierMemberCount,
    outlierMemberCount,
    failingCount: appendix.length,
    levels,
    appendix,
    video: opts.video ?? null,
    measured: opts.remediatedStats
      ? { beforeFailing: verdicts.failingAA, afterFailing: resolveVerdicts(opts.remediatedStats).failingAA }
      : null,
  };
}

// Count the option rows across both level sections (the page-length budget).
export const countOptionRows = (doc: AggregateDoc): number =>
  doc.levels.reduce((n, lv) => n + lv.groups.reduce((m, g) => m + g.rows.length, 0), 0);

// Pick the ORIGINAL (pre-remediation) render to preview. Pure over a file-exists
// predicate so it is unit-testable. `postApply` = template.draft.wv exists,
// meaning out.mp4 / out.silent.mp4 are the REMEDIATED renders, not the original.
export function resolveVideo(has: (f: string) => boolean, postApply: boolean): VideoRef | null {
  if (postApply) {
    if (has("out.draft.silent.mp4")) return { src: "out.draft.silent.mp4" };
    return { src: null, reason: "original render not available — current renders reflect applied changes" };
  }
  if (has("out.mp4")) return { src: "out.mp4" };
  if (has("out.silent.mp4")) return { src: "out.silent.mp4" };
  return null;
}

// ---------------------------------------------------------------------------
// Page assembly + IO layer (the IO parts are not exercised by the unit tests).
// ---------------------------------------------------------------------------

// The shared design-token SSOT, resolved relative to this module (repo-root
// preview/page/tokens.css). Its content is part of the studio's input.
export const TOKENS_CSS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../preview/page/tokens.css",
);
export function readTokensCss(): string {
  return readFileSync(TOKENS_CSS_PATH, "utf8");
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

// Fill a missing statistics file by RE-RUNNING the analyzer over existing raw
// samples (never sampling/rendering here). Statistics only — the analyzer's
// unused report goes to stdout, silenced; exit 1 (failing runs present) is a
// valid outcome.
function regenerateStatistics(finalDir: string, statsPath: string): void {
  const req = createRequire(import.meta.url);
  const { WCAG_CONTRAST_BIN } = req("../../../config.ts");
  const samples = path.join(finalDir, "wcag-contrast-samples.json");
  const r = spawnSync(WCAG_CONTRAST_BIN, [samples, "--statistics", statsPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (r.error) throw new Error(`recommend: failed to spawn analyzer: ${r.error.message}`);
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`recommend: analyzer exited ${r.status ?? `signal ${r.signal}`}`);
  }
}

export function runStudio(runDir: string): { jsonPath: string; htmlPath: string; variantsPath: string; doc: AggregateDoc } {
  const finalDir = path.join(runDir, "final");
  const statsPath = path.join(finalDir, "contrast-statistics.json");
  const samplesPath = path.join(finalDir, "wcag-contrast-samples.json");
  const templatePath = path.join(finalDir, "template.wv");

  if (!existsSync(statsPath)) {
    if (!existsSync(samplesPath)) {
      throw new Error(
        `recommend: no contrast-statistics.json and no wcag-contrast-samples.json in ${finalDir} — run the WCAG pass first:\n  node --import tsx pipeline/scripts/wcag-pass.ts --run ${runDir}`,
      );
    }
    regenerateStatistics(finalDir, statsPath);
  }
  if (!existsSync(templatePath)) {
    throw new Error(`recommend: template.wv missing in ${finalDir} — cannot roll up by class. Re-run the WCAG pass.`);
  }

  const stats = readJson<Statistics>(statsPath);
  const templateText = readFileSync(templatePath, "utf8");

  // The studio is a PRE-DECISION view: the preview must be the ORIGINAL,
  // unremediated render. If template.draft.wv exists the run is post-apply and
  // out.mp4 / out.silent.mp4 are the REMEDIATED renders — fall back to the draft
  // silent render, else omit with an honest reason. Otherwise out.mp4 IS original.
  const has = (f: string) => existsSync(path.join(finalDir, f));
  const postApply = has("template.draft.wv");
  const video = resolveVideo(has, postApply);

  const remediatedPath = path.join(finalDir, "contrast-statistics.remediated.json");
  const remediatedStats = existsSync(remediatedPath) ? readJson<Statistics>(remediatedPath) : null;

  const doc = buildAggregate(stats, templateText, { video, remediatedStats });
  const tokensCss = readTokensCss();
  const jsonPath = path.join(finalDir, "wcag-recommendations.json");
  const htmlPath = path.join(finalDir, "wcag-recommendations.html");
  const variantsPath = path.join(finalDir, "wcag-design-variants.html");
  writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(htmlPath, renderPage(doc, tokensCss));
  writeFileSync(variantsPath, renderVariantsPage(doc, tokensCss)); // static design chooser
  return { jsonPath, htmlPath, variantsPath, doc };
}

function isMainModule(argvPath: string | undefined, moduleUrl: string): boolean {
  return !!argvPath && path.resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const i = process.argv.indexOf("--run");
  const runDir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!runDir) {
    console.error("usage: node --import tsx pipeline/scripts/wcag/recommend.ts --run runs/<key>");
    process.exit(1);
  }
  try {
    const { jsonPath, htmlPath, variantsPath, doc } = runStudio(runDir);
    console.log(
      `[recommend] ${doc.failingCount} failing element(s): corpus ${doc.corpusClassKey} (${doc.corpusMemberCount}) + ${doc.outlierMemberCount} outlier(s); ${countOptionRows(doc)} option rows.`,
    );
    console.log(`[recommend] wrote ${jsonPath}`);
    console.log(`[recommend] wrote ${htmlPath}`);
    console.log(`[recommend] wrote ${variantsPath}`);
    process.exit(0);
  } catch (e: any) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
