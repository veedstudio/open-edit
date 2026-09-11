// STATISTICS-NATIVE verdict resolver — scores WCAG AA/AAA run verdicts from the
// analyzer's policy-free `contrast-statistics.json`. Scoring is per one-second
// SLIDING WINDOW (windows.ts): a run passes a level iff EVERY window clears it
// for EVERY foreground the text wore in that window, no window is unscorable,
// and no peak frame is unsampled. Unit-tested in tests/wcag-verdicts.test.ts.
//
// Also home of the `contrast-statistics.json` consumer types (field names are
// the analyzer's serialized output, schema version 1) and the template class
// parser the roll-up grouping uses.

import {
  compositeLuminance,
  DEFAULT_BAR,
  DEFAULT_MIN_LEAD_RATIO,
  effectiveThreshold,
  ratioFromLuminance,
  relativeLuminance,
  type Rgba,
  type Srgb8,
} from "./policy.ts";
import { scoreWindowWorst, slidingWindows, windowPasses, windowSize } from "./windows.ts";

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

// Per-element verdict. Any unsampled peak frame fails the run outright (its
// background is unknown).
// Judged over one-second SLIDING windows, not per instant: a caption unreadable
// for a second is a real failure, a single 200ms dip is sampling noise. Each
// window answers to THE acceptability predicate (optionWithinBar), the same one
// the solver and the credited evaluation use — so a rung can no longer be
// offered that this verdict then rejects.
function verdictFor(elt: ElementStat, minRatio: number | null, k: number): ElementVerdict {
  const windows = slidingWindows(elt, k);
  const anyUnsampled = elt.frames.some((f) => f.unsampled) || (elt.unsampled_frames?.n ?? 0) > 0;
  if (elt.indeterminate || windows.length === 0) {
    return { id: elt.id, aa: false, aaa: false, indeterminate: elt.indeterminate, worstFrameRatio: 0 };
  }
  let worst = Infinity;
  let aa = !anyUnsampled;
  let aaa = !anyUnsampled;
  for (const w of windows) {
    const rAA = effectiveThreshold("AA", w.fontSize, w.fontWeight, minRatio);
    const rAAA = effectiveThreshold("AAA", w.fontSize, w.fontWeight, minRatio);
    // Every foreground the run wore in this window has to clear — a caption that
    // changes colour mid-flight is judged with each colour it actually had.
    const sAA = scoreWindowWorst(w, rAA, DEFAULT_MIN_LEAD_RATIO);
    if (!windowPasses(sAA, DEFAULT_BAR)) aa = false;
    if (!windowPasses(scoreWindowWorst(w, rAAA, DEFAULT_MIN_LEAD_RATIO), DEFAULT_BAR)) aaa = false;
    if (sAA.worstRatio < worst) worst = sAA.worstRatio;
  }
  return { id: elt.id, aa, aaa, indeterminate: elt.indeterminate, worstFrameRatio: worst === Infinity ? 0 : worst };
}

// THE entry point: uncredited verdicts for every element, straight from the
// statistics. `minRatio` mirrors the analyzer's --min-ratio (null = level
// thresholds only, the default).
export function resolveVerdicts(statistics: Statistics, minRatio: number | null = null): VerdictResult {
  const k = windowSize(statistics);
  const elements = statistics.elements.map((e) => verdictFor(e, minRatio, k));
  return {
    elements,
    failingAA: elements.filter((e) => !e.aa).length,
    failingAAA: elements.filter((e) => !e.aaa).length,
    indeterminateCount: elements.filter((e) => e.indeterminate).length,
  };
}
