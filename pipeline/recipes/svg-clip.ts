/**
 * A vector logo the engine will actually draw.
 *
 * `svg-counterform-filled` (CONFIRMED) says an inline SVG path fills its counterform solid — the hole
 * in an O, a D or an e is lost, and `fill-rule`, `<mask>` and `<clipPath>` do not cut it. The route
 * that does is `clip-path-polygon-counterform` (CONFIRMED): a CSS polygon walking the outer contour,
 * returning along a degenerate slit, walking the hole, and coming back out. That stays vector, so it
 * is as clean at 26px as at 300px — which a bitmap keyed out of an export is not, and 720p footage
 * is exactly where that shows.
 *
 * This turns an arbitrary SVG into those polygons. Transforms are baked into the points here because
 * `svg-transform-attr` (CONFIRMED) says the engine displaces a shape carrying a transform ATTRIBUTE.
 *
 * The input is USER material — whatever a brand hands over — so every failure here is loud. An SVG
 * this cannot read throws; it never returns an empty logo that renders as nothing while the run
 * reports success.
 */
import { readFileSync } from 'node:fs';

export type ClipShape = {
  /** Ready for `clip-path: polygon(...)`, in % of the box. */
  polygon: string;
  /** The authored fill, when the source states a plain colour. `url()` and `currentColor` are dropped. */
  fill?: string;
};

export type ClipLogo = {
  width: number;
  height: number;
  /** width / height, for sizing the box from either dimension. */
  aspect: number;
  /** One entry per disjoint island — each is its own absolutely-positioned box. */
  shapes: ClipShape[];
};

export type Pt = [number, number];
/** An affine matrix as SVG writes it: a b c d e f. */
export type Mat = [number, number, number, number, number, number];

const I: Mat = [1, 0, 0, 1, 0, 0];

/** A logo is a mark, not a map. Past this it is a hostile or mistaken file, and saying so beats an OOM. */
const MAX_POINTS = 200_000;

export class SvgClipError extends Error {}

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Mat, [x, y]: Pt): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseTransform(s: string | undefined): Mat {
  if (!s) return I;
  let m = I;
  for (const [, op, argstr] of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = argstr.split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some((v) => !Number.isFinite(v))) {
      throw new SvgClipError(`transform "${op}(${argstr})" carries a value that is not a number`);
    }
    const rad = (deg: number) => (deg * Math.PI) / 180;
    let t: Mat;
    switch (op) {
      case 'matrix': t = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'skewX': t = [1, 0, Math.tan(rad(a[0] ?? 0)), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(rad(a[0] ?? 0)), 0, 1, 0, 0]; break;
      case 'rotate': {
        const [ang, cx = 0, cy = 0] = a;
        const c = Math.cos(rad(ang)), si = Math.sin(rad(ang));
        t = mul([1, 0, 0, 1, cx, cy], mul([c, si, -si, c, 0, 0], [1, 0, 0, 1, -cx, -cy]));
        break;
      }
      default: t = I;
    }
    m = mul(m, t);
  }
  return m;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Points per curve, from the control polygon's length against a flatness tolerance.
 *
 * The tolerance is a PARAMETER, never module state. It was a module-level `let` that `svgToClip`
 * wrote and the exported `pathToRings` read, so the same `d` string flattened differently depending
 * on which file had been converted earlier in the process: a 9000-unit em left behind a tolerance
 * that turned a 100-unit icon's circles into triangles.
 */
function steps(len: number, tol: number): number {
  return Math.max(2, Math.min(96, Math.ceil(Math.sqrt(len / (8 * tol)))));
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: Pt[], tol: number): void {
  const n = steps(dist(p0, p1) + dist(p1, p2) + dist(p2, p3), tol);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function quad(p0: Pt, p1: Pt, p2: Pt, out: Pt[], tol: number): void {
  const n = steps(dist(p0, p1) + dist(p1, p2), tol);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
}

/** SVG's endpoint-to-centre arc conversion, then sampled. */
function arc(p0: Pt, rx: number, ry: number, rot: number, large: number, sweep: number, p1: Pt, out: Pt[], tol: number): void {
  // A zero radius is a straight line, and coincident endpoints are nothing at all. The centre-form
  // conversion divides by a term that is zero in the second case, and every coordinate after it comes
  // out NaN — which reaches the document as `NaN%` and voids the whole clip-path.
  if (rx === 0 || ry === 0) { out.push(p1); return; }
  if (p0[0] === p1[0] && p0[1] === p1[1]) return;

  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rot * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;

  // A radius too small for the chord is scaled up until the arc closes, as the spec requires.
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const s = Math.sign(ux * vy - uy * vx) || 1;
    const c = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    return s * Math.acos(Math.max(-1, Math.min(1, c)));
  };
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;

  const n = steps(Math.abs(dt) * Math.max(rx, ry), tol);
  for (let i = 1; i <= n; i++) {
    const t = t0 + (dt * i) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/**
 * A cursor over path data, because an arc's flags cannot be tokenised like numbers.
 *
 * `A5 5 0 015 5` is what svgo emits for `A 5 5 0 0 1 5 5`: the two single-character flags and the
 * next coordinate, run together. A number-shaped scanner reads `015` as one value, every following
 * argument shifts by one, and the path comes out as garbage with nothing thrown. A flag is one
 * character, and only the reader knows which arguments are flags.
 */
class PathCursor {
  private i = 0;
  constructor(private readonly s: string) {}

  private ws(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++;
  }

  /** The next command letter, or undefined at the end. */
  command(): string | undefined {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined || !/[a-zA-Z]/.test(c)) return undefined;
    this.i++;
    return c;
  }

  /** True when another argument follows, so `M1,2 3,4` continues as an implicit lineto. */
  hasNumber(): boolean {
    this.ws();
    const c = this.s[this.i];
    return c !== undefined && (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9'));
  }

  number(): number {
    this.ws();
    const start = this.i;
    if (this.s[this.i] === '-' || this.s[this.i] === '+') this.i++;
    while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    if (this.s[this.i] === '.') { this.i++; while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++; }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      this.i++;
      if (this.s[this.i] === '-' || this.s[this.i] === '+') this.i++;
      while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    }
    const v = Number(this.s.slice(start, this.i));
    if (start === this.i || !Number.isFinite(v)) {
      throw new SvgClipError(`path data ends or malforms where a number was expected: "${this.s.slice(Math.max(0, start - 12), start + 12)}"`);
    }
    return v;
  }

  /** An arc flag: exactly one character, `0` or `1`. */
  flag(): number {
    this.ws();
    const c = this.s[this.i];
    if (c !== '0' && c !== '1') {
      throw new SvgClipError(`an arc flag is 0 or 1, saw "${c}": "${this.s.slice(Math.max(0, this.i - 12), this.i + 12)}"`);
    }
    this.i++;
    return c === '1' ? 1 : 0;
  }
}

/** One `d` attribute, flattened to closed rings of points. */
export function pathToRings(d: string, m: Mat = I, tol = 0.05): Pt[][] {
  const rings: Pt[][] = [];
  let cur: Pt[] = [];
  let pos: Pt = [0, 0], start: Pt = [0, 0];
  let prevC: Pt | null = null, prevQ: Pt | null = null;
  let budget = MAX_POINTS;

  const close = () => { if (cur.length > 2) rings.push(cur); cur = []; };
  const spend = (n: number) => {
    budget -= n;
    if (budget < 0) throw new SvgClipError(`this path passes ${MAX_POINTS} points — a mark does not need that many`);
  };

  const c = new PathCursor(d);
  let cmd = c.command();
  while (cmd !== undefined) {
    let rel = cmd === cmd.toLowerCase();
    let upper = cmd.toUpperCase();
    do {
      const ox = rel ? pos[0] : 0, oy = rel ? pos[1] : 0;
      const before = cur.length;
      switch (upper) {
        case 'M': {
          close();
          pos = [c.number() + ox, c.number() + oy]; start = pos; cur = [pos];
          // A repeated moveto argument set is a lineto, per the spec.
          upper = 'L';
          prevC = prevQ = null;
          break;
        }
        case 'L': { pos = [c.number() + ox, c.number() + oy]; cur.push(pos); prevC = prevQ = null; break; }
        case 'H': { pos = [c.number() + ox, pos[1]]; cur.push(pos); prevC = prevQ = null; break; }
        case 'V': { pos = [pos[0], c.number() + oy]; cur.push(pos); prevC = prevQ = null; break; }
        case 'C': {
          const c1: Pt = [c.number() + ox, c.number() + oy], c2: Pt = [c.number() + ox, c.number() + oy], p: Pt = [c.number() + ox, c.number() + oy];
          cubic(pos, c1, c2, p, cur, tol); pos = p; prevC = c2; prevQ = null; break;
        }
        case 'S': {
          const c1: Pt = prevC ? [2 * pos[0] - prevC[0], 2 * pos[1] - prevC[1]] : pos;
          const c2: Pt = [c.number() + ox, c.number() + oy], p: Pt = [c.number() + ox, c.number() + oy];
          cubic(pos, c1, c2, p, cur, tol); pos = p; prevC = c2; prevQ = null; break;
        }
        case 'Q': {
          const q: Pt = [c.number() + ox, c.number() + oy], p: Pt = [c.number() + ox, c.number() + oy];
          quad(pos, q, p, cur, tol); pos = p; prevQ = q; prevC = null; break;
        }
        case 'T': {
          const q: Pt = prevQ ? [2 * pos[0] - prevQ[0], 2 * pos[1] - prevQ[1]] : pos;
          const p: Pt = [c.number() + ox, c.number() + oy];
          quad(pos, q, p, cur, tol); pos = p; prevQ = q; prevC = null; break;
        }
        case 'A': {
          const rx = c.number(), ry = c.number(), rot = c.number(), la = c.flag(), sw = c.flag();
          const p: Pt = [c.number() + ox, c.number() + oy];
          arc(pos, rx, ry, rot, la, sw, p, cur, tol); pos = p; prevC = prevQ = null; break;
        }
        case 'Z': {
          if (cur.length) cur.push(start);
          close();
          // What follows a Z starts again at the subpath's own start, not at the origin.
          pos = start;
          prevC = prevQ = null;
          break;
        }
        default: throw new SvgClipError(`unknown path command "${upper}"`);
      }
      spend(Math.max(0, cur.length - before));
      if (upper === 'Z') break;
    } while (c.hasNumber());
    cmd = c.command();
    if (cmd !== undefined) { rel = cmd === cmd.toLowerCase(); upper = cmd.toUpperCase(); }
  }
  close();
  return rings.map((r) => r.map((p) => apply(m, p)));
}

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/**
 * Is `inner` WHOLLY inside `outer`? Sampling the whole ring is what separates the two cases a single
 * point cannot: a counterform released into its own `<path>` element sits entirely within its outer
 * contour, while two overlapping siblings each have points outside the other. Testing `ring[0]` alone
 * called overlapping circles nested — and scoping holes to one element to dodge that then lost every
 * counter an exporter had released, which is the commoner file by far.
 */
function within(inner: Pt[], outer: Pt[]): boolean {
  const step = Math.max(1, Math.floor(inner.length / 24));
  for (let i = 0; i < inner.length; i += step) if (!inside(inner[i], outer)) return false;
  return true;
}

function inside(pt: Pt, ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The index in `ring` nearest `p`, coarse then refined — a full scan per hole is quadratic. */
function nearestIndex(ring: Pt[], p: Pt): number {
  const stride = Math.max(1, Math.floor(ring.length / 64));
  let best = 0, bestD = Infinity;
  for (let i = 0; i < ring.length; i += stride) {
    const d = dist(ring[i], p);
    if (d < bestD) { bestD = d; best = i; }
  }
  for (let i = Math.max(0, best - stride); i < Math.min(ring.length, best + stride + 1); i++) {
    const d = dist(ring[i], p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * One island and its holes as a single ring: out along a slit, around the hole, back along the same
 * slit. The two slit EDGES are coincident, so the seam has no area — which is why the counterform
 * comes back transparent instead of as a hairline.
 *
 * A hole is REVERSED when it winds the same way as its outer contour. CSS `polygon()` fills by
 * NONZERO, so two same-wound contours give the counterform a winding number of 2 and it fills solid —
 * the module's whole purpose, lost silently, on the commonest export there is. `fill-rule="evenodd"`
 * art has no reason to wind its holes the other way, and both Illustrator and Figma emit it same-wound.
 *
 * Every bridge is measured against the ORIGINAL outer contour and spliced in from the last index
 * back to the first. Measuring against the ring as it grew made the cost quadratic in the hole count:
 * a mark with 80 counters took 50 seconds, and each doubling multiplied that by four.
 */
function weld(outer: Pt[], holes: Pt[][]): Pt[] {
  if (!holes.length) return outer.slice();
  const outerSign = Math.sign(ringArea(outer));

  const bridges = holes.map((raw) => {
    const hole = Math.sign(ringArea(raw)) === outerSign ? raw.slice().reverse() : raw;
    const seed = nearestIndex(outer, hole[0]);
    const hi = nearestIndex(hole, outer[seed]);
    return { oi: nearestIndex(outer, hole[hi]), hole, hi };
  });

  let ring = outer.slice();
  for (const b of bridges.sort((x, y) => y.oi - x.oi)) {
    const bridge = [...b.hole.slice(b.hi), ...b.hole.slice(0, b.hi + 1)];
    ring = [...ring.slice(0, b.oi + 1), ...bridge, ...ring.slice(b.oi)];
  }
  return ring;
}

/**
 * Points closer together than `eps`, dropped against the last KEPT point.
 *
 * It is a chained comparison, so a dense run collapses further than `eps` — which is why `eps` is a
 * twenty-thousandth of the mark rather than a visible fraction of it, and why curve density is
 * settled by the flatness tolerance instead. At a visible `eps` this deletes the corner of a narrow
 * stem and the letter loses its shape; that is a property of the algorithm, not a bug that was fixed.
 */
function thin(ring: Pt[], eps: number): Pt[] {
  const out: Pt[] = [ring[0]];
  for (const p of ring.slice(1)) if (dist(out[out.length - 1], p) > eps) out.push(p);
  return out;
}

/**
 * An attribute by name. The boundary is a space or a quote, never `\b`: a hyphen is a non-word
 * character, so `\bwidth` matched inside `stroke-width` and `\bopacity` inside `stroke-opacity`, and
 * whichever came first in the tag won. An 80-unit rect with `stroke-width="2"` written before it came
 * out two units wide, and a filled path with `stroke-opacity="0"` was read as invisible and dropped.
 */
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * A CSS length in user units: `24px`, `18pt` and a bare number read; `%`, `em`, `vw` and the rest do
 * not, because they mean nothing without a viewport. Taking the leading number and discarding the
 * unit turned `width="100%"` into 100 user units, and a 512-unit mark then emitted a polygon running
 * to 512% of its own box — off screen, drawn as nothing, reported as a success.
 */
function length(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = v.trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)$/i);
  if (!m) return undefined;
  const unit = m[2].toLowerCase();
  if (unit && unit !== 'px' && unit !== 'pt') return undefined;
  const n = Number(m[1]) * (unit === 'pt' ? 96 / 72 : 1);
  return Number.isFinite(n) ? n : undefined;
}

/** `<rect>`, `<circle>`, `<ellipse>`, `<polygon>` and `<polyline>`, as path data. */
function shapeToPath(tag: string, name: string): string | null {
  const n = (a: string, d = 0) => length(attr(tag, a)) ?? d;
  switch (name) {
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (w <= 0 || h <= 0) return null;
      const rx = Math.min(n('rx', n('ry')), w / 2), ry = Math.min(n('ry', n('rx')), h / 2);
      if (!rx && !ry) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}` +
        `V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}` +
        `H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
        `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
    }
    case 'circle': case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = name === 'circle' ? n('r') : n('rx'), ry = name === 'circle' ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
    }
    case 'polygon': case 'polyline': {
      const nums = (attr(tag, 'points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.length < 6 || nums.some((v) => !Number.isFinite(v))) return null;
      // An odd count means the list is malformed, and a lone trailing value is not half a vertex.
      const pairs = Math.floor(nums.length / 2);
      return `M${Array.from({ length: pairs }, (_, i) => `${nums[i * 2]},${nums[i * 2 + 1]}`).join('L')}Z`;
    }
    default: return null; // <line> has no area to clip
  }
}

/** Elements whose contents define something for later use and are never painted where they stand. */
const CONTAINERS = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker', 'filter']);

/**
 * Whether a tag is invisible, by any of the four ways an export says so.
 *
 * A hidden layer is not a definition, so the CONTAINERS skip never saw it — and a hidden full-bleed
 * rectangle is the largest island in the file, which makes every real glyph a HOLE in it. The mark
 * comes back knocked out of a solid block. Brand kits ship alternate lockups on hidden layers as a
 * matter of course, and that is exactly the input this module exists to accept.
 */
function hidden(tag: string): boolean {
  const style = attr(tag, 'style') ?? '';
  if (/(?:^|;)\s*display\s*:\s*none/i.test(style)) return true;
  if (/(?:^|;)\s*visibility\s*:\s*hidden/i.test(style)) return true;
  if (/(?:^|;)\s*(?:fill-)?opacity\s*:\s*0*(?:\.0*)?\s*(?:;|$)/i.test(style)) return true;
  if ((attr(tag, 'display') ?? '') === 'none') return true;
  if ((attr(tag, 'visibility') ?? '') === 'hidden') return true;
  for (const a of ['opacity', 'fill-opacity']) {
    const v = attr(tag, a);
    if (v !== undefined && Number(v) === 0) return true;
  }
  return false;
}

/**
 * An SVG file as clip-path polygons — one shape per island, holes welded in.
 *
 * `minAreaRatio` drops islands smaller than that fraction of the largest one: an export often
 * carries a stray sliver, and at 26px a sliver is a speck of dirt beside the mark. `flatness` is the
 * curve tolerance as a fraction of the mark's own size.
 *
 * Throws on anything it cannot read. A logo that renders as nothing while the run reports success is
 * the failure this exists to replace, so there is no quiet path out of here.
 */
export function svgToClip(
  file: string,
  opts: { minAreaRatio?: number; precision?: number; flatness?: number } = {},
): ClipLogo {
  const src = readFileSync(file, 'utf8');
  const minAreaRatio = opts.minAreaRatio ?? 0.002;
  const precision = opts.precision ?? 3;
  const flatness = opts.flatness ?? 1 / 2500;

  const svgTag = src.match(/<svg[^>]*>/i)?.[0];
  if (!svgTag) throw new SvgClipError(`${file} has no <svg> element`);
  const vb = (attr(svgTag, 'viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const box = vb.length === 4 && vb.every((v) => Number.isFinite(v)) ? vb : undefined;
  // `width="24px"` is a length, not a number. Read as one it is NaN, and NaN propagates through the
  // flatness tolerance into every step count, so each curve emits zero points and the whole mark
  // comes back as an empty shape list — an invisible logo, reported as a success.
  const W = box ? box[2] : length(attr(svgTag, 'width'));
  const H = box ? box[3] : length(attr(svgTag, 'height'));
  if (!W || !H || W <= 0 || H <= 0) {
    throw new SvgClipError(`${file} states no usable size — give it a viewBox, or a width and height`);
  }
  const X0 = box ? box[0] : 0, Y0 = box ? box[1] : 0;
  const tol = Math.max(W, H) * flatness;

  // A depth-tracked walk, so a <g transform> reaches the shapes under it. Nothing here parses XML
  // properly on purpose: an export is machine-written and its tags do not nest ambiguously.
  const stack: Mat[] = [I];
  const fills: (string | undefined)[] = [undefined];
  let skipDepth = 0;
  const rings: { ring: Pt[]; fill?: string }[] = [];

  for (const mt of src.matchAll(/<\/?\s*([a-z]+)\b([^>]*)>/gi)) {
    const [whole, name] = mt;
    const lower = name.toLowerCase();
    const closing = whole.startsWith('</');
    const selfClosing = whole.trimEnd().endsWith('/>');

    // A <defs>, <clipPath> or <mask> subtree defines something; it is not drawn where it stands. Read
    // as shapes, its contents become the largest island and every real glyph is then classified as a
    // HOLE in it — the mark comes back knocked out of a full-bleed rectangle, with no error.
    if (CONTAINERS.has(lower)) {
      if (closing) skipDepth = Math.max(0, skipDepth - 1);
      else if (!selfClosing) skipDepth++;
      continue;
    }
    // Inside a skipped subtree nothing is read, but its nesting still has to be counted or the skip
    // never ends and every shape after it is dropped.
    if (skipDepth > 0) {
      // BOTH tags that can open a skip must close it. Counting only `g` left a hidden `<svg>` — the
      // sprite-block idiom, `<svg style="display:none">` wrapping symbols — skipping the whole rest of
      // the file, and the error then blamed <defs> and stroke-only paths.
      if (lower === 'g' || lower === 'svg') {
        if (closing) skipDepth -= 1;
        else if (!selfClosing) skipDepth++;
      }
      continue;
    }

    if (lower === 'g' || lower === 'svg') {
      if (!closing && !selfClosing && hidden(whole)) { skipDepth++; continue; }
      if (closing) {
        // An export with more closing tags than opening ones must not empty the stack: the next
        // shape would multiply against undefined and throw a TypeError with nothing to read in it.
        if (stack.length > 1) { stack.pop(); fills.pop(); }
      } else if (!selfClosing) {
        stack.push(mul(stack[stack.length - 1], parseTransform(attr(whole, 'transform'))));
        fills.push(attr(whole, 'fill') ?? fills[fills.length - 1]);
      }
      continue;
    }
    if (closing) continue;

    const m = mul(stack[stack.length - 1], parseTransform(attr(whole, 'transform')));
    const style = attr(whole, 'style') ?? '';
    const fill = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1].trim()
      ?? attr(whole, 'fill')
      ?? fills[fills.length - 1];
    if (fill === 'none') continue; // stroke-only art has no area to clip
    if (hidden(whole)) continue;
    const d = lower === 'path' ? attr(whole, 'd') : shapeToPath(whole, lower);
    if (!d) continue;
    for (const ring of pathToRings(d, m, tol)) rings.push({ ring, fill });
  }

  if (!rings.length) {
    throw new SvgClipError(`${file} yielded no filled shape — is every path stroke-only, or inside <defs>?`);
  }

  // Outer contours and holes: a ring inside an odd number of others is a hole in the innermost of them.
  const areas = rings.map((r) => Math.abs(ringArea(r.ring)));
  const maxArea = Math.max(...areas);
  // Depth is counted within the ring's OWN element. Two separately painted shapes that overlap are
  // not nested, and a classifier that cannot tell made one a hole in the other.
  const depth = rings.map(({ ring }, i) =>
    rings.reduce((n, other, j) => (j !== i && within(ring, other.ring) ? n + 1 : n), 0));

  const shapes: ClipShape[] = [];
  const eps = Math.max(W, H) / 20000;
  rings.forEach(({ ring, fill }, i) => {
    if (depth[i] % 2 !== 0) return;                       // this one is a hole in something
    if (areas[i] < maxArea * minAreaRatio) return;        // export dirt
    const holes = rings
      .filter((r, j) => j !== i && depth[j] === depth[i] + 1 && within(r.ring, ring))
      .map((h) => h.ring);
    // Thin BEFORE welding, never after: the slit is two coincident points, and a pass that drops a
    // point within eps of the last kept one would delete the second of them, leaving an open seam
    // that renders as a hairline across the counterform.
    const welded = weld(thin(ring, eps), holes.map((h) => thin(h, eps)));
    const pts = welded.map(([x, y]) =>
      `${(((x - X0) / W) * 100).toFixed(precision)}% ${(((y - Y0) / H) * 100).toFixed(precision)}%`);
    // Only a colour a document could actually paint is worth reporting. `url(#grad)` and
    // `currentColor` are what an export writes when the fill lives somewhere else, and a caller that
    // took either of them for a background would paint nothing.
    const plain = fill && fill !== 'currentColor' && /^(#[0-9a-f]{3,8}$|rgba?\(|hsla?\(|[a-z]+$)/i.test(fill)
      ? fill : undefined;
    shapes.push({ polygon: pts.join(', '), fill: plain });
  });

  if (!shapes.length) {
    throw new SvgClipError(`${file} has shapes but none survived — every ring is a hole, or all are below minAreaRatio`);
  }
  return { width: W, height: H, aspect: W / H, shapes };
}

/**
 * The logo as engine-ready HTML: one absolutely-positioned box per island, all sharing the mark's
 * own box so the islands stay registered to each other.
 *
 * `colour` is REQUIRED. A mark over footage takes the document's ink, and a default would be a
 * colour the run's design system never declared — which its own gate is right to refuse.
 */
export function clipLogoHtml(
  logo: ClipLogo,
  o: { id: string; left: number; top: number; height: number; colour: string; zIndex?: number },
): { html: string; width: number; height: number } {
  if (!(o.height > 0) || !(logo.aspect > 0)) throw new SvgClipError('the mark has no usable size');
  const w = Math.round(o.height * logo.aspect);
  const z = o.zIndex === undefined ? '' : `z-index:${o.zIndex}; `;
  const html = logo.shapes
    .map((s, i) =>
      `<div id="${o.id}-${i}" style="position:absolute; ${z}left:${o.left}px; top:${o.top}px; ` +
      `width:${w}px; height:${o.height}px; background:${o.colour}; ` +
      `clip-path:polygon(${s.polygon})"></div>`)
    .join('\n');
  return { html, width: w, height: o.height };
}
