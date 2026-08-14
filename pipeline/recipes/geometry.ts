// Computed geometry for authored documents.
//
// The launch session generated numbers of exactly these shapes and then threw the generators away — a
// 251-tick dial, a 396-dot halftone field clipped to a burst, glyphs seated on a circle, a needle
// whose travel came from an integrated second-order equation. Only the output survived, so the
// arithmetic here is reconstructed from the delivered documents rather than recovered from a script.
//
// These are COMPUTATIONS, not devices. `alongArc` is not a speedometer and `lattice` is not a
// halftone: naming the artifact would freeze one film's two scenes into the library, and the point is
// the opposite — give the arithmetic away so a design nobody has had yet is cheap to build.
//
// Everything returns plain numbers in canvas px, and a caller spends them on a div, a clip-path or a
// keyframe ladder. The one exception says so in its own name and doc: `arcRectPolygon` returns a
// finished `polygon()` string, because a clip path in percentages has no other useful form.

const TAU = Math.PI * 2;
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface Pt { x: number; y: number }

/** A box placed on a path: its top-left corner, plus the rotation that keeps it tangent. */
export interface Placed { left: number; top: number; rotateDeg: number }

/**
 * N boxes seated on a circle, each rotated to its own angle.
 *
 * Angles run CLOCKWISE FROM 12 O'CLOCK, which is what a dial, a crown of type and a radial burst all
 * read as: x = cx + r·sin θ, y = cy − r·cos θ. `w`/`h` recentre the box on the point, so a caller
 * gets a `left`/`top` it can use directly.
 */
export function alongArc(opts: {
  cx: number; cy: number; r: number;
  fromDeg: number; toDeg: number;
  /** Number of boxes. Give this OR `stepDeg`. */
  count?: number;
  /** Angular pitch. Give this OR `count`. */
  stepDeg?: number;
  w?: number; h?: number;
  /** Round the emitted coordinates to this many decimals; the engine parses full precision. */
  decimals?: number;
}): Placed[] {
  const { cx, cy, r, fromDeg, toDeg, w = 0, h = 0, decimals = 2 } = opts;
  // Documented as exclusive. Accepting both silently ignored `toDeg` and returned a quarter of the
  // arc the caller asked for.
  if (opts.count !== undefined && opts.stepDeg !== undefined) {
    throw new Error('alongArc: give count OR stepDeg, not both — toDeg means a different thing in each');
  }
  if (opts.count === undefined && opts.stepDeg === undefined) {
    throw new Error('alongArc: give count or stepDeg');
  }
  if (opts.count !== undefined && (!Number.isInteger(opts.count) || opts.count < 1)) {
    throw new Error(`alongArc: count must be a positive integer, got ${opts.count}`);
  }
  if (opts.stepDeg !== undefined && (!Number.isFinite(opts.stepDeg) || opts.stepDeg === 0)) {
    throw new Error(`alongArc: stepDeg must be a non-zero finite number, got ${opts.stepDeg}`);
  }
  // A sweep that runs backwards through 12 o'clock is a legitimate dial; a positive step would return
  // nothing at all, so take the direction from the range rather than silently emitting [].
  if (opts.stepDeg !== undefined && Math.sign(toDeg - fromDeg) !== Math.sign(opts.stepDeg)) {
    opts = { ...opts, stepDeg: -opts.stepDeg };
  }
  const step = opts.stepDeg ?? (opts.count && opts.count > 1 ? (toDeg - fromDeg) / (opts.count - 1) : 0);
  const n = opts.count ?? (step === 0 ? 1 : Math.floor((toDeg - fromDeg) / step) + 1);
  const q = (v: number) => Number(v.toFixed(decimals));
  const out: Placed[] = [];
  for (let i = 0; i < n; i++) {
    const deg = fromDeg + i * step;
    const t = rad(deg);
    out.push({
      left: q(cx + r * Math.sin(t) - w / 2),
      top: q(cy - r * Math.cos(t) - h / 2),
      rotateDeg: q(deg),
    });
  }
  return out;
}

/**
 * Points on a rotated lattice covering a rectangle.
 *
 * A print screen is an OFFSET lattice at an angle, not a square grid — that difference is why one
 * delivered treatment read as polka dots until it was rebuilt. `stagger` shifts alternate rows by half
 * a pitch; `angleDeg` turns the whole lattice.
 */
export function lattice(opts: {
  x: number; y: number; w: number; h: number;
  pitch: number;
  angleDeg?: number;
  stagger?: boolean;
  decimals?: number;
}): Pt[] {
  const { x, y, w, h, pitch, angleDeg = 0, stagger = true, decimals = 2 } = opts;
  // A pitch of zero never advances the loop and pushes for ever — a hang inside a design pass that
  // ends in an OOM rather than an error. A non-finite one is refused with it: it yields no points at
  // all, which is a silent empty lattice.
  if (!Number.isFinite(pitch) || pitch <= 0) {
    throw new Error(`lattice: pitch must be a positive finite number, got ${pitch}`);
  }
  const q = (v: number) => Number(v.toFixed(decimals));
  const t = rad(angleDeg);
  const cos = Math.cos(t), sin = Math.sin(t);
  const cx = x + w / 2, cy = y + h / 2;
  // Cover the rectangle's own diagonal so a rotated lattice still fills the corners.
  const reach = Math.ceil(Math.hypot(w, h) / pitch / 2) + 1;
  const out: Pt[] = [];
  for (let row = -reach; row <= reach; row++) {
    const offset = stagger && (row & 1) ? pitch / 2 : 0;
    for (let col = -reach; col <= reach; col++) {
      const lx = col * pitch + offset;
      const ly = row * pitch;
      const px = cx + lx * cos - ly * sin;
      const py = cy + lx * sin + ly * cos;
      if (px < x || px > x + w || py < y || py > y + h) continue;
      out.push({ x: q(px), y: q(py) });
    }
  }
  return out;
}

/** Even-odd ray cast. The engine has no mask, so clipping a field to a shape happens here. */
export function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A rectangle whose corners are real arcs, as a `%` clip-path polygon.
 *
 * `border-radius` renders a true curve (probe: border-radius-chamfer), so reach for this only when a
 * corner must be sampled — an asymmetric radius, a corner cut into a clipped shape, or a shape the
 * radius property cannot describe. Percentages keep it canvas-independent.
 */
export function arcRectPolygon(opts: { w: number; h: number; r: number; samples?: number; decimals?: number }): string {
  const { w, h, r, samples = 8, decimals = 2 } = opts;
  const q = (v: number) => Number(v.toFixed(decimals));
  const px = (v: number) => q((v / w) * 100);
  const py = (v: number) => q((v / h) * 100);
  const pts: string[] = [];
  // corner centres, clockwise from top-left
  const corners: [number, number, number][] = [
    [r, r, 180], [w - r, r, 270], [w - r, h - r, 0], [r, h - r, 90],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= samples; i++) {
      const a = rad(start + (90 * i) / samples);
      pts.push(`${px(cx + r * Math.cos(a))}% ${py(cy + r * Math.sin(a))}%`);
    }
  }
  return `polygon(${pts.join(',')})`;
}

/** Points sampled along a quadratic Bézier — a bowed arrow, a dashed leader, a curved rail. */
export function sampleQuadratic(p0: Pt, p1: Pt, p2: Pt, n: number, decimals = 2): Pt[] {
  const q = (v: number) => Number(v.toFixed(decimals));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: q(u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x),
      y: q(u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y),
    });
  }
  return out;
}

/**
 * A damped second-order response, sampled as keyframe stops.
 *
 * A needle settling, a card overshooting, a counter landing — all the same equation, and all things
 * the engine has no easing curve for. `zeta` below 1 overshoots and rings; at 1 it lands without
 * overshoot. Percentages are INTEGERS: a fractional keyframe percentage is legal, but an integer stop
 * keeps the emitted document readable when --verify names a frame.
 */
export function springKeyframes(opts: {
  from: number; to: number;
  omega: number;
  zeta: number;
  durationMs: number;
  stops?: number;
  decimals?: number;
}): { pct: number; value: number }[] {
  const { from, to, omega, zeta, durationMs, stops = 100, decimals = 3 } = opts;
  const q = (v: number) => Number(v.toFixed(decimals));
  if (!Number.isFinite(stops) || stops < 1) throw new Error(`springKeyframes: stops must be >= 1, got ${stops}`);
  if (!Number.isFinite(zeta) || zeta < 0) throw new Error(`springKeyframes: zeta must be >= 0, got ${zeta}`);
  const over = zeta > 1;
  // Overdamped has two real roots; underdamped one damped frequency. Collapsing the first into the
  // second is a different curve, not a rounding difference.
  const wd = over ? omega * Math.sqrt(zeta * zeta - 1) : omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));
  const out: { pct: number; value: number }[] = [];
  for (let i = 0; i <= stops; i++) {
    const pct = Math.round((i / stops) * 100);
    const t = (i / stops) * (durationMs / 1000);
    const decay = Math.exp(-zeta * omega * t);
    // Unit step response. Above 1 the response is overdamped and takes the cosh/sinh branch; exactly 1
    // is the critically damped form, and below it the term rings.
    const osc = over
      ? Math.cosh(wd * t) + ((zeta * omega) / wd) * Math.sinh(wd * t)
      : wd > 0
        ? Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t)
        : 1 + omega * t;
    const y = 1 - decay * osc;
    out.push({ pct, value: q(from + (to - from) * y) });
  }
  // Collapse duplicate percentages produced by rounding, keeping the last value at each stop.
  const byPct = new Map<number, number>();
  for (const s of out) byPct.set(s.pct, s.value);
  return [...byPct].map(([pct, value]) => ({ pct, value }));
}

/** Vertices of a regular star, ready for a clip-path polygon or a computed div fan. */
export function starPolygon(opts: { cx: number; cy: number; outer: number; inner: number; points?: number; rotateDeg?: number; decimals?: number }): Pt[] {
  const { cx, cy, outer, inner, points = 5, rotateDeg = 0, decimals = 2 } = opts;
  const q = (v: number) => Number(v.toFixed(decimals));
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rad(rotateDeg) + (i * TAU) / (points * 2) - Math.PI / 2;
    out.push({ x: q(cx + r * Math.cos(a)), y: q(cy + r * Math.sin(a)) });
  }
  return out;
}
