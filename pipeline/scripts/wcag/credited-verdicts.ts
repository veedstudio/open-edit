// CREDITED re-audit resolver — applies the Gaussian falloff model IN TS, over the
// policy-free contrast-statistics as-is (NO rendering / weave-renderer changes,
// no re-sampling). Given the APPLIED choice entries, it credits shadow/outline
// treatments against every element and returns credited verdicts.
//
// - SHADOW: blend the falloff-covered shadow (the entry's recipe: `layers` × `blur`
//   at alpha SHADOW_ALPHA) over EACH sampled cluster, then score fg-vs-blended.
//   Background-dependent, per-frame for the worst-frame verdict.
// - OUTLINE: fg vs the outline colour ONLY — the outline replaces the background,
//   so the sampled clusters play no part.
// - Everything else (unshadowed, or colour/background choices) scores AS-IS from
//   the raw statistics (uncredited).
//
// The raw verdicts (verdicts.ts) stay untouched/uncredited — this is a SEPARATE
// credited interpretation for the apply-path after-summary. Pure; the caller
// (wcag-pass.ts) supplies `classOf` so class-key selectors (".w") can match.

import {
  compositeLuminance,
  ratioFromLuminance,
  relativeLuminance,
  threshold,
  type Level,
  type Rgba,
  type Srgb8,
} from "./policy.ts";
import { SHADOW_ALPHA, layerCoverage, outlineRatio, type ElementStat, type FrameStat, type Statistics } from "./recommend.ts";
import { DEFAULT_SHADOW_RECIPE, type ChoiceEntry } from "./wcag-choice.ts";

export type CreditKind = "shadow" | "outline";

export interface CreditedElement {
  id: string;
  aa: boolean;
  aaa: boolean;
  /** Worst per-sampled-frame ratio (credited when a shadow/outline covers it). */
  worstFrameRatio: number;
  /** Which treatment was credited, or null (scored as-is). */
  credited: CreditKind | null;
}

export interface CreditedResult {
  elements: CreditedElement[];
  failingAA: number;
  failingAAA: number;
}

const hexToSrgb = (h: string): Srgb8 => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

// Does a (comma-joined) CSS selector cover this element? `#id` matches by id;
// `.cls` matches when classOf(id) === cls (the caller supplies the class map).
function selectorCovers(selector: string, id: string, classOf?: (id: string) => string | null): boolean {
  for (const raw of selector.split(",")) {
    const tok = raw.trim();
    if (tok.startsWith("#") && tok.slice(1) === id) return true;
    if (tok.startsWith(".") && classOf && classOf(id) === tok.slice(1)) return true;
  }
  return false;
}
function entryCovers(entry: ChoiceEntry, id: string, classOf?: (id: string) => string | null): boolean {
  if (entry.split) return entry.split.some((p) => selectorCovers(p.selector, id, classOf));
  return entry.selector ? selectorCovers(entry.selector, id, classOf) : false;
}
// The applied colour for this element: a split part's own hex, else the entry hex.
function appliedColour(entry: ChoiceEntry, id: string, classOf?: (id: string) => string | null): string {
  if (entry.split) {
    const p = entry.split.find((s) => selectorCovers(s.selector, id, classOf));
    if (p) return p.hex;
  }
  return entry.hex;
}

// Ratio of `fg` over a background cluster, optionally with a shadow stack blended
// over the cluster first (each layer at its own coverage `C`).
function creditedRatio(fg: Rgba, clusterColor: Srgb8, layerCoverages: number[] | null, shadow: Srgb8 | null): number {
  let lBg = relativeLuminance(clusterColor);
  if (layerCoverages && shadow) {
    const lShadow = relativeLuminance(shadow);
    for (const C of layerCoverages) lBg = compositeLuminance(lShadow, C, lBg);
  }
  const lFg = compositeLuminance(relativeLuminance(fg), fg.a, lBg);
  return ratioFromLuminance(lFg, lBg);
}

interface Credit {
  kind: CreditKind;
  shadow?: Srgb8;
  layerCoverages?: number[];
  outlineColour?: Srgb8;
}

// Per-element credited verdict: worst-FRAME scoring (each sampled frame with its
// OWN fg/font metrics; the run's worst is the min across frames; aa/aaa require
// every sampled frame to clear the per-frame threshold).
function verdictFor(elt: ElementStat, credit: Credit | null): CreditedElement {
  const sampled = elt.frames.filter((f) => !f.unsampled);
  if (elt.indeterminate || sampled.length === 0) {
    return { id: elt.id, aa: false, aaa: false, worstFrameRatio: 0, credited: credit?.kind ?? null };
  }
  let worst = Infinity;
  let aa = true;
  let aaa = true;
  for (const f of sampled) {
    const frameWorst = worstFrameRatio(f, credit);
    if (frameWorst < threshold("AA", f.font_size, f.font_weight)) aa = false;
    if (frameWorst < threshold("AAA", f.font_size, f.font_weight)) aaa = false;
    if (frameWorst < worst) worst = frameWorst;
  }
  return { id: elt.id, aa, aaa, worstFrameRatio: worst === Infinity ? 0 : worst, credited: credit?.kind ?? null };
}

function worstFrameRatio(f: FrameStat, credit: Credit | null): number {
  // OUTLINE replaces the background — fg vs the outline colour, cluster-independent.
  if (credit?.kind === "outline") return outlineRatio(f.fg, credit.outlineColour!);
  let worst = Infinity;
  for (const cl of f.clusters) {
    const ratio =
      credit?.kind === "shadow"
        ? creditedRatio(f.fg, cl.color, credit.layerCoverages!, credit.shadow!)
        : creditedRatio(f.fg, cl.color, null, null);
    if (ratio < worst) worst = ratio;
  }
  return f.clusters.length === 0 ? 0 : worst; // no adjacent bg sampled on this frame
}

// THE entry point (wcag-pass.ts wires this into the apply-path after-summary).
// `appliedEntries` = the applied wcag-choice.json entries; only shadow/outline
// are credited. `classOf` maps an element id to its declared class so class-key
// selectors match (from the template; id-only matching works without it).
export function resolveCreditedVerdicts(
  statistics: Statistics,
  appliedEntries: ChoiceEntry[],
  classOf?: (id: string) => string | null,
): CreditedResult {
  const elements = statistics.elements.map((elt) => {
    const entry = appliedEntries.find(
      (e) => (e.kind === "shadow" || e.kind === "outline") && entryCovers(e, elt.id, classOf),
    );
    let credit: Credit | null = null;
    if (entry) {
      const colour = hexToSrgb(appliedColour(entry, elt.id, classOf));
      if (entry.kind === "outline") {
        credit = { kind: "outline", outlineColour: colour };
      } else {
        const { layers, blur } = entry.recipe ?? DEFAULT_SHADOW_RECIPE;
        const C = layerCoverage(SHADOW_ALPHA, blur, 0, 0); // centered
        credit = { kind: "shadow", shadow: colour, layerCoverages: Array(layers).fill(C) };
      }
    }
    return verdictFor(elt, credit);
  });
  return {
    elements,
    failingAA: elements.filter((e) => !e.aa).length,
    failingAAA: elements.filter((e) => !e.aaa).length,
  };
}

// Re-export for the caller's convenience (parity with the studio's model).
export type { Level };
