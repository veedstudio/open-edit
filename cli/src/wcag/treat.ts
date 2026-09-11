// ANALYTIC evaluation of a remediation, against the ORIGINAL samples.
//
// THE SAMPLING CONTRACT. Sampling happens once, on the original render, and is a
// fixed stochastic model of the colour behind the text. A decoration is painted
// OVER the footage — it does not repaint it — so its effect is COMPUTED against
// those constant samples. Nothing is ever re-sampled to "see" the result.
//
// Re-sampling a remediated render answers a different question anyway: the
// sampler excludes glyph quads inflated by each shadow's offset and blur, so
// once a decoration exists it measures further out and reads background that was
// never behind the text.
//
// This turns statistics into POST-TREATMENT statistics, so the ordinary summary
// path scores the outcome. One evaluator for all three kinds, rather than a
// credited side-path that only understood shadows.

import { compositeLuminance, relativeLuminance, type Srgb8 } from "./policy.ts";
import {
  HARD_OUTLINE_ALPHA,
  SHADOW_ALPHA,
  effectiveCoverage,
  hardRingCoverage,
  hardRingReaches,
  layerCoverage,
} from "./recommend.ts";
import type { ClusterStat, ElementStat, FrameStat, Statistics } from "./verdicts.ts";
import {
  DEFAULT_SHADOW_RECIPE,
  type ChoiceKind,
  type ShadowChoiceRecipe,
} from "./wcag-choice.ts";

/** What has been applied to a set of elements. A ChoiceEntry satisfies this, and
 * so does a rule from the automatic colour plan — the analytic evaluation does
 * not care which path produced it. */
export interface Treatment {
  kind: ChoiceKind;
  hex: string;
  backingHex?: string;
  recipe?: ShadowChoiceRecipe;
  /** Resolved element ids — exactly what the applier targeted. */
  ids?: string[];
  /** Class key, consulted only when ids are absent. */
  selector?: string;
}

const hexToSrgb = (h: string): Srgb8 => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

// A cluster is a COLOUR, and the treatments compose in luminance. Expressing the
// blended luminance as a grey keeps ClusterStat's shape without pretending we
// know the blended hue — every downstream score reads luminance back out.
//
// NOT rounded to 8 bits. `Srgb8`'s channels are plain numbers and
// `relativeLuminance` divides by 255 before the sRGB transform, so a fractional
// channel round-trips exactly. Quantising here cost up to 0.097 of a contrast
// ratio, which was enough to push a shadow the solver had just certified back
// below AA — the pass would promote a fix and then re-propose one for the class
// it had just fixed.
function greyOf(luminance: number): Srgb8 {
  const inv = (l: number) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  const v = Math.min(1, Math.max(0, inv(luminance))) * 255;
  return { r: v, g: v, b: v };
}

/** Per-layer ring coverage of a choice's shadow recipe — full for a hard ring
 * that reaches, the falloff coverage per copy for a soft stack. The element's
 * own opacity is applied on top of these, per layer set, by effectiveCoverage. */
function shadowCoverages(entry: Treatment): number[] {
  const recipe = entry.recipe ?? DEFAULT_SHADOW_RECIPE;
  if (recipe.style === "hard") {
    // Refused rather than scored as zero: a ring that reaches nothing is a
    // treatment that changes no pixel, and a chosen option promotes
    // unconditionally — the pass would ship the original as remediated.
    if (!hardRingReaches(recipe.directions, recipe.offset)) {
      throw new Error(
        `wcag-treat: hard recipe ${recipe.directions}-way at ${recipe.offset}px never reaches the 1px ring — it paints nothing`,
      );
    }
    return [hardRingCoverage(HARD_OUTLINE_ALPHA, recipe.offset, recipe.directions)];
  }
  return Array(recipe.layers).fill(layerCoverage(SHADOW_ALPHA, recipe.blur, 0, 0)); // centered
}

// `.cls` covers an element whose class key matches; `#id` covers that element.
// Resolved ids win when present: they are exactly what the applier targeted.
function covers(entry: Treatment, id: string, classOf: (id: string) => string | null): boolean {
  if (entry.ids?.length) return entry.ids.includes(id);
  const tok = entry.selector;
  if (!tok) return false;
  if (tok.startsWith("#")) return tok.slice(1) === id;
  return classOf(id) === tok.slice(1);
}

// A decoration is painted BY the text element, so the element's OWN opacity
// multiplies it exactly as it multiplies the glyph: what sits next to the text
// is `alpha·decoration + (1−alpha)·footage`, and below full opacity the footage
// never stops showing through. At alpha = 1 this collapses to outright
// replacement — the override case, now the limit of one formula rather than a
// branch of its own.
function treatClusters<T extends ClusterStat>(
  clusters: T[], colour: Srgb8, coverages: number[], alpha: number,
): T[] {
  const lDecoration = relativeLuminance(colour);
  const cover = effectiveCoverage(coverages, alpha);
  return clusters.map((c) => ({
    ...c,
    color: greyOf(compositeLuminance(lDecoration, cover, relativeLuminance(c.color))),
  }));
}

// A plate covers the whole box rather than a ring, so its only dilution is the
// element's own opacity — coverage 1, scaled.
const PLATE_COVERAGE = [1];

function treatFrame(f: FrameStat, entry: Treatment): FrameStat {
  if (entry.kind === "colour") {
    return { ...f, fg: { ...hexToSrgb(entry.hex), a: f.fg.a } };
  }
  if (entry.kind === "background") {
    return {
      ...f,
      fg: { ...hexToSrgb(entry.hex), a: f.fg.a },
      clusters: treatClusters(f.clusters, hexToSrgb(entry.backingHex!), PLATE_COVERAGE, f.fg.a),
    };
  }
  return {
    ...f,
    clusters: treatClusters(f.clusters, hexToSrgb(entry.hex), shadowCoverages(entry), f.fg.a),
  };
}

function treatElement(elt: ElementStat, entry: Treatment): ElementStat {
  const frames = elt.frames.map((f) => (f.unsampled ? f : treatFrame(f, entry)));
  const first = frames.find((f) => !f.unsampled);
  return {
    ...elt,
    fg: first ? first.fg : elt.fg,
    frames,
    // The element-level roll-up mirrors the frames it summarises, at the
    // element's steady opacity.
    clusters:
      entry.kind === "colour"
        ? elt.clusters
        : entry.kind === "background"
          ? treatClusters(elt.clusters, hexToSrgb(entry.backingHex!), PLATE_COVERAGE, elt.steady_alpha)
          : treatClusters(elt.clusters, hexToSrgb(entry.hex), shadowCoverages(entry), elt.steady_alpha),
  };
}

/** The statistics as they WOULD read with these choices applied, computed from
 * the originals. Elements no entry covers are returned untouched. Pure. */
export function applyTreatment(
  statistics: Statistics,
  treatments: readonly Treatment[],
  classOf: (id: string) => string | null,
): Statistics {
  return {
    ...statistics,
    elements: statistics.elements.map((elt) => {
      const entry = treatments.find((e) => covers(e, elt.id, classOf));
      return entry ? treatElement(elt, entry) : elt;
    }),
  };
}
