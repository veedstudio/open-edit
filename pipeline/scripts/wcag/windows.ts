// SAMPLE WINDOWS — the one temporal unit every score in this gate uses.
//
// THE SAMPLING CONTRACT. Sampling happens ONCE, on the original render. The
// samples are a fixed, stochastic model of the colour behind the text area, and
// they do NOT change when the text's decoration changes: adding a shadow, an
// outline or a plate paints OVER that colour, it does not repaint the footage.
// So a decoration is evaluated ANALYTICALLY against these constant samples, and
// nothing is ever re-sampled to "see" the result.
//
// TEMPORAL READABILITY. A caption that is unreadable for a second is a real
// failure; a single 200ms dip is sampling noise. Judging per instant is
// therefore too harsh, and pooling a whole run is too lenient — it averages the
// bad second away. The unit in between is a SLIDING one-second window: the run
// fails if any second of it fails.
//
// Sliding, not tumbling, so no frame is orphaned in a short trailing batch —
// every sampled frame belongs to at least one full window.
//
// Pure. Windows are a POLICY-layer notion over the policy-free statistics, so
// the Rust analyzer is untouched by any of this.

import {
  effectiveThreshold,
  failureMassAlpha,
  massBelowRatio,
  optionWithinBar,
  type RecCluster,
  type Srgb8,
} from "./policy.ts";
import type { ElementStat, FrameStat, Statistics } from "./verdicts.ts";

/** The audit density the sampler ran at, when the statistics do not say. */
export const DEFAULT_AUDIT_FPS = 5;

/** One second of footage, in sampled frames. */
export function windowSize(stats: Pick<Statistics, "audit_density_fps">): number {
  const k = Math.round(stats.audit_density_fps ?? DEFAULT_AUDIT_FPS);
  return Number.isFinite(k) && k >= 1 ? k : 1;
}

/** One foreground the text actually had during a window. A run can change colour
 * mid-flight, and each colour it wore has to answer for itself. */
export interface WindowForeground {
  fg: Srgb8;
  /** The faintest this colour got while it was on screen. */
  alpha: number;
}

/** One second of a text run: the background it sat over, and the harshest
 * conditions the text was under while it did. */
export interface SampleWindow {
  /** Audit frame numbers pooled into this window. */
  frames: number[];
  /** The pooled background — every frame's clusters, weight-normalised. */
  clusters: RecCluster[];
  /** EVERY distinct foreground worn during the window. Scoring requires all of
   * them to clear: taking only the first judged a recoloured caption with a
   * colour it no longer had, and never scored the run's tail at all. */
  foregrounds: WindowForeground[];
  /** The first foreground, kept for callers that need one representative colour
   * (the shadow/plate solvers pick their own colour anyway). */
  fg: Srgb8;
  /** The FAINTEST the text got in this window — its worst moment. */
  fgAlpha: number;
  /** True when ANY sampled frame in the window measured no adjacent background.
   * Pooling would otherwise dilute it: four measured frames plus one unmeasured
   * gives total weight 0.8 and a failing mass of 0, i.e. a silent pass for text
   * nothing was measured behind. */
  unscorable: boolean;
  /** Metrics of the frame demanding the highest ratio (smallest/lightest type). */
  fontSize: number;
  fontWeight: number;
}

// Clusters are POOLED, never colour-averaged. Averaging bright sky with dark
// shadow would yield a mid-grey that looks readable and is not — erasing the
// bimodality that is the whole reason the run fails.
function pooledWindow(frames: FrameStat[]): SampleWindow {
  const share = 1 / frames.length;
  const clusters: RecCluster[] = [];
  for (const f of frames) {
    for (const c of f.clusters) clusters.push({ color: c.color, weight: c.weight * share });
  }
  let strict = frames[0];
  for (const f of frames) {
    if (
      effectiveThreshold("AA", f.font_size, f.font_weight, null) >
      effectiveThreshold("AA", strict.font_size, strict.font_weight, null)
    ) {
      strict = f;
    }
  }
  // One entry per distinct colour, each carrying the faintest alpha it was seen at.
  const byColour = new Map<string, WindowForeground>();
  for (const f of frames) {
    const key = `${f.fg.r},${f.fg.g},${f.fg.b}`;
    const seen = byColour.get(key);
    if (seen) seen.alpha = Math.min(seen.alpha, f.fg.a);
    else byColour.set(key, { fg: { r: f.fg.r, g: f.fg.g, b: f.fg.b }, alpha: f.fg.a });
  }
  const foregrounds = [...byColour.values()];
  return {
    frames: frames.map((f) => f.frame),
    clusters,
    foregrounds,
    fg: foregrounds[0].fg,
    fgAlpha: Math.min(...frames.map((f) => f.fg.a)),
    unscorable: frames.some((f) => f.clusters.length === 0),
    fontSize: strict.font_size,
    fontWeight: strict.font_weight,
  };
}

/** What a window costs a candidate: the same three quantities every option in
 * the gate is judged on. `shadowFailure` returns this shape for the TREATED
 * case (it blends the treatment into the clusters first); this is the untreated
 * one. */
export interface WindowScore {
  mass: number;
  massBelowFloor: number;
  worstRatio: number;
}

/** Score ONE window for a foreground sitting on it, untreated. Pure.
 *
 * A window with NO clusters is scored as fully failing, never as clean: the
 * sampler found no adjacent background there, so nothing was measured — and an
 * unmeasured window must not be claimable as fixed by any rung. Failing closed
 * here means the verdict, the solver and the credited evaluation all inherit
 * that, instead of each having to remember it. */
export function scoreWindow(
  w: SampleWindow, fg: Srgb8, alpha: number, requiredRatio: number, floorRatio: number,
): WindowScore {
  if (w.unscorable || w.clusters.length === 0) return { mass: 1, massBelowFloor: 1, worstRatio: 0 };
  const [mass, worstRatio] = failureMassAlpha(fg, w.clusters, requiredRatio, alpha);
  return { mass, worstRatio, massBelowFloor: massBelowRatio(fg, w.clusters, floorRatio, alpha) };
}

/** Score a window against EVERY foreground it wore, worst first. A window is only
 * acceptable if all of them clear. Pure. */
export function scoreWindowWorst(
  w: SampleWindow, requiredRatio: number, floorRatio: number,
): WindowScore {
  let worst: WindowScore | null = null;
  for (const f of w.foregrounds) {
    const s = scoreWindow(w, f.fg, f.alpha, requiredRatio, floorRatio);
    if (!worst || s.mass > worst.mass || (s.mass === worst.mass && s.worstRatio < worst.worstRatio)) {
      worst = s;
    }
  }
  return worst ?? { mass: 1, massBelowFloor: 1, worstRatio: 0 };
}

/** Whether a window is acceptable, by THE single acceptability predicate. Pure. */
export function windowPasses(score: WindowScore, bar: number): boolean {
  return optionWithinBar(score.mass, score.massBelowFloor, bar);
}

/** Every one-second window of an element's SAMPLED frames.
 *
 * A run shorter than a window is judged as one short window rather than skipped:
 * a 0.6s caption is still on screen. Unsampled frames drop out entirely — they
 * carry no colour, and counting them as anything would invent data. */
export function slidingWindows(elt: ElementStat, k: number): SampleWindow[] {
  const sampled = elt.frames.filter((f) => !f.unsampled);
  if (sampled.length === 0) return [];
  const size = Math.min(Math.max(1, k), sampled.length);
  const out: SampleWindow[] = [];
  for (let i = 0; i + size <= sampled.length; i++) {
    out.push(pooledWindow(sampled.slice(i, i + size)));
  }
  return out;
}
