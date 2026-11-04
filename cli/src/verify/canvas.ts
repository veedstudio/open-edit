// The canvas check, advisory like every review check: a delivery whose picture is not a size the platforms list, such
// as a 16:9 source cut to 9:16 at its own 606x1080, or a 4K one at 1214x2160. A size nearly one of the platform shapes
// is reported unless it is exactly that shape; another shape (4:3, 2:3, 21:9) is the user's choice, and only its short
// side is judged.
import { probeSquareSize } from '../probe.ts';
import type { CheckReport, ReviewContext } from './checks.ts';

export interface Size {
  width: number;
  height: number;
}

/** The shapes the platforms' upload specs list. */
export const PLATFORM_SHAPES: readonly Size[] = [
  { width: 9, height: 16 },
  { width: 1, height: 1 },
  { width: 4, height: 5 },
  { width: 16, height: 9 },
];

/** The short side every platform's recommended canvas has, and the floor under which a phone shows the picture upscaled. */
export const SHORT_SIDE = 1080;

/** The short sides of the canvases the platforms list for a shape: 1080, and the larger sizes some list, for when they are asked for. */
export const SHORT_SIDES = [SHORT_SIDE, 1440, 2160] as const;

/**
 * How far a size's shape may be from a platform shape, as a fraction of it, and still count as that shape gone wrong
 * rather than another shape: half the 6.25% between 4:5 and 3:4, the nearest pair of distinct shapes in use.
 */
export const NEAR_SHAPE = 0.03;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The canvas of shape `ratio` (width over height) with `short` px on its short side, the long side on even pixels. */
export function canvasFor(ratio: number, short: number = SHORT_SIDE): Size {
  return ratio <= 1 ? { width: short, height: even(short / ratio) } : { width: even(short * ratio), height: short };
}

const ratioOf = (s: Size) => s.width / s.height;
const named = (s: Size) => `${s.width}x${s.height}`;
const shapeName = (s: Size) => `${s.width}:${s.height}`;

/** Every canvas of a platform shape, smallest first. */
export const canvasesOf = (shape: Size): Size[] => SHORT_SIDES.map((short) => canvasFor(ratioOf(shape), short));

/** The platform shape a size is nearly, if any. */
export function nearShape(size: Size): Size | undefined {
  const off = (shape: Size) => Math.abs(ratioOf(size) / ratioOf(shape) - 1);
  const nearest = [...PLATFORM_SHAPES].sort((a, b) => off(a) - off(b))[0];
  return off(nearest) <= NEAR_SHAPE ? nearest : undefined;
}

/** A shape as the report names it: W:H when it reduces to small numbers, else its width over its height. */
function shapeOf(size: Size): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(size.width, size.height);
  const [w, h] = [size.width / g, size.height / g];
  return w <= 32 && h <= 32 ? `${w}:${h}` : ratioOf(size).toFixed(3);
}

const listed = (items: string[]) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The judgement on a picture shown at `size`: reported when it is nearly a platform shape but not exactly it, which a
 * platform letterboxes or crops, or when its short side is under SHORT_SIDE. An exact platform shape at SHORT_SIDE or
 * more passes whatever its size, since every platform scales that without bars.
 */
export function judgeCanvas(size: Size): CheckReport {
  const shape = nearShape(size);
  const short = Math.min(size.width, size.height);
  const exact = shape !== undefined && size.width * shape.height === size.height * shape.width;
  const lines: string[] = [];
  if (shape && !exact) {
    lines.push(`the picture is ${named(size)}, nearly ${shapeName(shape)} but not exactly: the ${shapeName(shape)} canvases the platforms list are `
      + listed(canvasesOf(shape).map(named)));
  }
  if (short < SHORT_SIDE) lines.push(`its short side is ${short} px, under the ${SHORT_SIDE} px of the platforms' canvases`);
  if (lines.length) {
    lines.push(`reframe scales footage to ${named(canvasFor(ratioOf(shape ?? size)))} by default, and a page's stage of that size renders at it`);
    return { verdict: 'found', lines, skipped: [] };
  }
  if (shape) return { verdict: 'pass', lines: [`${named(size)}, exactly ${shapeName(shape)} with ${short} px on its short side`], skipped: [] };
  return {
    verdict: 'pass',
    lines: [`${named(size)}, ${short} px on its short side, at least the ${SHORT_SIDE} px of the platforms' canvases`],
    skipped: [`the shape: ${named(size)} is ${shapeOf(size)}, none of the platform shapes (${PLATFORM_SHAPES.map(shapeName).join(', ')})`],
  };
}

export function measureCanvas({ video }: ReviewContext): CheckReport {
  const { width, height } = probeSquareSize(video);
  return judgeCanvas({ width, height });
}
