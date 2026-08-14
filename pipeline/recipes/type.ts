// Typographic arithmetic.
//
// A delivered sheet carried the optical tracking curve as a table of ten hand-measured rungs, copied
// into the documents that used it. Fitting those ten points shows the table is a straight line in
// disguise: the ABSOLUTE spacing between glyphs falls linearly with size, from about half a pixel at
// caption sizes to zero at display sizes, which is why the `em` value looks like a curve. The fit
// reproduces all ten measured rungs to within 0.000043em.
//
// The table is one film's ten sizes. The line is the craft, and it answers for any size — which is
// the difference between freezing a result and keeping what was learned.
//
// This matters because a ladder is what stops a film inventing a size per graphic. The 12-minute film
// that motivated this used 23 distinct font sizes — 18, 19, 21, 22, 23, 24, 25, 26 among them — and
// its tracking was mostly fine: 42px body at +0.0027em sits 0.0001em off this curve. Sizes chosen one
// at a time are the defect; tracking is what makes each chosen size read as decided rather than typed.

/** Absolute inter-glyph spacing in px at a given font size. Linear, fitted from measured rungs. */
const SPACING_AT_ZERO = 0.9796;
const SPACING_SLOPE = -0.02069;

/** Optical letter-spacing in em for a font size in px. Bigger type takes tighter tracking. */
export function opticalTracking(px: number, decimals = 4): number {
  if (!Number.isFinite(px) || px <= 0) throw new Error(`opticalTracking: size must be a positive finite number, got ${px}`);
  return Number(((SPACING_AT_ZERO + SPACING_SLOPE * px) / px).toFixed(decimals));
}

/** The size at which tracking crosses zero and goes negative — the boundary between reading and display. */
export function trackingCrossoverPx(): number {
  return Number((SPACING_AT_ZERO / -SPACING_SLOPE).toFixed(1));
}

export interface LadderStep { role: string; px: number; trackingEm: number }

/**
 * A type ladder on a fixed ratio, each rung carrying its own tracking.
 *
 * Rungs are built from a ratio rather than picked, because a ladder of arbitrary sizes is what lets
 * a later element quietly introduce an eleventh size nobody decided on.
 */
export function ladder(opts: { base: number; ratio?: number; up?: number; down?: number; roles?: string[] }): LadderStep[] {
  const { base, ratio = 1.25, up = 2, down = 2 } = opts;
  if (!Number.isFinite(base) || base <= 0) throw new Error(`ladder: base must be a positive finite number, got ${base}`);
  if (!(ratio > 1)) throw new Error(`ladder: ratio must be greater than 1, got ${ratio}`);
  const steps: LadderStep[] = [];
  for (let i = -down; i <= up; i++) {
    const px = Math.round(base * ratio ** i);
    steps.push({ role: '', px, trackingEm: opticalTracking(px) });
  }
  steps.sort((a, b) => b.px - a.px);
  const roles = opts.roles ?? ['display', 'headline', 'subhead', 'body', 'kicker', 'micro'];
  steps.forEach((s, i) => { s.role = roles[i] ?? `step-${i}`; });
  return steps;
}

/**
 * How far a declared tracking sits from the curve, in em.
 *
 * Deviation is not automatically wrong — a condensed face or an all-caps kicker legitimately wants
 * more — so this reports the distance and lets the caller decide what is worth a finding.
 */
export function trackingDeviation(px: number, trackingEm: number): number {
  return Number((trackingEm - opticalTracking(px)).toFixed(4));
}
