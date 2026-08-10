// STATISTICS-NATIVE verdict resolver — scores WCAG AA/AAA run verdicts from the
// analyzer's policy-free `contrast-statistics.json`. The statistics carry ONLY
// the peak-plateau frames; each sampled peak frame is scored with ITS OWN fg /
// font metrics against its own clusters, and the run passes a level iff EVERY
// sampled peak frame clears that frame's threshold AND no peak frame is
// unsampled. Unit-tested in tests/wcag-verdicts.test.ts.
//
// Also home of the `contrast-statistics.json` consumer types (field names are
// the analyzer's serialized output, schema version 1) and the template class
// parser the roll-up grouping uses.

import {
  compositeLuminance,
  effectiveThreshold,
  ratioFromLuminance,
  relativeLuminance,
  type Rgba,
  type Srgb8,
} from "./policy.ts";

// ---------------------------------------------------------------------------
// contrast-statistics.json shape.
// ---------------------------------------------------------------------------

export interface ClusterStat {
  color: Srgb8;
  weight: number;
  covariance: number[][]; // OKLAB sample covariance, row-major [[f64;3];3]
}
export interface PooledClusterStat extends ClusterStat {
  frames: number[];
}
export interface FrameStat {
  frame: number;
  fg: Rgba;
  font_size: number;
  font_weight: number;
  unsampled: boolean;
  shadows?: unknown[];
  clusters: ClusterStat[];
}
export interface ElementStat {
  id: string;
  rect: { x: number; y: number; w: number; h: number };
  font_size: number;
  font_weight: number;
  shadows?: unknown[];
  steady_alpha: number;
  fg: Rgba;
  total_samples: number;
  total_frames: number;
  unscored_transient_frames: number;
  sampled_transient_frames: number;
  indeterminate: boolean;
  unsampled_frames?: { n: number; of: number };
  clusters: PooledClusterStat[];
  frames: FrameStat[];
}
export interface Statistics {
  version: number;
  fps: number;
  selection?: string;
  audit_density_fps?: number;
  budget_overflow_frames: number;
  elements: ElementStat[];
}

// ---------------------------------------------------------------------------
// Grouping: element -> declared class, from the template (the SAME source the
// analyzer's roll-up used).
// ---------------------------------------------------------------------------

// Parse `id -> composite class key` (null when the element has no class attribute)
// from the weave/HTML template. An element is keyed by the SORTED, dot-joined
// set of ALL its class tokens — class="w fade" => "fade.w" — so multi-class
// elements group by their full class set, never by the first token alone
// (leading dot added by the caller).
export function parseElementClasses(templateText: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const m of templateText.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]*)"/.exec(tag)?.[1];
    if (id === undefined) continue;
    const cls = /\bclass="([^"]*)"/.exec(tag)?.[1];
    const tokens = cls ? cls.trim().split(/\s+/).filter((t) => t.length > 0) : [];
    out.set(id, tokens.length ? [...tokens].sort().join(".") : null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Uncredited per-element verdicts.
// ---------------------------------------------------------------------------

export interface ElementVerdict {
  id: string;
  aa: boolean;
  aaa: boolean;
  indeterminate: boolean;
  /** Worst per-(peak-)frame ratio; 0 when nothing could be scored. */
  worstFrameRatio: number;
}

export interface VerdictResult {
  elements: ElementVerdict[];
  failingAA: number;
  failingAAA: number;
  indeterminateCount: number;
}

// Ratio of a frame's fg (composited at its own alpha) over one background
// cluster — the same math as policy.ts's pooled loop, applied per frame.
function frameClusterRatio(fg: Rgba, clusterColor: Srgb8): number {
  const lBg = relativeLuminance(clusterColor);
  const lFg = compositeLuminance(relativeLuminance(fg), fg.a, lBg);
  return ratioFromLuminance(lFg, lBg);
}

// Worst cluster ratio on one frame; 0 when the frame sampled no clusters.
function frameWorstRatio(f: FrameStat): number {
  let worst = Infinity;
  for (const cl of f.clusters) {
    const ratio = frameClusterRatio(f.fg, cl.color);
    if (ratio < worst) worst = ratio;
  }
  return f.clusters.length === 0 ? 0 : worst;
}

// Per-element verdict: every sampled peak frame must clear its OWN per-frame
// threshold (frame fg + frame font metrics), and any unsampled peak frame fails
// the run outright (its background is unknown).
function verdictFor(elt: ElementStat, minRatio: number | null): ElementVerdict {
  const sampled = elt.frames.filter((f) => !f.unsampled);
  const anyUnsampled = elt.frames.some((f) => f.unsampled) || (elt.unsampled_frames?.n ?? 0) > 0;
  if (elt.indeterminate || sampled.length === 0) {
    return { id: elt.id, aa: false, aaa: false, indeterminate: elt.indeterminate, worstFrameRatio: 0 };
  }
  let worst = Infinity;
  let aa = !anyUnsampled;
  let aaa = !anyUnsampled;
  for (const f of sampled) {
    const w = frameWorstRatio(f);
    if (w < effectiveThreshold("AA", f.font_size, f.font_weight, minRatio)) aa = false;
    if (w < effectiveThreshold("AAA", f.font_size, f.font_weight, minRatio)) aaa = false;
    if (w < worst) worst = w;
  }
  return { id: elt.id, aa, aaa, indeterminate: elt.indeterminate, worstFrameRatio: worst === Infinity ? 0 : worst };
}

// THE entry point: uncredited verdicts for every element, straight from the
// statistics. `minRatio` mirrors the analyzer's --min-ratio (null = level
// thresholds only, the default).
export function resolveVerdicts(statistics: Statistics, minRatio: number | null = null): VerdictResult {
  const elements = statistics.elements.map((e) => verdictFor(e, minRatio));
  return {
    elements,
    failingAA: elements.filter((e) => !e.aa).length,
    failingAAA: elements.filter((e) => !e.aaa).length,
    indeterminateCount: elements.filter((e) => e.indeterminate).length,
  };
}
